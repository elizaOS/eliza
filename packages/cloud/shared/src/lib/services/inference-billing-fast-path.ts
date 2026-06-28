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
 * unique constraint (migration) — see packages/cloud-api/docs/inference-hot-path.md.
 */

import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import { apiKeysService } from "./api-keys";
import { type CreditReconciliationResult, creditsService } from "./credits";
import {
  INFERENCE_AUTH_CONTEXT_VERSION,
  invalidateOrgBalanceHint,
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

export function isOptimisticBillingEnabled(
  env: { INFERENCE_OPTIMISTIC_BILLING?: string } = getCloudAwareEnv(),
): boolean {
  return (env.INFERENCE_OPTIMISTIC_BILLING ?? "").trim() === "true";
}

/**
 * Resolve SAFE_BALANCE_THRESHOLD (USD). Fails SAFE: unset / blank / non-finite /
 * non-positive → +Infinity, so no org is ever fast-pathed on misconfiguration.
 */
export function resolveSafeBalanceThresholdUsd(
  env: { SAFE_BALANCE_THRESHOLD?: string } = getCloudAwareEnv(),
): number {
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

/** Write the durable pending-charge backstop before forwarding to the model. */
export async function writePendingInferenceCharge(
  charge: Omit<PendingInferenceCharge, "v" | "enqueuedAt">,
  now: number,
): Promise<void> {
  const record: PendingInferenceCharge = {
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    enqueuedAt: now,
    ...charge,
  };
  await cache.set(
    CacheKeys.inference.pendingCharge(charge.requestId),
    record,
    CacheTTL.inference.pendingCharge,
  );
}

interface DebitContext {
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
 */
async function debitInferenceCost(
  ctx: DebitContext,
  amountUsd: number,
  source: "inline" | "backstop",
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
      await writeOrgBalanceHint(ctx.organizationId, result.newBalance, Date.now());
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
    void apiKeysService.invalidateInferenceContextForUser(ctx.userId);
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
}

/**
 * Cron backstop: settle pending charges whose inline settle never ran. Only
 * touches entries older than the grace window (younger ones may still be in
 * flight). Claims each via getAndDelete so it never races a concurrent inline
 * settle. Charges the ESTIMATE (the inline path, when it runs, charges actual).
 */
export async function sweepStalePendingInferenceCharges(opts?: {
  graceMs?: number;
  maxKeys?: number;
  now?: number;
}): Promise<SweepStats> {
  const graceMs = opts?.graceMs ?? DEFAULT_SWEEP_GRACE_MS;
  const maxKeys = opts?.maxKeys ?? 500;
  const now = opts?.now ?? Date.now();

  const keys = await cache.scanByPrefix(CacheKeys.inference.pendingChargePrefix(), maxKeys);
  const stats: SweepStats = {
    scanned: keys.length,
    settled: 0,
    uncollectedOrStale: 0,
    skippedYoung: 0,
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

  if (stats.settled > 0 || stats.uncollectedOrStale > 0) {
    logger.warn("[InferenceBilling] swept stale pending charges (dropped inline settles)", stats);
  }
  return stats;
}
