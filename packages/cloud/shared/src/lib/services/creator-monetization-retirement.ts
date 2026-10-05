/**
 * Creator monetization retirement (#22961 / #23022, owner decision in #22957).
 *
 * Cloud billing is subscription (Plus/Pro) plus pay-as-you-go. Creators no
 * longer accrue earnings from MCP usage or agent inference markup, and every
 * creator payout rail (token redemption, app earnings withdrawal,
 * earnings-funded hosting) is closed. The affiliate program continues:
 * affiliate earnings credited after retirement are paid through Stripe Connect
 * by `affiliate-payouts.ts`, which never draws on a frozen balance. Historical ledger
 * rows stay readable. Unpaid balances were recorded by migration 0500 as frozen
 * statements and are settled manually; nothing here pays out.
 */

import { eq } from "drizzle-orm";
import { dbRead } from "../../db/client";
import {
  type CreatorEarningsRetirementStatement,
  creatorEarningsRetirementStatements,
} from "../../db/schemas/creator-earnings-retirement-statements";
import { redeemableEarnings } from "../../db/schemas/redeemable-earnings";
import { ApiError } from "../api/cloud-worker-errors";
import { getAffiliatePayableBalance } from "./affiliate-payouts";

export const CREATOR_MONETIZATION_RETIRED_CODE = "creator_monetization_retired" as const;

export type RetiredCreatorCapability =
  | "token_redemption"
  | "app_earnings_withdrawal"
  | "earnings_funded_hosting"
  | "agent_inference_markup"
  | "app_monetization"
  | "paid_mcp_listing"
  | "payout_processing";

const RETIRED_MESSAGES: Record<RetiredCreatorCapability, string> = {
  token_redemption: "Creator earnings redemptions have been retired.",
  app_earnings_withdrawal: "App earnings withdrawals have been retired.",
  earnings_funded_hosting: "Paying for hosting from creator earnings has been retired.",
  agent_inference_markup: "Agent inference markup has been retired.",
  app_monetization: "App creator monetization has been retired.",
  paid_mcp_listing: "Paid MCP listings have been retired. MCP listings are free.",
  payout_processing: "Creator payout processing has been retired.",
};

/**
 * Typed refusal for a retired creator-monetization entry point. Extends
 * {@link ApiError} so every route that already maps errors through
 * `failureResponse` answers HTTP 410 with `code: creator_monetization_retired`.
 */
export class CreatorMonetizationRetiredError extends ApiError {
  readonly capability: RetiredCreatorCapability;

  constructor(capability: RetiredCreatorCapability) {
    super(410, CREATOR_MONETIZATION_RETIRED_CODE, RETIRED_MESSAGES[capability], {
      capability,
      statement: "/api/v1/earnings/statement",
    });
    this.name = "CreatorMonetizationRetiredError";
    this.capability = capability;
  }
}

export interface CreatorEarningsStatement {
  status: "none" | "frozen" | "settled_manually";
  payoutsRetired: true;
  /** Balance recorded at retirement; `null` when the user had nothing unpaid. */
  frozen: {
    organizationId: string | null;
    frozenAt: string;
    unpaidBalanceUsd: string;
    availableBalanceUsd: string;
    pendingRedemptionUsd: string;
    totalEarnedUsd: string;
    totalRedeemedUsd: string;
    totalConvertedToCreditsUsd: string;
    bySource: {
      apps: string;
      agents: string;
      mcps: string;
      affiliates: string;
      revenueShares: string;
    };
    settledAt: string | null;
    settlementReference: string | null;
  } | null;
  /** Affiliate earnings credited after retirement that can be paid out now. */
  affiliatePayableUsd: string;
  /** Current ledger balance. It can exceed the frozen amount when affiliate fees keep accruing. */
  current: {
    availableBalanceUsd: string;
    pendingRedemptionUsd: string;
    totalEarnedUsd: string;
  };
}

function statementFromRow(
  row: CreatorEarningsRetirementStatement,
): NonNullable<CreatorEarningsStatement["frozen"]> {
  return {
    organizationId: row.organization_id,
    frozenAt: row.frozen_at.toISOString(),
    unpaidBalanceUsd: row.unpaid_balance_usd,
    availableBalanceUsd: row.available_balance_usd,
    pendingRedemptionUsd: row.pending_redemption_usd,
    totalEarnedUsd: row.total_earned_usd,
    totalRedeemedUsd: row.total_redeemed_usd,
    totalConvertedToCreditsUsd: row.total_converted_to_credits_usd,
    bySource: {
      apps: row.earned_from_apps_usd,
      agents: row.earned_from_agents_usd,
      mcps: row.earned_from_mcps_usd,
      affiliates: row.earned_from_affiliates_usd,
      revenueShares: row.earned_from_revenue_shares_usd,
    },
    settledAt: row.settled_at?.toISOString() ?? null,
    settlementReference: row.settlement_reference,
  };
}

export class CreatorMonetizationRetirementService {
  /** Read-only statement for one user. Never mutates balances. */
  async getStatement(userId: string): Promise<CreatorEarningsStatement> {
    const [frozenRow, balanceRow, affiliatePayable] = await Promise.all([
      dbRead.query.creatorEarningsRetirementStatements.findFirst({
        where: eq(creatorEarningsRetirementStatements.user_id, userId),
      }),
      dbRead.query.redeemableEarnings.findFirst({
        where: eq(redeemableEarnings.user_id, userId),
      }),
      getAffiliatePayableBalance(userId),
    ]);

    return {
      status: frozenRow ? frozenRow.status : "none",
      payoutsRetired: true,
      frozen: frozenRow ? statementFromRow(frozenRow) : null,
      affiliatePayableUsd: affiliatePayable.payableUsd,
      current: {
        availableBalanceUsd: balanceRow?.available_balance ?? "0.0000",
        pendingRedemptionUsd: balanceRow?.total_pending ?? "0.0000",
        totalEarnedUsd: balanceRow?.total_earned ?? "0.0000",
      },
    };
  }
}

export const creatorMonetizationRetirementService = new CreatorMonetizationRetirementService();
