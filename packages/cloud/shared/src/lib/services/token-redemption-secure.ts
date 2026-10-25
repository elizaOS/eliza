/**
 * Token redemption records (read and operator rejection only).
 *
 * Creator payouts are retired (#23022, owner decision in #22957). Creating,
 * approving and executing redemptions was removed together with the payout
 * processor, so no code path can move a frozen balance out of the ledger.
 * Historical redemptions stay readable, and an operator may still reject a
 * pending redemption, which returns its lock to the user's frozen balance.
 * Unpaid balances are recorded in `creator_earnings_retirement_statements`.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../../db/client";
import { redeemableEarnings, redeemableEarningsLedger } from "../../db/schemas/redeemable-earnings";
import {
  redemptionLimits,
  type TokenRedemption,
  tokenRedemptions,
} from "../../db/schemas/token-redemptions";
import { logger } from "../utils/logger";

// ============================================================================
// HELPER: Sanitize log values (Fix #13)
// ============================================================================

function sanitizeForLog(value: string): string {
  return value
    .replace(/[\r\n]/g, " ") // Remove newlines
    .replace(/[^\x20-\x7E]/g, "?") // Replace non-printable chars
    .slice(0, 100); // Limit length
}

function maskAddress(address: string): string {
  if (address.length < 20) return "***invalid***";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// ============================================================================
// HELPER: Fail-closed NUMERIC parsing for money-out limit gates (Fix #6 hardening)
// ============================================================================

/**
 * A stored `redemption_limits` row NUMERIC value could not be parsed into a
 * finite number. The Postgres driver returns NUMERIC columns as strings, and
 * `'NaN'::numeric` is a *valid* Postgres NUMERIC that reads back as the string
 * `"NaN"`. `Number("NaN") === NaN`, and every `NaN` comparison is `false`, so a
 * corrupt `daily_usd_total` / `redemption_count` would silently make the daily
 * anti-sybil money-out gates fail OPEN (unbounded redemptions). Negative money
 * values are corrupt for these refund/cap paths because they invert balance and
 * limit arithmetic. We throw here so the caller can fail CLOSED (deny) instead
 * of authorizing over a corrupt row.
 */
export class CorruptRedemptionLimitError extends Error {
  constructor(field: string, rawValue: unknown) {
    super(
      `redemption_limits.${field} is not a finite number (got ${JSON.stringify(
        String(rawValue),
      )}); refusing to evaluate the daily limit gate on a corrupt row`,
    );
    this.name = "CorruptRedemptionLimitError";
  }
}

/**
 * Fail-closed boundary for a `redemption_limits` NUMERIC column read.
 *
 * - Rejects null/undefined/empty/whitespace, negative values, and any value
 *   that does not parse to a finite number (NaN, Infinity, `"NaN"`, `""`,
 *   garbage) -> throws.
 * - Allows an explicit domain zero (a fresh/zeroed limit row is legitimate).
 *
 * error-policy:J4 (fail-closed: a corrupt money-out limit value must DENY, not
 * silently authorize an unbounded redemption).
 *
 * Exported for unit testing of the fail-closed boundary.
 */
export function parseRedemptionLimitNumber(value: unknown, field: string): number {
  if (value === null || value === undefined) {
    throw new CorruptRedemptionLimitError(field, value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new CorruptRedemptionLimitError(field, value);
    }
    return value;
  }
  const raw = String(value).trim();
  if (raw === "") {
    throw new CorruptRedemptionLimitError(field, value);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CorruptRedemptionLimitError(field, value);
  }
  return parsed;
}

// ============================================================================
// TOKEN REDEMPTION RECORDS
// ============================================================================

export class SecureTokenRedemptionService {
  async rejectRedemption(
    redemptionId: string,
    adminUserId: string,
    reason: string,
  ): Promise<{ success: boolean; error?: string }> {
    await dbWrite.transaction(async (tx) => {
      const [redemption] = await tx
        .select()
        .from(tokenRedemptions)
        .where(and(eq(tokenRedemptions.id, redemptionId), eq(tokenRedemptions.status, "pending")))
        .for("update");

      if (!redemption) {
        throw new Error("Redemption not found or not pending");
      }

      // Refund to redeemable earnings (move from pending back to available).
      //
      // Fail-closed: usd_value is NUMERIC and 'NaN'::numeric reads back as the
      // string "NaN". A bare Number() here would interpolate NaN into the
      // `available_balance + NaN` SQL below, poisoning the user's ENTIRE
      // redeemable-earnings balance to NaN (plus GREATEST(0, x - NaN) = NaN in
      // redemption_limits and a "NaN" ledger amount). Throwing rolls back the
      // transaction: the redemption stays pending for manual repair instead of
      // destroying the balance row. error-policy:J4
      const refundAmount = parseRedemptionLimitNumber(redemption.usd_value, "usd_value");

      // CRITICAL: Refund to redeemable_earnings table
      // This moves funds from total_pending back to available_balance
      await tx
        .update(redeemableEarnings)
        .set({
          available_balance: sql`${redeemableEarnings.available_balance} + ${refundAmount}`,
          total_pending: sql`GREATEST(0, ${redeemableEarnings.total_pending} - ${refundAmount})`,
          version: sql`${redeemableEarnings.version} + 1`,
          updated_at: new Date(),
        })
        .where(eq(redeemableEarnings.user_id, redemption.user_id));

      // Create ledger entry for audit trail
      await tx.insert(redeemableEarningsLedger).values({
        user_id: redemption.user_id,
        entry_type: "refund",
        amount: String(refundAmount),
        balance_after: sql`(SELECT available_balance FROM redeemable_earnings WHERE user_id = ${redemption.user_id})`,
        redemption_id: redemptionId,
        description: `Refund from rejected redemption: ${sanitizeForLog(reason)}`,
        metadata: {
          admin_user_id: adminUserId,
          refunded_at: new Date().toISOString(),
        },
      });

      // Fix #7: Restore daily limits
      const todayUTC = new Date();
      todayUTC.setUTCHours(0, 0, 0, 0);

      await tx
        .update(redemptionLimits)
        .set({
          daily_usd_total: sql`GREATEST(0, ${redemptionLimits.daily_usd_total} - ${refundAmount})`,
          redemption_count: sql`GREATEST(0, CAST(${redemptionLimits.redemption_count} AS INTEGER) - 1)`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(redemptionLimits.user_id, redemption.user_id),
            gte(redemptionLimits.date, todayUTC),
          ),
        );

      // Update redemption status
      await tx
        .update(tokenRedemptions)
        .set({
          status: "rejected",
          failure_reason: sanitizeForLog(reason),
          reviewed_by: adminUserId,
          reviewed_at: new Date(),
          review_notes: sanitizeForLog(reason),
          updated_at: new Date(),
        })
        .where(eq(tokenRedemptions.id, redemptionId));
    });

    logger.info("[SecureRedemption] Rejected and earnings restored", {
      redemptionId,
      adminUserId: maskAddress(adminUserId),
    });

    return { success: true };
  }

  async getRedemption(redemptionId: string, userId?: string): Promise<TokenRedemption | null> {
    const conditions = [eq(tokenRedemptions.id, redemptionId)];
    if (userId) {
      conditions.push(eq(tokenRedemptions.user_id, userId));
    }

    const redemption = await dbRead.query.tokenRedemptions.findFirst({
      where: and(...conditions),
    });

    return redemption ?? null;
  }

  async listUserRedemptions(userId: string, limit = 20): Promise<TokenRedemption[]> {
    return await dbRead.query.tokenRedemptions.findMany({
      where: eq(tokenRedemptions.user_id, userId),
      orderBy: (redemptions, { desc }) => [desc(redemptions.created_at)],
      limit: Math.min(limit, 100),
    });
  }
}

export const secureTokenRedemptionService = new SecureTokenRedemptionService();
