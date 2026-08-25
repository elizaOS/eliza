/** Provides native and in-memory Redis adapters for webhook routing state. */
import { createRequire } from "node:module";
import {
  ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT,
  ACTIVATION_ROUTING_UPSTASH_READ_ONLY_SCRIPT,
  type ActivationRoutingSnapshotKeys,
  type ActivationRoutingSnapshotReader,
} from "@elizaos/cloud-services-common";
import { Redis as UpstashRedis } from "@upstash/redis";
import IORedis from "ioredis";
import { logger } from "./logger";

const requireCJS = createRequire(import.meta.url);

type RedisMockConstructor<T> = new () => T;
type RedisMockModule<T> =
  | RedisMockConstructor<T>
  | { default?: RedisMockConstructor<T> };

function resolveRedisMockConstructor<T>(
  mod: RedisMockModule<T>,
): RedisMockConstructor<T> {
  if (typeof mod === "function") return mod;
  if (mod.default) return mod.default;
  throw new TypeError("ioredis-mock did not export a Redis constructor");
}

interface SetOptions {
  ex?: number;
  nx?: boolean;
}

function parseRedisValue<T>(value: string | null): T | null {
  if (value === null) return null;

  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

export interface GatewayRedis {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: string, options?: SetOptions): Promise<unknown>;
  del(key: string): Promise<unknown>;
  lpush(key: string, value: string): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  quit?(): Promise<unknown>;
}

/** Redis boundary required by managed activation routing consumers. */
export interface GatewayRoutingRedis
  extends GatewayRedis,
    ActivationRoutingSnapshotReader {
  readAgentServerRoutingValue(key: string): Promise<unknown>;
}

type NativeRedisClient = Pick<
  IORedis,
  "get" | "set" | "del" | "lpush" | "ltrim" | "expire" | "eval_ro" | "quit"
>;

type UpstashRedisClient = Pick<
  UpstashRedis,
  "get" | "set" | "del" | "lpush" | "ltrim" | "expire" | "evalRo"
> & {
  quit?(): Promise<unknown>;
};

export class NativeRedisAdapter implements GatewayRoutingRedis {
  constructor(private readonly client: NativeRedisClient) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    return parseRedisValue<T>(await this.client.get(key));
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

  async del(key: string): Promise<unknown> {
    return this.client.del(key);
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

  async readActivationRoutingSnapshot(
    keys: ActivationRoutingSnapshotKeys,
  ): Promise<unknown> {
    return this.client.eval_ro(
      ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT,
      3,
      ...keys,
    );
  }

  async readAgentServerRoutingValue(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async quit(): Promise<unknown> {
    return this.client.quit();
  }
}

export class UpstashRedisAdapter implements GatewayRoutingRedis {
  constructor(private readonly client: UpstashRedisClient) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    return parseRedisValue<T>(await this.client.get<string>(key));
  }

  async set(
    key: string,
    value: string,
    options: SetOptions = {},
  ): Promise<unknown> {
    if (options.ex && options.nx) {
      return this.client.set(key, value, { ex: options.ex, nx: true });
    }
    if (options.ex) {
      return this.client.set(key, value, { ex: options.ex });
    }
    if (options.nx) {
      return this.client.set(key, value, { nx: true });
    }
    return this.client.set(key, value);
  }

  async del(key: string): Promise<unknown> {
    return this.client.del(key);
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

  async readActivationRoutingSnapshot(
    keys: ActivationRoutingSnapshotKeys,
  ): Promise<unknown> {
    return this.client.evalRo(
      ACTIVATION_ROUTING_UPSTASH_READ_ONLY_SCRIPT,
      [...keys],
      [],
    );
  }

  async readAgentServerRoutingValue(key: string): Promise<string | null> {
    return this.client.get<string>(key);
  }

  async quit(): Promise<unknown> {
    return this.client.quit?.();
  }
}

class MemoryRedisAdapter implements GatewayRoutingRedis {
  private readonly client: IORedis;

  constructor() {
    // ioredis-mock implements the same surface as ioredis with an in-memory
    // backend. We type it as IORedis to reuse the native adapter shape.
    const mod = requireCJS("ioredis-mock") as RedisMockModule<IORedis>;
    const RedisMockCtor = resolveRedisMockConstructor(mod);
    this.client = new RedisMockCtor();
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return parseRedisValue<T>(await this.client.get(key));
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

  async del(key: string): Promise<unknown> {
    return this.client.del(key);
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

  async readActivationRoutingSnapshot(
    keys: ActivationRoutingSnapshotKeys,
  ): Promise<unknown> {
    // ioredis-mock does not implement EVAL_RO. This adapter is selected only by
    // MOCK_REDIS=1, so execute the same portable read-only script with EVAL.
    return this.client.eval(
      ACTIVATION_ROUTING_REDIS_EVAL_RO_SCRIPT,
      3,
      ...keys,
    );
  }

  async readAgentServerRoutingValue(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async quit(): Promise<unknown> {
    return this.client.quit();
  }
}

export function createRedis(): GatewayRoutingRedis {
  if (process.env.MOCK_REDIS === "1") {
    logger.info("[GatewayRedis] using in-memory mock adapter");
    return new MemoryRedisAdapter();
  }

  const kvRestApiUrl = process.env.KV_REST_API_URL;
  const kvRestApiToken = process.env.KV_REST_API_TOKEN;

  if (kvRestApiUrl && kvRestApiToken) {
    logger.info("Using Upstash Redis REST client");
    return new UpstashRedisAdapter(
      new UpstashRedis({
        url: kvRestApiUrl,
        token: kvRestApiToken,
        automaticDeserialization: false,
      }),
    );
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
