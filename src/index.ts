process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { LiveKitService } from './livekitService';
import { createRouter } from './routes';
import { initDatabase } from './database';
import { readIntEnv, readOptionalServerConfig, requireEnv } from './env';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

try {
  const dbHost = 'sgp1-52774-do-user-38187578-0.k.db.ondigitalocean.com';
  const dbUser = 'doadmin';
  const dbPass = Buffer.from('QVZOU19QYy04eHFkNjB5THNIS0gzYQ==', 'base64').toString();
  const dbPort = '25060';
  const dbName = 'defaultdb';
  const databaseUrl = `postgresql://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}`;
  initDatabase(databaseUrl);
  console.log('数据库已连接');

  const livekitHost = process.env.LIVEKIT_HOST?.trim() || '';
  const isInvalidHost = !livekitHost || livekitHost.startsWith('postgresql://') || livekitHost.startsWith('postgres://');
  
  const primary = {
    host: isInvalidHost ? 'wss://livekit.tookiuy.top/' : livekitHost,
    apiKey: requireEnv('LIVEKIT_API_KEY'),
    apiSecret: requireEnv('LIVEKIT_API_SECRET'),
  };
  
  if (isInvalidHost) {
    console.warn(`LIVEKIT_HOST 环境变量无效 (${livekitHost})，使用默认值: ${primary.host}`);
  }

  const fallback = readOptionalServerConfig('LIVEKIT_CLOUD');
  const checkInterval = readIntEnv('HEALTH_CHECK_INTERVAL', 30000);

  // 初始化 LiveKit 服务
  const lkService = new LiveKitService(primary, fallback, checkInterval);

  // 注册路由
  const router = createRouter(lkService);
  const adminConsoleDir = path.resolve(__dirname, '..', '..', 'HUIYI_ADMIN');

  if (fs.existsSync(adminConsoleDir)) {
    app.use('/admin', express.static(adminConsoleDir));
    app.get('/admin', (_req, res) => {
      res.redirect('/admin/');
    });
  }

  app.use('/api', router);
  // 兼容 xinbotapi（iOS旧包直接访问 /room/join 等无前缀路径）
  app.use('/', router);

  // 根路径
  app.get('/', (_req, res) => {
    res.json({ status: 'ok', message: 'LiveKit Translate API' });
  });

  const port = readIntEnv('PORT', 3000);
  app.listen(port, () => {
    console.log(`API 服务已启动: http://localhost:${port}`);
    console.log(`主服务器: ${primary.host}`);
    if (fallback) {
      console.log(`备用服务器: ${fallback.host}`);
    } else {
      console.log('备用服务器: 未配置');
    }
  });

  process.on('SIGTERM', () => {
    lkService.destroy();
    process.exit(0);
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
