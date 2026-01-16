import { KVClient, SetOptions } from '../types';

export class MemoryKV implements KVClient {
  private store = new Map<string, any>();
  private timeouts = new Map<string, NodeJS.Timeout>();

  async get(key: string): Promise<string | null> {
    const val = this.store.get(key);
    if (val === undefined) return null;
    if (typeof val !== 'string' && typeof val !== 'number') return null;
    return String(val);
  }

  async set(key: string, value: string | number, options?: SetOptions): Promise<string | null> {
    const exists = this.store.has(key);

    if (options?.nx && exists) return null;
    if (options?.xx && !exists) return null;

    this.clearTimeout(key);

    this.store.set(key, String(value));

    if (options?.ex) {
      this.setTimeout(key, options.ex);
    }

    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.clearTimeout(key);
    const deleted = this.store.delete(key);
    return deleted ? 1 : 0;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.store.has(key)) return 0;
    this.clearTimeout(key);
    this.setTimeout(key, seconds);
    return 1;
  }

  async lpush(key: string, ...elements: (string | number)[]): Promise<number> {
    let list = this.store.get(key);
    if (list === undefined) {
        list = [];
        this.store.set(key, list);
    }
    if (!Array.isArray(list)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

    const strings = elements.map(String);
    // lpush prepends
    list.unshift(...strings);
    return list.length;
  }

  async rpush(key: string, ...elements: (string | number)[]): Promise<number> {
    let list = this.store.get(key);
    if (list === undefined) {
        list = [];
        this.store.set(key, list);
    }
    if (!Array.isArray(list)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

    const strings = elements.map(String);
    list.push(...strings);
    return list.length;
  }

  async lpop(key: string): Promise<string | null> {
    const list = this.store.get(key);
    if (list === undefined) return null;
    if (!Array.isArray(list)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

    const val = list.shift();
    if (list.length === 0) this.store.delete(key);
    return val || null;
  }

  async rpop(key: string): Promise<string | null> {
    const list = this.store.get(key);
    if (list === undefined) return null;
    if (!Array.isArray(list)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

    const val = list.pop();
    if (list.length === 0) this.store.delete(key);
    return val || null;
  }

  async hset(key: string, arg1: string | Record<string, string | number>, arg2?: string | number): Promise<number> {
    let hash = this.store.get(key);
    if (hash === undefined) {
      hash = new Map<string, string>();
      this.store.set(key, hash);
    }
    if (!(hash instanceof Map)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

    let count = 0;
    if (typeof arg1 === 'string') {
      // hset(key, field, value)
      const field = arg1;
      const value = String(arg2);
      if (!hash.has(field)) count = 1;
      hash.set(field, value);
    } else {
      // hset(key, obj)
      for (const [field, value] of Object.entries(arg1)) {
         if (!hash.has(field)) count++;
         hash.set(field, String(value));
      }
    }
    return count;
  }

  async hget(key: string, field: string): Promise<string | null> {
    const hash = this.store.get(key);
    if (hash === undefined) return null;
    if (!(hash instanceof Map)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

    const val = hash.get(field);
    return val !== undefined ? val : null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.store.get(key);
    if (hash === undefined) return {};
    if (!(hash instanceof Map)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

    const result: Record<string, string> = {};
    for (const [k, v] of hash.entries()) {
      result[k] = v;
    }
    return result;
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    let hash = this.store.get(key);
    if (hash === undefined) {
      hash = new Map<string, string>();
      this.store.set(key, hash);
    }
    if (!(hash instanceof Map)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

    const current = hash.get(field);
    const val = current ? parseInt(current, 10) : 0;
    if (isNaN(val)) throw new Error('hash value is not an integer');

    const newVal = val + increment;
    hash.set(field, String(newVal));
    return newVal;
  }

  async incr(key: string): Promise<number> {
    const current = this.store.get(key);
    if (current !== undefined && typeof current !== 'string') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');

    const val = current ? parseInt(current, 10) : 0;
    if (isNaN(val)) throw new Error('value is not an integer');

    const newVal = val + 1;
    this.store.set(key, String(newVal));
    return newVal;
  }

  async disconnect(): Promise<void> {
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout);
    }
    this.timeouts.clear();
    this.store.clear();
  }

  private setTimeout(key: string, seconds: number) {
    const timeout = setTimeout(() => {
      this.store.delete(key);
      this.timeouts.delete(key);
    }, seconds * 1000);
    this.timeouts.set(key, timeout);
  }

  private clearTimeout(key: string) {
    const timeout = this.timeouts.get(key);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(key);
    }
  }
}
