/**
 * PushTokenRegistry
 *
 * A small, persistent registry of device push tokens. Each registered device
 * stores `{ token, platform, createdAt }`. The registry is keyed by token so a
 * re-registration of the same token is an idempotent upsert (it refreshes
 * `createdAt`).
 *
 * Persistence rides on the DB-backed runtime cache (`runtime.getCache` /
 * `runtime.compareAndSetCache`) under a single stable key, mirroring the
 * persistence pattern in `@elizaos/core`'s `NotificationService`. A cold/headless
 * runtime with no cache adapter starts empty and degrades to in-memory only.
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
 *      restarts do not repeatedly re-scan and re-normalize the same dump. The
 *      repair write must resolve exactly `true`; a rejected OR resolved-`false`
 *      write is reported (best-effort, never failing the read) and the dirty
 *      row is left intact so a later restart retries the repair.
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
 * single process (promise-tail queue) and — since the migration to
 * `compareAndSetCache` — durable writes are also conflict-safe ACROSS
 * processes: each mutation CAS-es against the last-known raw durable value
 * and re-applies the pure op to the reloaded base on conflict, so a retiring
 * container generation writing during a blue/green overlap cannot silently
 * drop the new generation's tokens (and vice versa).
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
  /**
   * Canonical owner entity id this device belongs to (#23106). Absent on
   * legacy records — a token without an owner NEVER matches a recipient-bound
   * push (fail-closed): it can be listed/unregistered, but no notification is
   * ever pushed to it until the device re-registers with a principal.
   */
  ownerEntityId?: string;
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
 * Stable `ElizaError.code` for a mutation whose CAS kept conflicting past the
 * bounded retry budget (a concurrent writer is persistently racing us).
 */
export const PUSH_TOKEN_CONFLICT_EXHAUSTED_CODE =
  "PUSH_TOKEN_CONFLICT_EXHAUSTED";

/**
 * Bounded compare-and-set retry budget for one registry mutation. Each retry
 * re-applies the same pure op to the reloaded durable base, so this only
 * bounds the loop against an adversarial writer that conflicts on EVERY
 * attempt — a normal blue/green overlap resolves on the first or second try.
 */
const MAX_CAS_ATTEMPTS = 8;

/**
 * The durable persistence envelope for the registry row. `version` is a
 * monotonic integer bumped on every accepted write, so two racing writers can
 * never produce the same row twice (the duplicated-version lost-update the
 * cross-process CAS exists to prevent); `tokens` is the canonical record
 * array. Legacy rows (a bare array from before the envelope) are read as
 * `version 0` content and rewritten in envelope form by the first CAS write.
 */
interface PersistedPushTokenEnvelope {
  version: number;
  tokens: PushTokenRecord[];
}

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

/**
 * Canonicalize an optional owner entity id (#23106): a trimmed non-empty
 * string, or undefined when absent/blank. Byte-capped like the token so a
 * hostile caller cannot plant an oversized identifier in a cache row.
 */
function normalizeOwnerEntityId(ownerEntityId: unknown): string | undefined {
  if (typeof ownerEntityId !== "string") return undefined;
  const trimmed = ownerEntityId.trim();
  if (!trimmed) return undefined;
  if (utf8ByteLength(trimmed) > MAX_PUSH_TOKEN_BYTES) {
    throw new ElizaError(
      "[PushTokenRegistry] ownerEntityId exceeds the byte cap",
      {
        code: PUSH_TOKEN_INVALID_CODE,
        context: { reason: "owner_too_large" },
        severity: "ephemeral",
      },
    );
  }
  return trimmed;
}

/**
 * Non-throwing form for HYDRATION only: a persisted row's owner field that
 * fails validation (wrong type, oversized) degrades to unowned — the record
 * stays valid and listable, and delivery to it fails closed. Contrast with
 * {@link normalizeOwnerEntityId}, which gates live mutations and must reject.
 */
function parsePersistedOwnerEntityId(
  ownerEntityId: unknown,
): string | undefined {
  if (typeof ownerEntityId !== "string") return undefined;
  const trimmed = ownerEntityId.trim();
  if (!trimmed) return undefined;
  if (utf8ByteLength(trimmed) > MAX_PUSH_TOKEN_BYTES) return undefined;
  return trimmed;
}

export class PushTokenRegistry {
  private tokens = new Map<string, PushTokenRecord>();
  private hydrated = false;
  private hydrationPromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  /**
   * The raw durable value this instance last observed or wrote — NEVER the
   * normalized form of a dirty row. CAS compares against this exact snapshot,
   * so a still-dirty stored row conflicts correctly instead of wedging, and a
   * `undefined` baseline makes the first write insert-only-if-absent.
   */
  private persistedBaseline: unknown = undefined;
  /**
   * Envelope version of {@link persistedBaseline} (`0` for legacy bare-array
   * rows and absent rows). CAS conditions on the FULL baseline snapshot (which
   * includes the version), and the replacement bumps the version — this field
   * exists so repair/mutation can compute the next envelope without re-parsing.
   */
  private persistedVersion = 0;

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
    const { records, version } = parsePersistedRow(stored);
    const repaired =
      stored !== undefined &&
      !isOverCeilingRow(stored) &&
      !isCanonicalPersistedRow(stored, records, version);
    this.tokens = new Map(records.map((record) => [record.token, record]));
    this.persistedBaseline = stored;
    this.persistedVersion = version;
    this.hydrated = true;
    if (repaired) {
      // Durable one-time repair: rewrite the normalized (validated, deduped,
      // capped) envelope so later restarts do not re-scan the same dirty dump.
      // The repair is itself a CAS against the raw dirty baseline, so a
      // concurrent writer that moves the row first CONFLICTS the repair
      // instead of being silently overwritten (the exact blue/green race the
      // CAS primitive exists for). Best-effort: a failed/conflicted repair
      // only means we re-normalize next start; it must not fail the read path.
      try {
        await this.repairPersistedRow();
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

  /**
   * Rewrite the durable row in canonical envelope form via compare-and-set
   * against the baseline `loadPersistedTokens` observed (repair path only —
   * every mutation goes through {@link commit}). On conflict the repair is
   * skipped (a fresher writer owns the row; the next hydrate re-normalizes).
   */
  private async repairPersistedRow(): Promise<void> {
    // Safe-integer ceiling guard, computed from the RAW baseline like
    // commit()'s: an envelope at the ceiling parses as version 0 (the shape
    // guard rejects it), so repairing on the parsed version would rewrite the
    // row as {version: 1, tokens: []} — destroying the stored tokens. Refuse
    // the bump; the read path already served the normalized in-memory view.
    const rawVersion = rawEnvelopeVersion(this.persistedBaseline);
    if (
      this.persistedVersion >= Number.MAX_SAFE_INTEGER - 1 ||
      rawVersion >= Number.MAX_SAFE_INTEGER - 1
    ) {
      throw new ElizaError(
        "[PushTokenRegistry] envelope version exhausted the safe-integer range",
        {
          code: PUSH_TOKEN_PERSIST_FAILED_CODE,
          context: { reason: "version_exhausted" },
          severity: "ephemeral",
        },
      );
    }
    const written: PersistedPushTokenEnvelope = {
      version: this.persistedVersion + 1,
      tokens: [...this.tokens.values()],
    };
    const landed = await this.runtime.compareAndSetCache(
      this.cacheKey,
      this.persistedBaseline,
      written,
    );
    if (!landed) {
      // A concurrent writer moved the row first — leave the baseline on the
      // durable truth; the next hydrate re-normalizes whatever landed.
      return;
    }
    this.persistedBaseline = written;
    this.persistedVersion = written.version;
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
   * Apply one pure mutation `op` to the durable registry via compare-and-set
   * on the versioned persistence envelope.
   *
   * Each attempt CAS-es the FULL next envelope
   * (`{ version: baseVersion + 1, tokens: op(base) }`) against the raw durable
   * baseline (`persistedBaseline` — `undefined` before the first durable row
   * exists, which makes that write insert-only-if-absent). Conditioning on
   * the whole snapshot (which carries the monotonic version) means a writer
   * that moved the row — including one that only bumped the version — cannot
   * be overwritten: every accepted write carries a strictly larger version,
   * so a duplicated-version lost update is structurally impossible.
   *
   * On conflict (`false`) the freshest raw value is reloaded and the SAME op
   * re-applied to it — `register` (set token → evict oldest) and `unregister`
   * (delete-if-present) are pure functions of the base, so retries converge
   * without a mutation queue. The in-process {@link enqueueMutation} tail
   * still orders ops within one process; the CAS closes the cross-process
   * window (two container generations sharing the durable cache during a
   * managed blue/green upgrade) that the previous unconditional `setCache`
   * could not.
   *
   * Observable-atomicity invariant #5 is preserved: `this.tokens` and the
   * baseline are reassigned ONLY after a `true` result, so `list`/`count`
   * never observe an uncommitted candidate. A CAS rejection is a typed
   * persistence failure; a `false` after {@link MAX_CAS_ATTEMPTS} bounded
   * retries throws {@link PUSH_TOKEN_CONFLICT_EXHAUSTED_CODE} rather than
   * looping forever against a writer that keeps racing us.
   *
   * @returns the op's answer computed against the base it was finally applied
   * to (e.g. `unregister` reports presence w.r.t. the freshest durable state).
   */
  private async commit<T>(
    op: (base: Map<string, PushTokenRecord>) => {
      next: Map<string, PushTokenRecord>;
      result: T;
      /** Set to `false` when the op changed nothing and NO write is due; omit it (or set `true`) when the write should proceed. */
      write?: boolean;
    },
  ): Promise<T> {
    let baseline = this.persistedBaseline;
    let baseVersion = this.persistedVersion;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const parsed = parsePersistedRow(baseline);
      const base = new Map(
        parsed.records.map((record) => [record.token, record]),
      );
      baseVersion = parsed.version;
      // Same safe-integer ceiling guard as repairPersistedRow, computed from
      // the RAW baseline: an envelope whose version is AT or ONE BELOW the
      // ceiling parses to a bumpable base (the shape guard rejects only
      // versions >= MAX), so persisting version + 1 would write MAX itself —
      // a row this module's own parser then fails closed on (and refuses to
      // repair), freezing the registry empty. Refuse the bump one tick early.
      if (
        rawEnvelopeVersion(baseline) >= Number.MAX_SAFE_INTEGER - 1 ||
        baseVersion >= Number.MAX_SAFE_INTEGER - 1
      ) {
        throw new ElizaError(
          "[PushTokenRegistry] envelope version exhausted the safe-integer range",
          {
            code: PUSH_TOKEN_PERSIST_FAILED_CODE,
            context: { reason: "version_exhausted" },
            severity: "ephemeral",
          },
        );
      }
      const applied = op(base);
      const { next, result } = applied;
      // A no-op op (e.g. unregister of an absent token) must not create or
      // bump the durable row — answering from the current base is enough.
      if (applied.write === false) {
        this.tokens = next;
        return result;
      }
      const replacement: PersistedPushTokenEnvelope = {
        version: baseVersion + 1,
        tokens: [...next.values()],
      };
      let landed: boolean;
      try {
        landed = await this.runtime.compareAndSetCache(
          this.cacheKey,
          baseline,
          replacement,
        );
      } catch (error) {
        // error-policy:J2 context-adding rethrow — the candidate was never
        // published, the observable registry is unchanged, and the underlying
        // cause is preserved.
        throw new ElizaError(
          "[PushTokenRegistry] failed to persist push-token mutation",
          {
            code: PUSH_TOKEN_PERSIST_FAILED_CODE,
            cause: error,
            context: { tokenCount: replacement.tokens.length },
            severity: "ephemeral",
          },
        );
      }
      if (landed) {
        this.tokens = next;
        this.persistedBaseline = replacement;
        this.persistedVersion = replacement.version;
        return result;
      }
      // Conflict: another process moved the durable row. Reload the raw value
      // and re-apply the same pure op to the freshest base.
      baseline = await this.runtime.getCache<unknown>(this.cacheKey);
    }
    // error-policy:J2 context-adding rethrow — a persistently conflicting row
    // is a failure the caller must see; the observable registry stays on the
    // last committed state and the next mutation starts from a fresh hydrate.
    throw new ElizaError(
      "[PushTokenRegistry] push-token cache conflicted past the retry budget",
      {
        code: PUSH_TOKEN_CONFLICT_EXHAUSTED_CODE,
        context: { attempts: MAX_CAS_ATTEMPTS },
        severity: "ephemeral",
      },
    );
  }

  /**
   * Register (upsert) a device token. Re-registering an existing token under a
   * new platform moves it to that platform and refreshes `createdAt`. An
   * optional `ownerEntityId` binds the device to a canonical principal (#23106)
   * so pushes are recipient-bound; omitting it leaves the record unowned, and
   * unowned records never receive pushes (fail-closed at the delivery seam).
   *
   * Observably atomic w.r.t. persistence: the mutation is staged on a candidate
   * Map and published only after the durable write succeeds, so a rejected write
   * leaves the observable registry unchanged and a typed error is thrown.
   * `platform` is validated at this boundary so a direct/untyped caller cannot
   * persist an unsupported transport.
   */
  async register(
    platform: PushPlatform,
    token: string,
    ownerEntityId?: string,
  ): Promise<void> {
    const validPlatform = assertValidPlatform(platform);
    const trimmed = assertValidToken(token);
    const owner = normalizeOwnerEntityId(ownerEntityId);
    // createdAt is computed ONCE so every CAS retry applies the identical
    // mutation and eviction order is stable across attempts.
    const createdAt = Date.now();
    await this.enqueueMutation(async () => {
      await this.hydrate();
      await this.commit((base) => {
        const next = new Map(base);
        next.set(trimmed, {
          token: trimmed,
          platform: validPlatform,
          createdAt,
          ...(owner ? { ownerEntityId: owner } : {}),
        });
        evictOldestPushTokens(next);
        return { next, result: undefined };
      });
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
      return this.commit((base) => {
        if (!base.has(trimmed)) {
          // Absent on this base: answer w.r.t. this (possibly reloaded,
          // freshest-durable) state without attempting a write.
          return { next: base, result: false, write: false };
        }
        const next = new Map(base);
        next.delete(trimmed);
        return { next, result: true };
      });
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

  /**
   * List token records owned by one canonical principal (#23106). Unowned
   * legacy records never match — delivery to them fails closed.
   */
  async listByOwner(ownerEntityId: string): Promise<PushTokenRecord[]> {
    // Read path: a malformed/oversized query owner matches nothing (no throw —
    // delivery just fails closed to zero tokens).
    const owner = parsePersistedOwnerEntityId(ownerEntityId);
    if (owner === undefined) return [];
    await this.hydrate();
    return [...this.tokens.values()].filter(
      (r) => r.ownerEntityId !== undefined && r.ownerEntityId === owner,
    );
  }

  /** Total number of registered tokens. */
  async count(): Promise<number> {
    await this.hydrate();
    return this.tokens.size;
  }
}

/**
 * Parse a raw durable row into the registry's canonical records plus the
 * envelope version.
 *
 * Accepted forms:
 *   - the canonical envelope `{ version, tokens }`
 *   - a legacy bare array (pre-envelope row): read as `version 0`; the first
 *     CAS write rewrites it in envelope form.
 *   - absent/corrupt: empty records, `version 0` (fail-closed like before).
 *
 * Order matters and is load-bearing:
 *   1. Reject non-envelope/non-array shapes and over-ceiling arrays WITHOUT
 *      traversal.
 *   2. Validate each record and keep the NEWEST per token (dedup-before-cap).
 *   3. Apply the live cap to the deduped set.
 */
/**
 * True when `stored` is a row whose token array exceeds the persisted-record
 * ceiling — whether a legacy bare array or a valid envelope's `tokens`. Such a
 * row failed closed to empty and must NOT be rewritten by the repair path: the
 * repair would persist the empty normalized view, destroying the original
 * durable dump (a later mutation still overwrites it with a bounded envelope).
 */
function isOverCeilingRow(stored: unknown): boolean {
  if (Array.isArray(stored)) {
    return stored.length > MAX_PERSISTED_PUSH_TOKENS;
  }
  if (isEnvelopeShape(stored)) {
    return stored.tokens.length > MAX_PERSISTED_PUSH_TOKENS;
  }
  return false;
}

function parsePersistedRow(stored: unknown): {
  records: PushTokenRecord[];
  version: number;
} {
  if (Array.isArray(stored)) {
    return { records: normalizeLegacyTokenArray(stored), version: 0 };
  }
  if (isEnvelopeShape(stored)) {
    return {
      records: normalizeLegacyTokenArray(stored.tokens),
      version: stored.version,
    };
  }
  return { records: [], version: 0 };
}

/**
 * The `version` field of a RAW baseline when it structurally looks like an
 * envelope whose version is a safe non-negative integer, else `-1`. Unlike
 * {@link isEnvelopeShape}, versions AT `Number.MAX_SAFE_INTEGER` are still
 * reported — the ceiling guard needs to observe exactly that row.
 */
function rawEnvelopeVersion(stored: unknown): number {
  if (typeof stored !== "object" || stored === null) return -1;
  const record = stored as Record<string, unknown>;
  const version = record.version;
  if (
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= 0 &&
    Array.isArray(record.tokens)
  ) {
    return version;
  }
  return -1;
}

/** Structural guard for the envelope row (own keys exactly `version,tokens`). */
function isEnvelopeShape(
  value: unknown,
): value is { version: number; tokens: unknown[] } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const ownKeys = Object.keys(record);
  if (
    ownKeys.length !== 2 ||
    !ownKeys.includes("version") ||
    !ownKeys.includes("tokens")
  ) {
    return false;
  }
  return (
    typeof record.version === "number" &&
    Number.isSafeInteger(record.version) &&
    record.version >= 0 &&
    record.version < Number.MAX_SAFE_INTEGER &&
    Array.isArray(record.tokens)
  );
}

/**
 * Normalize a raw token array (envelope `tokens` or a legacy bare row) into
 * canonical records: bounded, validated, deduped (newest per token), capped.
 */
function normalizeLegacyTokenArray(stored: unknown[]): PushTokenRecord[] {
  // Bound BEFORE any filter/copy/sort. A hostile/corrupt oversized dump fails
  // closed to empty; we deliberately do NOT rewrite it here (a later mutation
  // overwrites it with a bounded envelope), so a transient never destroys a
  // large legitimate row.
  if (stored.length > MAX_PERSISTED_PUSH_TOKENS) {
    logger.warn(
      `[PushTokenRegistry] persisted token array exceeds ceiling (${stored.length} > ${MAX_PERSISTED_PUSH_TOKENS}); failing closed`,
    );
    return [];
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
  return unique;
}

/**
 * True when `stored` is already exactly the canonical persisted form of
 * `canonical` — the envelope shape carrying the same version and a tokens
 * array whose length and per-record fields match the normalized values (same
 * length, same order, plain objects with exactly the canonical fields). Used
 * to suppress a repair write on an already-clean load; a legacy bare array or
 * dirty envelope is NOT canonical and triggers the (CAS-guarded) repair.
 */
function isCanonicalPersistedRow(
  stored: unknown,
  canonical: PushTokenRecord[],
  version: number,
): boolean {
  if (!isEnvelopeShape(stored)) return false;
  if (stored.version !== version) return false;
  return isCanonicalPersistedArray(stored.tokens, canonical);
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
    // Canonical fields: the 3 legacy keys, plus an optional ownerEntityId
    // (#23106) that is present only when the canonical record carries one.
    const expected = canonical[i];
    const expectedKeyCount = expected.ownerEntityId ? 4 : 3;
    if (
      record.token !== expected.token ||
      record.platform !== expected.platform
    ) {
      return false;
    }
    if (record.createdAt !== expected.createdAt) return false;
    if ((record.ownerEntityId ?? undefined) !== expected.ownerEntityId) {
      return false;
    }
    if (Object.keys(record).length !== expectedKeyCount) return false;
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

  // #23106 optional owner: accepted only when it is a trimmed non-empty string
  // within the byte cap; anything else is dropped (the record stays valid but
  // unowned — delivery fails closed, listing keeps working).
  const ownerEntityId = parsePersistedOwnerEntityId(record.ownerEntityId);

  return {
    token,
    platform: record.platform,
    createdAt,
    ...(ownerEntityId ? { ownerEntityId } : {}),
  };
}
