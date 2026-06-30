/**
 * DB-backed pending-charge + settlement ledger for Tier-2 optimistic inference
 * billing (#9899) — the documented "next step" that closes the at-scale residuals
 * a KV-only backstop cannot:
 *
 *   - **Hard concurrent-overdraw bound.** Admission runs ONE atomic statement
 *     that locks the org row (`FOR UPDATE`), subtracts the SUM of the org's
 *     still-pending charges from its balance, and only inserts a new pending row
 *     if `balance - in-flight >= estimate` (and `balance > threshold`). Concurrent
 *     admissions for one org serialize on the row lock, so a burst can never
 *     collectively overdraw — the KV gate could only bound this softly via the
 *     threshold.
 *   - **Exactly-once settlement.** `request_id` is the table PK and the settle is
 *     an atomic `UPDATE ... WHERE status = 'pending'` claim, so the inline settler
 *     and the cron sweep can never both charge one request. (KV's get-then-delete
 *     was only near-atomic ⇒ a rare double-bill; the row claim removes it.)
 *   - **Age-ordered sweep drain.** The cron drains oldest-pending-first through an
 *     indexed `ORDER BY enqueued_at` cursor and loops until empty — no silent cap.
 *
 * Money flow mirrors the KV path: admit (reserve in-flight) → forward → settle the
 * ACTUAL cost off the response path (sweep settles the ESTIMATE for stragglers).
 * The actual debit goes through the single audited `creditsService.deductCredits`
 * mutation (atomic balance guard + `CHECK(credit_balance >= 0)` + all
 * notifications), so there is exactly ONE credit-mutation codepath. A debit the DB
 * refuses (would go negative) is recorded `uncollected` and the org self-heals onto
 * the safe synchronous-reserve path — bounded over-spend, never free-forever.
 *
 * Selected by `INFERENCE_BILLING_LEDGER="db"` (default `kv` = the existing backstop
 * in `inference-billing-fast-path.ts`); both are gated behind
 * `INFERENCE_OPTIMISTIC_BILLING`. See `packages/cloud/api/docs/inference-hot-path.md`.
 */

import { sql } from "drizzle-orm";
import { sqlRows } from "../../db/execute-helpers";
import { dbWrite } from "../../db/helpers";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";
import { type CreditReconciliationResult, creditsService } from "./credits";
import { invalidateOrgBalanceHint } from "./inference-auth-cache";

export type InferenceBillingLedger = "db" | "kv";

type StringEnv = Record<string, string | undefined>;

/**
 * Which durable backstop the optimistic path uses. Default `kv` (the shipped
 * backstop) so flipping `INFERENCE_BILLING_LEDGER` is the only thing that moves an
 * environment onto the DB ledger — a deliberate, soak-then-cutover migration.
 */
export function resolveInferenceBillingLedger(
  env: StringEnv = getCloudAwareEnv(),
): InferenceBillingLedger {
  return (env.INFERENCE_BILLING_LEDGER ?? "").trim().toLowerCase() === "db" ? "db" : "kv";
}

/** Default sweep grace: a pending row older than this with no inline settle is a straggler. */
const DEFAULT_SWEEP_GRACE_MS = 20 * 60 * 1000; // 20 min (> max route duration)

export interface LedgerChargeContext {
  requestId: string;
  organizationId: string;
  userId: string;
  apiKeyId: string | null;
  model: string;
  provider: string;
  billingSource: string;
}

export interface LedgerAdmission {
  admitted: boolean;
  /** Why admission was refused — for the `[preforward]` log / fallback decision. */
  reason?: "ineligible" | "org_not_found" | "error";
}

interface AdmissionRow {
  org_exists: boolean | "t" | "f" | null;
  admitted_request_id: string | null;
}

function isPgTrue(value: boolean | "t" | "f" | null | undefined): boolean {
  return value === true || value === "t";
}

/**
 * Atomically admit an optimistic charge against the org's available balance.
 *
 * One statement, one org-row lock: read the live balance, sum the org's
 * still-`pending` charges, and INSERT a pending row ONLY when the balance clears
 * the threshold AND `balance - in-flight >= estimate`. Returns `admitted:false`
 * (→ caller takes the synchronous reserve) when the gate fails, the org is
 * missing, or the row already exists (idempotent re-delivery). Never throws — a
 * DB error resolves to `admitted:false` so the request falls back to the safe
 * path rather than forwarding on an unrecorded charge.
 */
export async function admitInferenceChargeViaLedger(params: {
  charge: LedgerChargeContext;
  estimatedCostUsd: number;
  thresholdUsd: number;
}): Promise<LedgerAdmission> {
  const { charge, estimatedCostUsd, thresholdUsd } = params;

  // +Inf threshold (misconfig / unset SAFE_BALANCE_THRESHOLD) ⇒ no org is ever
  // fast-pathed. Mirror the fast-path gate's fail-safe so the two backends agree.
  if (!Number.isFinite(thresholdUsd)) return { admitted: false, reason: "ineligible" };
  if (!(estimatedCostUsd >= 0)) return { admitted: false, reason: "ineligible" };

  try {
    const rows = await sqlRows<AdmissionRow>(
      dbWrite,
      sql`
        WITH locked_org AS (
          SELECT id, credit_balance::numeric AS balance
          FROM organizations
          WHERE id = ${charge.organizationId}
          FOR UPDATE
        ),
        inflight AS (
          SELECT COALESCE(SUM(estimated_cost_usd), 0)::numeric AS pending_sum
          FROM inference_pending_charges
          WHERE organization_id = ${charge.organizationId}
            AND status = 'pending'
        ),
        gate AS (
          SELECT locked_org.id
          FROM locked_org, inflight
          WHERE locked_org.balance > ${String(thresholdUsd)}::numeric
            AND (locked_org.balance - inflight.pending_sum) >= ${String(estimatedCostUsd)}::numeric
        ),
        inserted AS (
          INSERT INTO inference_pending_charges (
            request_id, organization_id, user_id, api_key_id,
            model, provider, billing_source, estimated_cost_usd, status, enqueued_at
          )
          SELECT
            ${charge.requestId}, gate.id, ${charge.userId}, ${charge.apiKeyId},
            ${charge.model}, ${charge.provider}, ${charge.billingSource},
            ${String(estimatedCostUsd)}::numeric, 'pending', NOW()
          FROM gate
          ON CONFLICT (request_id) DO NOTHING
          RETURNING request_id
        )
        SELECT
          EXISTS(SELECT 1 FROM locked_org) AS org_exists,
          (SELECT request_id FROM inserted) AS admitted_request_id
      `,
    );
    const row = rows[0];
    if (!row || !isPgTrue(row.org_exists)) return { admitted: false, reason: "org_not_found" };
    if (!row.admitted_request_id) return { admitted: false, reason: "ineligible" };
    return { admitted: true };
  } catch (error) {
    logger.error("[InferenceLedger] admission failed; falling back to synchronous reserve", {
      requestId: charge.requestId,
      organizationId: charge.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { admitted: false, reason: "error" };
  }
}

interface ClaimRow {
  organization_id: string | null;
}

/**
 * Atomically CLAIM a pending charge: flip `pending → settled` for this request and
 * stamp the cost. Returns the org id when THIS caller won the claim, or null when
 * the row was already settled (the sweep got there first, or a duplicate settle).
 * This `WHERE status = 'pending'` transition is the exactly-once gate — only one of
 * {inline settler, sweep} can ever own a given request.
 */
async function claimPendingCharge(requestId: string, costUsd: number): Promise<string | null> {
  const rows = await sqlRows<ClaimRow>(
    dbWrite,
    sql`
      UPDATE inference_pending_charges
      SET status = 'settled', settled_at = NOW(), actual_cost_usd = ${String(costUsd)}::numeric
      WHERE request_id = ${requestId} AND status = 'pending'
      RETURNING organization_id
    `,
  );
  return rows[0]?.organization_id ?? null;
}

/** Mark a claimed row `uncollected` for audit when its debit was refused. Best-effort. */
async function markUncollected(requestId: string): Promise<void> {
  try {
    await dbWrite.execute(
      sql`UPDATE inference_pending_charges SET status = 'uncollected' WHERE request_id = ${requestId}`,
    );
  } catch (error) {
    logger.warn("[InferenceLedger] failed to mark charge uncollected", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Debit a claimed charge through the single audited credit mutation. On a refused
 * debit (balance would go negative — the DB forbids it) record the uncollected
 * amount, drop the org-balance hint, and mark the row; the org's next admission
 * reads the now-depleted balance and self-heals onto the synchronous-reserve path.
 * Never throws.
 */
async function debitClaimedCharge(
  ctx: LedgerChargeContext,
  amountUsd: number,
  source: "inline" | "sweep",
): Promise<void> {
  try {
    const result = await creditsService.deductCredits({
      organizationId: ctx.organizationId,
      amount: amountUsd,
      description: `Inference (ledger ${source}): ${ctx.model}`,
      metadata: {
        user_id: ctx.userId,
        requestId: ctx.requestId,
        model: ctx.model,
        provider: ctx.provider,
        billingSource: ctx.billingSource,
        type: "inference_optimistic_ledger",
        source,
      },
    });
    if (result.success) return;
    logger.error("[InferenceLedger] uncollected inference charge", {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      requestId: ctx.requestId,
      amountUsd,
      source,
      reason: result.reason,
    });
    await invalidateOrgBalanceHint(ctx.organizationId);
    await markUncollected(ctx.requestId);
  } catch (error) {
    logger.error("[InferenceLedger] inference debit threw", {
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
 * Build the post-response settler. Same `(actualCost) => Promise<...>` shape as the
 * reservation/KV settlers, so the route's single settle chain is unchanged. It
 * CLAIMS the pending row (exactly-once) then debits the actual cost; called with 0
 * on error/abort, which still claims (clearing the row) but charges nothing.
 */
export function createLedgerDebitSettler(
  ctx: LedgerChargeContext,
): (actualCostUsd: number) => Promise<CreditReconciliationResult | null> {
  return async (actualCostUsd: number) => {
    const claimedOrg = await claimPendingCharge(ctx.requestId, Math.max(actualCostUsd, 0));
    if (!claimedOrg) return null; // already settled by the sweep / a prior call
    if (actualCostUsd > 0) {
      await debitClaimedCharge(ctx, actualCostUsd, "inline");
    }
    return null;
  };
}

export interface LedgerSweepStats {
  scanned: number;
  settled: number;
  skipped: number;
  batches: number;
  /** true when the sweep hit its batch ceiling — a backlog larger than one run can drain. */
  capHit: boolean;
}

interface SweepRow {
  request_id: string;
  organization_id: string;
  user_id: string | null;
  model: string;
  provider: string;
  billing_source: string;
  estimated_cost_usd: string;
}

/**
 * Cron backstop: settle pending rows whose inline settle never ran (isolate
 * eviction / dropped waitUntil). Drains oldest-pending-first in age-ordered
 * batches until empty (cursor by `enqueued_at`), bounded by `maxBatches`. Each row
 * is settled through the SAME atomic claim, so overlapping cron runs and a racing
 * inline settler can never double-charge — which is why this needs no KV-style
 * single-flight lock. Charges the ESTIMATE (the actual is unknown once the inline
 * path is lost).
 */
export async function sweepStalePendingInferenceChargesDb(opts?: {
  graceMs?: number;
  batchSize?: number;
  maxBatches?: number;
  now?: number;
}): Promise<LedgerSweepStats> {
  const graceMs = opts?.graceMs ?? DEFAULT_SWEEP_GRACE_MS;
  const batchSize = opts?.batchSize ?? 200;
  const maxBatches = opts?.maxBatches ?? 50;
  const now = opts?.now ?? Date.now();
  const cutoff = new Date(now - graceMs);

  const stats: LedgerSweepStats = {
    scanned: 0,
    settled: 0,
    skipped: 0,
    batches: 0,
    capHit: false,
  };

  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await sqlRows<SweepRow>(
      dbWrite,
      sql`
        SELECT request_id, organization_id, user_id, model, provider, billing_source, estimated_cost_usd
        FROM inference_pending_charges
        WHERE status = 'pending' AND enqueued_at < ${cutoff.toISOString()}
        ORDER BY enqueued_at ASC
        LIMIT ${batchSize}
      `,
    );
    if (rows.length === 0) break;
    stats.batches++;
    stats.scanned += rows.length;

    for (const row of rows) {
      const estimate = Number(row.estimated_cost_usd);
      const claimedOrg = await claimPendingCharge(
        row.request_id,
        Number.isFinite(estimate) ? estimate : 0,
      );
      if (!claimedOrg) {
        // Lost the claim to a concurrent inline settle — counts as handled, not work.
        stats.skipped++;
        continue;
      }
      if (Number.isFinite(estimate) && estimate > 0) {
        await debitClaimedCharge(
          {
            requestId: row.request_id,
            organizationId: row.organization_id,
            userId: row.user_id ?? "",
            apiKeyId: null,
            model: row.model,
            provider: row.provider,
            billingSource: row.billing_source,
          },
          estimate,
          "sweep",
        );
      }
      stats.settled++;
    }

    if (rows.length < batchSize) break;
    if (batch === maxBatches - 1) stats.capHit = true;
  }

  if (stats.capHit) {
    logger.warn("[InferenceLedger] pending-charge sweep hit its batch ceiling — backlog growing", {
      maxBatches,
      batchSize,
      scanned: stats.scanned,
    });
  }
  if (stats.settled > 0 || stats.skipped > 0) {
    logger.warn("[InferenceLedger] swept stale pending charges (dropped inline settles)", stats);
  }
  return stats;
}
