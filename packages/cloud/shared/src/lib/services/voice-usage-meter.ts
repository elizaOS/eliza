import { buildRedisClient, type RedisFactoryEnv } from "../cache/redis-factory";

const DAY_MS = 86_400_000;
const COUNTER_SCALE = 1_000_000;

export type VoiceUsageIdentity = {
  organizationId: string;
  userId: string;
};

export type VoiceUsageLimits = {
  organizationDailyMinutes: number;
  userDailyMinutes: number;
};

export type VoiceUsageDecision =
  | {
      allowed: true;
      organizationUsedMinutes: number;
      userUsedMinutes: number;
      day: string;
    }
  | {
      allowed: false;
      scope: "organization" | "user";
      limitMinutes: number;
      usedMinutes: number;
      requestedMinutes: number;
      day: string;
    };

export interface VoiceUsageStore {
  checkAndRecord(
    identity: VoiceUsageIdentity,
    requestedMinutes: number,
    limits: VoiceUsageLimits,
  ): Promise<VoiceUsageDecision>;
  release(identity: VoiceUsageIdentity, minutes: number): Promise<void>;
}

type Counter = { dayNumber: number; minutes: number };

/** Atomic within one JS isolate, intended for tests and local development. */
export class InMemoryVoiceUsageStore implements VoiceUsageStore {
  private readonly counters = new Map<string, Counter>();
  private operations = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async checkAndRecord(
    identity: VoiceUsageIdentity,
    requestedMinutes: number,
    limits: VoiceUsageLimits,
  ): Promise<VoiceUsageDecision> {
    validateUsageInput(identity, requestedMinutes, limits);
    const { dayNumber, day } = resolveDay(this.now());
    const orgKey = `org:${identity.organizationId}`;
    const userKey = `user:${identity.organizationId}:${identity.userId}`;
    const orgUsed = this.current(orgKey, dayNumber);
    const userUsed = this.current(userKey, dayNumber);

    const denied = quotaDenial(orgUsed, userUsed, requestedMinutes, limits, day);
    if (denied) return denied;

    const organizationUsedMinutes = orgUsed + requestedMinutes;
    const userUsedMinutes = userUsed + requestedMinutes;
    this.counters.set(orgKey, { dayNumber, minutes: organizationUsedMinutes });
    this.counters.set(userKey, { dayNumber, minutes: userUsedMinutes });
    if (++this.operations % 256 === 0) this.prune(dayNumber);
    return { allowed: true, organizationUsedMinutes, userUsedMinutes, day };
  }

  async release(identity: VoiceUsageIdentity, minutes: number): Promise<void> {
    assertPositiveFinite("minutes", minutes);
    const { dayNumber } = resolveDay(this.now());
    for (const key of [
      `org:${identity.organizationId}`,
      `user:${identity.organizationId}:${identity.userId}`,
    ]) {
      const counter = this.counters.get(key);
      if (counter?.dayNumber === dayNumber) {
        counter.minutes = Math.max(0, counter.minutes - minutes);
      }
    }
  }

  clear(): void {
    this.counters.clear();
    this.operations = 0;
  }

  private current(key: string, dayNumber: number): number {
    const counter = this.counters.get(key);
    return counter?.dayNumber === dayNumber ? counter.minutes : 0;
  }

  private prune(dayNumber: number): void {
    for (const [key, counter] of this.counters) {
      if (counter.dayNumber !== dayNumber) this.counters.delete(key);
    }
  }
}

export interface AtomicVoiceUsageRedis {
  eval(script: string, keys: string[], args: Array<string | number>): Promise<unknown>;
}

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
    if (!Array.isArray(raw) || raw.length < 4) {
      throw new Error("Voice usage store returned an invalid response");
    }
    const [allowed, deniedScope, orgRaw, userRaw] = raw.map(Number);
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
  return redis ? new RedisVoiceUsageStore(redis as AtomicVoiceUsageRedis, now) : null;
}

export type ByteRateDecision = {
  allowed: boolean;
  observedBytes: number;
  allowedBytes: number;
  byteRate: number;
};

/** Server-observed byte ceiling. The grace window permits normal frame jitter. */
export function checkVoiceByteRate(input: {
  observedBytes: number;
  elapsedMs: number;
  maxBytesPerSecond: number;
  graceMs?: number;
}): ByteRateDecision {
  const { observedBytes, elapsedMs, maxBytesPerSecond } = input;
  const graceMs = input.graceMs ?? 1_000;
  if (![observedBytes, elapsedMs, maxBytesPerSecond, graceMs].every(Number.isFinite)) {
    throw new TypeError("byte-rate values must be finite");
  }
  if (observedBytes < 0 || elapsedMs < 0 || maxBytesPerSecond <= 0 || graceMs < 0) {
    throw new RangeError("byte-rate values are out of range");
  }
  const allowedBytes = Math.floor(maxBytesPerSecond * ((elapsedMs + graceMs) / 1_000));
  return {
    allowed: observedBytes <= allowedBytes,
    observedBytes,
    allowedBytes,
    byteRate: elapsedMs > 0 ? observedBytes / (elapsedMs / 1_000) : observedBytes,
  };
}

/** Derives PCM duration from bytes observed by the server, never client claims. */
export function pcmDurationMinutes(input: {
  byteLength: number;
  sampleRate: number;
  channels: number;
  bytesPerSample: number;
}): number {
  const { byteLength, sampleRate, channels, bytesPerSample } = input;
  if (![byteLength, sampleRate, channels, bytesPerSample].every(Number.isFinite)) {
    throw new TypeError("audio format values must be finite");
  }
  if (byteLength < 0 || sampleRate <= 0 || channels <= 0 || bytesPerSample <= 0) {
    throw new RangeError("audio format values are out of range");
  }
  return byteLength / (sampleRate * channels * bytesPerSample * 60);
}

function resolveDay(now: number): { dayNumber: number; day: string } {
  const dayNumber = Math.floor(now / DAY_MS);
  return {
    dayNumber,
    day: new Date(dayNumber * DAY_MS).toISOString().slice(0, 10),
  };
}

function quotaDenial(
  orgUsed: number,
  userUsed: number,
  requestedMinutes: number,
  limits: VoiceUsageLimits,
  day: string,
): VoiceUsageDecision | null {
  if (orgUsed + requestedMinutes > limits.organizationDailyMinutes) {
    return {
      allowed: false,
      scope: "organization",
      limitMinutes: limits.organizationDailyMinutes,
      usedMinutes: orgUsed,
      requestedMinutes,
      day,
    };
  }
  if (userUsed + requestedMinutes > limits.userDailyMinutes) {
    return {
      allowed: false,
      scope: "user",
      limitMinutes: limits.userDailyMinutes,
      usedMinutes: userUsed,
      requestedMinutes,
      day,
    };
  }
  return null;
}

function validateUsageInput(
  identity: VoiceUsageIdentity,
  requestedMinutes: number,
  limits: VoiceUsageLimits,
): void {
  assertPositiveFinite("requestedMinutes", requestedMinutes);
  assertPositiveFinite("organizationDailyMinutes", limits.organizationDailyMinutes);
  assertPositiveFinite("userDailyMinutes", limits.userDailyMinutes);
  if (!identity.organizationId || !identity.userId) {
    throw new TypeError("organizationId and userId are required");
  }
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be positive and finite`);
  }
}
