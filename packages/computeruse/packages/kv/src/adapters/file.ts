import * as fs from 'fs';
import * as path from 'path';
import { KVClient, SetOptions, KVConfig } from '../types';

interface StoreData {
  // Value storage: string | number | Array | Record<string, string>
  data: Record<string, any>;
  // Expiry timestamps in milliseconds
  expiry: Record<string, number>;
}

export class FileKV implements KVClient {
  private filePath: string;
  private lockFile: string;
  private lockStaleTime = 5000; // 5 seconds lock timeout
  private retryInterval = 50;
  private maxRetries = 100; // ~5 seconds total wait

  constructor(config: KVConfig) {
    let p = config.url || 'file://./computeruse-kv.json';
    if (p.startsWith('file://')) {
      p = p.slice(7);
    }
    // Handle relative paths correctly
    this.filePath = path.resolve(process.cwd(), p);
    this.lockFile = `${this.filePath}.lock`;

    // Initialize if not exists
    if (!fs.existsSync(this.filePath)) {
      // We use sync here to ensure it's ready immediately
      try {
        fs.writeFileSync(this.filePath, JSON.stringify({ data: {}, expiry: {} }));
      } catch (e) {
        // Ignore error if created in parallel
      }
    }
  }

  private async acquireLock(): Promise<void> {
    let retries = 0;
    while (retries < this.maxRetries) {
      try {
        // 'wx' flag fails if path exists
        await fs.promises.writeFile(this.lockFile, String(Date.now()), { flag: 'wx' });
        return;
      } catch (e: any) {
        if (e.code === 'EEXIST') {
          // Check if lock is stale
          try {
            const created = parseInt(await fs.promises.readFile(this.lockFile, 'utf8'), 10);
            if (Date.now() - created > this.lockStaleTime) {
              // Lock is stale, try to remove it and retry immediately
              try {
                await fs.promises.unlink(this.lockFile);
              } catch (ignore) {}
              continue;
            }
          } catch (err) {
            // Lock file might have been deleted in between, retry
          }

          await new Promise(r => setTimeout(r, this.retryInterval));
          retries++;
        } else {
          throw e;
        }
      }
    }
    throw new Error(`Could not acquire lock on ${this.lockFile} after ${this.maxRetries} attempts`);
  }

  private async releaseLock(): Promise<void> {
    try {
      await fs.promises.unlink(this.lockFile);
    } catch (e) {
      // Ignore if already gone
    }
  }

  private async withLock<T>(operation: (data: StoreData) => Promise<{ result: T, modified: boolean }>): Promise<T> {
    await this.acquireLock();
    try {
      let content = '{}';
      try {
        content = await fs.promises.readFile(this.filePath, 'utf8');
      } catch (e) {
        // If read fails, assume empty or corrupt, reset to default
        content = JSON.stringify({ data: {}, expiry: {} });
      }

      let store: StoreData;
      try {
        store = JSON.parse(content);
        if (!store.data) store.data = {};
        if (!store.expiry) store.expiry = {};
      } catch {
        store = { data: {}, expiry: {} };
      }

      // Clean expired keys lazily
      const now = Date.now();
      let cleaned = false;
      for (const key in store.expiry) {
        if (store.expiry[key] <= now) {
          delete store.expiry[key];
          delete store.data[key];
          cleaned = true;
        }
      }

      const { result, modified } = await operation(store);

      if (modified || cleaned) {
        await fs.promises.writeFile(this.filePath, JSON.stringify(store, null, 2));
      }

      return result;
    } finally {
      await this.releaseLock();
    }
  }

  async get(key: string): Promise<string | null> {
    return this.withLock(async (store) => {
      const val = store.data[key];
      if (val === undefined) return { result: null, modified: false };
      if (typeof val !== 'string' && typeof val !== 'number') return { result: null, modified: false };
      return { result: String(val), modified: false };
    });
  }

  async set(key: string, value: string | number, options?: SetOptions): Promise<string | null> {
    return this.withLock(async (store) => {
      const exists = key in store.data;

      if (options?.nx && exists) return { result: null, modified: false };
      if (options?.xx && !exists) return { result: null, modified: false };

      store.data[key] = String(value);

      if (options?.ex) {
        store.expiry[key] = Date.now() + (options.ex * 1000);
      } else {
        // Clear expiry if it existed
        delete store.expiry[key];
      }

      return { result: 'OK', modified: true };
    });
  }

  async del(key: string): Promise<number> {
    return this.withLock(async (store) => {
      if (key in store.data) {
        delete store.data[key];
        delete store.expiry[key];
        return { result: 1, modified: true };
      }
      return { result: 0, modified: false };
    });
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.withLock(async (store) => {
      if (!(key in store.data)) return { result: 0, modified: false };
      store.expiry[key] = Date.now() + (seconds * 1000);
      return { result: 1, modified: true };
    });
  }

  async lpush(key: string, ...elements: (string | number)[]): Promise<number> {
    return this.withLock(async (store) => {
      let list = store.data[key];
      if (list === undefined) {
        list = [];
        store.data[key] = list;
      }
      if (!Array.isArray(list)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

      const strings = elements.map(String);
      list.unshift(...strings);

      return { result: list.length, modified: true };
    });
  }

  async rpush(key: string, ...elements: (string | number)[]): Promise<number> {
    return this.withLock(async (store) => {
      let list = store.data[key];
      if (list === undefined) {
        list = [];
        store.data[key] = list;
      }
      if (!Array.isArray(list)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

      const strings = elements.map(String);
      list.push(...strings);

      return { result: list.length, modified: true };
    });
  }

  async lpop(key: string): Promise<string | null> {
    return this.withLock(async (store) => {
      const list = store.data[key];
      if (list === undefined) return { result: null, modified: false };
      if (!Array.isArray(list)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

      const val = list.shift();
      if (list.length === 0) {
        delete store.data[key];
        delete store.expiry[key];
      }
      return { result: val || null, modified: true };
    });
  }

  async rpop(key: string): Promise<string | null> {
    return this.withLock(async (store) => {
      const list = store.data[key];
      if (list === undefined) return { result: null, modified: false };
      if (!Array.isArray(list)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

      const val = list.pop();
      if (list.length === 0) {
        delete store.data[key];
        delete store.expiry[key];
      }
      return { result: val || null, modified: true };
    });
  }

  async hset(key: string, arg1: string | Record<string, string | number>, arg2?: string | number): Promise<number> {
    return this.withLock(async (store) => {
      let hash = store.data[key];
      if (hash === undefined) {
        hash = {};
        store.data[key] = hash;
      }
      if (Array.isArray(hash) || typeof hash !== 'object') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

      let count = 0;
      if (typeof arg1 === 'string') {
        const field = arg1;
        const value = String(arg2);
        if (!(field in hash)) count = 1;
        hash[field] = value;
      } else {
        for (const [field, value] of Object.entries(arg1)) {
          if (!(field in hash)) count++;
          hash[field] = String(value);
        }
      }
      return { result: count, modified: true };
    });
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.withLock(async (store) => {
      const hash = store.data[key];
      if (hash === undefined) return { result: null, modified: false };
      if (Array.isArray(hash) || typeof hash !== 'object') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

      const val = hash[field];
      return { result: val !== undefined ? val : null, modified: false };
    });
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.withLock(async (store) => {
      const hash = store.data[key];
      if (hash === undefined) return { result: {}, modified: false };
      if (Array.isArray(hash) || typeof hash !== 'object') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

      return { result: { ...hash }, modified: false };
    });
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    return this.withLock(async (store) => {
      let hash = store.data[key];
      if (hash === undefined) {
        hash = {};
        store.data[key] = hash;
      }
      if (Array.isArray(hash) || typeof hash !== 'object') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

      const current = hash[field];
      const val = current ? parseInt(current, 10) : 0;
      if (isNaN(val)) throw new Error('hash value is not an integer');

      const newVal = val + increment;
      hash[field] = String(newVal);

      return { result: newVal, modified: true };
    });
  }

  async incr(key: string): Promise<number> {
    return this.withLock(async (store) => {
      const current = store.data[key];
      if (current !== undefined && typeof current !== 'string') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

      const val = current ? parseInt(current, 10) : 0;
      if (isNaN(val)) throw new Error('value is not an integer');

      const newVal = val + 1;
      store.data[key] = String(newVal);

      return { result: newVal, modified: true };
    });
  }

  async disconnect(): Promise<void> {
    // No persistent connection to close
    return Promise.resolve();
  }
}
