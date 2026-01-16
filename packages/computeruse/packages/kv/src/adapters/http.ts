import { KVClient, SetOptions, KVConfig } from '../types';

/**
 * HTTP-based KV client that proxies requests through a web API.
 * Used to avoid exposing Redis credentials on VMs and desktop apps.
 *
 * URL format: http://your-webapp.com/api/kv or https://...
 *
 * Authentication:
 * - Pass token in config: createClient({ url: '...', token: input.ORG_TOKEN })
 * - Or set ORG_TOKEN environment variable (fallback)
 */
export class HttpKV implements KVClient {
  private baseUrl: string;
  private token: string;

  constructor(config: KVConfig) {
    if (!config.url) {
      throw new Error('[KV] HTTP adapter requires a URL');
    }

    // Remove trailing slash if present
    this.baseUrl = config.url.replace(/\/$/, '');

    // Get auth token from config or environment
    // Priority: config.token > ORG_TOKEN env var
    this.token = config.token || process.env.ORG_TOKEN || '';
    if (!this.token) {
      throw new Error('[KV] HTTP adapter requires token (pass in config or set ORG_TOKEN env var)');
    }
  }

  private async request<T>(body: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
      throw new Error(`[KV] HTTP error ${response.status}: ${error.error || 'Unknown error'}`);
    }

    const data = await response.json() as { result: T };
    return data.result;
  }

  async get(key: string): Promise<string | null> {
    return this.request<string | null>({ action: 'get', key });
  }

  async set(key: string, value: string | number, options?: SetOptions): Promise<string | null> {
    return this.request<string | null>({ action: 'set', key, value, options });
  }

  async del(key: string): Promise<number> {
    return this.request<number>({ action: 'del', key });
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.request<number>({ action: 'expire', key, seconds });
  }

  async lpush(key: string, ...elements: (string | number)[]): Promise<number> {
    return this.request<number>({ action: 'lpush', key, elements });
  }

  async rpush(key: string, ...elements: (string | number)[]): Promise<number> {
    return this.request<number>({ action: 'rpush', key, elements });
  }

  async lpop(key: string): Promise<string | null> {
    return this.request<string | null>({ action: 'lpop', key });
  }

  async rpop(key: string): Promise<string | null> {
    return this.request<string | null>({ action: 'rpop', key });
  }

  async hset(key: string, arg1: string | Record<string, string | number>, arg2?: string | number): Promise<number> {
    if (typeof arg1 === 'string') {
      return this.request<number>({ action: 'hset', key, field: arg1, value: arg2 });
    } else {
      return this.request<number>({ action: 'hset', key, fields: arg1 });
    }
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.request<string | null>({ action: 'hget', key, field });
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.request<Record<string, string>>({ action: 'hgetall', key });
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    return this.request<number>({ action: 'hincrby', key, field, increment });
  }

  async incr(key: string): Promise<number> {
    return this.request<number>({ action: 'incr', key });
  }

  async disconnect(): Promise<void> {
    // No persistent connection to close for HTTP
  }
}
