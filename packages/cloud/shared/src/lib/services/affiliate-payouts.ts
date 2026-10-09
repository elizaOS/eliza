/**
 * Affiliate-only payouts (#23022 follow-up).
 *
 * Creator monetization is retired and creator balances are frozen, but the
 * affiliate program continues. Creator and affiliate earnings share one
 * redeemable balance per user, so a payout must never draw on the frozen part.
 * The payable amount is:
 *
 *   min(affiliate net since retirement, available balance - frozen available)
 *
 * where "affiliate net since retirement" sums the user's `affiliate` ledger
 * earnings and adjustments (payout debits, reversals, rejected-payout
 * refunds) after the retirement instant (the user's statement `frozen_at`, or
 * the global `creator_monetization_retirement.retired_at`). Affiliate earnings
 * that were unpaid at retirement are part of the frozen statement and are
 * settled manually with it. The check and the debit run in one transaction
 * under the same per-user advisory lock the earnings ledger uses, so
 * concurrent payouts cannot both pass the check.
 */

import Decimal from "decimal.js";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { type DbTransaction, dbWrite } from "../../db/client";
import {
  creatorEarningsRetirementStatements,
  creatorMonetizationRetirement,
} from "../../db/schemas/creator-earnings-retirement-statements";
import { redeemableEarnings, redeemableEarningsLedger } from "../../db/schemas/redeemable-earnings";
import { ApiError } from "../api/cloud-worker-errors";
import { normalizeLedgerSourceId } from "../utils/ledger-source-id";
import { redeemableEarningsService } from "./redeemable-earnings";

export interface AffiliatePayableBalance {
  /** Amount an affiliate payout may debit now, USD with 4 decimals. */
  payableUsd: string;
  affiliateNetSinceRetirementUsd: string;
  availableBalanceUsd: string;
  frozenAvailableUsd: string;
  retiredAt: string;
}

/** Refusal when a payout would draw on frozen creator earnings. */
export class AffiliatePayoutExceedsPayableError extends ApiError {
  constructor(requestedUsd: string, payableUsd: string) {
    super(
      409,
      "affiliate_payout_exceeds_payable",
      "Only affiliate earnings credited after creator monetization was retired can be paid out.",
      { requestedUsd, payableUsd },
    );
    this.name = "AffiliatePayoutExceedsPayableError";
  }
}

function usd(value: Decimal): string {
  return value.toFixed(4);
}

function lockUser(tx: DbTransaction, userId: string) {
  return tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`redeemable_earnings:${userId}`}))`,
  );
}

async function payableInTransaction(
  tx: DbTransaction,
  userId: string,
): Promise<AffiliatePayableBalance> {
  const [retirement] = await tx.select().from(creatorMonetizationRetirement).limit(1);
  if (!retirement) {
    // error-policy:J4 without the retirement instant the frozen/payable split
    // is unknown; refuse rather than risk paying a frozen balance.
    throw new ApiError(
      503,
      "service_unavailable",
      "Affiliate payouts are unavailable until the creator retirement is recorded",
    );
  }
  const [statement] = await tx
    .select()
    .from(creatorEarningsRetirementStatements)
    .where(eq(creatorEarningsRetirementStatements.user_id, userId))
    .limit(1);
  const cutoff = statement?.frozen_at ?? retirement.retired_at;
  const frozenAvailable =
    statement?.status === "frozen" ? new Decimal(statement.available_balance_usd) : new Decimal(0);

  const [balance] = await tx
    .select({ available: redeemableEarnings.available_balance })
    .from(redeemableEarnings)
    .where(eq(redeemableEarnings.user_id, userId))
    .limit(1);
  const available = new Decimal(balance?.available ?? "0");

  const [net] = await tx
    .select({
      total: sql<string>`COALESCE(SUM(${redeemableEarningsLedger.amount}), 0)::text`,
    })
    .from(redeemableEarningsLedger)
    .where(
      and(
        eq(redeemableEarningsLedger.user_id, userId),
        eq(redeemableEarningsLedger.earnings_source, "affiliate"),
        inArray(redeemableEarningsLedger.entry_type, ["earning", "adjustment"]),
        gt(redeemableEarningsLedger.created_at, cutoff),
      ),
    );
  const affiliateNet = new Decimal(net?.total ?? "0");
  const payable = Decimal.max(0, Decimal.min(affiliateNet, available.minus(frozenAvailable)));
  return {
    payableUsd: usd(payable),
    affiliateNetSinceRetirementUsd: usd(affiliateNet),
    availableBalanceUsd: usd(available),
    frozenAvailableUsd: usd(frozenAvailable),
    retiredAt: cutoff.toISOString(),
  };
}

/** Read-only payable affiliate balance for one user. */
export async function getAffiliatePayableBalance(userId: string): Promise<AffiliatePayableBalance> {
  return dbWrite.transaction(async (tx) => {
    await lockUser(tx, userId);
    return payableInTransaction(tx, userId);
  });
}

/**
 * Debit an affiliate payout, idempotent on `idempotencyKey`. A retry of a key
 * that already debited returns the prior debit without re-checking the
 * payable amount. Throws {@link AffiliatePayoutExceedsPayableError} when the
 * amount would reach frozen creator earnings.
 */
export async function debitAffiliatePayout(params: {
  userId: string;
  amountUsd: number;
  idempotencyKey: string;
  description: string;
  metadata?: Record<string, unknown>;
}): Promise<{ newBalance: number; deduplicated: boolean; ledgerEntryId?: string }> {
  const amount = new Decimal(params.amountUsd);
  if (!amount.isFinite() || !amount.gt(0) || !amount.times(100).isInteger()) {
    throw new ApiError(400, "validation_error", "Payout amount must be positive whole cents");
  }
  return dbWrite.transaction(async (tx) => {
    await lockUser(tx, params.userId);
    const [existing] = await tx
      .select({ id: redeemableEarningsLedger.id, amount: redeemableEarningsLedger.amount })
      .from(redeemableEarningsLedger)
      .where(
        and(
          eq(redeemableEarningsLedger.user_id, params.userId),
          eq(redeemableEarningsLedger.entry_type, "adjustment"),
          eq(redeemableEarningsLedger.earnings_source, "affiliate"),
          eq(redeemableEarningsLedger.source_id, normalizeLedgerSourceId(params.idempotencyKey)),
        ),
      )
      .limit(1);
    if (existing && !new Decimal(existing.amount).equals(amount.negated())) {
      throw new ApiError(
        409,
        "billing_state_conflict",
        "Payout idempotency key was already used for a different amount",
      );
    }
    if (!existing) {
      const payable = await payableInTransaction(tx, params.userId);
      if (amount.gt(payable.payableUsd)) {
        throw new AffiliatePayoutExceedsPayableError(usd(amount), payable.payableUsd);
      }
    }
    const debit = await redeemableEarningsService.reduceEarnings({
      userId: params.userId,
      amount: amount.toNumber(),
      source: "affiliate",
      sourceId: params.idempotencyKey,
      description: params.description,
      metadata: { ...params.metadata, payout_kind: "affiliate" },
      requireSufficientBalance: true,
      dedupeBySourceId: true,
      countAsRedeemed: true,
      transaction: tx,
    });
    if (!debit.success) {
      throw new ApiError(409, "billing_state_conflict", debit.error ?? "Failed to reserve balance");
    }
    return {
      newBalance: debit.newBalance ?? 0,
      deduplicated: debit.deduplicated === true,
      ledgerEntryId: debit.ledgerEntryId,
    };
  });
}
