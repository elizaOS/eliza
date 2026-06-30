/**
 * DB-backed pending-charge + settlement ledger for Tier-2 optimistic inference
 * billing (#9899) — the documented "next step" that closes the at-scale residuals
 * a KV-only backstop cannot:
 *
 *   - **Hard concurrent-overdraw bound.** Admission runs inside a transaction that
 *     first takes a per-org advisory lock (`pg_advisory_xact_lock`), THEN reads the
 *     org balance + the SUM of its still-`pending` charges and inserts a `pending`
 *     row only if `balance > threshold AND balance - in-flight >= estimate`. The
 *     advisory lock serializes admissions for one org, so each reads the in-flight
 *     SUM only after any concurrent admission has COMMITTED (READ COMMITTED takes a
 *     fresh snapshot per statement) — a burst can never collectively overdraw. A
 *     bare `FOR UPDATE` on the org row is NOT enough: the in-flight SUM scans a
 *     different table and would read a stale MVCC snapshot, so two admissions would
 *     both see the same pre-insert SUM and both admit (the bug the advisory lock
 *     fixes; single-connection PGlite masks it, real Postgres does not).
 *   - **Exactly-once settlement, crash-safe.** The claim (`UPDATE … SET
 *     status='settled' WHERE status='pending'`) and the actual debit run in ONE
 *     transaction. Only one of {inline settler, cron sweep} can win the `pending`
 *     transition (exactly-once), and because claim+debit commit together a crash
 *     between them ROLLS BACK the claim — the row stays `pending` and the sweep
 *     recovers it (no lost charge), and no other transaction ever observes a
 *     "claimed-but-not-debited" state (no over-admit window).
 *   - **Age-ordered sweep drain.** The cron drains oldest-pending-first via an
 *     indexed `ORDER BY enqueued_at` cursor, looping batches until empty, and GCs
 *     terminal rows past a retention window so the table cannot grow unbounded.
 *
 * The debit is replicated here (the same atomic `FOR UPDATE` balance guard +
 * `credit_transactions` row as `creditsService.reserveAndDeductCredits`) so it can
 * run INSIDE the claim transaction — `deductCredits` cannot take an external
 * transaction. A debit the DB refuses (`credit_balance >= 0` CHECK) marks the row
 * `uncollected` (auditable) and the org self-heals onto the synchronous-reserve
 * path on its next admission (the slow path re-engages low-credit / auto-top-up
 * notifications). Cache invalidation fires post-commit.
 *
 * Selected by `INFERENCE_BILLING_LEDGER="db"` (default `kv` = the existing backstop
 * in `inference-billing-fast-path.ts`); both are gated behind
 * `INFERENCE_OPTIMISTIC_BILLING`. See `packages/cloud/api/docs/inference-hot-path.md`.
 */

import { sql } from "drizzle-orm";
import { sqlRows } from "../../db/execute-helpers";
import { dbWrite, writeTransaction } from "../../db/helpers";
import { CacheInvalidation } from "../cache/invalidation";
import { invalidateOrganizationCache } from "../cache/organizations-cache";
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
/** Terminal rows (settled/uncollected) older than this are GC'd so the table stays bounded. */
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h — well past the sweep grace

export interface LedgerChargeContext {
  requestId: string;
  organizationId: string;
  userId: string | null;
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

function isPgTrue(value: boolean | "t" | "f" | number | string | null | undefined): boolean {
  return value === true || value === "t" || value === 1 || value === "1" || value === "true";
}

interface AdmissionRow {
  org_exists: boolean | "t" | "f" | null;
  admitted_request_id: string | null;
}

/**
 * Atomically admit an optimistic charge against the org's available balance.
 *
 * Serialized per org by a transaction-scoped advisory lock so the in-flight SUM is
 * read only after any concurrent admission for the same org has committed — that
 * is what makes the overdraw bound HARD. Returns `admitted:false` (→ caller takes
 * the synchronous reserve) when the gate fails, the org is missing, or the row
 * already exists (idempotent re-delivery). Never throws — a DB error resolves to
 * `admitted:false` so the request falls back to the safe path rather than
 * forwarding on an unrecorded charge.
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
    return await writeTransaction(async (tx) => {
      // Serialize admissions for THIS org. Held until commit, so the next admission
      // reads the in-flight SUM below only after ours is durable.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`inference_admit:${charge.organizationId}`}))`,
      );
      const rows = await sqlRows<AdmissionRow>(
        tx,
        sql`
          WITH org AS (
            SELECT id, credit_balance::numeric AS balance
            FROM organizations
            WHERE id = ${charge.organizationId}
          ),
          inflight AS (
            SELECT COALESCE(SUM(estimated_cost_usd), 0)::numeric AS pending_sum
            FROM inference_pending_charges
            WHERE organization_id = ${charge.organizationId}
              AND status = 'pending'
          ),
          gate AS (
            SELECT org.id
            FROM org, inflight
            WHERE org.balance > ${String(thresholdUsd)}::numeric
              AND (org.balance - inflight.pending_sum) >= ${String(estimatedCostUsd)}::numeric
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
            EXISTS(SELECT 1 FROM org) AS org_exists,
            (SELECT request_id FROM inserted) AS admitted_request_id
        `,
      );
      const row = rows[0];
      if (!row || !isPgTrue(row.org_exists)) return { admitted: false, reason: "org_not_found" };
      if (!row.admitted_request_id) return { admitted: false, reason: "ineligible" };
      return { admitted: true };
    });
  } catch (error) {
    logger.error("[InferenceLedger] admission failed; falling back to synchronous reserve", {
      requestId: charge.requestId,
      organizationId: charge.organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { admitted: false, reason: "error" };
  }
}

interface SettleOutcome {
  claimed: boolean;
  debited: boolean;
  uncollected: boolean;
  newBalance?: number;
}

interface ClaimRow {
  organization_id: string | null;
}
interface DebitRow {
  debited: boolean | "t" | "f" | null;
  new_balance: string | number | null;
}

/**
 * Settle a pending charge in ONE transaction: atomically claim it
 * (`pending → settled`, the exactly-once gate) and, when the cost is > 0, debit it
 * with the same atomic balance guard (`FOR UPDATE` + `credit_balance >= amount`)
 * and `credit_transactions` row that `reserveAndDeductCredits` uses. Because both
 * happen in one transaction, a crash rolls back the claim (the sweep re-finds a
 * `pending` row) and no concurrent admission ever sees a claimed-but-undebited
 * state. A refused debit (would overdraw) marks the row `uncollected`. Never throws.
 */
async function settleLedgerCharge(
  ctx: LedgerChargeContext,
  amountUsd: number,
  source: "inline" | "sweep",
): Promise<SettleOutcome> {
  let outcome: SettleOutcome = { claimed: false, debited: false, uncollected: false };
  try {
    outcome = await writeTransaction(async (tx) => {
      const claimed = await sqlRows<ClaimRow>(
        tx,
        sql`
          UPDATE inference_pending_charges
          SET status = 'settled', settled_at = NOW(), actual_cost_usd = ${String(Math.max(amountUsd, 0))}::numeric
          WHERE request_id = ${ctx.requestId} AND status = 'pending'
          RETURNING organization_id
        `,
      );
      if (claimed.length === 0) return { claimed: false, debited: false, uncollected: false };
      if (!(amountUsd > 0)) return { claimed: true, debited: false, uncollected: false };

      const metadataJson = JSON.stringify({
        user_id: ctx.userId,
        requestId: ctx.requestId,
        model: ctx.model,
        provider: ctx.provider,
        billingSource: ctx.billingSource,
        type: "inference_optimistic_ledger",
        source,
      });
      const debit = await sqlRows<DebitRow>(
        tx,
        sql`
          WITH locked AS (
            SELECT id, credit_balance::numeric AS bal
            FROM organizations
            WHERE id = ${ctx.organizationId}
            FOR UPDATE
          ),
          upd AS (
            UPDATE organizations o
            SET credit_balance = o.credit_balance - ${String(amountUsd)}::numeric, updated_at = NOW()
            FROM locked
            WHERE o.id = locked.id AND locked.bal >= ${String(amountUsd)}::numeric
            RETURNING o.credit_balance AS new_balance
          ),
          ins AS (
            INSERT INTO credit_transactions (organization_id, amount, type, description, metadata, created_at)
            SELECT ${ctx.organizationId}, ${String(-amountUsd)}::numeric, 'debit',
              ${`Inference (ledger ${source}): ${ctx.model}`}, ${metadataJson}::jsonb, NOW()
            WHERE EXISTS (SELECT 1 FROM upd)
            RETURNING id
          )
          SELECT EXISTS(SELECT 1 FROM upd) AS debited, (SELECT new_balance FROM upd) AS new_balance
        `,
      );
      const debited = isPgTrue(debit[0]?.debited);
      if (!debited) {
        await tx.execute(
          sql`UPDATE inference_pending_charges SET status = 'uncollected' WHERE request_id = ${ctx.requestId}`,
        );
        return { claimed: true, debited: false, uncollected: true };
      }
      const nb = debit[0]?.new_balance;
      return {
        claimed: true,
        debited: true,
        uncollected: false,
        newBalance: nb === null || nb === undefined ? undefined : Number(nb),
      };
    });
  } catch (error) {
    // The transaction rolled back (the row stays `pending` for the sweep). Surface
    // it; never swallow into a false "settled".
    logger.error("[InferenceLedger] settle transaction failed; charge left pending for sweep", {
      requestId: ctx.requestId,
      organizationId: ctx.organizationId,
      amountUsd,
      source,
      error: error instanceof Error ? error.message : String(error),
    });
    return { claimed: false, debited: false, uncollected: false };
  }

  // Post-commit side-effects (cache freshness; alerting). Outside the transaction.
  if (!outcome.claimed) return outcome;
  if (outcome.debited) {
    await CacheInvalidation.onCreditMutation(ctx.organizationId).catch(() => {});
    invalidateOrganizationCache(ctx.organizationId).catch(() => {});
    invalidateOrgBalanceHint(ctx.organizationId).catch(() => {});
    // Parity with deductCredits: fire low-credits email + auto-top-up + the waifu
    // hosted-agent pause webhook so an org draining via optimistic inference still
    // gets low-balance warnings (the ledger debits with its own SQL, not deductCredits).
    if (outcome.newBalance !== undefined) {
      creditsService.notifyBalanceDecrease(ctx.organizationId, outcome.newBalance, {
        user_id: ctx.userId,
        requestId: ctx.requestId,
        model: ctx.model,
        provider: ctx.provider,
        billingSource: ctx.billingSource,
        type: "inference_optimistic_ledger",
        source,
      });
    }
  } else if (outcome.uncollected) {
    logger.error("[InferenceLedger] uncollected inference charge", {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      requestId: ctx.requestId,
      amountUsd,
      source,
    });
    invalidateOrgBalanceHint(ctx.organizationId).catch(() => {});
  }
  return outcome;
}

/**
 * Build the post-response settler. Same `(actualCost) => Promise<...>` shape as the
 * reservation/KV settlers, so the route's single settle chain is unchanged. Claims
 * + debits the actual cost atomically; called with 0 on error/abort, which still
 * claims (clearing the row) but charges nothing.
 */
export function createLedgerDebitSettler(
  ctx: LedgerChargeContext,
): (actualCostUsd: number) => Promise<CreditReconciliationResult | null> {
  return async (actualCostUsd: number) => {
    await settleLedgerCharge(ctx, actualCostUsd, "inline");
    return null;
  };
}

export interface LedgerSweepStats {
  scanned: number;
  settled: number;
  skipped: number;
  batches: number;
  gcDeleted: number;
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
 * is settled through the SAME atomic transactional claim, so overlapping cron runs
 * and a racing inline settler can never double-charge — which is why this needs no
 * KV-style single-flight lock. Charges the ESTIMATE (the actual is unknown once the
 * inline path is lost). Finally GCs terminal rows older than the retention window
 * so the table cannot grow unbounded.
 *
 * The staleness cutoff is computed IN SQL (`enqueued_at < NOW() - interval`) so it
 * is timezone-consistent with the `NOW()`-written `enqueued_at` — a client-side ISO
 * string would skew under any non-UTC DB session timezone.
 */
export async function sweepStalePendingInferenceChargesDb(opts?: {
  graceMs?: number;
  batchSize?: number;
  maxBatches?: number;
  retentionMs?: number;
}): Promise<LedgerSweepStats> {
  const graceMs = opts?.graceMs ?? DEFAULT_SWEEP_GRACE_MS;
  const batchSize = opts?.batchSize ?? 200;
  const maxBatches = opts?.maxBatches ?? 50;
  const retentionMs = opts?.retentionMs ?? DEFAULT_RETENTION_MS;

  const stats: LedgerSweepStats = {
    scanned: 0,
    settled: 0,
    skipped: 0,
    batches: 0,
    gcDeleted: 0,
    capHit: false,
  };

  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await sqlRows<SweepRow>(
      dbWrite,
      sql`
        SELECT request_id, organization_id, user_id, model, provider, billing_source, estimated_cost_usd
        FROM inference_pending_charges
        WHERE status = 'pending'
          AND enqueued_at < NOW() - (${String(graceMs)} || ' milliseconds')::interval
        ORDER BY enqueued_at ASC
        LIMIT ${batchSize}
      `,
    );
    if (rows.length === 0) break;
    stats.batches++;
    stats.scanned += rows.length;

    for (const row of rows) {
      const estimate = Number(row.estimated_cost_usd);
      const outcome = await settleLedgerCharge(
        {
          requestId: row.request_id,
          organizationId: row.organization_id,
          userId: row.user_id,
          apiKeyId: null,
          model: row.model,
          provider: row.provider,
          billingSource: row.billing_source,
        },
        Number.isFinite(estimate) ? estimate : 0,
        "sweep",
      );
      if (outcome.claimed) stats.settled++;
      else stats.skipped++; // lost the claim to a concurrent inline settle — already handled
    }

    if (rows.length < batchSize) break;
    if (batch === maxBatches - 1) stats.capHit = true;
  }

  // GC terminal rows so a caller-supplied request_id can't pin an immortal row and
  // the table stays bounded. Idempotent; runs every sweep. RETURNING + row count is
  // driver-portable (PGlite's result does not expose a reliable `rowCount`).
  try {
    const deleted = await sqlRows<{ request_id: string }>(
      dbWrite,
      sql`
        DELETE FROM inference_pending_charges
        WHERE status IN ('settled', 'uncollected')
          AND settled_at IS NOT NULL
          AND settled_at < NOW() - (${String(retentionMs)} || ' milliseconds')::interval
        RETURNING request_id
      `,
    );
    stats.gcDeleted = deleted.length;
  } catch (error) {
    logger.warn("[InferenceLedger] pending-charge GC failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (stats.capHit) {
    logger.warn("[InferenceLedger] pending-charge sweep hit its batch ceiling — backlog growing", {
      maxBatches,
      batchSize,
      scanned: stats.scanned,
    });
  }
  if (stats.settled > 0 || stats.skipped > 0 || stats.gcDeleted > 0) {
    logger.warn("[InferenceLedger] swept stale pending charges (dropped inline settles)", stats);
  }
  return stats;
}
