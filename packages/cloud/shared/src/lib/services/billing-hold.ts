/**
 * Organization billing hold after an underfunding Stripe reversal (#22930,
 * Decision A).
 *
 * The hold is server-owned: `CreditsService.clawbackCredits` places it in the
 * same statement that records an unrecovered refund or dispute shortfall.
 * While it is active, new paid admission (inference, Dedicated agents,
 * containers and other new paid resources) fails closed with
 * {@link BillingHoldActiveError}. Running resources are not stopped by the hold
 * itself: they keep settling against whatever funding exists and follow the
 * existing unfunded-stop lifecycle, and automatic resume stays blocked.
 * Repayment (credits added while held) and dispute reinstatement clear it.
 */

import { ORGANIZATION_CREDIT_CHECKOUT_LIMITS } from "@elizaos/cloud-sdk/browser-contracts";
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import {
  listActivePaymentReversalHolds,
  type ReversalShortfallSettlement,
  settleReversalShortfalls,
} from "../../db/repositories/payment-reversal-holds";
import type { PaymentReversalHoldReason } from "../../db/schemas/organization-payment-reversal-holds";
import { logger } from "../utils/logger";
import { BillingHoldActiveError, creditsService } from "./credits";

export { BILLING_HOLD_ACTIVE_CODE, BillingHoldActiveError } from "./credits";

export interface BillingHoldEntry {
  id: string;
  reason: PaymentReversalHoldReason;
  /** Unrecovered amount when the hold was placed; null for historical lost-dispute holds. */
  shortfallUsd: string | null;
  /** Amount still owed on this hold; null for historical lost-dispute holds. */
  outstandingUsd: string | null;
  createdAt: string;
}

/** Typed billing-hold state served by the billing API. */
export type BillingHoldState =
  | { status: "clear" }
  | {
      status: "held";
      /** Total still owed across active shortfall holds (USD, 6 dp). */
      outstandingUsd: string;
      holds: BillingHoldEntry[];
      /**
       * `add_funds`: credits added to the balance repay the outstanding amount
       * first and clear the hold once it is covered. `contact_support`: the
       * hold carries no repayable amount and needs an operator release.
       */
      payAction:
        | { kind: "add_funds"; amountUsd: string; minimumTopUpUsd: string }
        | { kind: "contact_support" };
    };

function toEntry(hold: Awaited<ReturnType<typeof listActivePaymentReversalHolds>>[number]) {
  return {
    id: hold.id,
    reason: hold.reason,
    shortfallUsd: hold.shortfall_usd,
    outstandingUsd: hold.outstanding_usd,
    createdAt: hold.created_at.toISOString(),
  } satisfies BillingHoldEntry;
}

/** Checkout minimum for a pay-as-you-go top-up, from the canonical contract. */
const MINIMUM_TOP_UP_USD = ORGANIZATION_CREDIT_CHECKOUT_LIMITS.minAmountUsd.toFixed(2);

export class BillingHoldService {
  /** Reads the authoritative hold state from the primary. */
  async getState(
    organizationId: string,
    executor?: Parameters<typeof listActivePaymentReversalHolds>[1],
  ): Promise<BillingHoldState> {
    const holds = await listActivePaymentReversalHolds(organizationId, executor);
    if (holds.length === 0) return { status: "clear" };
    const outstanding = holds.reduce(
      (sum, hold) => sum.plus(hold.outstanding_usd ?? 0),
      new Decimal(0),
    );
    if (!outstanding.isFinite()) {
      throw new ElizaError("Billing hold carries a non-finite outstanding amount", {
        code: "PAYMENT_REVERSAL_HOLD_CORRUPT",
        context: { organizationId },
      });
    }
    return {
      status: "held",
      outstandingUsd: outstanding.toFixed(6),
      holds: holds.map(toEntry),
      payAction: outstanding.gt(0)
        ? {
            kind: "add_funds",
            // Card checkout takes whole cents; round up so the payment covers it.
            amountUsd: outstanding.toDecimalPlaces(2, Decimal.ROUND_UP).toFixed(2),
            minimumTopUpUsd: MINIMUM_TOP_UP_USD,
          }
        : { kind: "contact_support" },
    };
  }

  /** Fails closed: throws {@link BillingHoldActiveError} while any hold is active. */
  async assertNoHold(
    organizationId: string,
    executor?: Parameters<typeof listActivePaymentReversalHolds>[1],
  ): Promise<void> {
    const state = await this.getState(organizationId, executor);
    if (state.status === "held") {
      throw new BillingHoldActiveError(organizationId, state.outstandingUsd);
    }
  }

  /**
   * Applies the current balance to outstanding shortfalls (oldest first) and
   * clears covered holds. Called after credits land (top-up, reinstatement)
   * and from the billing API pay action.
   */
  async settleOutstandingShortfalls(organizationId: string): Promise<ReversalShortfallSettlement> {
    const active = await listActivePaymentReversalHolds(organizationId);
    if (!active.some((hold) => hold.reason === "reversal_shortfall")) {
      return {
        appliedUsd: "0.000000",
        outstandingUsd: "0.000000",
        releasedHoldIds: [],
        repaymentTransactionId: null,
      };
    }
    const settlement = await settleReversalShortfalls(organizationId);
    if (settlement.appliedUsd !== "0.000000") {
      await creditsService.invalidateCreditCaches(organizationId);
      logger.info("[billing-hold] Applied balance to reversal shortfall", {
        organizationId,
        appliedUsd: settlement.appliedUsd,
        outstandingUsd: settlement.outstandingUsd,
        releasedHolds: settlement.releasedHoldIds.length,
      });
    }
    return settlement;
  }
}

export const billingHoldService = new BillingHoldService();
