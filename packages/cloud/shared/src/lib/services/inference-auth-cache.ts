/**
 * Low-level cache + invalidation for the inference hot path (#9899).
 *
 * This module is intentionally dependency-light - it imports ONLY the cache
 * layer (no auth / api-key / moderation services) so that the mutation sites
 * that must invalidate the cache (api-keys, admin) can import it without
 * creating an import cycle with the resolver in `inference-auth-context.ts`.
 *
 * Inference auth-context entries collapse auth + org + moderation into a
 * single cache read for API-key or Steward-session inference. The feature is
 * default-off until a strongly consistent revocation boundary exists (see
 * `packages/cloud/api/docs/inference-hot-path.md`). Its data-shape rules are:
 *   1. A positive entry is ONLY ever written for a FULLY-authorized credential
 *      (active user + active org + not suspended + org present). Explicit
 *      negative entries contain only a bounded 401/403 decision, never identity
 *      fields, so cold Worker retries converge without a database fallback.
 *   2. Entries are keyed by the FULL sha256(key) (== the stored `key_hash`), so
 *      revoke/ban invalidation by `key_hash` is exact.
 */

import { createHash } from "node:crypto";
import {
  type CacheBackendKind,
  type CacheReadOutcome,
  type CacheWriteOutcome,
  cache,
} from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";

/** Current IAC schema version. Bump the key suffix in CacheKeys on a breaking change. */
export const INFERENCE_AUTH_CONTEXT_VERSION = 2 as const;

/** Admission state co-located with identity so a warm Worker performs one KV read. */
export interface InferenceAdmissionSnapshot {
  balance: {
    balanceUsd: number;
    balanceAt: number;
    balanceRevision: string;
  };
  rateLimits: {
    completionsRpm: number;
    embeddingsRpm: number;
    standardRpm: number;
    strictRpm: number;
  };
}

/**
 * A cached, fully-authorized inference identity. Presence of this entry means
 * the credential was active + org-active + not-suspended at populate time.
 */
export interface InferenceAuthContext {
  v: typeof INFERENCE_AUTH_CONTEXT_VERSION;
  cachedAt: number;
  userId: string;
  orgId: string;
  apiKeyId: string;
  /** Full sha256(presented key) - equals the stored api_keys.key_hash. */
  keyHash: string;
  /** Owning app for an app-minted key; null for an ordinary org key. */
  appScopeId: string | null;
  admission?: InferenceAdmissionSnapshot;
}

export interface InferenceApiKeyAuthRejection {
  v: typeof INFERENCE_AUTH_CONTEXT_VERSION;
  cachedAt: number;
  keyHash: string;
  decision: "rejected" | "suspended";
  status: 401 | 403;
  /** Bounded account-standing category safe to return without a DB read. */
  reason?: InferenceAuthRejectionReason;
}

export type InferenceAuthRejectionReason =
  | "credential_invalid"
  | "credential_inactive"
  | "account_inactive"
  | "organization_inactive"
  | "membership_missing"
  | "moderation_blocked";

const INFERENCE_AUTH_REJECTION_REASONS = new Set<InferenceAuthRejectionReason>([
  "credential_invalid",
  "credential_inactive",
  "account_inactive",
  "organization_inactive",
  "membership_missing",
  "moderation_blocked",
]);

/**
 * A cached, fully-authorized Steward session identity. The JWT is still
 * signature/expiry/tenant verified on every request; this entry replaces only
 * the cloud user/org/moderation database wave.
 */
export interface InferenceSessionAuthContext {
  v: typeof INFERENCE_AUTH_CONTEXT_VERSION;
  cachedAt: number;
  userId: string;
  orgId: string;
  apiKeyId: null;
  stewardUserId: string;
  admission?: InferenceAdmissionSnapshot;
}

export interface InferenceSessionAuthRejection {
  v: typeof INFERENCE_AUTH_CONTEXT_VERSION;
  cachedAt: number;
  stewardUserId: string;
  decision: "rejected" | "suspended";
  status: 401 | 403;
  reason?: InferenceAuthRejectionReason;
}

export type InferenceSessionAuthDecision =
  | InferenceSessionAuthContext
  | InferenceSessionAuthRejection;

export type ResolvedInferenceAuthContext = InferenceAuthContext | InferenceSessionAuthContext;

function isInferenceAdmissionSnapshot(value: unknown): value is InferenceAdmissionSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<InferenceAdmissionSnapshot>;
  const balance = candidate.balance;
  const rateLimits = candidate.rateLimits;
  return (
    Boolean(balance) &&
    typeof balance?.balanceUsd === "number" &&
    Number.isFinite(balance.balanceUsd) &&
    typeof balance.balanceAt === "number" &&
    Number.isFinite(balance.balanceAt) &&
    typeof balance.balanceRevision === "string" &&
    /^(0|[1-9]\d*)$/.test(balance.balanceRevision) &&
    Boolean(rateLimits) &&
    Number.isSafeInteger(rateLimits?.completionsRpm) &&
    (rateLimits?.completionsRpm ?? 0) > 0 &&
    Number.isSafeInteger(rateLimits?.embeddingsRpm) &&
    (rateLimits?.embeddingsRpm ?? 0) > 0 &&
    Number.isSafeInteger(rateLimits?.standardRpm) &&
    (rateLimits?.standardRpm ?? 0) > 0 &&
    Number.isSafeInteger(rateLimits?.strictRpm) &&
    (rateLimits?.strictRpm ?? 0) > 0
  );
}

/** Cache lookup states retained by the auth trace instead of collapsed to null. */
export type InferenceAuthCacheReadOutcome =
  | { kind: "hit"; ctx: InferenceAuthContext; backend: CacheBackendKind }
  | {
      kind: "rejected";
      decision: "rejected" | "suspended";
      status: 401 | 403;
      reason?: InferenceAuthRejectionReason;
      backend: CacheBackendKind;
    }
  | {
      kind: "miss" | "invalid" | "unavailable" | "error";
      backend: CacheBackendKind;
    };

export interface InferenceCacheCleanupExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function deferMalformedEntryCleanup(
  key: string,
  executionCtx?: InferenceCacheCleanupExecutionContext,
): void {
  const cleanup = cache.del(key, { keyClass: "inference_auth" }).then(
    () => undefined,
    (error) => {
      // error-policy:J7 malformed state already failed closed; cleanup remains
      // observable without adding another remote write to authorization latency.
      logger.warn("[InferenceAuthCache] Malformed entry cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  if (executionCtx) {
    executionCtx.waitUntil(cleanup);
  } else {
    void cleanup;
  }
}

/** Org credit-balance snapshot used ONLY as the optimistic-billing fast-path gate hint. */
export interface OrgBalanceHint {
  v: typeof INFERENCE_AUTH_CONTEXT_VERSION;
  orgId: string;
  balanceUsd: number;
  balanceAt: number;
  balanceRevision: string;
}

/** Full sha256 of a presented API key - matches how `api_keys.key_hash` is stored. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/** One-way cache-key material for a verified Steward subject. */
export function hashStewardUserId(stewardUserId: string): string {
  return createHash("sha256").update(stewardUserId).digest("hex");
}

/**
 * Runtime shape guard. Rejects legacy / wrong-version / partial entries so a
 * malformed value can never be trusted as an authorization decision. Positive
 * and rejection validators are mutually exclusive: an entry carrying BOTH a
 * rejection `decision` and positive identity fields validates as neither, so a
 * hybrid value is dropped as malformed instead of resolving by field order.
 */
export function isInferenceAuthContext(value: unknown): value is InferenceAuthContext {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    !("decision" in v) &&
    v.v === INFERENCE_AUTH_CONTEXT_VERSION &&
    typeof v.cachedAt === "number" &&
    Number.isFinite(v.cachedAt) &&
    v.cachedAt > 0 &&
    typeof v.userId === "string" &&
    v.userId.length > 0 &&
    typeof v.orgId === "string" &&
    v.orgId.length > 0 &&
    typeof v.apiKeyId === "string" &&
    v.apiKeyId.length > 0 &&
    typeof v.keyHash === "string" &&
    /^[0-9a-f]{64}$/.test(v.keyHash) &&
    (v.appScopeId === null || (typeof v.appScopeId === "string" && v.appScopeId.length > 0)) &&
    isInferenceAdmissionSnapshot(v.admission)
  );
}

function isInferenceApiKeyAuthRejection(value: unknown): value is InferenceApiKeyAuthRejection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    !("apiKeyId" in v) &&
    v.v === INFERENCE_AUTH_CONTEXT_VERSION &&
    typeof v.cachedAt === "number" &&
    Number.isFinite(v.cachedAt) &&
    v.cachedAt > 0 &&
    typeof v.keyHash === "string" &&
    /^[0-9a-f]{64}$/.test(v.keyHash) &&
    (v.decision === "rejected" || v.decision === "suspended") &&
    (v.status === 401 || v.status === 403) &&
    (v.reason === undefined || isInferenceAuthRejectionReason(v.reason))
  );
}

function isInferenceAuthRejectionReason(value: unknown): value is InferenceAuthRejectionReason {
  return (
    typeof value === "string" &&
    INFERENCE_AUTH_REJECTION_REASONS.has(value as InferenceAuthRejectionReason)
  );
}

/** Reject malformed session identities before they can authorize inference. */
export function isInferenceSessionAuthContext(
  value: unknown,
): value is InferenceSessionAuthContext {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    !("decision" in v) &&
    v.v === INFERENCE_AUTH_CONTEXT_VERSION &&
    typeof v.cachedAt === "number" &&
    Number.isFinite(v.cachedAt) &&
    v.cachedAt > 0 &&
    typeof v.userId === "string" &&
    v.userId.length > 0 &&
    typeof v.orgId === "string" &&
    v.orgId.length > 0 &&
    v.apiKeyId === null &&
    typeof v.stewardUserId === "string" &&
    v.stewardUserId.length > 0 &&
    isInferenceAdmissionSnapshot(v.admission)
  );
}

function isInferenceSessionAuthRejection(value: unknown): value is InferenceSessionAuthRejection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    !("apiKeyId" in v) &&
    v.v === INFERENCE_AUTH_CONTEXT_VERSION &&
    typeof v.cachedAt === "number" &&
    Number.isFinite(v.cachedAt) &&
    v.cachedAt > 0 &&
    typeof v.stewardUserId === "string" &&
    v.stewardUserId.length > 0 &&
    (v.decision === "rejected" || v.decision === "suspended") &&
    (v.status === 401 || v.status === 403) &&
    (v.reason === undefined || isInferenceAuthRejectionReason(v.reason))
  );
}

function mapCacheReadOutcome(
  outcome: Exclude<CacheReadOutcome<unknown>, { kind: "hit" }>,
): InferenceAuthCacheReadOutcome {
  return { kind: outcome.kind, backend: outcome.backend };
}

export function isOrgBalanceHint(value: unknown): value is OrgBalanceHint {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === INFERENCE_AUTH_CONTEXT_VERSION &&
    typeof v.orgId === "string" &&
    v.orgId.length > 0 &&
    typeof v.balanceUsd === "number" &&
    Number.isFinite(v.balanceUsd) &&
    typeof v.balanceAt === "number" &&
    typeof v.balanceRevision === "string" &&
    /^(0|[1-9]\d*)$/.test(v.balanceRevision)
  );
}

/**
 * Read only a positive cached IAC for a presented key hash. Returns null for a
 * negative decision, miss, malformed entry, or unavailable cache.
 */
export async function readInferenceAuthContext(
  keyHash: string,
): Promise<InferenceAuthContext | null> {
  const outcome = await readInferenceAuthContextWithOutcome(keyHash);
  return outcome.kind === "hit" ? outcome.ctx : null;
}

/** Read an IAC without hiding whether KV missed, failed, or held malformed data. */
export async function readInferenceAuthContextWithOutcome(
  keyHash: string,
  probeDiscriminator?: string,
  executionCtx?: InferenceCacheCleanupExecutionContext,
): Promise<InferenceAuthCacheReadOutcome> {
  const canonicalKey = CacheKeys.inference.authContext(keyHash);
  // Authenticated latency probes read a unique, never-written variant so each
  // controlled sample exercises a real KV miss. The authorized result is still
  // written only to the canonical, revocation-invalidated key below.
  const key = probeDiscriminator ? `${canonicalKey}:probe:${probeDiscriminator}` : canonicalKey;
  const outcome = await cache.getWithOutcome<unknown>(key, {
    keyClass: "inference_auth",
  });
  if (outcome.kind !== "hit") return mapCacheReadOutcome(outcome);
  if (isInferenceApiKeyAuthRejection(outcome.value) && outcome.value.keyHash === keyHash) {
    return {
      kind: "rejected",
      decision: outcome.value.decision,
      status: outcome.value.status,
      reason: outcome.value.reason,
      backend: outcome.backend,
    };
  }
  if (!isInferenceAuthContext(outcome.value) || outcome.value.keyHash !== keyHash) {
    logger.warn("[InferenceAuthCache] Dropping malformed IAC entry");
    deferMalformedEntryCleanup(key, executionCtx);
    return { kind: "invalid", backend: outcome.backend };
  }
  return { kind: "hit", ctx: outcome.value, backend: outcome.backend };
}

/** Write a fully-authorized IAC entry. Callers MUST only pass authorized identities. */
export async function writeInferenceAuthContext(
  ctx: InferenceAuthContext,
): Promise<CacheWriteOutcome> {
  return await cache.setWithOutcome(
    CacheKeys.inference.authContext(ctx.keyHash),
    ctx,
    CacheTTL.inference.authContext,
    { keyClass: "inference_auth" },
  );
}

/** Cache a bounded fail-closed API-key decision without storing identity data. */
export async function writeInferenceApiKeyAuthRejection(
  keyHash: string,
  decision: "rejected" | "suspended",
  status: 401 | 403,
  reason?: InferenceAuthRejectionReason,
): Promise<CacheWriteOutcome> {
  return await cache.setWithOutcome(
    CacheKeys.inference.authContext(keyHash),
    {
      v: INFERENCE_AUTH_CONTEXT_VERSION,
      cachedAt: Date.now(),
      keyHash,
      decision,
      status,
      ...(reason ? { reason } : {}),
    } satisfies InferenceApiKeyAuthRejection,
    CacheTTL.inference.authContext,
    { keyClass: "inference_auth" },
  );
}

/** Read a session IAC without consulting any authoritative store. */
export async function readInferenceSessionAuthContext(
  stewardUserId: string,
): Promise<InferenceSessionAuthContext | null> {
  const decision = await readInferenceSessionAuthDecision(stewardUserId);
  return decision && "apiKeyId" in decision ? decision : null;
}

/** Read the cached positive or fail-closed session decision. */
export async function readInferenceSessionAuthDecision(
  stewardUserId: string,
  executionCtx?: InferenceCacheCleanupExecutionContext,
): Promise<InferenceSessionAuthDecision | null> {
  const key = CacheKeys.inference.sessionAuthContext(hashStewardUserId(stewardUserId));
  const outcome = await cache.getWithOutcome<unknown>(key, { keyClass: "inference_auth" });
  const cached = outcome.kind === "hit" ? outcome.value : null;
  if (cached === null) return null;
  if (
    (!isInferenceSessionAuthContext(cached) && !isInferenceSessionAuthRejection(cached)) ||
    cached.stewardUserId !== stewardUserId
  ) {
    logger.warn("[InferenceAuthCache] Dropping malformed session IAC entry");
    deferMalformedEntryCleanup(key, executionCtx);
    return null;
  }
  return cached;
}

/** Write a fully-authorized session IAC after user/org/moderation hydration. */
export async function writeInferenceSessionAuthContext(
  ctx: InferenceSessionAuthContext,
): Promise<CacheWriteOutcome> {
  return await writeInferenceSessionAuthDecision(ctx);
}

/** Persist a session authorization decision for bounded retry behavior. */
export async function writeInferenceSessionAuthDecision(
  decision: InferenceSessionAuthDecision,
): Promise<CacheWriteOutcome> {
  return await cache.setWithOutcome(
    CacheKeys.inference.sessionAuthContext(hashStewardUserId(decision.stewardUserId)),
    decision,
    CacheTTL.inference.authContext,
    { keyClass: "inference_auth" },
  );
}

/** Exact lifecycle invalidation for every active token belonging to a user. */
export async function invalidateInferenceSessionAuthContext(
  stewardUserId: string,
): Promise<boolean> {
  return await cache.delConfirmed(
    CacheKeys.inference.sessionAuthContext(hashStewardUserId(stewardUserId)),
    { keyClass: "inference_auth" },
  );
}

/**
 * Fail closed when any user in a lifecycle mutation cannot be evicted. The
 * authoritative mutation caller decides whether cache failure may abort or is
 * an explicitly logged teardown-style best effort.
 */
export async function invalidateInferenceSessionAuthContexts(
  stewardUserIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(stewardUserIds.filter((id) => id.length > 0))];
  const results = await Promise.all(unique.map((id) => invalidateInferenceSessionAuthContext(id)));
  const unconfirmed = unique.filter((_id, index) => !results[index]);
  if (unconfirmed.length > 0) {
    throw new Error(
      `Inference session auth-context invalidation not confirmed for ${unconfirmed.length}/${unique.length} user(s)`,
    );
  }
}

/**
 * Exact invalidation by the stored `key_hash`. Called from every api-key
 * mutation (revoke/update/delete/deactivate) so a revoked key stops fast-pathing
 * immediately rather than waiting out the TTL.
 */
/**
 * Invalidate the inference auth-context entry for a single key hash.
 *
 * @returns `true` when the delete is confirmed, `false` when the backend
 *   rejected it. Callers on a credential-revocation path (see
 *   {@link ../api-keys}) must fail closed on `false` — a discarded failure here
 *   let a revoked key keep fast-pathing inference until the IAC TTL lapsed
 *   (#13417).
 */
export async function invalidateInferenceAuthContextByKeyHash(keyHash: string): Promise<boolean> {
  return await cache.delConfirmed(CacheKeys.inference.authContext(keyHash), {
    keyClass: "inference_auth",
  });
}

/**
 * Fan-out invalidation for every supplied key hash (used at ban / deactivate,
 * where the caller resolves the user's key hashes from the DB).
 *
 * FAILS CLOSED: every hash is attempted, but if ANY per-key delete is
 * unconfirmed (backend rejected it or the cache is configured-but-unavailable)
 * this THROWS naming the still-warm hashes. Ban/deactivate callers simply
 * `await` this and do not inspect a return value, so a thrown error is what
 * makes them fail closed instead of completing the ban while warm IAC entries
 * keep authorizing until TTL. Callers that intentionally want best-effort
 * (e.g. a lifecycle write that must not be blocked by a cache brownout) wrap
 * this in their own try/catch — that stays a deliberate, visible choice rather
 * than a silently-swallowed one. (#13417)
 *
 * @throws when any key's invalidation is not confirmed.
 */
export async function invalidateInferenceAuthContextsByKeyHashes(
  keyHashes: readonly string[],
): Promise<void> {
  if (keyHashes.length === 0) return;
  const results = await Promise.all(
    keyHashes.map((h) =>
      cache.delConfirmed(CacheKeys.inference.authContext(h), {
        keyClass: "inference_auth",
      }),
    ),
  );
  const unconfirmed = keyHashes.filter((_h, i) => !results[i]);
  if (unconfirmed.length > 0) {
    logger.error("[InferenceAuthCache] Fan-out invalidation not confirmed", {
      unconfirmedCount: unconfirmed.length,
      total: keyHashes.length,
    });
    throw new Error(
      `Inference auth-context invalidation not confirmed for ${unconfirmed.length}/${keyHashes.length} key(s); revoked credentials may keep authorizing until TTL`,
    );
  }
}

export async function readOrgBalanceHint(orgId: string): Promise<OrgBalanceHint | null> {
  const cached = await cache.get<unknown>(CacheKeys.inference.orgBalance(orgId));
  if (cached === null) return null;
  if (!isOrgBalanceHint(cached)) {
    await cache.del(CacheKeys.inference.orgBalance(orgId));
    return null;
  }
  return cached;
}

export async function writeOrgBalanceHint(
  orgId: string,
  balanceUsd: number,
  balanceAt: number,
  balanceRevision: string,
): Promise<void> {
  const hint: OrgBalanceHint = {
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    orgId,
    balanceUsd,
    balanceAt,
    balanceRevision,
  };
  // Physical lifetime is orgBalanceStale (5m): the hint must survive past the
  // orgBalance freshness window so getGateBalanceUsd can serve it stale-while-
  // revalidate. `balanceAt` is the freshness clock the reader checks; the debit
  // settler (lowerOrgBalanceHint) and top-ups (invalidateOrgBalanceHint) still
  // keep the served value correct on writes.
  const outcome = await cache.setWithOutcome(
    CacheKeys.inference.orgBalance(orgId),
    hint,
    CacheTTL.inference.orgBalanceStale,
  );
  if (outcome.kind !== "written") {
    throw new Error(`Organization balance hint write was not confirmed: ${outcome.kind}`);
  }
}

/** Drop the org-balance gate hint so the next request re-reads it fresh. */
export async function invalidateOrgBalanceHint(orgId: string): Promise<void> {
  const confirmed = await cache.delConfirmed(CacheKeys.inference.orgBalance(orgId));
  if (!confirmed) {
    throw new Error("Organization balance hint invalidation was not confirmed");
  }
}

/**
 * Write the org-balance gate hint ONLY when it lowers the cached value. Used by
 * the debit settler: a debit can only reduce a balance, so an out-of-order
 * concurrent debit must never raise the cached gate value (which would
 * over-admit the optimistic path). A fresh authoritative read still uses
 * `writeOrgBalanceHint` (it is the source of truth); top-ups invalidate the hint.
 */
export async function lowerOrgBalanceHint(
  orgId: string,
  balanceUsd: number,
  balanceAt: number,
): Promise<void> {
  const existing = await readOrgBalanceHint(orgId);
  if (!existing) return;
  if (existing.balanceUsd <= balanceUsd) return;
  await writeOrgBalanceHint(orgId, balanceUsd, balanceAt, existing.balanceRevision);
}

/**
 * Publish one authoritative post-debit balance snapshot with a single cache
 * write and no cache readback.
 *
 * Unlike {@link lowerOrgBalanceHint}, this seeds an entry after the committed
 * debit's invalidation deletes the old hint, preventing the next Worker turn
 * from failing closed on an avoidable cache miss. The projection is not the
 * monetary authority: Worker provider dispatch is serialized by the
 * revision-aware InferenceAdmissionGate Durable Object. Non-Worker paths use
 * the atomic DB-ledger admission or reserve credits synchronously; the legacy
 * KV lane cannot dispatch from this projection. A delayed projection write can
 * therefore be stale, but it cannot authorize spend by itself; the next Durable
 * Object admission applies only a newer revision and accounts for active holds.
 */
export async function republishOrgBalanceHint(
  orgId: string,
  balanceUsd: number,
  balanceAt: number,
  balanceRevision: string,
): Promise<void> {
  await writeOrgBalanceHint(orgId, balanceUsd, balanceAt, balanceRevision);
}
