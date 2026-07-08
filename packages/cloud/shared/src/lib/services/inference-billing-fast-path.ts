/**
 * Tier-2 optimistic off-path billing for inference (#9899).
 *
 * When enabled (INFERENCE_OPTIMISTIC_BILLING="true") and an org's balance
 * comfortably clears SAFE_BALANCE_THRESHOLD, a chat-completions request SKIPS
 * the synchronous credit reserve and instead:
 *   1. writes a durable per-request "pending charge" to KV (fast, CF-native) —
 *      the BACKSTOP against a dropped post-response settle;
 *   2. forwards to the model;
 *   3. debits the ACTUAL cost off the response path (the existing
 *      settleReservation chain, now backed by `createOptimisticDebitSettler`);
 *   4. the inline settler atomically claims (getAndDelete) the pending entry so
 *      the cron sweep won't double-charge.
 *
 * A cron sweep (`sweepStalePendingInferenceCharges`) mops up pending entries
 * older than the grace window whose inline settle never ran (isolate eviction /
 * dropped waitUntil), charging the ESTIMATE. Steady-state the inline path
 * deletes its own entry, so the sweep set is just the rare stragglers — it does
 * NOT process every request (which would not scale).
 *
 * SAFETY:
 *   - credit_balance has a DB CHECK(>=0); a debit that would overdraw fails
 *     (success:false) rather than going negative → that is uncollected revenue,
 *     NOT a free-forever loop: on any failed debit we invalidate the org-balance
 *     hint + the user's auth-context so the next request drops to the safe
 *     synchronous-reserve path, and log for alerting.
 *   - SAFE_BALANCE_THRESHOLD defaults to +Infinity (every org slow-paths) when
 *     unset/invalid — fail SAFE, never fast.
 *   - All of this is gated behind INFERENCE_OPTIMISTIC_BILLING (default OFF);
 *     OFF behavior is the existing synchronous reserve, unchanged.
 *
 * Residual (documented): exactly-once settlement relies on an atomic
 * getAndDelete claim of the KV pending entry. On the KV backend that is a
 * get-then-delete (near-atomic); a crash between claim and debit loses a single
 * charge (under-bill, never double-bill). True exactly-once would need a DB
 * unique constraint (migration) — see packages/cloud/api/docs/inference-hot-path.md.
 */

import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { apiKeysService } from "./api-keys";
import { type CreditReconciliationResult, creditsService } from "./credits";
import {
  INFERENCE_AUTH_CONTEXT_VERSION,
  invalidateOrgBalanceHint,
  lowerOrgBalanceHint,
  readOrgBalanceHint,
  writeOrgBalanceHint,
} from "./inference-auth-cache";

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

/**
 * Resolve SAFE_BALANCE_THRESHOLD (USD). Fails SAFE: unset / blank / non-finite /
 * non-positive → +Infinity, so no org is ever fast-pathed on misconfiguration.
 */
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
 * Read the gate balance for an org. Uses the short-lived KV hint when present;
 * on a miss reads a FRESH authoritative balance and caches the hint. The
 * fast-vs-safe decision is therefore made on a number at most `orgBalance` TTL
 * old (plus KV lag), which the threshold must account for.
 */
export async function getGateBalanceUsd(organizationId: string): Promise<number> {
  const hint = await readOrgBalanceHint(organizationId);
  if (hint) return hint.balanceUsd;
  const fresh = await creditsService.getOrganizationBalanceUsd(organizationId);
  await writeOrgBalanceHint(organizationId, fresh, Date.now());
  return fresh;
}

/**
 * Decide whether THIS request may take the optimistic path. Requires the flag,
 * org-credits (not app-credits), and a balance that comfortably clears both the
 * configured threshold and this request's estimated cost.
 */
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

/**
 * Debit an inference cost and refresh the org-balance hint. On a failed debit
 * (insufficient balance — the DB forbids negative) record the uncollected
 * amount and force the org back onto the safe path. Never throws.
 *
 * Exported for the deferred-admission settler (`inference-billing-deferred`),
 * which uses it as the fail-closed fallback charge when a deferred durable
 * admission resolves refused after the request already forwarded.
 */
export async function debitInferenceCost(
  ctx: DebitContext,
  amountUsd: number,
  source: "inline" | "backstop" | "deferred",
): Promise<void> {
  try {
    const result = await creditsService.deductCredits({
      organizationId: ctx.organizationId,
      amount: amountUsd,
      description: `Inference (${source}): ${ctx.model}`,
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
    if (result.success) {
      // Lower-only: a debit can only REDUCE the balance, so never let an
      // out-of-order concurrent debit raise the cached gate hint (#9899 #12).
      // Top-ups go through a separate path that invalidates the hint.
      await lowerOrgBalanceHint(ctx.organizationId, result.newBalance, Date.now());
      return;
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
  } catch (error) {
    logger.error("[InferenceBilling] inference debit threw", {
      organizationId: ctx.organizationId,
      requestId: ctx.requestId,
      amountUsd,
      source,
      error: error instanceof Error ? error.message : String(error),
    });
    await invalidateOrgBalanceHint(ctx.organizationId);
  }
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
  return async (actualCostUsd: number) => {
    const claimed = await cache.getAndDelete<PendingInferenceCharge>(
      CacheKeys.inference.pendingCharge(ctx.requestId),
    );
    // claimed === null → the sweep already settled this request; do nothing.
    if (!claimed) return null;
    if (actualCostUsd > 0) {
      await debitInferenceCost(ctx, actualCostUsd, "inline");
    }
    return null;
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
        await debitInferenceCost(
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
    await cache.del(SWEEP_LOCK_KEY).catch(() => {});
  }
}
