/**
 * Tier-3 deferred billing admission for the inference hot path (#9899).
 *
 * Tier-2 (optimistic billing) removed the synchronous credit reserve but still
 * AWAITS a durable admission write on the critical path before forwarding: the
 * DB ledger admission (`admitInferenceChargeViaLedger`, a cross-provider
 * Postgres transaction, ~100–400ms from a CF Worker to Railway) or the KV
 * pending-charge write. Measured warm TTFB through the gateway is ~1.6–1.8s
 * against a ~0.15s provider call, and that admission write is the largest
 * remaining per-request round-trip.
 *
 * Tier-3 moves ONLY the write off the critical path. When enabled
 * (`INFERENCE_DEFERRED_ADMISSION="true"`, default OFF) and the request has a
 * Workers `executionCtx`:
 *
 *   1. The critical path keeps a CACHED balance gate: the 15s org-balance hint
 *      (`getGateBalanceUsd`) + `isOptimisticEligible` + the in-isolate refusal
 *      blocklist below. An org the hint says is broke falls through to the
 *      synchronous reserve and 402s exactly as today.
 *   2. The durable admission (ledger insert or KV pending charge) is STARTED
 *      immediately but not awaited; it is registered with
 *      `executionCtx.waitUntil` so the runtime keeps the isolate alive for it,
 *      and it runs concurrently with the (≥150ms) provider call — in practice
 *      it lands before the first token streams back.
 *   3. The post-response settler (built here) FIRST awaits that admission, so
 *      settlement ordering is unchanged: admitted → the normal ledger/KV
 *      settler claims + debits exactly-once; refused/not-durable → the request
 *      already forwarded, so the settler charges the actual cost directly via
 *      the fail-closed `debitInferenceCost` (uncollected → hint + IAC
 *      invalidation, same as Tier-2), records the org in the refusal blocklist,
 *      and drops the balance hint so the org's NEXT request takes the
 *      synchronous-reserve path (serial traffic 402s one request later;
 *      concurrent worst case is the one 15s hint window described below).
 *
 * Safety envelope vs Tier-2:
 *   - The 402 gate moves from an authoritative in-transaction balance read to
 *     the 15s hint + 60s refusal blocklist — the concurrent worst case is
 *     every request admitted within one 15s hint window (per org, fleet-wide;
 *     the hint is shared) plus in-flight streams, and every slipped request is
 *     still charged (or recorded uncollected) by the fallback debit. Bounded
 *     over-spend, never free-forever; identical in kind to the Tier-2 KV-gate
 *     residual, and a zero-delta on the prod KV config.
 *   - The durable record now depends on `waitUntil` surviving until the
 *     admission write lands (typically < the provider call itself). An isolate
 *     crash in that window loses the pending record AND the settle, i.e. a
 *     single-request under-bill — the same residual class Tier-2 documents for
 *     its claim/debit gap, and why this stays flag-gated to
 *     `SAFE_BALANCE_THRESHOLD`-cleared orgs.
 *   - Monetized-app billing (`reserveInferenceCredits`, #11976 contract) and
 *     the affiliate-marked synchronous reserve (#12749) are NOT eligible; the
 *     route only reaches this module on the org-credits optimistic branch.
 */

import { InMemoryLRUCache } from "../cache/in-memory-lru-cache";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import type { CreditReconciliationResult } from "./credits";
import { invalidateOrgBalanceHint } from "./inference-auth-cache";
import { type DebitContext, debitInferenceCost } from "./inference-billing-fast-path";

type StringEnv = Record<string, string | undefined>;

/**
 * Tier-3 flag. Default OFF — same deliberate soak-then-cutover discipline as
 * `INFERENCE_OPTIMISTIC_BILLING` / `INFERENCE_BILLING_LEDGER`, which it extends
 * (it does nothing unless the optimistic path is enabled and eligible).
 */
export function isDeferredAdmissionEnabled(env: StringEnv = getCloudAwareEnv()): boolean {
  return (env.INFERENCE_DEFERRED_ADMISSION ?? "").trim() === "true";
}

/** Uniform outcome for both deferred producers (ledger admission / KV backstop write). */
export interface DeferredAdmissionOutcome {
  admitted: boolean;
}

/**
 * In-isolate refusal blocklist: orgs whose deferred admission resolved refused
 * (or whose fallback debit failed) skip the deferred path for the TTL, so a
 * broke org cannot free-ride request-after-request inside the balance-hint
 * window. Per-isolate by design — the cross-isolate bound is the 15s org
 * balance hint, which is invalidated on the same events.
 */
const REFUSAL_TTL_MS = 60_000;
const refusedOrgs = new InMemoryLRUCache<true>(4096, REFUSAL_TTL_MS);

export function markOrgAdmissionRefused(organizationId: string): void {
  refusedOrgs.set(organizationId, true);
}

export function isOrgAdmissionRefused(organizationId: string): boolean {
  return refusedOrgs.get(organizationId) === true;
}

/** Test hook: reset the refusal blocklist between tests. */
export function __clearDeferredAdmissionState(): void {
  refusedOrgs.deleteByPrefix("");
}

/**
 * Build the post-response settler for a deferred admission. Same
 * `(actualCost) => Promise<CreditReconciliationResult | null>` shape as every
 * other settler, so the route's single settle chain is unchanged.
 *
 * Awaits the in-flight admission first (both producers resolve, never reject,
 * by contract), then:
 *   - admitted → delegate to the normal exactly-once settler (ledger claim /
 *     KV getAndDelete), preserving all Tier-2/ledger reconciliation semantics;
 *   - refused / not durable → there is no pending record for the sweep to
 *     recover, so charge the actual cost directly (fail-closed
 *     `debitInferenceCost`: uncollected → logged + hint/IAC invalidation) and
 *     push the org onto the refusal blocklist + drop its balance hint so the
 *     next request takes the synchronous reserve.
 *
 * First-call-wins, even on throw (#11512 pattern): the route's error path can
 * invoke the settler twice (handler catch + outer catch). The admitted
 * delegates are claim-idempotent on their own, but the refusal-fallback debit
 * is a direct charge — caching the settlement promise makes a repeat call
 * observe the same resolution instead of debiting again.
 */
export function createDeferredAdmissionSettler(params: {
  admission: Promise<DeferredAdmissionOutcome>;
  onAdmitted: (actualCostUsd: number) => Promise<CreditReconciliationResult | null>;
  fallback: DebitContext;
}): (actualCostUsd: number) => Promise<CreditReconciliationResult | null> {
  let settlement: Promise<CreditReconciliationResult | null> | null = null;

  const settle = async (actualCostUsd: number) => {
    const { admitted } = await params.admission;
    if (admitted) return params.onAdmitted(actualCostUsd);

    markOrgAdmissionRefused(params.fallback.organizationId);
    await invalidateOrgBalanceHint(params.fallback.organizationId);
    if (actualCostUsd > 0) {
      logger.warn(
        "[InferenceBilling] deferred admission refused after forward; charging actual cost directly",
        {
          requestId: params.fallback.requestId,
          organizationId: params.fallback.organizationId,
          actualCostUsd,
        },
      );
      await debitInferenceCost(params.fallback, actualCostUsd, "deferred");
    }
    return null;
  };

  return (actualCostUsd: number) => {
    if (!settlement) settlement = settle(actualCostUsd);
    return settlement;
  };
}
