import { createHash } from "node:crypto";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { getCloudBinding } from "../runtime/cloud-bindings";
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

export class HfEgressStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HfEgressStateError";
  }
}
function owner(organizationId: string, month: string): string {
  if (!organizationId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new HfEgressStateError("Invalid quota identity");
  return `hf-v1:${createHash("sha256")
    .update(JSON.stringify([organizationId, month]))
    .digest("hex")}`;
}
async function callState(
  namespace: RuntimeDurableObjectNamespace,
  organizationId: string,
  month: string,
  input: object,
): Promise<unknown> {
  const response = await namespace
    .getByName(owner(organizationId, month))
    .fetch("https://hf-egress.internal/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  if (!response.ok)
    throw new HfEgressStateError(
      `Hugging Face quota state rejected operation (${response.status})`,
    );
  return response.json();
}
class CloudflareHfEgressQuotaStore implements HfProxyEgressQuotaStore {
  constructor(private readonly namespace: RuntimeDurableObjectNamespace) {}
  private async update(
    organizationId: string,
    month: string,
    operation: "reserve" | "release",
    bytes: number,
    limitBytes?: number,
  ): Promise<HfProxyEgressDecision> {
    assertQuotaInput(bytes, limitBytes);
    const result = await callState(this.namespace, organizationId, month, {
      operation,
      bytes,
      limitBytes,
    });
    if (
      !result ||
      typeof result !== "object" ||
      !("allowed" in result) ||
      typeof result.allowed !== "boolean" ||
      !("usedBytes" in result) ||
      typeof result.usedBytes !== "number" ||
      !Number.isSafeInteger(result.usedBytes) ||
      result.usedBytes < 0
    )
      throw new HfEgressStateError("Invalid quota receipt");
    return { allowed: result.allowed, usedBytes: result.usedBytes };
  }
  reserve(
    organizationId: string,
    month: string,
    bytes: number,
    limitBytes: number,
  ): Promise<HfProxyEgressDecision> {
    return this.update(organizationId, month, "reserve", bytes, limitBytes);
  }
  async release(organizationId: string, month: string, bytes: number): Promise<void> {
    const result = await this.update(organizationId, month, "release", bytes);
    if (!result.allowed) throw new HfEgressStateError("Quota release was not acknowledged");
  }
}
/** Private binding transfer before activation; never exposed by a public route. */
export async function importCloudflareHfEgress(
  namespace: RuntimeDurableObjectNamespace,
  organizationId: string,
  month: string,
  usedBytes: number,
  expiresAt: number,
  sourceQuiesced: true,
): Promise<void> {
  const result = await callState(namespace, organizationId, month, {
    operation: "import",
    usedBytes,
    expiresAt,
    sourceQuiesced,
  });
  if (!result || typeof result !== "object" || !("imported" in result) || result.imported !== true)
    throw new HfEgressStateError("Invalid quota import receipt");
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
  env: RedisFactoryEnv & {
    CLOUD_HF_EGRESS_BACKEND?: string;
    HF_EGRESS_STATE?: RuntimeDurableObjectNamespace;
  },
): HfProxyEgressQuotaStore | null {
  const backend = env.CLOUD_HF_EGRESS_BACKEND ?? "redis";
  if (backend !== "redis") {
    if (backend !== "cloudflare") throw new HfEgressStateError("Invalid CLOUD_HF_EGRESS_BACKEND");
    const binding =
      env.HF_EGRESS_STATE ?? getCloudBinding<RuntimeDurableObjectNamespace>("HF_EGRESS_STATE");
    if (!binding) throw new HfEgressStateError("HF_EGRESS_STATE binding is required");
    return new CloudflareHfEgressQuotaStore(binding);
  }
  const redis = buildRedisClient(env);
  if (redis && supportsRedisEval(redis)) {
    return new RedisHfProxyEgressQuotaStore(redis);
  }
  if (env.MOCK_REDIS === "1" || !isCloudflareWorkerRuntime()) return localStore;
  return null;
}
