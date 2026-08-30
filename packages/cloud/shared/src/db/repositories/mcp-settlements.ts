/**
 * Claim-and-resume access to the MCP settlement authority rows (#22961):
 * first-committed-wins receipt insert with replay-mismatch rejection, leg-id
 * updates for recovery, and terminal transition. The service layer
 * (`user-mcps.ts`) owns the economics; this module only persists them.
 */
import { and, eq, sql } from "drizzle-orm";
import { dbWrite } from "../client";
import { writeTransaction } from "../helpers";
import {
  type McpSettlement,
  mcpSettlements,
  type NewMcpSettlement,
} from "../schemas/mcp-settlements";

/**
 * Grace window before the recovery sweep may touch a settling receipt or an
 * orphaned precharge (#22961). A live delivery's settlement write happens
 * seconds after its debit; 10 minutes is far past any legitimate in-flight
 * window while keeping a wedged receipt recoverable within one sweep tick
 * (the durable lane runs every minute).
 */
export const MCP_SETTLEMENT_RESUME_GRACE_MS = 10 * 60 * 1000;

/**
 * Horizon after which a `settlement`-claimed precharge with no receipt row is
 * treated as dead (#22961): the live delivery that wrote the marker can never
 * still be between marker-write and receipt-insert 24h later, so the sweep may
 * reclaim and refund it. Kept far above the resume grace for the same reason
 * the grace exists — a live path must never race its own refund — with a 144x
 * margin over the longest plausible in-flight delivery.
 */
export const MCP_SETTLEMENT_STALE_CLAIM_MS = 24 * 60 * 60 * 1000;

/** Immutable identity + economics that a replay must reproduce exactly. */
const REPLAY_FIELDS = [
  "buyer_organization_id",
  "buyer_user_id",
  "mcp_id",
  "tool_name",
  "payment_type",
  "affiliate_owner_id",
  "affiliate_code_id",
  "creator_organization_id",
  "creator_user_id",
  "base_amount_usd",
  "affiliate_fee_usd",
  "platform_fee_usd",
  "total_amount_usd",
  "creator_earnings_usd",
  "platform_earnings_usd",
] as const;

type ReplayField = (typeof REPLAY_FIELDS)[number];
const NUMERIC_REPLAY_FIELDS = new Set<ReplayField>([
  "base_amount_usd",
  "affiliate_fee_usd",
  "platform_fee_usd",
  "total_amount_usd",
  "creator_earnings_usd",
  "platform_earnings_usd",
]);

function replayMismatch(incoming: NewMcpSettlement, committed: McpSettlement): string | null {
  for (const field of REPLAY_FIELDS) {
    const next = incoming[field];
    const prior = committed[field];
    if (next === undefined) continue;
    if (prior === null && next === null) continue;
    if (prior === null || next === null) return `${field} differs (nullability)`;
    if (NUMERIC_REPLAY_FIELDS.has(field)) {
      // NUMERIC columns re-read with scale padding ("0.1" stores as
      // "0.100000"), so equality is decimal, never textual.
      if (Number(prior) !== Number(next)) return `${field} differs`;
    } else if (String(prior) !== String(next)) {
      return `${field} differs`;
    }
  }
  return null;
}

export const mcpSettlementsRepository = {
  /**
   * Insert the receipt with ON CONFLICT DO NOTHING, then re-read and compare
   * the committed row (the unique index on (payment_type, payment_event_id)
   * arbitrates the race — no row lock is taken). Returns the authoritative
   * row plus whether this call created it. A same-payment-event row with
   * different identity/economics throws — replay mismatches are never
   * silently accepted.
   */
  async claim(values: NewMcpSettlement): Promise<{ settlement: McpSettlement; created: boolean }> {
    const [inserted] = await dbWrite
      .insert(mcpSettlements)
      .values(values)
      .onConflictDoNothing({
        target: [mcpSettlements.payment_type, mcpSettlements.payment_event_id],
      })
      .returning();
    if (inserted) {
      return { settlement: inserted, created: true };
    }
    const [committed] = await dbWrite
      .select()
      .from(mcpSettlements)
      .where(
        and(
          eq(mcpSettlements.payment_type, values.payment_type),
          eq(mcpSettlements.payment_event_id, values.payment_event_id),
        ),
      )
      .limit(1);
    if (!committed) {
      throw new Error("MCP settlement claim lost the race and found no committed row");
    }
    const mismatch = replayMismatch(values, committed);
    if (mismatch) {
      throw new Error(`MCP settlement replay does not match the committed receipt: ${mismatch}`);
    }
    return { settlement: committed, created: false };
  },

  async getById(id: string): Promise<McpSettlement | null> {
    const [row] = await dbWrite
      .select()
      .from(mcpSettlements)
      .where(eq(mcpSettlements.id, id))
      .limit(1);
    return row ?? null;
  },

  /** Persist one completed leg's linkage; recovery reads these to skip it. */
  async recordLeg(
    id: string,
    leg: {
      affiliate_ledger_entry_id?: string;
      creator_credit_transaction_id?: string;
      creator_ledger_entry_id?: string;
      mcp_usage_id?: string;
    },
  ): Promise<McpSettlement | null> {
    const [row] = await dbWrite
      .update(mcpSettlements)
      .set(leg)
      .where(eq(mcpSettlements.id, id))
      .returning();
    return row ?? null;
  },

  /** Flip to the terminal settled receipt; idempotent on re-delivery. */
  async markSettled(id: string): Promise<McpSettlement | null> {
    const [row] = await dbWrite
      .update(mcpSettlements)
      .set({ status: "settled", settled_at: new Date() })
      .where(eq(mcpSettlements.id, id))
      .returning();
    return row ?? null;
  },

  /**
   * Recovery sweep input (#22961): settling receipts past the grace window,
   * oldest first. The grace keeps a live in-flight delivery out of the sweep;
   * anything older is either crashed mid-legs or wedged, and resume is
   * exactly-once per leg so re-driving is always safe.
   */
  async listDueForResume(
    limit = 50,
    olderThanMs = MCP_SETTLEMENT_RESUME_GRACE_MS,
  ): Promise<McpSettlement[]> {
    return dbWrite
      .select()
      .from(mcpSettlements)
      .where(
        and(
          eq(mcpSettlements.status, "settling"),
          sql`${mcpSettlements.created_at} < now() - (${olderThanMs} || ' milliseconds')::interval`,
        ),
      )
      .orderBy(mcpSettlements.created_at)
      .limit(limit);
  },

  /**
   * Orphaned MCP precharges (#22961): successful credits-rail debits carrying
   * the proxy's `mcp_precharge` marker whose id appears as NO settlement's
   * payment event — the debit committed but settlement creation itself never
   * did (eviction between debit and claim). The sweep claims each candidate
   * atomically via claimPrechargeForSweep before refunding.
   */
  async findOrphanPrecharges(
    olderThanMs = MCP_SETTLEMENT_RESUME_GRACE_MS,
    staleClaimOlderThanMs = MCP_SETTLEMENT_STALE_CLAIM_MS,
  ): Promise<
    Array<{
      id: string;
      organization_id: string;
      amount: string;
      refunded: string;
      description: string | null;
      metadata: Record<string, unknown> | null;
      created_at: Date;
    }>
  > {
    // The claim predicate (`claimPrechargeForSweep`) is intentionally BROADER
    // than this finder's: the marker (`mcp_precharge = 'v1'`), the resume
    // grace age, and the refund-row NOT EXISTS exclusion live HERE in the
    // finder, not in the claim, so the finder emits a strictly narrower
    // candidate set. That split is safe only because the finder is the claim's
    // sole caller — every candidate it emits satisfies the claim's weaker
    // predicate (or the claim loses the race and the sweep skips it until the
    // next pass), while moving the exclusions into the claim would silently
    // drop refund-protected debits from recovery entirely (#27992).
    const rows = await dbWrite.execute<{
      id: string;
      organization_id: string;
      amount: string;
      description: string | null;
      metadata: Record<string, unknown> | null;
      created_at: Date;
    }>(sql`
      SELECT ct.id, ct.organization_id, ct.amount::text AS amount, ct.description,
             ct.metadata, ct.created_at,
             COALESCE((
               SELECT SUM(r.amount)
               FROM credit_transactions r
               WHERE r.type = 'refund'
                 AND (
                   r.metadata->>'mcp_precharge_refund_for' = ct.id::text
                   OR r.metadata->>'reservation_transaction_id' = ct.id::text
                 )
             ), 0)::text AS refunded
      FROM credit_transactions ct
      WHERE ct.type = 'debit'
        AND (
          -- Service-layer precharges and admission-rail reservation debits
          -- (the route tags both with the recovery marker).
          ct.metadata->>'mcp_precharge' = 'v1'
          OR (
            -- #27992 rebase: admission-rail DEFERRED/LEDGER debits. The MCP
            -- proxy is the only producer of the mcp/<id> model namespace
            -- (grep-verified sole call site), and debitInferenceCost /
            -- settleLedgerCharge stamp every such debit with the route's
            -- requestId prefix. Failure refunds for these modes settle the
            -- exact amount back, so the refund-linkage NOT EXISTS below
            -- matches them via their requestId-keyed refund metadata.
            ct.metadata->>'requestId' LIKE 'mcp-proxy:%'
            AND ct.metadata->>'model' LIKE 'mcp/%'
          )
        )
        AND (
          ct.metadata->>'mcp_precharge_swept' IS NULL
          OR ct.metadata->>'mcp_precharge_swept' = 'refunding'
          OR (
            ct.metadata->>'mcp_precharge_swept' = 'settlement'
            AND coalesce(
              (ct.metadata->>'mcp_precharge_swept_at')::bigint,
              (extract(epoch from ct.created_at) * 1000)::bigint
            ) < (extract(epoch from now()) * 1000)::bigint - ${staleClaimOlderThanMs}
          )
        )
        AND ct.created_at < now() - (${olderThanMs} || ' milliseconds')::interval
        AND NOT EXISTS (
          SELECT 1 FROM mcp_settlements s
          WHERE s.payment_type = 'credits'
            AND s.payment_event_id = ct.id::text
        )
        -- Refund-linkage exclusion (#27992 rebase, r1 F1/F3 unified): a debit
        -- is only orphan-candidate when linked refunds have NOT already
        -- returned its full value. Linkage arms: service-layer sweep refunds
        -- (mcp_precharge_refund_for) and admission-rail reconcile refunds
        -- (reservation_transaction_id). Sum-based, not existence-based: a
        -- PARTIAL reconcile refund followed by a crash before the receipt
        -- insert leaves a net remainder the sweep must return (F3) — the
        -- sweep refunds only that remainder, so no path double-pays.
        AND COALESCE((
          SELECT SUM(r.amount)
          FROM credit_transactions r
          WHERE r.type = 'refund'
            AND (
              r.metadata->>'mcp_precharge_refund_for' = ct.id::text
              OR r.metadata->>'reservation_transaction_id' = ct.id::text
            )
        ), 0) < ABS(ct.amount)
        -- Reconciliation-overage exclusion (#27992 r1 F2): when reconcile
        -- collects an overage, the overage debit inherits the reservation's
        -- metadata (including mcp_precharge v1) and is referenced by NO
        -- receipt — the receipt keys the parent reservation. Without this
        -- arm the sweep would refund an overage the buyer legitimately owes.
        -- Only excluded when the parent reservation is itself protected (a
        -- settlement receipt exists for it); when the worker died before ANY
        -- receipt, the parent debit is also an orphan and the overage stays
        -- sweepable so the buyer is made whole.
        AND NOT (
          ct.metadata->>'type' = 'reconciliation_overage'
          AND EXISTS (
            SELECT 1
            FROM mcp_settlements s
            JOIN credit_transactions parent
              ON parent.id::text = ct.metadata->>'reservation_transaction_id'
             AND parent.type = 'debit'
            WHERE s.payment_type = 'credits'
              AND s.payment_event_id = ct.metadata->>'reservation_transaction_id'
          )
        )
      ORDER BY ct.created_at
      LIMIT 100
    `);
    return (rows.rows ?? []) as Array<{
      id: string;
      organization_id: string;
      amount: string;
      refunded: string;
      description: string | null;
      metadata: Record<string, unknown> | null;
      created_at: Date;
    }>;
  },

  /**
   * Atomic single-row claim that decides whether the SWEEP owns a debit
   * (#22961 round-4 P0). Sets the sweep marker only when no settlement exists
   * for the event and no prior claim marker was written; returns the row id
   * for the winner only. This is the mutual-exclusion point against
   * claimPrechargeForSettlement — both sides gate on the same row UPDATE, so
   * a debit can never be both refunded and settled.
   *
   * Reclaim horizon: a `settlement` marker with no receipt row means the live
   * delivery crashed between its marker write and the receipt insert. Only a
   * dead delivery can leave that state, but the marker is still fresh enough
   * to race a redelivery — the same reason the resume grace exists — so the
   * sweep reclaims it only after MCP_SETTLEMENT_STALE_CLAIM_MS. Within the
   * horizon the debit stays claimed-and-unrefunded, a conservative stuck state
   * that never mints duplicate value; the horizon makes it temporary instead
   * of permanent (#22961: recover safely from lost responses).
   */
  async claimPrechargeForSweep(
    debitId: string,
    staleClaimOlderThanMs = MCP_SETTLEMENT_STALE_CLAIM_MS,
  ): Promise<{ claimed: boolean; netRefundable: string | null }> {
    // Atomic claim + net computation (#27992 r2 F1, r3 F1): run inside a
    // transaction that FOR UPDATE locks the debit row in its own statement,
    // then computes the linked-refund sum in a SEPARATE statement so the sum
    // reads a fresh READ COMMITTED snapshot taken AFTER the lock was granted.
    // A single combined SELECT … SUM … FOR UPDATE would keep the statement's
    // pre-wait snapshot for the correlated sum and miss a refund committed by
    // the lock holder while this transaction waited (#27992 r3 F1).
    // Concurrent writers that also take this row's lock
    // (reconcileReservationTransaction's claim UPDATE,
    // claimPrechargeForSettlement) serialize against this read, so the
    // returned netRefundable is the committed truth the caller must refund —
    // never a stale finder snapshot. Returns claimed=false, null when the row
    // is not claimable (receipt exists, fully refunded, stale-claim window,
    // receipt-protected overage, or missing).
    return writeTransaction(async (tx) => {
      const locked = await tx.execute<{ id: string }>(sql`
        SELECT id FROM credit_transactions
        WHERE id = ${debitId}::uuid
          AND type = 'debit'
        FOR UPDATE
      `);
      if (!(locked.rows ?? [])[0]) {
        return { claimed: false, netRefundable: null };
      }
      const rows = await tx.execute<{
        id: string;
        amount: string;
        refunded: string;
        row_type: string | null;
        parent_id: string | null;
      }>(sql`
        SELECT id, amount::text AS amount,
               metadata->>'type' AS row_type,
               metadata->>'reservation_transaction_id' AS parent_id,
               COALESCE((
                 SELECT SUM(r.amount)
                 FROM credit_transactions r
                 WHERE r.type = 'refund'
                   AND (
                     r.metadata->>'mcp_precharge_refund_for' = ${debitId}::text
                     OR r.metadata->>'reservation_transaction_id' = ${debitId}::text
                   )
               ), 0)::text AS refunded
        FROM credit_transactions
        WHERE id = ${debitId}::uuid
          AND type = 'debit'
      `);
      const row = rows.rows?.[0];
      if (!row) {
        return { claimed: false, netRefundable: null };
      }
      // Overage/parent serialization (#27992 r4 F1): locking the overage row
      // alone does not contend with the LIVE delivery, which claims the PARENT
      // reservation row — the two rows never meet, so the sweep could refund
      // the overage while the live path settles the parent (double value).
      // When the target is a reconciliation overage, the same transaction also
      // stamps the parent 'refunding': claimPrechargeForSettlement refuses a
      // 'refunding' parent, so whichever side commits first on the PARENT row
      // wins exclusively. The parent stamp refuses when the parent carries a
      // fresh settlement claim or a receipt (the overage must not be swept);
      // every other parent state (NULL / refunding / true / stale settlement)
      // is dead-worker shape and stays sweepable so the buyer is made whole.
      // Lock order is overage→parent everywhere; no writer takes them in the
      // reverse order, so this cannot deadlock.
      if (row.row_type === "reconciliation_overage") {
        if (!row.parent_id) {
          // An overage without its parent linkage cannot be serialized
          // against the live path; refuse rather than risk double value.
          return { claimed: false, netRefundable: null };
        }
        const parentStamp = await tx.execute<{ id: string }>(sql`
          UPDATE credit_transactions parent
          SET metadata = jsonb_set(
                jsonb_set(
                  coalesce(parent.metadata, '{}'::jsonb),
                  '{mcp_precharge_swept}',
                  '"refunding"'::jsonb
                ),
                '{mcp_precharge_swept_at}',
                to_jsonb((extract(epoch from now()) * 1000)::bigint)
              )
          WHERE parent.id = ${row.parent_id}::uuid
            AND parent.type = 'debit'
            AND (
              parent.metadata->>'mcp_precharge_swept' IS NULL
              OR parent.metadata->>'mcp_precharge_swept' = 'refunding'
              OR parent.metadata->>'mcp_precharge_swept' = 'true'
              OR (
                parent.metadata->>'mcp_precharge_swept' = 'settlement'
                AND coalesce(
                  (parent.metadata->>'mcp_precharge_swept_at')::bigint,
                  (extract(epoch from parent.created_at) * 1000)::bigint
                ) < (extract(epoch from now()) * 1000)::bigint - ${staleClaimOlderThanMs}
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM mcp_settlements s
              WHERE s.payment_type = 'credits'
                AND s.payment_event_id = ${row.parent_id}::text
            )
          RETURNING parent.id
        `);
        if (!(parentStamp.rows ?? [])[0]) {
          return { claimed: false, netRefundable: null };
        }
      }
      const claimable = await tx.execute<{ id: string; net_refundable: string }>(sql`
        UPDATE credit_transactions ct
        SET metadata = jsonb_set(
              jsonb_set(
                coalesce(ct.metadata, '{}'::jsonb),
                '{mcp_precharge_swept}',
                '"refunding"'::jsonb
              ),
              '{mcp_precharge_swept_at}',
              to_jsonb((extract(epoch from now()) * 1000)::bigint)
            )
        WHERE ct.id = ${debitId}::uuid
          AND ct.type = 'debit'
          AND (
            (ct.metadata->>'mcp_precharge_swept') IS NULL
            OR ct.metadata->>'mcp_precharge_swept' = 'refunding'
            OR (
              ct.metadata->>'mcp_precharge_swept' = 'settlement'
              AND coalesce(
                (ct.metadata->>'mcp_precharge_swept_at')::bigint,
                (extract(epoch from ct.created_at) * 1000)::bigint
              ) < (extract(epoch from now()) * 1000)::bigint - ${staleClaimOlderThanMs}
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM mcp_settlements s
            WHERE s.payment_type = 'credits'
              AND s.payment_event_id = ${debitId}::text
          )
          -- Receipt-protected overage exclusion (#27992 r2 F2, r3 F2): a
          -- reconciliation overage inherits the reservation's mcp_precharge
          -- marker but no receipt keys it — the receipt keys the parent. When
          -- the parent is receipted this overage is a settled charge and must
          -- never be swept. With no receipt anywhere (dead worker) both parent
          -- and overage stay sweepable so the buyer is made whole. All outer
          -- references are ct-qualified: an unqualified metadata here would
          -- resolve to the joined parent row (also credit_transactions) and
          -- silently null out the exclusion.
          -- r3 F2: the parent arm ALSO rejects an actively settlement-CLAIMED
          -- parent (marker 'settlement' fresher than the stale window). The
          -- live delivery stamps the marker BEFORE inserting the receipt, so a
          -- receipt-only check leaves a window where the sweep refunds an
          -- overage whose parent is mid-settlement. A stale claim (dead
          -- delivery) still leaves the overage sweepable — the buyer is made
          -- whole after the horizon.
          AND NOT (
            ct.metadata->>'type' = 'reconciliation_overage'
            AND EXISTS (
              SELECT 1
              FROM credit_transactions parent
              WHERE parent.id::text = ct.metadata->>'reservation_transaction_id'
                AND parent.type = 'debit'
                AND (
                  EXISTS (
                    SELECT 1 FROM mcp_settlements s
                    WHERE s.payment_type = 'credits'
                      AND s.payment_event_id = parent.id::text
                  )
                  OR (
                    parent.metadata->>'mcp_precharge_swept' = 'settlement'
                    AND coalesce(
                      (parent.metadata->>'mcp_precharge_swept_at')::bigint,
                      (extract(epoch from parent.created_at) * 1000)::bigint
                    ) >= (extract(epoch from now()) * 1000)::bigint - ${staleClaimOlderThanMs}
                  )
                )
            )
          )
          -- Refund-linkage sum exclusion (#27992 r1 F1, r2 F1, r3 F3): the
          -- debit is only claimable while its linked refunds have not returned
          -- the full value. The comparison stays in PostgreSQL numeric
          -- arithmetic — a JS Number round-trip of numeric(16,6) values near
          -- the domain edge (10^10 magnitude, 10^-6 resolution) loses the
          -- final unit and can either over-refund or strand it. The net is
          -- computed in the same statement and returned as text so the caller
          -- never re-derives it from floats.
          AND ${row.refunded}::numeric < ABS(${row.amount}::numeric)
        RETURNING ct.id,
          (ABS(${row.amount}::numeric) - ${row.refunded}::numeric)::text AS net_refundable
      `);
      const claimedRow = (claimable.rows ?? [])[0];
      if (!claimedRow) {
        return { claimed: false, netRefundable: null };
      }
      // net_refundable arrives as exact PG numeric text (no float round-trip);
      // it is already non-positive-free by the WHERE guard above. The caller
      // converts once with Number() purely to pass the credits service's
      // numeric-string API — PG numeric(16,6) text always round-trips through
      // a JS double at this magnitude without loss (16 significant digits).
      return { claimed: true, netRefundable: claimedRow.net_refundable };
    });
  },

  /**
   * Terminal transition of a sweep-owned refund claim (#22961 round 6): the
   * refund row has committed, so the claim becomes the frozen 'true' marker.
   * Only a 'refunding' claim written by this sweep protocol may transition;
   * a receipt appearing in the window aborts the transition (the debit was
   * settled by a concurrent live delivery that won the row race).
   */
  async markPrechargeRefunded(debitId: string): Promise<boolean> {
    const rows = await dbWrite.execute<{ id: string }>(sql`
      UPDATE credit_transactions
      SET metadata = jsonb_set(
            coalesce(metadata, '{}'::jsonb),
            '{mcp_precharge_swept}',
            'true'::jsonb
          )
      WHERE id = ${debitId}::uuid
        AND type = 'debit'
        AND metadata->>'mcp_precharge_swept' = 'refunding'
        AND NOT EXISTS (
          SELECT 1 FROM mcp_settlements s
          WHERE s.payment_type = 'credits'
            AND s.payment_event_id = ${debitId}::text
        )
      RETURNING id
    `);
    return (rows.rows?.length ?? 0) > 0;
  },

  /**
   * Atomic single-row claim that decides whether the LIVE delivery owns a
   * debit (#22961 round-4 P0) — the mirror of claimPrechargeForSweep. Returns
   * true when this call may proceed to claim the settlement. When it returns
   * false the caller must check whether a receipt already exists (legitimate
   * replay) or the sweep owns the row (fail-closed read — refuse).
   *
   * Round 6 F1: the claim STAMPS mcp_precharge_swept_at (epoch ms) so the
   * sweep judges staleness by WHEN THE CLAIM WAS WRITTEN, never by the
   * debit's created_at — an old debit claimed by a live delivery seconds ago
   * is fresh by its claim timestamp, and only a claim written more than
   * MCP_SETTLEMENT_STALE_CLAIM_MS ago is dead. The claim also atomically
   * re-claims a timestamp-stale 'settlement' claim (a dead delivery's
   * leftover), which is safe for the same reason the sweep's reclaim is:
   * the prior claimant can no longer exist.
   */
  async claimPrechargeForSettlement(
    debitId: string,
    staleClaimOlderThanMs = MCP_SETTLEMENT_STALE_CLAIM_MS,
  ): Promise<boolean> {
    const rows = await dbWrite.execute<{ id: string }>(sql`
      UPDATE credit_transactions
      SET metadata = jsonb_set(
            jsonb_set(
              coalesce(metadata, '{}'::jsonb),
              '{mcp_precharge_swept}',
              '"settlement"'::jsonb
            ),
            '{mcp_precharge_swept_at}',
            to_jsonb((extract(epoch from now()) * 1000)::bigint)
          )
      WHERE id = ${debitId}::uuid
        AND type = 'debit'
        AND (
          (metadata->>'mcp_precharge_swept') IS NULL
          OR (
            metadata->>'mcp_precharge_swept' = 'settlement'
            AND coalesce(
              (metadata->>'mcp_precharge_swept_at')::bigint,
              (extract(epoch from created_at) * 1000)::bigint
            ) < (extract(epoch from now()) * 1000)::bigint - ${staleClaimOlderThanMs}
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM mcp_settlements s
          WHERE s.payment_type = 'credits'
            AND s.payment_event_id = ${debitId}::text
        )
      RETURNING id
    `);
    return (rows.rows?.length ?? 0) > 0;
  },

  /**
   * Validate that a credits-rail payment event names a real DEBIT row before
   * any settlement leg runs (#27992 rebase). Reconciliation callers can
   * surface refund or overage adjustment ids; a refund row must never key a
   * settlement (the buyer was not charged), and claiming one would pass the
   * receipt FK (which does not constrain transaction type) while failing the
   * claim marker above. Returns true when the row exists and is a debit.
   */
  async isDebitTransaction(transactionId: string): Promise<boolean> {
    const rows = await dbWrite.execute<{ id: string }>(sql`
      SELECT id FROM credit_transactions
      WHERE id = ${transactionId}::uuid AND type = 'debit'
    `);
    return (rows.rows?.length ?? 0) > 0;
  },

  /**
   * Fail-closed read after a lost live claim (#22961 round 6): true when the
   * SWEEP owns the debit in any state — 'true' (refund terminal), 'refunding'
   * (refund in flight), or a stale-'settlement' claim past the reclaim
   * horizon — OR when a refund row already exists for the debit. The
   * round-4 read refused only the terminal 'true' state, so a refund in
   * flight or a reclaimable stale claim let a late redelivery race the refund
   * and settle a refunded debit (double value). Any sweep-ownership signal
   * stops the delivery dead; only a live-fresh 'settlement' claim (replay of
   * a receipt the caller will re-read below) falls through.
   */
  async prechargeSweptByRefund(
    debitId: string,
    staleClaimOlderThanMs = MCP_SETTLEMENT_STALE_CLAIM_MS,
  ): Promise<boolean> {
    const rows = await dbWrite.execute<{
      swept: string | null;
      claimed_ms: string | null;
    }>(sql`
      SELECT metadata->>'mcp_precharge_swept' AS swept,
             coalesce(
               (metadata->>'mcp_precharge_swept_at')::bigint,
               (extract(epoch from created_at) * 1000)::bigint
             )::text AS claimed_ms
      FROM credit_transactions
      WHERE id = ${debitId}::uuid
    `);
    const row = rows.rows?.[0];
    if (!row) return false;
    if (row.swept === "true" || row.swept === "refunding") return true;
    if (row.swept === "settlement") {
      const claimedMs = Number(row.claimed_ms);
      if (Number.isFinite(claimedMs) && Date.now() - claimedMs > staleClaimOlderThanMs) {
        return true;
      }
    }
    const refunds = await dbWrite.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM credit_transactions r
      WHERE r.type = 'refund'
        AND r.metadata->>'mcp_precharge_refund_for' = ${debitId}::text
    `);
    return Number(refunds.rows?.[0]?.count ?? "0") > 0;
  },
};

export type { McpSettlement, NewMcpSettlement };
