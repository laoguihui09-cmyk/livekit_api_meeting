import { AccessToken } from 'livekit-server-sdk';
import { getPool, cacheGet, cacheSet, cacheDel } from './database';
import { InviteCode, CreateInviteRequest, InviteResponse, JoinRequest, JoinResponse, CodeRecord } from './models';
import crypto from 'crypto';

export class InviteService {
  private apiKey: string;
  private apiSecret: string;
  private serverUrl: string;

  constructor(apiKey: string, apiSecret: string, serverUrl: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.serverUrl = serverUrl;
  }

  updateServer(apiKey: string, apiSecret: string, serverUrl: string) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.serverUrl = serverUrl;
  }

  private normalizeCode(code: string): string {
    return code.trim().toUpperCase();
  }

  private mapCodeRecord(data: any): CodeRecord {
    const expiresAt = data.expires_at ?? null;
    const roomName = data.room_name ?? null;
    const isActive = !!roomName && (!expiresAt || new Date(expiresAt).getTime() > Date.now());
    const isAssigned = isActive || data.assigned_to !== null;

    return {
      code: data.code,
      status: isAssigned || !!(data.assigned_name ?? '').trim() ? 'assigned' : 'available',
      in_use: isActive,
      expires_at: expiresAt,
      bound_room: roomName,
      created_at: data.created_at,
      activated_at: data.activated_at ?? null,
      max_participants: data.max_participants,
      assigned_to: data.assigned_to ?? null,
      assigned_name: data.assigned_name ?? '',
      note: data.note ?? '',
    };
  }

  // 生成 6 位邀请码
  private generateCode(): string {
    return crypto.randomBytes(3).toString('hex').toUpperCase(); // 如 A3F2B1
  }

  // 创建邀请码
  async createInvite(request: CreateInviteRequest): Promise<InviteResponse> {
    const { ttlSeconds = 3600, maxParticipants = 2, assignedTo = null, assignedName = '', note = '' } = request;
    const pool = getPool();

    // 清理过期邀请码
    await pool.query('DELETE FROM invite_codes WHERE expires_at < $1', [new Date().toISOString()]);

    const code = this.generateCode();
    const now = new Date();

    await pool.query(
      `INSERT INTO invite_codes (code, room_name, created_at, activated_at, expires_at, ttl_seconds, max_participants, assigned_to, assigned_name, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [code, null, now.toISOString(), null, null, ttlSeconds, maxParticipants, assignedTo, assignedName, note],
    );

    return {
      code,
      createdAt: now.toISOString(),
      activatedAt: null,
      expiresAt: null,
      maxParticipants,
    };
  }

  async createCodes(
    count: number,
    ttlSeconds: number,
    maxParticipants = 2,
    options?: { assignedTo?: number | null; assignedName?: string; note?: string },
  ): Promise<CodeRecord[]> {
    const records: CodeRecord[] = [];
    for (let index = 0; index < count; index += 1) {
      const invite = await this.createInvite({
        ttlSeconds,
        maxParticipants,
        assignedTo: options?.assignedTo ?? null,
        assignedName: options?.assignedName ?? '',
        note: options?.note ?? '',
      });
      records.push({
        code: invite.code,
        status: (options?.assignedTo !== undefined && options?.assignedTo !== null) || !!(options?.assignedName ?? '').trim() ? 'assigned' : 'available',
        in_use: false,
        expires_at: invite.expiresAt,
        bound_room: null,
        created_at: invite.createdAt,
        activated_at: invite.activatedAt,
        max_participants: invite.maxParticipants,
        assigned_to: options?.assignedTo ?? null,
        assigned_name: options?.assignedName ?? '',
        note: options?.note ?? '',
      });
    }
    return records;
  }

  async listCodes(limit = 100, options?: { status?: string; assignedTo?: number | null; assignedName?: string }): Promise<CodeRecord[]> {
    const pool = getPool();
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (options?.assignedTo !== undefined && options.assignedTo !== null) {
      conditions.push(`assigned_to = $${idx++}`);
      params.push(options.assignedTo);
    }
    if (options?.assignedName) {
      conditions.push(`assigned_name = $${idx++}`);
      params.push(options.assignedName);
    }

    const fetchLimit = options?.status ? Math.max(limit * 5, 100) : limit;
    params.push(fetchLimit);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM invite_codes ${where} ORDER BY created_at DESC LIMIT $${idx}`,
      params,
    );

    let mapped = rows.map((item: any) => this.mapCodeRecord(item));
    if (options?.status) {
      mapped = mapped.filter((item: CodeRecord) => item.status === options.status);
    }
    return mapped.slice(0, limit);
  }

  async getCodeStats(): Promise<{ total: number; available: number; assigned: number; in_use: number }> {
    const rows = await this.listCodes(1000);
    const assigned = rows.filter((item) => item.status === 'assigned').length;
    const inUse = rows.filter((item) => item.in_use).length;
    return {
      total: rows.length,
      available: rows.length - assigned,
      assigned,
      in_use: inUse,
    };
  }

  async getCodeRecord(code: string): Promise<CodeRecord | null> {
    const pool = getPool();
    const normalizedCode = this.normalizeCode(code);
    const { rows } = await pool.query('SELECT * FROM invite_codes WHERE code = $1', [normalizedCode]);

    if (rows.length === 0) {
      return null;
    }

    return this.mapCodeRecord(rows[0]);
  }

  async deleteCodes(codes: string[]): Promise<{ deleted: number; failed: string[] }> {
    const pool = getPool();
    let deleted = 0;
    const failed: string[] = [];

    for (const rawCode of codes) {
      const code = this.normalizeCode(rawCode);
      const record = await this.getCodeRecord(code);
      if (!record || record.in_use) {
        failed.push(code);
        continue;
      }

      try {
        await pool.query('DELETE FROM invite_codes WHERE code = $1', [code]);
        deleted += 1;
      } catch {
        failed.push(code);
      }
    }

    return { deleted, failed };
  }

  // 用邀请码 + 房间名 + 身份 加入房间
  async joinRoom(request: JoinRequest): Promise<JoinResponse> {
    const { roomName, identity } = request;
    const code = this.normalizeCode(request.code);
    const displayName = request.name?.trim() || identity;
    const pool = getPool();

    const cacheKey = `invite:${code}`;
    let invite: any = null;

    // 1. 先尝试从内存缓存读取
    invite = cacheGet(cacheKey);

    // 2. 缓存没命中，查数据库
    if (!invite) {
      const { rows } = await pool.query('SELECT * FROM invite_codes WHERE code = $1', [code]);

      if (rows.length === 0) {
        throw new Error('邀请码无效或已过期');
      }
      invite = rows[0];

      // 写入缓存 (300秒 / 5分钟)
      if (invite.id) {
        if (!invite.expires_at || new Date(invite.expires_at).getTime() > Date.now()) {
          cacheSet(cacheKey, invite, 300);
        }
      }
    }

    if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) {
      throw new Error('邀请码无效或已过期');
    }

    // 缓存数据缺少 id 时，回退到数据库查询
    if (!invite.id) {
      const { rows } = await pool.query('SELECT * FROM invite_codes WHERE code = $1', [code]);
      if (rows.length === 0) {
        throw new Error('邀请码无效或已过期');
      }
      invite = rows[0];
    }

    let effectiveInvite = invite;

    // 如果邀请码还没绑定房间，绑定到用户设置的房间名
    if (!invite.room_name) {
      const activatedAt = invite.activated_at || new Date().toISOString();
      const expiresAt = invite.expires_at || new Date(Date.now() + invite.ttl_seconds * 1000).toISOString();
      const result = await pool.query(
        'UPDATE invite_codes SET room_name = $1, activated_at = $2, expires_at = $3 WHERE id = $4',
        [roomName, activatedAt, expiresAt, invite.id],
      );

      if (result.rowCount === 0) {
        throw new Error('绑定房间失败');
      }
      effectiveInvite = { ...invite, room_name: roomName, activated_at: activatedAt, expires_at: expiresAt };
    } else if (invite.room_name !== roomName) {
      // 授权码已绑定其他房间，拒绝创建新房间
      throw new Error('该授权码已有会议进行中，不能同时开启两个会议');
    }

    // 生成 LiveKit Token
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity,
      ttl: Math.floor((new Date(effectiveInvite.expires_at).getTime() - Date.now()) / 1000),
      name: displayName,
    });

    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    return {
      token,
      url: this.serverUrl,
      roomName,
      expiresAt: effectiveInvite.expires_at,
    };
  }

  // 查询邀请码信息
  async getInviteInfo(code: string): Promise<InviteCode | null> {
    const pool = getPool();
    const { rows } = await pool.query('SELECT * FROM invite_codes WHERE code = $1', [this.normalizeCode(code)]);

    if (rows.length === 0) return null;
    const data = rows[0];

    return {
      id: data.id,
      code: data.code,
      roomName: data.room_name,
      createdAt: new Date(data.created_at),
      activatedAt: data.activated_at ? new Date(data.activated_at) : null,
      expiresAt: data.expires_at ? new Date(data.expires_at) : null,
      ttlSeconds: data.ttl_seconds,
      maxParticipants: data.max_participants,
    };
  }

  // 列出所有有效邀请码
  async getAllInvites(): Promise<InviteCode[]> {
    const pool = getPool();
    const { rows } = await pool.query('SELECT * FROM invite_codes ORDER BY created_at DESC');

    return rows
      .filter((d: any) => !d.expires_at || new Date(d.expires_at).getTime() > Date.now())
      .map((d: any) => ({
      id: d.id,
      code: d.code,
      roomName: d.room_name,
      createdAt: new Date(d.created_at),
      activatedAt: d.activated_at ? new Date(d.activated_at) : null,
      expiresAt: d.expires_at ? new Date(d.expires_at) : null,
      ttlSeconds: d.ttl_seconds,
      maxParticipants: d.max_participants,
    }));
  }

  // 释放房间（把邀请码的 room_name 清空，下次可以开新房间）
  async releaseRoom(code: string): Promise<boolean> {
    const pool = getPool();
    const now = new Date().toISOString();
    const result = await pool.query(
      `UPDATE invite_codes SET room_name = NULL WHERE code = $1 AND (expires_at IS NULL OR expires_at > $2)`,
      [this.normalizeCode(code), now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async autoReleaseInactiveRooms(activeRoomNames: string[]): Promise<number> {
    const pool = getPool();
    const now = new Date().toISOString();
    const { rows } = await pool.query(
      `SELECT code, room_name FROM invite_codes WHERE room_name IS NOT NULL AND (expires_at IS NULL OR expires_at > $1)`,
      [now],
    );

    if (rows.length === 0) {
      return 0;
    }

    const activeRooms = new Set(activeRoomNames);
    const releasableCodes = rows
      .filter((item: any) => item.room_name && !activeRooms.has(item.room_name))
      .map((item: any) => item.code);

    if (releasableCodes.length === 0) {
      return 0;
    }

    const result = await pool.query(
      'UPDATE invite_codes SET room_name = NULL WHERE code = ANY($1)',
      [releasableCodes],
    );

    return result.rowCount ?? 0;
  }

  // 撤销邀请码
  async revokeInvite(code: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query('DELETE FROM invite_codes WHERE code = $1', [this.normalizeCode(code)]);
    return (result.rowCount ?? 0) > 0;
  }
}
