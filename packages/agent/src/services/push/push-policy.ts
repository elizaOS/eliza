/**
 * Per-principal push delivery policy (#23106): the inbox-before-push seam.
 *
 * A notification ALWAYS lands in the inbox first (NotificationService owns
 * that). Whether it may ALSO leave the process as a remote push (APNs/FCM) is
 * a per-principal policy decision made HERE, and the decision FAILS CLOSED:
 * no recipient, no policy, or a corrupt policy all mean "inbox-only" — never a
 * push. This is the deliberate privacy default of the maintainer disposition on
 * #23106 ("first require recipient and add an inbox-before-push policy seam;
 * scheduler owns digests").
 *
 * Boundary invariants:
 *   1. The decision is a pure function of the persisted policy record plus the
 *      notification — no ambient state, so it is deterministic and testable.
 *   2. A policy row is untrusted cache input: anything that is not the exact
 *      expected shape fails closed to {@link PUSH_DELIVERY_DENY} (inbox-only)
 *      and is reported for repair, never interpreted charitably.
 *   3. The policy is durable (runtime cache under a stable per-agent key) and
 *      keyed by the canonical recipient entity id, so two principals on one
 *      agent can hold different push policies without observing each other's.
 *
 * Digest ownership intentionally lives elsewhere: there is ONE clock (core
 * TaskService) and `plugin-scheduling` owns the scheduled-item state machine
 * (see root AGENTS.md "Scheduling and personal-assistant domains"). This seam
 * expresses no scheduling and creates no competing scheduler.
 */

import { type AgentNotification, ElizaError, logger } from "@elizaos/core";

/** Outcome of the inbox-before-push decision. */
export type PushDeliveryDecision =
  | { outcome: "allow"; policyVersion: number }
  | { outcome: "deny"; reason: PushDenyReason; policyVersion: number };

/** Why a push was denied (audit/debug vocabulary, never client-facing prose). */
export type PushDenyReason =
  | "no_recipient" // notification carries no canonical recipient — cannot address a principal
  | "no_policy" // fail-closed default: the principal never opted into push
  | "policy_denied" // an explicit policy says push off
  | "policy_corrupt"; // stored policy failed validation — treat as absent

/** The durable per-principal push policy record. */
export interface PushDeliveryPolicy {
  /** Whether remote push delivery is permitted at all. */
  pushEnabled: boolean;
  /** Monotonic policy version, bumped on every change. */
  version: number;
  /** Unix ms when the policy was last changed. */
  updatedAt: number;
}

/** The decision used when nothing better can be computed. */
export const PUSH_DELIVERY_DENY: PushDeliveryDecision = {
  outcome: "deny",
  reason: "no_policy",
  policyVersion: 0,
} as const;

/** Stable cache key for a principal's policy (scoped per agent). */
const policyCacheKeyFor = (agentId: string, recipientId: string): string =>
  `push-policy:${agentId}:${recipientId}`;

/** Stable `ElizaError.code` for a rejected durable push-policy write. */
export const PUSH_POLICY_PERSIST_FAILED_CODE = "PUSH_POLICY_PERSIST_FAILED";

/**
 * Stable `ElizaError.code` for a policy update whose compare-and-set kept
 * conflicting past the bounded retry budget (a concurrent writer is
 * persistently racing us, e.g. a stuck retiring container generation).
 */
export const PUSH_POLICY_CONFLICT_EXHAUSTED_CODE =
  "PUSH_POLICY_CONFLICT_EXHAUSTED";

/**
 * Bounded compare-and-set retry budget for one policy update. Each retry
 * re-applies the same advance to the reloaded durable base, so this only
 * bounds the loop against an adversarial writer that conflicts on EVERY
 * attempt — a normal blue/green overlap resolves on the first or second try.
 */
const PUSH_POLICY_MAX_CAS_ATTEMPTS = 8;

/** Cap on the stored policy record size guard (bytes, defensive). */
const MAX_POLICY_JSON_BYTES = 4096;

/**
 * Validate an untrusted stored policy value. Returns the canonical record or
 * null (fail-closed). Mirrors the boundary-validation discipline of
 * PushTokenRegistry: exact shape, no charitable interpretation.
 */
export function parsePushDeliveryPolicy(
  value: unknown,
): PushDeliveryPolicy | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  // EXACT shape: the row's own enumerable key set must be exactly the three
  // canonical names — extra keys fail closed, and inherited properties are not
  // substitutes: property reads below would accept prototype values, so the
  // key-set equality is what blocks inherited-policy injection via Object.create.
  const ownKeys = Object.keys(record);
  if (
    ownKeys.length !== 3 ||
    !ownKeys.includes("pushEnabled") ||
    !ownKeys.includes("version") ||
    !ownKeys.includes("updatedAt")
  ) {
    return null;
  }
  if (typeof record.pushEnabled !== "boolean") return null;
  if (
    typeof record.version !== "number" ||
    !Number.isSafeInteger(record.version) ||
    record.version < 0
  ) {
    return null;
  }
  if (
    typeof record.updatedAt !== "number" ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.updatedAt < 0
  ) {
    return null;
  }
  return {
    pushEnabled: record.pushEnabled,
    version: record.version,
    updatedAt: record.updatedAt,
  };
}

/**
 * The inbox-before-push decision for one notification addressed to one
 * principal. Pure: the caller supplies the (already-loaded) policy.
 *
 * Fail-closed matrix:
 *   - no recipient            → deny "no_recipient" (inbox-only)
 *   - policy absent           → deny "no_policy"    (inbox-only)
 *   - policy corrupt          → deny "policy_corrupt" (inbox-only)
 *   - policy.pushEnabled true → allow (version carried for audit)
 */
export function decidePushDelivery(
  notification: Pick<AgentNotification, "recipientId">,
  policy: PushDeliveryPolicy | null,
): PushDeliveryDecision {
  if (!notification.recipientId || notification.recipientId.length === 0) {
    return { outcome: "deny", reason: "no_recipient", policyVersion: 0 };
  }
  if (policy === null) {
    return { outcome: "deny", reason: "no_policy", policyVersion: 0 };
  }
  if (!policy.pushEnabled) {
    return {
      outcome: "deny",
      reason: "policy_denied",
      policyVersion: policy.version,
    };
  }
  return { outcome: "allow", policyVersion: policy.version };
}

/**
 * Durable store of per-principal push policies, riding the same runtime-cache
 * persistence pattern as PushTokenRegistry. One key per (agent, recipient).
 */
export class PushPolicyStore {
  /** Per-principal update tails serializing `update()` calls (see its doc). */
  private readonly updateTails = new Map<string, Promise<void>>();

  constructor(private readonly runtime: PushPolicyRuntime) {}

  private cacheKey(recipientId: string): string {
    return policyCacheKeyFor(String(this.runtime.agentId), recipientId);
  }

  /** Load a principal's policy, or null when absent/corrupt (fail-closed). */
  async load(recipientId: string): Promise<PushDeliveryPolicy | null> {
    const stored = await this.runtime.getCache<unknown>(
      this.cacheKey(recipientId),
    );
    const parsed = parsePushDeliveryPolicy(stored);
    if (stored !== undefined && stored !== null && parsed === null) {
      // Corrupt row: report once per load; the decision stays fail-closed.
      logger.warn(
        { src: "push-policy", recipientId },
        "[PushPolicyStore] corrupt policy row; failing closed to inbox-only",
      );
    }
    return parsed;
  }

  /**
   * Serialize a principal's policy advance — load, apply `pushEnabled`, bump
   * the version, durably save via compare-and-set — per principal, so two
   * concurrent enable/disable requests can never both observe the same base
   * version and silently overwrite an opt-out: each update CAS-es on the
   * observed (record, version) and persists a distinct monotonic version,
   * giving every accepted write an auditable position in the principal's
   * ordering. Returns the persisted record.
   *
   * Concurrency scope: same-principal writes are serialized and failure-atomic
   * WITHIN one process (the tail) AND across processes/containers — the
   * compare-and-set closes the blue/green upgrade window this store used to
   * carry as a known limitation: an in-flight write from the retiring
   * container now conflicts the new container's write instead of being
   * silently overwritten, and the loser reloads and retries.
   */
  update(
    recipientId: string,
    pushEnabled: boolean,
  ): Promise<PushDeliveryPolicy> {
    // Queue on the principal's own tail, not a shared one: unrelated principals
    // never delay each other. Keys are recipient ids; a settled tail is removed
    // below, so the map tracks in-flight work, not every principal seen.
    const previous = this.updateTails.get(recipientId) ?? Promise.resolve();
    const pending = previous.then(() =>
      this.bumpAndSave(recipientId, pushEnabled),
    );
    // error-policy:J5 the caller observes `pending`; this recovery keeps one
    // failed persistence attempt from poisoning every later policy update.
    const recovered = pending.then(
      () => undefined,
      () => undefined,
    );
    this.updateTails.set(recipientId, recovered);
    // Settle-cleanup: when this tail is still the END of the principal's queue
    // (no later update chained onto it), drop it so the map stays bounded by
    // active work. The identity check keeps a newer queued update's tail.
    void recovered.then(() => {
      if (this.updateTails.get(recipientId) === recovered) {
        this.updateTails.delete(recipientId);
      }
    });
    return pending;
  }

  /**
   * One serialized step: CAS-loop the policy advance against the durable row.
   * Each attempt re-loads the row inside the critical section (so it reflects
   * every earlier queued update AND the freshest cross-process writer),
   * applies the new setting with `version + 1`, and compare-and-sets the
   * full record. On conflict the loop reloads and re-applies — the version
   * bump makes a duplicated-version lost update structurally impossible.
   *
   * A corrupt row parses as absent per the fail-closed parse contract, so the
   * sequence restarts at version 1 rather than trusting an unreadable prior
   * version — but only when the CAS WINS the row (insert-if-absent via a
   * `null` base only when the row is truly absent); a corrupt row that is
   * still durable conflicts the write, so this store never overwrites an
   * unreadable row it cannot interpret. A row already at the safe integer
   * ceiling rejects the bump: persisting `version + 1` would store a record
   * this store's own parser fails closed on, so the write is refused instead
   * of planting a row every later load treats as corrupt.
   */
  private async bumpAndSave(
    recipientId: string,
    pushEnabled: boolean,
  ): Promise<PushDeliveryPolicy> {
    for (let attempt = 0; attempt < PUSH_POLICY_MAX_CAS_ATTEMPTS; attempt++) {
      const stored = await this.runtime.getCache<unknown>(
        this.cacheKey(recipientId),
      );
      const existing = parsePushDeliveryPolicy(stored);
      if (existing && existing.version >= Number.MAX_SAFE_INTEGER) {
        throw new ElizaError(
          "[PushPolicyStore] policy version exhausted the safe-integer range",
          {
            code: PUSH_POLICY_PERSIST_FAILED_CODE,
            context: {
              recipientId: recipientId.length,
              baseVersion: existing.version,
            },
            severity: "ephemeral",
          },
        );
      }
      // Corrupt-but-present rows are NOT treated as absent for writes: a
      // non-null stored value that fails to parse conflicts the CAS (the
      // caller/operator must repair it deliberately), preserving the
      // fail-closed parse contract on the write side too.
      const baseVersion = existing?.version ?? 0;
      const expected = stored === undefined ? undefined : stored;
      if (stored !== undefined && existing === null) {
        throw new ElizaError(
          "[PushPolicyStore] refusing to overwrite a corrupt policy row",
          {
            code: PUSH_POLICY_PERSIST_FAILED_CODE,
            context: {
              recipientLength: recipientId.length,
              reason: "corrupt_row",
            },
            severity: "ephemeral",
          },
        );
      }
      const next: PushDeliveryPolicy = {
        pushEnabled,
        version: baseVersion + 1,
        updatedAt: Date.now(),
      };
      const serialized = JSON.stringify(next);
      if (serialized.length > MAX_POLICY_JSON_BYTES) {
        throw new ElizaError(
          "[PushPolicyStore] policy record exceeds size cap",
          {
            code: PUSH_POLICY_PERSIST_FAILED_CODE,
            context: {
              byteLength: serialized.length,
              limit: MAX_POLICY_JSON_BYTES,
            },
            severity: "ephemeral",
          },
        );
      }
      let landed: boolean;
      try {
        landed = await this.runtime.compareAndSetCache(
          this.cacheKey(recipientId),
          expected,
          next,
        );
      } catch (error) {
        // error-policy:J2 context-adding rethrow — the candidate was never
        // published and the underlying cause is preserved.
        throw new ElizaError(
          "[PushPolicyStore] failed to persist push-policy update",
          {
            code: PUSH_POLICY_PERSIST_FAILED_CODE,
            cause: error,
            context: { recipientLength: recipientId.length },
            severity: "ephemeral",
          },
        );
      }
      if (landed) return next;
      // Conflict: another writer (possibly another container generation during
      // a blue/green upgrade) moved the row. Loop to reload the freshest base.
    }
    // error-policy:J2 context-adding rethrow — a persistently conflicting row
    // is a failure the caller must see.
    throw new ElizaError(
      "[PushPolicyStore] push-policy cache conflicted past the retry budget",
      {
        code: PUSH_POLICY_CONFLICT_EXHAUSTED_CODE,
        context: { attempts: PUSH_POLICY_MAX_CAS_ATTEMPTS },
        severity: "ephemeral",
      },
    );
  }

  /**
   * Persist a policy. Requires the durable write to resolve exactly `true`
   * (mirroring PushTokenRegistry.commit discipline); throws a typed error
   * otherwise so a caller can surface a real failure instead of a silent no-op.
   */
  async save(recipientId: string, policy: PushDeliveryPolicy): Promise<void> {
    const serialized = JSON.stringify(policy);
    if (serialized.length > MAX_POLICY_JSON_BYTES) {
      throw new ElizaError("[PushPolicyStore] policy record exceeds size cap", {
        code: PUSH_POLICY_PERSIST_FAILED_CODE,
        context: {
          byteLength: serialized.length,
          limit: MAX_POLICY_JSON_BYTES,
        },
        severity: "ephemeral",
      });
    }
    // Write the record through the same bounded CAS loop `update()` uses, so
    // the direct-save path is also conflict-safe across processes/containers.
    // On conflict the record's version is re-validated against the FRESHEST
    // base: a save may only land at a strictly greater version than anything
    // durably observed (monotonic-version discipline — no ABA, no regression
    // to a stale record), and a caller-supplied version at or below the
    // durable row is a typed rejection, never a silent overwrite.
    for (let attempt = 0; attempt < PUSH_POLICY_MAX_CAS_ATTEMPTS; attempt++) {
      const stored = await this.runtime.getCache<unknown>(
        this.cacheKey(recipientId),
      );
      // A corrupt-but-present row is never blindly overwritten (fail-closed
      // on the write side, mirroring bumpAndSave): the operator must repair
      // it deliberately.
      if (stored !== undefined && parsePushDeliveryPolicy(stored) === null) {
        throw new ElizaError(
          "[PushPolicyStore] refusing to overwrite a corrupt policy row",
          {
            code: PUSH_POLICY_PERSIST_FAILED_CODE,
            context: {
              recipientLength: recipientId.length,
              reason: "corrupt_row",
            },
            severity: "ephemeral",
          },
        );
      }
      const durable = parsePushDeliveryPolicy(stored);
      if (durable !== null && policy.version <= durable.version) {
        throw new ElizaError(
          "[PushPolicyStore] refusing a non-monotonic policy save",
          {
            code: PUSH_POLICY_PERSIST_FAILED_CODE,
            context: {
              recipientLength: recipientId.length,
              reason: "version_not_monotonic",
              durableVersion: durable.version,
              saveVersion: policy.version,
            },
            severity: "ephemeral",
          },
        );
      }
      let landed: boolean;
      try {
        landed = await this.runtime.compareAndSetCache(
          this.cacheKey(recipientId),
          stored,
          policy,
        );
      } catch (error) {
        // error-policy:J2 context-adding rethrow — the record was never
        // published and the underlying cause is preserved.
        throw new ElizaError(
          "[PushPolicyStore] failed to persist push-policy save",
          {
            code: PUSH_POLICY_PERSIST_FAILED_CODE,
            cause: error,
            context: { recipientLength: recipientId.length },
            severity: "ephemeral",
          },
        );
      }
      if (landed) return;
      // Conflict: another writer (possibly another container generation)
      // moved the row. Reload the freshest base and re-validate the version.
    }
    // error-policy:J2 context-adding rethrow — a persistently conflicting row
    // is a failure the caller must see, never a fabricated success.
    throw new ElizaError(
      "[PushPolicyStore] push-policy cache conflicted past the retry budget",
      {
        code: PUSH_POLICY_CONFLICT_EXHAUSTED_CODE,
        context: { attempts: PUSH_POLICY_MAX_CAS_ATTEMPTS },
        severity: "ephemeral",
      },
    );
  }
}

/** Minimal runtime surface the store needs (structural, for testability). */
export interface PushPolicyRuntime {
  agentId: string | UUIDLike;
  getCache<T>(key: string): Promise<T | undefined>;
  setCache<T>(key: string, value: T): Promise<boolean>;
  /**
   * Atomic conditional write (see `IAgentRuntime.compareAndSetCache`).
   * `update()` requires it: the cross-process blue/green guarantee is built
   * on CAS, and there is deliberately NO fallback to unconditional
   * `setCache` (that would silently reopen the lost-update window).
   */
  compareAndSetCache<T>(
    key: string,
    expected: unknown,
    replacement: T,
  ): Promise<boolean>;
}

type UUIDLike = { toString(): string };
