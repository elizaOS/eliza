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
   * the version, durably save — per principal, so two concurrent
   * enable/disable requests can never both observe the same base version and
   * silently overwrite an opt-out: each update persists a distinct monotonic
   * version, giving every accepted write an auditable position in the
   * principal's ordering. Returns the persisted record.
   *
   * Concurrency scope: same-principal writes are serialized and failure-atomic
   * within a single process, mirroring `PushTokenRegistry`'s documented scope —
   * the runtime cache contract exposes no compare-and-swap primitive
   * (`getCache`/`setCache` only). Known limitation: during a managed
   * blue/green upgrade two container generations briefly share the durable
   * cache, so an in-flight write from the retiring container can interleave
   * with the new container's first write (the same exposure the token
   * registry carries).
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
   * One serialized step: re-load the durable row inside the critical section
   * (so it reflects every earlier queued update), apply the new setting, and
   * persist. The version is `loaded + 1` — strictly monotonic across successive
   * updates through this store. A corrupt row parses as absent per the
   * fail-closed parse contract, so the sequence restarts at version 1 rather
   * than trusting an unreadable prior version. A row already at the safe
   * integer ceiling rejects the bump: persisting `version + 1` would store a
   * record this store's own parser fails closed on, so the write is refused
   * instead of planting a row every later load treats as corrupt.
   */
  private async bumpAndSave(
    recipientId: string,
    pushEnabled: boolean,
  ): Promise<PushDeliveryPolicy> {
    const existing = await this.load(recipientId);
    const baseVersion = existing?.version ?? 0;
    if (baseVersion >= Number.MAX_SAFE_INTEGER) {
      throw new ElizaError(
        "[PushPolicyStore] policy version exhausted the safe-integer range",
        {
          code: PUSH_POLICY_PERSIST_FAILED_CODE,
          context: { recipientId: recipientId.length, baseVersion },
          severity: "ephemeral",
        },
      );
    }
    const next: PushDeliveryPolicy = {
      pushEnabled,
      version: baseVersion + 1,
      updatedAt: Date.now(),
    };
    await this.save(recipientId, next);
    return next;
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
    const persisted = await this.runtime.setCache(
      this.cacheKey(recipientId),
      policy,
    );
    if (persisted !== true) {
      throw new ElizaError(
        "[PushPolicyStore] durable cache rejected the push-policy write",
        {
          code: PUSH_POLICY_PERSIST_FAILED_CODE,
          context: { recipientLength: recipientId.length },
          severity: "ephemeral",
        },
      );
    }
  }
}

/** Minimal runtime surface the store needs (structural, for testability). */
export interface PushPolicyRuntime {
  agentId: string | UUIDLike;
  getCache<T>(key: string): Promise<T | undefined>;
  setCache<T>(key: string, value: T): Promise<boolean>;
}

type UUIDLike = { toString(): string };
