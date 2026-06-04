import { Pool } from 'pg';

let pool: Pool;

// ====== 内存缓存（替代 Redis） ======
interface CacheEntry {
  data: any;
  expiry: number;
}

const cacheStore = new Map<string, CacheEntry>();

export function cacheGet(key: string): any | null {
  const entry = cacheStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    cacheStore.delete(key);
    return null;
  }
  return entry.data;
}

export function cacheSet(key: string, data: any, ttlSeconds: number): void {
  cacheStore.set(key, { data, expiry: Date.now() + ttlSeconds * 1000 });
}

export function cacheDel(key: string): void {
  cacheStore.delete(key);
}

// ====== 数据库连接 ======
export function initDatabase(connectionString: string): Pool {
  pool = new Pool({ connectionString, max: 20 });
  pool.on('error', (err) => {
    console.error('数据库连接池异常:', err.message);
  });
  console.log('PostgreSQL 连接池已创建');
  return pool;
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error('数据库未初始化，请先调用 initDatabase()');
  }
  return pool;
}
