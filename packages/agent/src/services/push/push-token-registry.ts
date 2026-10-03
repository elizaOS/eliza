/** Durable push-token registry. Mutations reload and compare-and-set the
 * canonical cache row so overlapping host generations cannot lose revocations.
 */

import { ElizaError, type IAgentRuntime, logger } from "@elizaos/core";

/** Mobile push transport a token belongs to. */
export type PushPlatform = "ios" | "android";

/** A single registered device push token. */
export interface PushTokenRecord {
  /** The raw device token (APNs hex token or FCM registration token). */
  token: string;
  /** Which transport delivers to this token. */
  platform: PushPlatform;
  /** Unix ms when first registered (refreshed on re-registration). */
  createdAt: number;
}

/** Stable cache key the registry persists under (scoped per agent). */
const cacheKeyFor = (agentId: string): string => `push-tokens:${agentId}`;

/**
 * Hard cap on distinct tokens stored per agent (the live cap). A device
 * re-register is an upsert; unique tokens are unbounded on origin and
 * `persist()` writes the entire Map to the durable runtime cache. Oldest
 * `createdAt` is evicted first.
 */
export const MAX_PUSH_TOKENS_PER_AGENT = 64;

/**
 * Hard cap on a single token, measured in UTF-8 BYTES (not char length, so a
 * multi-byte token cannot smuggle past a char check). The HTTP body reader
 * already stops at 8 KiB; this keeps a direct `register()` caller from planting
 * a huge Map key and a huge cache row.
 */
export const MAX_PUSH_TOKEN_BYTES = 4096;

/**
 * Persisted-record ceiling: the largest stored array the registry will even
 * traverse. A cache row longer than this (hostile or corrupt) is rejected
 * fail-closed WITHOUT filtering/copying/sorting it, bounding worst-case
 * hydration work to a single `Array.isArray`/`length` check. The ceiling sits
 * far above any legitimate dump (16x the live cap) so real dirty-but-bounded
 * legacy data is repaired rather than discarded.
 */
export const MAX_PERSISTED_PUSH_TOKENS = MAX_PUSH_TOKENS_PER_AGENT * 16;

/** Stable `ElizaError.code` for a rejected token (empty or over the byte cap). */
export const PUSH_TOKEN_INVALID_CODE = "PUSH_TOKEN_INVALID";
/** Stable `ElizaError.code` for a durable-write failure during a mutation. */
export const PUSH_TOKEN_PERSIST_FAILED_CODE = "PUSH_TOKEN_PERSIST_FAILED";

/**
 * True when `error` is a token-validation failure the caller should translate
 * to a client error (HTTP 400), as opposed to a genuine persistence failure
 * (HTTP 500). Never inspects or exposes the offending token.
 */
export function isPushTokenValidationError(error: unknown): boolean {
  return error instanceof ElizaError && error.code === PUSH_TOKEN_INVALID_CODE;
}

/** UTF-8 byte length of `value` without allocating an intermediate Buffer view. */
function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Validate and canonicalize a token for a mutation. Returns the trimmed token
 * or throws a typed {@link PUSH_TOKEN_INVALID_CODE} error. Accepts `unknown` so
 * a non-string runtime value from untyped/plugin callers becomes the typed
 * invalid error instead of leaking a raw `token.trim` TypeError. The error
 * context records only the byte length or received type, never the token.
 */
function assertValidToken(token: unknown): string {
  if (typeof token !== "string") {
    throw new ElizaError("[PushTokenRegistry] token must be a string", {
      code: PUSH_TOKEN_INVALID_CODE,
      context: { reason: "not_a_string", received: typeof token },
      severity: "ephemeral",
    });
  }
  const trimmed = token.trim();
  if (!trimmed) {
    throw new ElizaError("[PushTokenRegistry] token is required", {
      code: PUSH_TOKEN_INVALID_CODE,
      context: { reason: "empty" },
      severity: "ephemeral",
    });
  }
  const byteLength = utf8ByteLength(trimmed);
  if (byteLength > MAX_PUSH_TOKEN_BYTES) {
    throw new ElizaError("[PushTokenRegistry] token exceeds the byte cap", {
      code: PUSH_TOKEN_INVALID_CODE,
      context: { reason: "too_large", byteLength, limit: MAX_PUSH_TOKEN_BYTES },
      severity: "ephemeral",
    });
  }
  return trimmed;
}

/**
 * Validate a platform at the persistence boundary. Direct `register()` callers
 * in untyped/plugin code can pass an unsupported value (e.g. "web"); this
 * rejects it with a typed {@link PUSH_TOKEN_INVALID_CODE} error before it
 * reaches the durable cache, rather than persisting an arbitrary runtime string.
 */
function assertValidPlatform(platform: unknown): PushPlatform {
  if (platform !== "ios" && platform !== "android") {
    throw new ElizaError("[PushTokenRegistry] unsupported platform", {
      code: PUSH_TOKEN_INVALID_CODE,
      context: { reason: "unsupported_platform" },
      severity: "ephemeral",
    });
  }
  return platform;
}

export class PushTokenRegistry {
  constructor(private readonly runtime: IAgentRuntime) {}

  private get cacheKey(): string {
    return cacheKeyFor(String(this.runtime.agentId));
  }

  async hydrate(): Promise<void> {
    await this.list();
  }

  private async mutate<T>(
    change: (tokens: Map<string, PushTokenRecord>) => T,
  ): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const stored = await this.runtime.getCache<unknown>(this.cacheKey);
      const { records } = normalizePersistedTokens(stored);
      const candidate = new Map(
        records.map((record) => [record.token, record]),
      );
      const result = change(candidate);
      try {
        if (
          await this.runtime.compareAndSetCache(this.cacheKey, stored, [
            ...candidate.values(),
          ])
        )
          return result;
      } catch (cause) {
        // error-policy:J2 preserve the registry's public persistence error.
        throw new ElizaError("Failed to persist push-token mutation", {
          code: PUSH_TOKEN_PERSIST_FAILED_CODE,
          cause,
          context: { tokenCount: candidate.size },
        });
      }
    }
    throw new ElizaError("Push-token updates repeatedly conflicted", {
      code: "PUSH_TOKEN_CONFLICT_EXHAUSTED",
    });
  }

  /** Validate and durably register a device token. */
  async register(platform: PushPlatform, token: string): Promise<void> {
    const validPlatform = assertValidPlatform(platform);
    const trimmed = assertValidToken(token);
    await this.mutate((candidate) => {
      candidate.set(trimmed, {
        token: trimmed,
        platform: validPlatform,
        createdAt: Date.now(),
      });
      evictOldestPushTokens(candidate);
    });
  }

  /**
   * Unregister a device token. Returns true if it existed. Applies the same
   * token validation as {@link register}, and is atomic w.r.t. persistence.
   */
  async unregister(token: string): Promise<boolean> {
    const trimmed = assertValidToken(token);
    return this.mutate((candidate) => candidate.delete(trimmed));
  }

  /** List every registered token record. */
  async list(): Promise<PushTokenRecord[]> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const stored = await this.runtime.getCache<unknown>(this.cacheKey);
      const { records, repaired } = normalizePersistedTokens(stored);
      if (!repaired) return records;
      try {
        if (
          await this.runtime.compareAndSetCache(this.cacheKey, stored, records)
        )
          return records;
      } catch (error) {
        // error-policy:J7 legacy normalization remains best effort on reads.
        this.runtime.reportError("push.registry.repair", error, {
          tokenCount: records.length,
        });
        return records;
      }
    }
    throw new ElizaError("Push-token repair repeatedly conflicted", {
      code: "PUSH_TOKEN_CONFLICT_EXHAUSTED",
    });
  }

  /** List token records for one platform. */
  async listByPlatform(platform: PushPlatform): Promise<PushTokenRecord[]> {
    return (await this.list()).filter((r) => r.platform === platform);
  }

  /** Total number of registered tokens. */
  async count(): Promise<number> {
    return (await this.list()).length;
  }
}

/**
 * Normalize a raw cache value into the registry's canonical records and report
 * whether the stored form differed (so the caller can durably repair once).
 *
 * Order matters and is load-bearing:
 *   1. Reject non-arrays and over-ceiling arrays WITHOUT traversal.
 *   2. Validate each record and keep the NEWEST per token (dedup-before-cap).
 *   3. Apply the live cap to the deduped set.
 */
function normalizePersistedTokens(stored: unknown): {
  records: PushTokenRecord[];
  repaired: boolean;
} {
  if (!Array.isArray(stored)) {
    return { records: [], repaired: false };
  }
  // Bound BEFORE any filter/copy/sort. A hostile/corrupt oversized dump fails
  // closed to empty; we deliberately do NOT rewrite it here (a later mutation
  // overwrites it with a bounded array), so a transient never destroys a large
  // legitimate row.
  if (stored.length > MAX_PERSISTED_PUSH_TOKENS) {
    logger.warn(
      `[PushTokenRegistry] persisted token array exceeds ceiling (${stored.length} > ${MAX_PERSISTED_PUSH_TOKENS}); failing closed`,
    );
    return { records: [], repaired: false };
  }

  const newestByToken = new Map<string, PushTokenRecord>();
  for (const value of stored) {
    const record = parsePushTokenRecord(value);
    if (!record) continue;
    const existing = newestByToken.get(record.token);
    if (!existing || record.createdAt > existing.createdAt) {
      newestByToken.set(record.token, record);
    }
  }

  let unique = [...newestByToken.values()];
  if (unique.length > MAX_PUSH_TOKENS_PER_AGENT) {
    unique = unique
      .sort((left, right) => {
        const leftTime = Number.isFinite(left.createdAt) ? left.createdAt : 0;
        const rightTime = Number.isFinite(right.createdAt)
          ? right.createdAt
          : 0;
        return rightTime - leftTime;
      })
      .slice(0, MAX_PUSH_TOKENS_PER_AGENT);
  }

  return {
    records: unique,
    repaired: !isCanonicalPersistedArray(stored, unique),
  };
}

/**
 * True when `stored` is already exactly the canonical persisted form of
 * `canonical` (same length, same order, and each element is a plain object with
 * exactly the three canonical fields equal to the normalized values). Used to
 * suppress a repair write on an already-clean load.
 */
function isCanonicalPersistedArray(
  stored: unknown[],
  canonical: PushTokenRecord[],
): boolean {
  if (stored.length !== canonical.length) return false;
  for (let i = 0; i < stored.length; i++) {
    const raw = stored[i];
    if (typeof raw !== "object" || raw === null) return false;
    const record = raw as Record<string, unknown>;
    if (Object.keys(record).length !== 3) return false;
    const expected = canonical[i];
    if (
      record.token !== expected.token ||
      record.platform !== expected.platform ||
      record.createdAt !== expected.createdAt
    ) {
      return false;
    }
  }
  return true;
}

function evictOldestPushTokens(tokens: Map<string, PushTokenRecord>): void {
  while (tokens.size > MAX_PUSH_TOKENS_PER_AGENT) {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, record] of tokens) {
      if (record.createdAt < oldestAt) {
        oldestAt = record.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) {
      break;
    }
    tokens.delete(oldestKey);
  }
}

/**
 * Validate an untrusted persisted value and return a canonical record, or null
 * if it fails any boundary check. The returned record is a fresh plain object
 * with a trimmed token so the durable repair writes a clean shape (extra fields
 * stripped). Mirrors the mutation-path checks in {@link assertValidToken} plus
 * the platform and timestamp constraints.
 */
function parsePushTokenRecord(value: unknown): PushTokenRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  if (typeof record.token !== "string") return null;
  const token = record.token.trim();
  if (!token) return null;
  if (utf8ByteLength(token) > MAX_PUSH_TOKEN_BYTES) return null;

  if (record.platform !== "ios" && record.platform !== "android") return null;

  const createdAt = record.createdAt;
  if (
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  ) {
    return null;
  }

  return { token, platform: record.platform, createdAt };
}
