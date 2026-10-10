import {
  buildRedisClient,
  type EvalCapableRedis,
  type RedisFactoryEnv,
  supportsRedisEval,
} from "../cache/redis-factory";

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
  env: RedisFactoryEnv,
  now?: () => number,
): RedisVoiceUsageStore | null {
  // The repository mock intentionally implements only common Redis commands,
  // not Lua. Local/tests use the isolate-safe in-memory store instead.
  if (env.MOCK_REDIS === "1") return null;
  const redis = buildRedisClient(env);
  return redis && supportsRedisEval(redis) ? new RedisVoiceUsageStore(redis, now) : null;
}
