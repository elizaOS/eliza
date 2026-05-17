import { createRequire } from "node:module";
import { Redis as UpstashRedis } from "@upstash/redis";
import IORedis from "ioredis";
import { logger } from "./logger";

const requireCJS = createRequire(import.meta.url);

interface SetOptions {
  ex?: number;
  nx?: boolean;
}

export interface GatewayRedis {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: string, options?: SetOptions): Promise<unknown>;
  lpush(key: string, value: string): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  quit?(): Promise<unknown>;
}

class NativeRedisAdapter implements GatewayRedis {
  constructor(private readonly client: IORedis) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (value === null) return null;

    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set(
    key: string,
    value: string,
    options: SetOptions = {},
  ): Promise<unknown> {
    if (options.ex && options.nx) {
      return this.client.set(key, value, "EX", options.ex, "NX");
    }
    if (options.ex) {
      return this.client.set(key, value, "EX", options.ex);
    }
    if (options.nx) {
      return this.client.set(key, value, "NX");
    }
    return this.client.set(key, value);
  }

  async lpush(key: string, value: string): Promise<unknown> {
    return this.client.lpush(key, value);
  }

  async ltrim(key: string, start: number, stop: number): Promise<unknown> {
    return this.client.ltrim(key, start, stop);
  }

  async expire(key: string, seconds: number): Promise<unknown> {
    return this.client.expire(key, seconds);
  }

  async quit(): Promise<unknown> {
    return this.client.quit();
  }
}

class MemoryRedisAdapter implements GatewayRedis {
  private readonly client: IORedis;

  constructor() {
    // ioredis-mock implements the same surface as ioredis with an in-memory
    // backend. We type it as IORedis to reuse the native adapter shape.
    // biome-ignore lint/suspicious/noExplicitAny: dynamic ESM/CJS interop with ioredis-mock
    const mod = requireCJS("ioredis-mock") as any;
    const RedisMockCtor = mod?.default ?? mod;
    this.client = new RedisMockCtor() as IORedis;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (value === null) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set(
    key: string,
    value: string,
    options: SetOptions = {},
  ): Promise<unknown> {
    if (options.ex && options.nx) {
      return this.client.set(key, value, "EX", options.ex, "NX");
    }
    if (options.ex) {
      return this.client.set(key, value, "EX", options.ex);
    }
    if (options.nx) {
      return this.client.set(key, value, "NX");
    }
    return this.client.set(key, value);
  }

  async lpush(key: string, value: string): Promise<unknown> {
    return this.client.lpush(key, value);
  }

  async ltrim(key: string, start: number, stop: number): Promise<unknown> {
    return this.client.ltrim(key, start, stop);
  }

  async expire(key: string, seconds: number): Promise<unknown> {
    return this.client.expire(key, seconds);
  }

  async quit(): Promise<unknown> {
    return this.client.quit();
  }
}

export function createRedis(): GatewayRedis {
  if (process.env.MOCK_REDIS === "1") {
    logger.info("[GatewayRedis] using in-memory mock adapter");
    return new MemoryRedisAdapter();
  }

  const kvRestApiUrl = process.env.KV_REST_API_URL;
  const kvRestApiToken = process.env.KV_REST_API_TOKEN;

  if (kvRestApiUrl && kvRestApiToken) {
    logger.info("Using Upstash Redis REST client");
    return new UpstashRedis({
      url: kvRestApiUrl,
      token: kvRestApiToken,
    }) as GatewayRedis;
  }

  if (process.env.REDIS_URL) {
    logger.info("Using native Redis client");
    return new NativeRedisAdapter(new IORedis(process.env.REDIS_URL));
  }

  logger.warn(
    "Redis is not configured; set REDIS_URL or KV_REST_API_URL/KV_REST_API_TOKEN",
  );
  throw new Error("Redis configuration is required");
}
