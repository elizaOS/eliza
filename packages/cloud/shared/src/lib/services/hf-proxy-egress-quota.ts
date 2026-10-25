/**
 * Atomically reserves monthly Hugging Face proxy egress before provider work.
 * Production uses one Redis script per reservation; the isolate-local store is
 * restricted to explicit mocks and non-Worker development.
 */

import {
  buildRedisClient,
  type EvalCapableRedis,
  isCloudflareWorkerRuntime,
  type RedisFactoryEnv,
  supportsRedisEval,
} from "../cache/redis-factory";

const MONTHLY_EGRESS_TTL_SECONDS = 35 * 24 * 60 * 60;

export type HfProxyEgressDecision =
  | { allowed: true; usedBytes: number }
  | { allowed: false; usedBytes: number };

export interface HfProxyEgressQuotaStore {
  reserve(
    organizationId: string,
    month: string,
    bytes: number,
    limitBytes: number,
  ): Promise<HfProxyEgressDecision>;
  release(organizationId: string, month: string, bytes: number): Promise<void>;
}

const RESERVE_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local requested = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if current + requested > limit then return {0, current} end
local next = redis.call('INCRBY', KEYS[1], requested)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {1, next}
`;

const RELEASE_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local next = math.max(0, current - tonumber(ARGV[1]))
redis.call('SET', KEYS[1], next, 'EX', ARGV[2])
return next
`;

function quotaKey(organizationId: string, month: string): string {
  return `hf-proxy:egress:${organizationId}:${month}`;
}

function assertQuotaInput(bytes: number, limitBytes?: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new RangeError("Hugging Face egress bytes must be a positive safe integer");
  }
  if (limitBytes !== undefined && (!Number.isSafeInteger(limitBytes) || limitBytes <= 0)) {
    throw new RangeError("Hugging Face egress limit must be a positive safe integer");
  }
}

export class RedisHfProxyEgressQuotaStore implements HfProxyEgressQuotaStore {
  constructor(private readonly redis: EvalCapableRedis) {}

  async reserve(
    organizationId: string,
    month: string,
    bytes: number,
    limitBytes: number,
  ): Promise<HfProxyEgressDecision> {
    assertQuotaInput(bytes, limitBytes);
    const raw = await this.redis.eval(
      RESERVE_LUA,
      [quotaKey(organizationId, month)],
      [bytes, limitBytes, MONTHLY_EGRESS_TTL_SECONDS],
    );
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error("Hugging Face egress quota returned an invalid response");
    }
    const allowed = Number(raw[0]);
    const usedBytes = Number(raw[1]);
    if ((allowed !== 0 && allowed !== 1) || !Number.isSafeInteger(usedBytes) || usedBytes < 0) {
      throw new Error("Hugging Face egress quota returned an invalid response");
    }
    return { allowed: allowed === 1, usedBytes };
  }

  async release(organizationId: string, month: string, bytes: number): Promise<void> {
    assertQuotaInput(bytes);
    await this.redis.eval(
      RELEASE_LUA,
      [quotaKey(organizationId, month)],
      [bytes, MONTHLY_EGRESS_TTL_SECONDS],
    );
  }
}

/** Atomic within one isolate, for deterministic tests and local development. */
export class InMemoryHfProxyEgressQuotaStore implements HfProxyEgressQuotaStore {
  private readonly counters = new Map<string, number>();

  async reserve(
    organizationId: string,
    month: string,
    bytes: number,
    limitBytes: number,
  ): Promise<HfProxyEgressDecision> {
    assertQuotaInput(bytes, limitBytes);
    const key = quotaKey(organizationId, month);
    const usedBytes = this.counters.get(key) ?? 0;
    if (usedBytes + bytes > limitBytes) return { allowed: false, usedBytes };
    const next = usedBytes + bytes;
    this.counters.set(key, next);
    return { allowed: true, usedBytes: next };
  }

  async release(organizationId: string, month: string, bytes: number): Promise<void> {
    assertQuotaInput(bytes);
    const key = quotaKey(organizationId, month);
    this.counters.set(key, Math.max(0, (this.counters.get(key) ?? 0) - bytes));
  }

  clear(): void {
    this.counters.clear();
  }
}

const localStore = new InMemoryHfProxyEgressQuotaStore();

export function resetHfProxyEgressQuotaForTests(): void {
  localStore.clear();
}

export function createHfProxyEgressQuotaStore(
  env: RedisFactoryEnv,
): HfProxyEgressQuotaStore | null {
  const redis = buildRedisClient(env);
  if (redis && supportsRedisEval(redis)) {
    return new RedisHfProxyEgressQuotaStore(redis);
  }
  if (env.MOCK_REDIS === "1" || !isCloudflareWorkerRuntime()) return localStore;
  return null;
}
