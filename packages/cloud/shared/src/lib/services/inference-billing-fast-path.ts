/**
 * Revisioned organization-balance projections and compatibility accounting
 * utilities for inference.
 *
 * Covered Worker token/model routes read the balance projection and use a
 * Durable Object lease as their pre-provider write-ahead record; they never
 * write a KV pending charge. The pending-charge and safety-threshold helpers
 * remain for non-Worker callers and sweep compatibility.
 */

import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { apiKeysService } from "./api-keys";
import { type CreditReconciliationResult, creditsService } from "./credits";
import { clearOrgAdmissionRefused, markOrgAdmissionRefused } from "./inference-admission-refusal";
import {
  INFERENCE_AUTH_CONTEXT_VERSION,
  invalidateOrgBalanceHint,
  readOrgBalanceHint,
  writeOrgBalanceHint,
} from "./inference-auth-cache";
import { republishOrgBalanceHintAfterDebit } from "./inference-balance-republish";

/**
 * Re-exported so the settler call site below and existing importers keep a
 * single name. The implementation lives in `inference-balance-republish` to
 * keep it reachable from the DB ledger without widening that module's graph.
 */
export { republishOrgBalanceHintAfterDebit };

/** A durable record of an in-flight optimistic charge (the backstop). */
export interface PendingInferenceCharge {
  v: typeof INFERENCE_AUTH_CONTEXT_VERSION;
  requestId: string;
  organizationId: string;
  userId: string;
  apiKeyId: string | null;
  model: string;
  provider: string;
  billingSource: string;
  estimatedCostUsd: number;
  enqueuedAt: number;
}

/** Default sweep grace: a pending entry older than this with no inline settle is a straggler. */
const DEFAULT_SWEEP_GRACE_MS = 20 * 60 * 1000; // 20 min (> max route duration)

type StringEnv = Record<string, string | undefined>;

export function isOptimisticBillingEnabled(env: StringEnv = getCloudAwareEnv()): boolean {
  return (env.INFERENCE_OPTIMISTIC_BILLING ?? "").trim() === "true";
}

/**
 * Whether the durable pending-charge backstop can be written right now. The
 * optimistic path SKIPS the synchronous reserve, so the backstop is the only
 * record of the charge until settle — if the cache is unavailable (circuit open
 * during a KV brownout, disabled, no backend) the request MUST take the safe
 * synchronous-reserve path, never forward on an un-recorded charge (#9899, the
 * "free-forever on cache failure" hole). Mirrors the IAC resolver's CS-5 guard.
 *
 * Note: this is `cache.isAvailable()`, NOT `supportsAtomicOperations()` — the
 * production backend is Cloudflare KV (no atomic NX), and gating on atomicity
 * would disable the optimistic path entirely in prod. Durability, not atomicity,
 * is what the backstop needs; exactly-once is handled by the getAndDelete claim
 * (with the documented KV residual).
 */
export function isOptimisticBackstopAvailable(): boolean {
  return cache.isAvailable();
}

/** Resolve the non-Worker optimistic-lane balance cushion in USD. */
export function resolveSafeBalanceThresholdUsd(env: StringEnv = getCloudAwareEnv()): number {
  const raw = (env.SAFE_BALANCE_THRESHOLD ?? "").trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}

export function isPendingInferenceCharge(value: unknown): value is PendingInferenceCharge {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === INFERENCE_AUTH_CONTEXT_VERSION &&
    typeof v.requestId === "string" &&
    typeof v.organizationId === "string" &&
    typeof v.userId === "string" &&
    typeof v.model === "string" &&
    typeof v.provider === "string" &&
    typeof v.billingSource === "string" &&
    typeof v.estimatedCostUsd === "number" &&
    Number.isFinite(v.estimatedCostUsd) &&
    typeof v.enqueuedAt === "number"
  );
}

/**
 * Read the gate balance for an org, stale-while-revalidate. Serves the KV hint
 * whenever one exists; if it is older than the `orgBalance` freshness window it
 * is still returned immediately and an authoritative refresh is scheduled in the
 * background. Only a full miss (no hint within the physical `orgBalanceStale`
 * lifetime) blocks on the authoritative read. This keeps the human-paced first
 * call of each turn off the ~200-500ms balance re-read that a hard 15s TTL
 * forced, without widening the over-admit window: every optimistic charge still
 * lands in the durable pending-charge ledger, the debit settler lowers the hint
 * after each settle, and top-ups invalidate it — so a drained org is corrected
 * on its first settle exactly as before, not after the stale window.
 */
export interface GateBalanceReadOptions {
  /**
   * Worker lifetime hook for stale/full-miss revalidation. Supplying this keeps
   * every authoritative refresh observable and alive without joining it to the
   * response promise.
   */
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
  /**
   * Fail closed on a full cache miss instead of performing a synchronous
   * Postgres read in the inference path. The caller should return a retryable
   * cache-warming response; the authoritative hydration is registered with
   * `executionCtx`.
   */
  cacheOnly?: boolean;
}

export class InferenceBalanceCacheWarmingError extends Error {
  constructor() {
    super("Inference billing cache is warming; retry the request");
    this.name = "InferenceBalanceCacheWarmingError";
  }
}

export interface GateBalanceSnapshot {
  balanceUsd: number;
  balanceAt: number;
  balanceRevision: string;
}

const balanceRevalidationInFlight = new Map<string, Promise<GateBalanceSnapshot>>();

function refreshOrgBalanceHint(organizationId: string): Promise<GateBalanceSnapshot> {
  const existing = balanceRevalidationInFlight.get(organizationId);
  if (existing) return existing;

  // This timestamp marks when the authoritative read started, not when its
  // cache write completed. A delayed old query must never masquerade as newer
  // than a debit that committed while it was in flight.
  const balanceAt = Date.now();
  const refresh = creditsService
    .getOrganizationBalanceSnapshot(organizationId)
    .then(async (fresh) => {
      await writeOrgBalanceHint(organizationId, fresh.balanceUsd, balanceAt, fresh.revision);
      clearOrgAdmissionRefused(organizationId);
      return {
        balanceUsd: fresh.balanceUsd,
        balanceAt,
        balanceRevision: fresh.revision,
      };
    })
    .finally(() => {
      balanceRevalidationInFlight.delete(organizationId);
    });
  balanceRevalidationInFlight.set(organizationId, refresh);
  return refresh;
}

function observeBackgroundBalanceRefresh(
  organizationId: string,
  refresh: Promise<GateBalanceSnapshot>,
): Promise<void> {
  return refresh.then(
    () => undefined,
    (error) => {
      // error-policy:J7 the inference response is deliberately independent of
      // cache refresh; log the failed hydration so the next miss can retry.
      logger.warn("[InferenceBilling] org-balance revalidation failed", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

/** Start an authoritative balance refresh without joining the request promise. */
export function scheduleOrgBalanceHintHydration(
  organizationId: string,
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
): void {
  executionCtx.waitUntil(
    observeBackgroundBalanceRefresh(organizationId, refreshOrgBalanceHint(organizationId)),
  );
}

export async function getGateBalanceHint(
  organizationId: string,
  options: GateBalanceReadOptions = {},
): Promise<GateBalanceSnapshot> {
  const hint = await readOrgBalanceHint(organizationId);
  if (hint) {
    if (Date.now() - hint.balanceAt > CacheTTL.inference.orgBalance * 1000) {
      const refresh = observeBackgroundBalanceRefresh(
        organizationId,
        refreshOrgBalanceHint(organizationId),
      );
      if (options.executionCtx) {
        options.executionCtx.waitUntil(refresh);
      } else {
        void refresh;
      }
    }
    return {
      balanceUsd: hint.balanceUsd,
      balanceAt: hint.balanceAt,
      balanceRevision: hint.balanceRevision,
    };
  }

  const refresh = refreshOrgBalanceHint(organizationId);
  if (options.cacheOnly) {
    const observed = observeBackgroundBalanceRefresh(organizationId, refresh);
    if (options.executionCtx) {
      options.executionCtx.waitUntil(observed);
    } else {
      await observed;
    }
    throw new InferenceBalanceCacheWarmingError();
  }
  return await refresh;
}

export async function getGateBalanceUsd(
  organizationId: string,
  options: GateBalanceReadOptions = {},
): Promise<number> {
  return (await getGateBalanceHint(organizationId, options)).balanceUsd;
}

/** Decide whether a non-Worker caller may use the KV optimistic lane. */
export function isOptimisticEligible(params: {
  enabled: boolean;
  useAppCredits: boolean;
  balanceUsd: number;
  thresholdUsd: number;
  estimatedCostUsd: number;
}): boolean {
  const { enabled, useAppCredits, balanceUsd, thresholdUsd, estimatedCostUsd } = params;
  if (!enabled || useAppCredits) return false;
  if (!Number.isFinite(thresholdUsd)) return false; // +Inf → never fast-path
  return balanceUsd > thresholdUsd && balanceUsd > estimatedCostUsd;
}

/**
 * Write the durable pending-charge backstop before forwarding to the model, and
 * REPORT whether it actually persisted. The caller (route) must only take the
 * optimistic path when this returns `true`; otherwise it has to fall back to the
 * synchronous reserve, because a forwarded request with no durable charge is
 * free inference (#9899). Uses `setIfNotExists` (requestId is a unique id, so NX
 * always sets) because, unlike `cache.set`, it throws on an unavailable backend
 * and surfaces write success/failure instead of silently swallowing it.
 */
export async function writePendingInferenceCharge(
  charge: Omit<PendingInferenceCharge, "v" | "enqueuedAt">,
  now: number,
): Promise<boolean> {
  const record: PendingInferenceCharge = {
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    enqueuedAt: now,
    ...charge,
  };
  try {
    return await cache.setIfNotExists(
      CacheKeys.inference.pendingCharge(charge.requestId),
      record,
      CacheTTL.inference.pendingCharge * 1000, // setIfNotExists takes ms
    );
  } catch (error) {
    logger.warn("[InferenceBilling] pending-charge backstop write failed; will reserve instead", {
      requestId: charge.requestId,
      organizationId: charge.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export interface DebitContext {
  requestId: string;
  organizationId: string;
  userId: string;
  model: string;
  provider: string;
  billingSource: string;
}

/** Authoritative result of one idempotent direct inference debit. */
export type InferenceDebitCollectionOutcome =
  | {
      status: "collected";
      attemptedAmountUsd: number;
      collectedAmountUsd: number;
      newBalanceUsd: number;
      transactionId: string;
    }
  | {
      status: "uncollected";
      attemptedAmountUsd: number;
      collectedAmountUsd: 0;
      newBalanceUsd: number;
      transactionId: null;
      reason: "insufficient_balance" | "below_minimum" | "org_not_found";
    };

/** Infrastructure failure while the authoritative debit outcome is unknown. */
export class InferenceDebitInfrastructureError extends Error {
  constructor(
    readonly requestId: string,
    readonly organizationId: string,
    cause: unknown,
  ) {
    super(`Inference debit failed for request ${requestId}`, { cause });
    this.name = "InferenceDebitInfrastructureError";
  }
}

/** Persisted idempotent debit does not match the logical request being settled. */
export class InferenceDebitReplayMismatchError extends Error {
  constructor(
    readonly requestId: string,
    readonly organizationId: string,
    readonly attemptedAmountUsd: number,
    readonly persistedAmountUsd: number,
  ) {
    super(`Inference debit replay mismatch for request ${requestId}`);
    this.name = "InferenceDebitReplayMismatchError";
  }
}

/**
 * Debit an inference cost and refresh the org-balance hint. On a failed debit
 * (insufficient balance — the DB forbids negative) record the uncollected
 * amount and force the org back onto the safe path. A database or transport
 * failure rejects with an explicit infrastructure error: callers must not
 * report an unknown money outcome as a successful settlement.
 *
 * Exported for the deferred-admission settler (`inference-billing-deferred`),
 * which uses it as the fail-closed fallback charge when a deferred durable
 * admission resolves refused after the request already forwarded.
 */
export async function debitInferenceCost(
  ctx: DebitContext,
  amountUsd: number,
  source: "inline" | "backstop" | "deferred",
): Promise<InferenceDebitCollectionOutcome> {
  let result: Awaited<ReturnType<typeof creditsService.deductCredits>>;
  try {
    result = await creditsService.deductCredits({
      organizationId: ctx.organizationId,
      amount: amountUsd,
      description: `Inference (${source}): ${ctx.model}`,
      // The same server request may be retried by a post-response task or
      // claimed by a backstop after an acknowledgement loss. One key across
      // sources makes the database row the exactly-once collection gate.
      stripePaymentIntentId: `inference-debit:${ctx.organizationId}:${ctx.requestId}`,
      metadata: {
        user_id: ctx.userId,
        requestId: ctx.requestId,
        model: ctx.model,
        provider: ctx.provider,
        billingSource: ctx.billingSource,
        type: "inference_optimistic",
        source,
      },
    });
  } catch (cause) {
    logger.error("[InferenceBilling] inference debit infrastructure failure", {
      organizationId: ctx.organizationId,
      requestId: ctx.requestId,
      amountUsd,
      source,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    try {
      await invalidateOrgBalanceHint(ctx.organizationId);
    } catch (invalidationError) {
      // error-policy:J7 the authoritative debit failure remains the primary
      // signal; cache eviction failure is separately observable for operators.
      logger.error("[InferenceBilling] failed to invalidate balance after debit failure", {
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        error:
          invalidationError instanceof Error
            ? invalidationError.message
            : String(invalidationError),
      });
    }
    // error-policy:J2 preserve the infrastructure cause so the waitUntil
    // boundary can surface and retry the deterministic money operation.
    throw new InferenceDebitInfrastructureError(ctx.requestId, ctx.organizationId, cause);
  }

  if (result.success) {
    const transaction = result.transaction;
    const persistedAmountUsd = transaction ? Math.abs(Number(transaction.amount)) : Number.NaN;
    const transactionMetadata =
      transaction?.metadata && typeof transaction.metadata === "object" ? transaction.metadata : {};
    if (
      !transaction ||
      transaction.organization_id !== ctx.organizationId ||
      transactionMetadata.requestId !== ctx.requestId ||
      !Number.isFinite(persistedAmountUsd)
    ) {
      markOrgAdmissionRefused(ctx.organizationId);
      try {
        await invalidateOrgBalanceHint(ctx.organizationId);
      } catch (invalidationError) {
        logger.error("[InferenceBilling] failed to invalidate mismatched debit replay", {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          error:
            invalidationError instanceof Error
              ? invalidationError.message
              : String(invalidationError),
        });
      }
      throw new InferenceDebitReplayMismatchError(
        ctx.requestId,
        ctx.organizationId,
        amountUsd,
        persistedAmountUsd,
      );
    }
    if (Math.abs(persistedAmountUsd - amountUsd) > 0.000001) {
      logger.warn("[InferenceBilling] idempotent debit replay used the first committed amount", {
        organizationId: ctx.organizationId,
        requestId: ctx.requestId,
        attemptedAmountUsd: amountUsd,
        persistedAmountUsd,
      });
    }
    // The committed debit already evicted the gate hint via onCreditMutation.
    // Republish authoritative balance + revision so the NEXT turn hits a warm
    // entry instead of a fail-closed cache-warming 503. The revision-aware
    // Durable Object remains the Worker dispatch authority if concurrent cache
    // writers arrive out of order.
    try {
      await republishOrgBalanceHintAfterDebit(
        ctx.organizationId,
        result.newBalance,
        result.balanceRevision,
      );
    } catch (cause) {
      markOrgAdmissionRefused(ctx.organizationId);
      try {
        await invalidateOrgBalanceHint(ctx.organizationId);
      } catch (invalidationError) {
        logger.error("[InferenceBilling] failed to invalidate after balance-hint write failure", {
          organizationId: ctx.organizationId,
          requestId: ctx.requestId,
          error:
            invalidationError instanceof Error
              ? invalidationError.message
              : String(invalidationError),
        });
      }
      // error-policy:J2 the debit committed and is safe to replay by its
      // deterministic key; preserve the cache failure for task retry.
      throw new InferenceDebitInfrastructureError(ctx.requestId, ctx.organizationId, cause);
    }
    return {
      status: "collected",
      attemptedAmountUsd: amountUsd,
      collectedAmountUsd: persistedAmountUsd,
      newBalanceUsd: result.newBalance,
      transactionId: transaction.id,
    };
  }

  // Uncollected: balance can't go negative, so the debit was refused. Record
  // it and force the org off the fast path until it tops up.
  logger.error("[InferenceBilling] uncollected inference charge", {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    requestId: ctx.requestId,
    amountUsd,
    source,
    reason: result.reason,
  });
  await invalidateOrgBalanceHint(ctx.organizationId);
  void apiKeysService.invalidateInferenceContextForUser(ctx.userId).catch((error) => {
    // error-policy:J5 - the org balance hint is already invalidated above,
    // so the next request leaves the optimistic path. User IAC eviction is
    // a best-effort acceleration here; contain cache brownouts explicitly.
    logger.error("[InferenceBilling] failed to invalidate user inference auth context", {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      requestId: ctx.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return {
    status: "uncollected",
    attemptedAmountUsd: amountUsd,
    collectedAmountUsd: 0,
    newBalanceUsd: result.newBalance,
    transactionId: null,
    reason: result.reason ?? "insufficient_balance",
  };
}

/**
 * Build a settler with the SAME `(actualCost) => Promise<CreditReconciliationResult|null>`
 * shape as the reservation settler, so the route's post-response billing chain is
 * unchanged. It atomically CLAIMS the pending entry (so the cron sweep can't also
 * charge), then debits the actual cost when > 0. Called with 0 on error/abort,
 * which still claims (removing the pending entry) but charges nothing.
 */
export function createOptimisticDebitSettler(
  ctx: DebitContext,
): (actualCostUsd: number) => Promise<CreditReconciliationResult | null> {
  let claimAttempted = false;
  let claimed: PendingInferenceCharge | null = null;
  let firstActualCostUsd: number | null = null;
  let settlement: Promise<CreditReconciliationResult | null> | null = null;

  const settle = async (): Promise<CreditReconciliationResult | null> => {
    if (!claimAttempted) {
      claimed = await cache.getAndDelete<PendingInferenceCharge>(
        CacheKeys.inference.pendingCharge(ctx.requestId),
      );
      claimAttempted = true;
    }
    // claimed === null → the sweep already settled this request; do nothing.
    if (!claimed) return null;
    const actualCostUsd = firstActualCostUsd ?? 0;
    if (actualCostUsd <= 0) {
      return {
        reservedAmount: 0,
        actualCost: 0,
        settlementTransactionIds: [],
        adjustmentType: "none",
      };
    }
    let outcome: InferenceDebitCollectionOutcome;
    try {
      outcome = await debitInferenceCost(ctx, actualCostUsd, "inline");
    } catch (error) {
      const { v: _version, enqueuedAt: _enqueuedAt, ...charge } = claimed;
      const requeued = await writePendingInferenceCharge(
        { ...charge, estimatedCostUsd: actualCostUsd },
        Date.now(),
      );
      if (!requeued) {
        logger.error("[InferenceBilling] failed to requeue rejected inline debit", {
          requestId: ctx.requestId,
          organizationId: ctx.organizationId,
        });
      }
      throw error;
    }
    return {
      reservedAmount: outcome.collectedAmountUsd,
      actualCost: actualCostUsd,
      settlementTransactionIds: outcome.transactionId ? [outcome.transactionId] : [],
      adjustmentType:
        outcome.status === "collected" && outcome.collectedAmountUsd + 0.000001 >= actualCostUsd
          ? "none"
          : "uncollected_overage",
    };
  };

  return (actualCostUsd: number) => {
    if (firstActualCostUsd === null) firstActualCostUsd = actualCostUsd;
    if (settlement) return settlement;
    const current = settle();
    settlement = current;
    current.then(
      () => undefined,
      () => {
        // error-policy:J5 the caller observes the debit rejection. The claimed
        // record and first actual cost remain in memory for a keyed retry.
        if (settlement === current) settlement = null;
      },
    );
    return current;
  };
}

export interface SweepStats {
  scanned: number;
  settled: number;
  uncollectedOrStale: number;
  skippedYoung: number;
  /** true when this run did no work (another sweep held the lock, or cache down). */
  locked: boolean;
  /** true when the scan hit `maxKeys` — a backlog larger than one run can drain. */
  capHit: boolean;
}

/** Single-flight lock so two overlapping cron sweeps can't both claim+charge an entry. */
const SWEEP_LOCK_KEY = "iac:sweep-lock:v1";
const SWEEP_LOCK_TTL_MS = 50_000; // < 60s cron interval; auto-expires if a run dies

/**
 * Cron backstop: settle pending charges whose inline settle never ran. Only
 * touches entries older than the grace window (younger ones may still be in
 * flight). Claims each via getAndDelete so it never races a concurrent inline
 * settle. Charges the ESTIMATE (the inline path, when it runs, charges actual).
 *
 * Single-flighted via a best-effort lock (real exclusion on atomic backends;
 * a no-op on Cloudflare KV, where overlapping sweeps plus non-atomic getAndDelete
 * remain a documented residual — the production-grade fix is a DB-backed ledger,
 * see packages/cloud/api/docs/inference-hot-path.md). `maxKeys` bounds work per
 * run; a `capHit` means the backlog exceeds one run and is logged, not silently
 * dropped.
 */
export async function sweepStalePendingInferenceCharges(opts?: {
  graceMs?: number;
  maxKeys?: number;
  now?: number;
}): Promise<SweepStats> {
  const graceMs = opts?.graceMs ?? DEFAULT_SWEEP_GRACE_MS;
  const maxKeys = opts?.maxKeys ?? 1000;
  const now = opts?.now ?? Date.now();

  const idle: SweepStats = {
    scanned: 0,
    settled: 0,
    uncollectedOrStale: 0,
    skippedYoung: 0,
    locked: true,
    capHit: false,
  };

  let lockOwned = false;
  try {
    lockOwned = await cache.setIfNotExists(SWEEP_LOCK_KEY, now, SWEEP_LOCK_TTL_MS);
  } catch {
    return idle; // cache unavailable → nothing to sweep
  }
  if (!lockOwned) return idle; // another sweep is already running this minute

  try {
    const keys = await cache.scanByPrefix(CacheKeys.inference.pendingChargePrefix(), maxKeys);
    const stats: SweepStats = {
      scanned: keys.length,
      settled: 0,
      uncollectedOrStale: 0,
      skippedYoung: 0,
      locked: false,
      capHit: keys.length >= maxKeys,
    };

    for (const key of keys) {
      const pending = await cache.get<unknown>(key);
      if (!pending || !isPendingInferenceCharge(pending)) {
        await cache.del(key);
        stats.uncollectedOrStale++;
        continue;
      }
      if (now - pending.enqueuedAt < graceMs) {
        stats.skippedYoung++;
        continue;
      }
      // Claim atomically; if the inline settle grabbed it first, getAndDelete → null.
      const claimed = await cache.getAndDelete<PendingInferenceCharge>(key);
      if (!claimed || !isPendingInferenceCharge(claimed)) continue;
      if (claimed.estimatedCostUsd > 0) {
        let outcome: InferenceDebitCollectionOutcome;
        try {
          outcome = await debitInferenceCost(
            {
              requestId: claimed.requestId,
              organizationId: claimed.organizationId,
              userId: claimed.userId,
              model: claimed.model,
              provider: claimed.provider,
              billingSource: claimed.billingSource,
            },
            claimed.estimatedCostUsd,
            "backstop",
          );
        } catch (error) {
          const { v: _version, enqueuedAt: _enqueuedAt, ...charge } = claimed;
          const requeued = await writePendingInferenceCharge(charge, Date.now());
          if (!requeued) {
            logger.error("[InferenceBilling] failed to requeue rejected backstop debit", {
              requestId: claimed.requestId,
              organizationId: claimed.organizationId,
            });
          }
          throw error;
        }
        if (
          outcome.status === "uncollected" ||
          outcome.collectedAmountUsd + 0.000001 < claimed.estimatedCostUsd
        ) {
          stats.uncollectedOrStale++;
          continue;
        }
      }
      stats.settled++;
    }

    if (stats.capHit) {
      logger.warn("[InferenceBilling] pending-charge sweep hit its scan cap — backlog growing", {
        maxKeys,
        scanned: stats.scanned,
      });
    }
    if (stats.settled > 0 || stats.uncollectedOrStale > 0) {
      logger.warn("[InferenceBilling] swept stale pending charges (dropped inline settles)", stats);
    }
    return stats;
  } finally {
    await cache.del(SWEEP_LOCK_KEY).catch((error) => {
      // error-policy:J6 lock release is teardown; failure delays the next sweep until TTL expiry.
      logger.warn("[InferenceBilling] failed to release pending-charge sweep lock", {
        lockKey: SWEEP_LOCK_KEY,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
