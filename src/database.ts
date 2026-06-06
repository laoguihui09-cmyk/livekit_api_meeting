import { Pool } from 'pg';

let pool: Pool;

// ====== 鍐呭瓨缂撳瓨锛堟浛浠?Redis锛?======
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

// ====== 鏁版嵁搴撹繛鎺?======
function normalizeDatabaseUrl(connectionString: string): string {
  const url = new URL(connectionString);
  if (url.searchParams.has('sslmode')) {
    url.searchParams.set('sslmode', 'no-verify');
  }
  return url.toString();
}

export function initDatabase(connectionString: string): Pool {
  pool = new Pool({
    connectionString: normalizeDatabaseUrl(connectionString),
    max: 20,
  });
  pool.on('error', (err) => {
    console.error('鏁版嵁搴撹繛鎺ユ睜寮傚父:', err.message);
  });
  console.log('PostgreSQL 杩炴帴姹犲凡鍒涘缓');
  return pool;
}

export function getPool(): Pool {
  if (!pool) {
    throw new Error('鏁版嵁搴撴湭鍒濆鍖栵紝璇峰厛璋冪敤 initDatabase()');
  }
  return pool;
}
