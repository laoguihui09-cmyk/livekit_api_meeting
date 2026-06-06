import { RoomServiceClient, EgressClient, EncodedFileOutput, EncodedFileType } from 'livekit-server-sdk';
import { HealthStatus, RoomInfo } from './models';
import { InviteService } from './tokenService';

interface ServerConfig {
  host: string;
  apiKey: string;
  apiSecret: string;
}

export class LiveKitService {
  private primary: ServerConfig;
  private fallback: ServerConfig | null = null;
  private activePrimary = true;
  private primaryHealthy = true;
  private lastHealthCheck = new Date(0);
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private inviteService: InviteService;
  private autoReleaseTimer: NodeJS.Timeout | null = null;

  constructor(primary: ServerConfig, fallback: ServerConfig | null, checkInterval: number) {
    this.primary = primary;
    this.fallback = fallback;
    this.inviteService = new InviteService(primary.apiKey, primary.apiSecret, primary.host);

    // Railway 持久进程：定时健康检查
    this.healthCheckTimer = setInterval(() => this.checkHealth(), checkInterval);
    this.checkHealth();
    this.autoReleaseTimer = setInterval(() => {
      void this.autoReleaseRooms();
    }, 30000);
    void this.autoReleaseRooms();
  }

  // Railway 持久进程不需要 ensureHealthy，保留空方法兼容路由中间件
  async ensureHealthy() {}

  getInviteService(): InviteService {
    return this.inviteService;
  }

  private getActiveConfig(): ServerConfig {
    if (this.activePrimary) return this.primary;
    if (this.fallback) return this.fallback;
    return this.primary;
  }

  private getRoomService(): RoomServiceClient {
    const config = this.getActiveConfig();
    const httpHost = config.host.replace(/^wss?:\/\//, 'https://');
    return new RoomServiceClient(httpHost, config.apiKey, config.apiSecret);
  }

  private getEgressClient(): EgressClient {
    const config = this.getActiveConfig();
    const httpHost = config.host.replace(/^wss?:\/\//, 'https://');
    return new EgressClient(httpHost, config.apiKey, config.apiSecret);
  }

  // ====== 健康检查 ======
  async checkHealth(): Promise<boolean> {
    try {
      const httpHost = this.primary.host.replace(/^wss?:\/\//, 'https://');
      const roomService = new RoomServiceClient(
        httpHost,
        this.primary.apiKey,
        this.primary.apiSecret
      );
      await roomService.listRooms();
      this.primaryHealthy = true;
      this.lastHealthCheck = new Date();

      // 如果主服务器恢复，切回主服务器
      if (!this.activePrimary) {
        console.log('[故障转移] 主服务器恢复，切回主服务器');
        this.activePrimary = true;
        this.inviteService.updateServer(this.primary.apiKey, this.primary.apiSecret, this.primary.host);
      }

      return true;
    } catch (err) {
      console.error('[健康检查] 主服务器不可用:', (err as Error).message);
      this.primaryHealthy = false;
      this.lastHealthCheck = new Date();

      // 切换到备用服务器
      if (this.fallback && this.activePrimary) {
        console.log('[故障转移] 切换到备用服务器:', this.fallback.host);
        this.activePrimary = false;
        this.inviteService.updateServer(this.fallback.apiKey, this.fallback.apiSecret, this.fallback.host);
      }

      return false;
    }
  }

  getHealthStatus(): HealthStatus {
    return {
      primary: {
        url: this.primary.host,
        healthy: this.primaryHealthy,
        lastChecked: this.lastHealthCheck.toISOString(),
      },
      fallback: {
        url: this.fallback?.host || '未配置',
        configured: !!this.fallback,
      },
      activeServer: this.activePrimary ? 'primary' : 'fallback',
    };
  }

  // ====== 房间管理 ======
  async listRooms(): Promise<RoomInfo[]> {
    const roomService = this.getRoomService();
    const rooms = await roomService.listRooms();
    return rooms.map((r) => ({
      name: r.name,
      numParticipants: r.numParticipants,
      createdAt: r.creationTime,
      activeRecording: r.activeRecording,
    }));
  }

  async autoReleaseRooms(): Promise<number> {
    try {
      const rooms = await this.listRooms();
      const activeRoomNames = rooms
        .filter((room) => room.numParticipants > 0)
        .map((room) => room.name);
      const releasedCount = await this.inviteService.autoReleaseInactiveRooms(activeRoomNames);
      if (releasedCount > 0) {
        console.log(`[自动释放] 已自动释放 ${releasedCount} 个已结束会议的房间绑定`);
      }
      return releasedCount;
    } catch (err) {
      console.error('[自动释放] 检查房间释放状态失败:', (err as Error).message);
      return 0;
    }
  }

  async createRoom(roomName: string, emptyTimeout?: number, maxParticipants?: number) {
    const roomService = this.getRoomService();
    return await roomService.createRoom({
      name: roomName,
      emptyTimeout: emptyTimeout || 600, // 10 分钟无人自动关闭
      maxParticipants: maxParticipants || 2, // 1v1 默认最多 2 人
    });
  }

  async deleteRoom(roomName: string) {
    const roomService = this.getRoomService();
    await roomService.deleteRoom(roomName);
  }

  // ====== 录制 ======
  async startRecording(roomName: string, outputFile?: string) {
    const egress = this.getEgressClient();
    const filename = outputFile || `recording-${roomName}-${Date.now()}.mp4`;
    const fileOutput = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: `/recordings/${filename}`,
    });
    const info = await egress.startRoomCompositeEgress(roomName, { file: fileOutput });
    return {
      egressId: info.egressId,
      roomName,
      filename,
      status: 'recording',
    };
  }

  async stopRecording(egressId: string) {
    const egress = this.getEgressClient();
    const info = await egress.stopEgress(egressId);
    return {
      egressId: info.egressId,
      status: 'stopped',
    };
  }

  async listRecordings() {
    const egress = this.getEgressClient();
    const list = await egress.listEgress();
    return list.map((e) => ({
      egressId: e.egressId,
      roomName: e.roomName,
      status: e.status,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
    }));
  }

  destroy() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    if (this.autoReleaseTimer) {
      clearInterval(this.autoReleaseTimer);
    }
  }
}
