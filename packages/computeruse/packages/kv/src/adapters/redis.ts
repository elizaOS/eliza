import Redis from 'ioredis';
import { KVClient, SetOptions, KVConfig } from '../types';

export class RedisKV implements KVClient {
  private client: Redis;

  constructor(config: KVConfig) {
    if (config.url) {
      this.client = new Redis(config.url);
    } else {
      // Default to localhost:6379 if no URL provided, standard ioredis behavior
      this.client = new Redis();
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string | number, options?: SetOptions): Promise<string | null> {
    if (options) {
      if (options.ex && options.nx) {
        return this.client.set(key, value, 'EX', options.ex, 'NX');
      }
      if (options.ex && options.xx) {
        return this.client.set(key, value, 'EX', options.ex, 'XX');
      }
      if (options.ex) {
        return this.client.set(key, value, 'EX', options.ex);
      }
      if (options.nx) {
        return this.client.set(key, value, 'NX');
      }
      if (options.xx) {
        return this.client.set(key, value, 'XX');
      }
    }
    return this.client.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  async lpush(key: string, ...elements: (string | number)[]): Promise<number> {
    return this.client.lpush(key, ...elements);
  }

  async rpush(key: string, ...elements: (string | number)[]): Promise<number> {
    return this.client.rpush(key, ...elements);
  }

  async lpop(key: string): Promise<string | null> {
    return this.client.lpop(key);
  }

  async rpop(key: string): Promise<string | null> {
    return this.client.rpop(key);
  }

  async hset(key: string, arg1: string | Record<string, string | number>, arg2?: string | number): Promise<number> {
    if (typeof arg1 === 'string') {
      // arg2 is value
      return this.client.hset(key, arg1, arg2 as string | number);
    } else {
      // arg1 is object
      return this.client.hset(key, arg1);
    }
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    return this.client.hincrby(key, field, increment);
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}
