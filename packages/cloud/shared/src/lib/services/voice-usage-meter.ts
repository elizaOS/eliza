import { createHash } from "node:crypto";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import {
  buildRedisClient,
  type EvalCapableRedis,
  type RedisFactoryEnv,
  supportsRedisEval,
} from "../cache/redis-factory";
import { getCloudBinding } from "../runtime/cloud-bindings";

const DAY_MS = 86_400_000;
const COUNTER_SCALE = 1_000_000;

import {
  assertPositiveFinite,
  resolveDay,
  type VoiceUsageDecision,
  type VoiceUsageIdentity,
  type VoiceUsageLimits,
  type VoiceUsageStore,
  validateUsageInput,
} from "@elizaos/host/voice/usage";

export {
  type ByteRateDecision,
  checkVoiceByteRate,
  InMemoryVoiceUsageStore,
  pcmDurationMinutes,
  type VoiceUsageDecision,
  type VoiceUsageIdentity,
  type VoiceUsageLimits,
  type VoiceUsageStore,
} from "@elizaos/host/voice/usage";
export interface AtomicVoiceUsageRedis extends EvalCapableRedis {}

const RELEASE_LUA = `
for _, key in ipairs(KEYS) do
  local current = tonumber(redis.call('GET', key) or '0')
  redis.call('SET', key, math.max(0, current - tonumber(ARGV[1])), 'EX', ARGV[2])
end
return 1
`;

const CHECK_AND_RECORD_LUA = `
local org = tonumber(redis.call('GET', KEYS[1]) or '0')
local usr = tonumber(redis.call('GET', KEYS[2]) or '0')
local requested = tonumber(ARGV[1])
local org_limit = tonumber(ARGV[2])
local user_limit = tonumber(ARGV[3])
if org + requested > org_limit then return {0, 1, org, usr} end
if usr + requested > user_limit then return {0, 2, org, usr} end
org = redis.call('INCRBY', KEYS[1], requested)
usr = redis.call('INCRBY', KEYS[2], requested)
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return {1, 0, org, usr}
`;

export class VoiceUsageStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceUsageStateError";
  }
}

function voiceUsageOwner(orgKey: string): string {
  return `voice-v1:${createHash("sha256").update(orgKey).digest("hex")}`;
}

/** Retains the exact quota arithmetic while replacing the atomic transport. */
class CloudflareVoiceUsageTransport implements AtomicVoiceUsageRedis {
  constructor(private readonly namespace: RuntimeDurableObjectNamespace) {}
  async eval(script: string, keys: string[], args: Array<string | number>): Promise<unknown> {
    const operation =
      script === CHECK_AND_RECORD_LUA ? "reserve" : script === RELEASE_LUA ? "release" : null;
    if (!operation || keys.length !== 2)
      throw new VoiceUsageStateError("Unsupported voice usage operation");
    const response = await this.namespace
      .getByName(voiceUsageOwner(keys[0]))
      .fetch("https://voice-usage.internal/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, keys, args }),
      });
    if (!response.ok)
      throw new VoiceUsageStateError(`Voice usage state failed (${response.status})`);
    const value: unknown = await response.json();
    if (operation === "release" && value !== 1)
      throw new VoiceUsageStateError("Invalid voice release receipt");
    return value;
  }
}

/** Private operator transfer; no public API route exposes it. */
export async function importCloudflareVoiceUsage(
  namespace: RuntimeDurableObjectNamespace,
  orgKey: string,
  entries: Array<{ key: string; value: number; expiresAt: number }>,
  sourceQuiesced: true,
): Promise<void> {
  const response = await namespace
    .getByName(voiceUsageOwner(orgKey))
    .fetch("https://voice-usage.internal/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "import", orgKey, entries, sourceQuiesced }),
    });
  if (!response.ok)
    throw new VoiceUsageStateError(`Voice usage import rejected (${response.status})`);
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("imported" in result) ||
    result.imported !== entries.length
  )
    throw new VoiceUsageStateError("Invalid voice usage import receipt");
}

/** Durable, cross-isolate quota accounting through one atomic Redis script. */
export class RedisVoiceUsageStore implements VoiceUsageStore {
  constructor(
    private readonly redis: AtomicVoiceUsageRedis,
    private readonly now: () => number = Date.now,
  ) {}

  async checkAndRecord(
    identity: VoiceUsageIdentity,
    requestedMinutes: number,
    limits: VoiceUsageLimits,
  ): Promise<VoiceUsageDecision> {
    validateUsageInput(identity, requestedMinutes, limits);
    const now = this.now();
    const { dayNumber, day } = resolveDay(now);
    const requested = Math.max(1, Math.ceil(requestedMinutes * COUNTER_SCALE));
    const orgLimit = Math.floor(limits.organizationDailyMinutes * COUNTER_SCALE);
    const userLimit = Math.floor(limits.userDailyMinutes * COUNTER_SCALE);
    const ttlSeconds = Math.ceil((dayNumber * DAY_MS + DAY_MS - now) / 1_000) + 86_400;
    const prefix = `voice-usage:${day}`;
    const raw = await this.redis.eval(
      CHECK_AND_RECORD_LUA,
      [
        `${prefix}:org:${identity.organizationId}`,
        `${prefix}:user:${identity.organizationId}:${identity.userId}`,
      ],
      [requested, orgLimit, userLimit, ttlSeconds],
    );
    if (!Array.isArray(raw) || raw.length !== 4) {
      throw new Error("Voice usage store returned an invalid response");
    }
    const [allowed, deniedScope, orgRaw, userRaw] = raw.map(Number);
    if (
      ![allowed, deniedScope, orgRaw, userRaw].every(Number.isFinite) ||
      (allowed !== 0 && allowed !== 1) ||
      (allowed === 1 && deniedScope !== 0) ||
      (allowed === 0 && deniedScope !== 1 && deniedScope !== 2) ||
      orgRaw < 0 ||
      userRaw < 0
    ) {
      throw new Error("Voice usage store returned an invalid response");
    }
    const orgUsed = orgRaw / COUNTER_SCALE;
    const userUsed = userRaw / COUNTER_SCALE;
    if (allowed === 1) {
      return {
        allowed: true,
        organizationUsedMinutes: orgUsed,
        userUsedMinutes: userUsed,
        day,
      };
    }
    const scope = deniedScope === 1 ? "organization" : "user";
    return {
      allowed: false,
      scope,
      limitMinutes:
        scope === "organization" ? limits.organizationDailyMinutes : limits.userDailyMinutes,
      usedMinutes: scope === "organization" ? orgUsed : userUsed,
      requestedMinutes,
      day,
    };
  }

  async release(identity: VoiceUsageIdentity, minutes: number): Promise<void> {
    assertPositiveFinite("minutes", minutes);
    const now = this.now();
    const { dayNumber, day } = resolveDay(now);
    const ttlSeconds = Math.ceil((dayNumber * DAY_MS + DAY_MS - now) / 1_000) + 86_400;
    const prefix = `voice-usage:${day}`;
    await this.redis.eval(
      RELEASE_LUA,
      [
        `${prefix}:org:${identity.organizationId}`,
        `${prefix}:user:${identity.organizationId}:${identity.userId}`,
      ],
      [Math.max(1, Math.ceil(minutes * COUNTER_SCALE)), ttlSeconds],
    );
  }
}

export function createDurableVoiceUsageStore(
  env: RedisFactoryEnv & {
    CLOUD_VOICE_USAGE_BACKEND?: string;
    VOICE_USAGE_STATE?: RuntimeDurableObjectNamespace;
  },
  now?: () => number,
): RedisVoiceUsageStore | null {
  const backend = env.CLOUD_VOICE_USAGE_BACKEND ?? "redis";
  if (backend !== "redis") {
    if (backend !== "cloudflare")
      throw new VoiceUsageStateError("Invalid CLOUD_VOICE_USAGE_BACKEND");
    const binding =
      env.VOICE_USAGE_STATE ?? getCloudBinding<RuntimeDurableObjectNamespace>("VOICE_USAGE_STATE");
    if (!binding) throw new VoiceUsageStateError("VOICE_USAGE_STATE binding is required");
    return new RedisVoiceUsageStore(new CloudflareVoiceUsageTransport(binding), now);
  }
  // The repository mock intentionally implements only common Redis commands,
  // not Lua. Local/tests use the isolate-safe in-memory store instead.
  if (env.MOCK_REDIS === "1") return null;
  const redis = buildRedisClient(env);
  return redis && supportsRedisEval(redis) ? new RedisVoiceUsageStore(redis, now) : null;
}
