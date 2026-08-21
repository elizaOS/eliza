/**
 * PushTokenRegistry
 *
 * A small, persistent registry of device push tokens. Each registered device
 * stores `{ token, platform, createdAt }`. The registry is keyed by token so a
 * re-registration of the same token is an idempotent upsert (it refreshes
 * `createdAt`).
 *
 * Persistence rides on the DB-backed runtime cache (`runtime.getCache` /
 * `runtime.setCache`) under a single stable key, mirroring the persistence
 * pattern in `@elizaos/core`'s `NotificationService`. A cold/headless runtime
 * with no cache adapter starts empty and degrades to in-memory only.
 *
 * Boundary invariants (a cache row is untrusted, possibly-hostile input):
 *   1. Hydration bounds work BEFORE traversing. A stored array larger than
 *      {@link MAX_PERSISTED_PUSH_TOKENS} is rejected without filter/copy/sort,
 *      so a hostile/oversized dump cannot force unbounded validation work.
 *   2. Every hydrated record is validated at the persistence boundary
 *      ({@link parsePushTokenRecord}): trimmed non-empty token, token within an
 *      explicit UTF-8 BYTE limit, supported platform, and a finite,
 *      non-negative, safe-integer timestamp. The same validator gates
 *      `register`/`unregister`, so byte/platform/timestamp checks are identical
 *      everywhere.
 *   3. Dedup happens BEFORE the live cap: the newest valid record per token is
 *      kept, then the {@link MAX_PUSH_TOKENS_PER_AGENT} cap is applied, so
 *      duplicate-heavy data cannot underfill the registry.
 *   4. When a bounded-but-dirty legacy dump is normalized, the repaired form is
 *      persisted once (guarded so a clean load never rewrites), so later
 *      restarts do not repeatedly re-scan and re-normalize the same dump.
 *   5. `register`/`unregister` are observably atomic w.r.t. `setCache`: the
 *      mutation is staged on a candidate Map that is published to `this.tokens`
 *      only after the durable write succeeds, so `list`/`count` never observe an
 *      uncommitted add/delete. A write that rejects OR resolves a non-`true`
 *      value (`setCache` returns `Promise<boolean>`; adapters resolve `false`
 *      when the row did not land) is treated as a failure that leaves the
 *      observable registry unchanged, and the same-process mutation queue keeps
 *      processing later operations after a failure (no wedge).
 *
 * Concurrency scope: mutations are serialized and failure-atomic WITHIN a
 * single process. Cross-process compare-and-swap is out of scope because the
 * runtime cache contract exposes no transactional CAS primitive; do not read
 * multi-process atomicity into this class.
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
  private tokens = new Map<string, PushTokenRecord>();
  private hydrated = false;
  private hydrationPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly runtime: IAgentRuntime) {}

  private get cacheKey(): string {
    return cacheKeyFor(String(this.runtime.agentId));
  }

  /** Load persisted tokens from the DB-backed cache. Idempotent. */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    if (!this.hydrationPromise) {
      this.hydrationPromise = this.loadPersistedTokens();
    }
    const hydrationPromise = this.hydrationPromise;
    try {
      await hydrationPromise;
    } catch (error) {
      if (this.hydrationPromise === hydrationPromise) {
        this.hydrationPromise = null;
      }
      throw error;
    }
  }

  private async loadPersistedTokens(): Promise<void> {
    const stored = await this.runtime.getCache<unknown>(this.cacheKey);
    const { records, repaired } = normalizePersistedTokens(stored);
    this.tokens = new Map(records.map((record) => [record.token, record]));
    this.hydrated = true;
    if (repaired) {
      // Durable one-time repair: rewrite the normalized (validated, deduped,
      // capped) form so later restarts do not re-scan the same dirty dump.
      // Best-effort: a failed repair write only means we re-normalize next
      // start; it must not fail the read path.
      try {
        await this.persist();
      } catch (error) {
        // error-policy:J7 diagnostics must not kill the loop — a failed
        // one-time repair write degrades to re-scanning on the next start.
        this.runtime.reportError("push.registry.repair", error, {
          tokenCount: this.tokens.size,
        });
        logger.warn(
          "[PushTokenRegistry] durable repair write failed; will re-normalize on next hydrate",
        );
      }
    }
  }

  private async persist(): Promise<void> {
    await this.runtime.setCache(this.cacheKey, [...this.tokens.values()]);
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const pending = this.mutationTail.then(mutation);
    // error-policy:J5 the caller observes `pending`; this recovery keeps one
    // failed persistence attempt from poisoning every later registry mutation.
    this.mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  /**
   * Persist `candidate` and, only after the durable write reports success,
   * publish it as the observable registry. Because `this.tokens` is reassigned
   * solely on a `true` result, `list`/`count` running while the write is pending
   * observe the still-committed prior state; a write that rejects OR resolves a
   * non-`true` value leaves the observable registry unchanged and throws a typed
   * error. Callers run this inside {@link enqueueMutation}, so the next queued
   * mutation still proceeds.
   */
  private async commit(candidate: Map<string, PushTokenRecord>): Promise<void> {
    let persisted: boolean;
    try {
      persisted = await this.runtime.setCache(this.cacheKey, [
        ...candidate.values(),
      ]);
    } catch (error) {
      // error-policy:J2 context-adding rethrow — surface a typed persistence
      // failure with a redacted count while preserving the underlying cause. The
      // candidate was never published, so the observable registry is unchanged.
      throw new ElizaError(
        "[PushTokenRegistry] failed to persist push-token mutation",
        {
          code: PUSH_TOKEN_PERSIST_FAILED_CODE,
          cause: error,
          context: { tokenCount: candidate.size },
          severity: "ephemeral",
        },
      );
    }
    if (persisted !== true) {
      // error-policy:J2 context-adding rethrow — `setCache` resolving a
      // non-`true` value is a durable-write failure (the SQL adapter propagates
      // `false` when the underlying write did not land). The candidate was never
      // published, so the observable registry stays on the committed state.
      throw new ElizaError(
        "[PushTokenRegistry] durable cache rejected the push-token mutation",
        {
          code: PUSH_TOKEN_PERSIST_FAILED_CODE,
          context: { tokenCount: candidate.size },
          severity: "ephemeral",
        },
      );
    }
    this.tokens = candidate;
  }

  /**
   * Register (upsert) a device token. Re-registering an existing token under a
   * new platform moves it to that platform and refreshes `createdAt`.
   *
   * Observably atomic w.r.t. persistence: the mutation is staged on a candidate
   * Map and published only after the durable write succeeds, so a rejected write
   * leaves the observable registry unchanged and a typed error is thrown.
   * `platform` is validated at this boundary so a direct/untyped caller cannot
   * persist an unsupported transport.
   */
  async register(platform: PushPlatform, token: string): Promise<void> {
    const validPlatform = assertValidPlatform(platform);
    const trimmed = assertValidToken(token);
    await this.enqueueMutation(async () => {
      await this.hydrate();
      const candidate = new Map(this.tokens);
      candidate.set(trimmed, {
        token: trimmed,
        platform: validPlatform,
        createdAt: Date.now(),
      });
      evictOldestPushTokens(candidate);
      await this.commit(candidate);
    });
  }

  /**
   * Unregister a device token. Returns true if it existed. Applies the same
   * token validation as {@link register}, and is atomic w.r.t. persistence.
   */
  async unregister(token: string): Promise<boolean> {
    const trimmed = assertValidToken(token);
    return this.enqueueMutation(async () => {
      await this.hydrate();
      if (!this.tokens.has(trimmed)) {
        return false;
      }
      const candidate = new Map(this.tokens);
      candidate.delete(trimmed);
      await this.commit(candidate);
      return true;
    });
  }

  /** List every registered token record. */
  async list(): Promise<PushTokenRecord[]> {
    await this.hydrate();
    return [...this.tokens.values()];
  }

  /** List token records for one platform. */
  async listByPlatform(platform: PushPlatform): Promise<PushTokenRecord[]> {
    await this.hydrate();
    return [...this.tokens.values()].filter((r) => r.platform === platform);
  }

  /** Total number of registered tokens. */
  async count(): Promise<number> {
    await this.hydrate();
    return this.tokens.size;
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
      .sort((left, right) => right.createdAt - left.createdAt)
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
