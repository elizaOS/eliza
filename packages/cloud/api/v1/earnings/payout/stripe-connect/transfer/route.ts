import { requireAdmin } from "@elizaos/cloud-shared/auth";
import { stripeConnectAccountsRepository } from "@elizaos/cloud-shared/db/repositories/stripe-connect-accounts";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  moneyRateLimit,
  RateLimitPresets,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import { debitAffiliatePayout } from "@elizaos/cloud-shared/lib/services/affiliate-payouts";
import { redeemableEarningsService } from "@elizaos/cloud-shared/lib/services/redeemable-earnings";
import { transferToConnectAccount } from "@elizaos/cloud-shared/lib/services/stripe-connect-payout";
import { requireStripe } from "@elizaos/cloud-shared/lib/stripe";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  AppEnv,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { toConnectClient } from "../_stripe-connect-client";

const MAX_TRANSFER_USD = 1_000_000;

const TransferSchema = z.object({
  user_id: z.string().uuid(),
  amount: z.number().positive().max(MAX_TRANSFER_USD),
  idempotency_key: z.string().min(16).max(64),
});

/**
 * POST /api/v1/earnings/payout/stripe-connect/transfer (#8922)
 *
 * Pays an affiliate's earnings to their connected account as fiat.
 * ADMIN-GATED (`requireAdmin`): an operator executes the approved payout.
 *
 * Creator monetization is retired (#22961 / #23022). Only affiliate earnings
 * credited after the retirement instant are payable; frozen creator balances
 * (and affiliate earnings frozen with them) are refused with 409
 * `affiliate_payout_exceeds_payable` and settled manually. The money flow is a
 * compensating saga so a Stripe failure never leaves the balance debited:
 *   1. validate the connected account is active and payout-ready
 *   2. debit the payable affiliate balance (atomic, fails closed, idempotent)
 *   3. transfer to the connected account (Stripe idempotency key, no double-pay)
 *   4. on a definitive transfer rejection, re-credit the debited amount
 */
async function handleTransfer(c: AppContext) {
  await requireAdmin(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON in request body" },
      { status: 400 },
    );
  }
  const parsed = TransferSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        success: false,
        error: parsed.error.issues[0]?.message ?? "Invalid request",
      },
      { status: 400 },
    );
  }
  const { user_id, amount, idempotency_key } = parsed.data;

  const account = await stripeConnectAccountsRepository.findByUserId(user_id);
  if (!account) {
    return Response.json(
      { success: false, error: "No Stripe Connect account; onboard first" },
      { status: 400 },
    );
  }
  if (account.status !== "active" || !account.payouts_enabled) {
    return Response.json(
      { success: false, error: "Connected account is not payout-ready" },
      { status: 400 },
    );
  }

  // Debit first so a crash can never transfer more than was reserved. The
  // debit checks the payable affiliate balance under the per-user ledger lock
  // and fails closed; it is idempotent on idempotency_key so a same-key retry
  // reuses the prior debit while Stripe replays the single transfer.
  const debit = await debitAffiliatePayout({
    userId: user_id,
    amountUsd: amount,
    idempotencyKey: idempotency_key,
    description: "Stripe Connect affiliate payout",
    metadata: { payout_method: "stripe_connect" },
  });

  // A DEDUPLICATED debit means an adjustment row for this idempotency_key already
  // exists. That is legitimate for the ambiguous-retry case (Call 1 debited, the
  // transfer timed out with an uncertain outcome, we held the debit; Stripe's own
  // transfer idempotency then replays the single transfer on retry — no double
  // pay). But if a compensating `${key}:refund` earning ALSO exists, Call 1's
  // transfer was DEFINITIVELY rejected and the debit was rolled back — the balance
  // was fully restored, so this debit no longer holds funds. Proceeding would fire
  // a FRESH transfer (Stripe never persisted the rejected key) against a no-op
  // debit and pay the creator twice while they keep the balance. Refuse the retry
  // and require a fresh idempotency_key. (#11022)
  if (debit.deduplicated) {
    const alreadyRefunded =
      await redeemableEarningsService.hasEarningBySourceId({
        userId: user_id,
        source: "affiliate",
        sourceId: `${idempotency_key}:refund`,
      });
    if (alreadyRefunded) {
      logger.warn("[StripeConnect] refusing retry of a rejected+refunded key", {
        userId: user_id,
        idempotencyKey: idempotency_key,
      });
      return Response.json(
        {
          success: false,
          error:
            "This idempotency_key was already rejected and the balance refunded. Retry with a fresh idempotency_key.",
        },
        { status: 409 },
      );
    }
  }

  try {
    const { transferId, amountCents } = await transferToConnectAccount(
      toConnectClient(requireStripe()),
      {
        accountId: account.stripe_connect_account_id,
        amountUsd: amount,
        idempotencyKey: idempotency_key,
        metadata: { userId: user_id },
      },
    );
    logger.info("[StripeConnect] payout transferred", {
      userId: user_id,
      accountId: account.stripe_connect_account_id,
      transferId,
      amountCents,
    });
    return Response.json({
      success: true,
      transferId,
      newBalance: debit.newBalance,
    });
  } catch (error) {
    // Only auto-compensate when Stripe DEFINITIVELY rejected the request, i.e.
    // no transfer was created (bad params, inactive account, insufficient
    // platform balance, auth/permission). On an AMBIGUOUS failure — a network
    // timeout or a Stripe-side error where the create may have reached Stripe and
    // settled — re-crediting would double-pay (fiat already left, balance
    // restored). In that case we hold the debit and surface for reconciliation
    // rather than mint balance back on uncertainty. The refund is itself
    // idempotent (dedupeBySourceId) so a route retry can't double-credit.
    const stripeType =
      error && typeof error === "object" && "type" in error
        ? String((error as { type: unknown }).type)
        : "";
    const definitivelyNotCreated =
      stripeType === "StripeInvalidRequestError" ||
      stripeType === "StripeAuthenticationError" ||
      stripeType === "StripePermissionError" ||
      stripeType === "StripeRateLimitError";

    if (definitivelyNotCreated) {
      await redeemableEarningsService.addEarnings({
        userId: user_id,
        amount,
        source: "affiliate",
        sourceId: `${idempotency_key}:refund`,
        description:
          "Stripe Connect affiliate payout rejected — balance restored",
        metadata: {
          payout_method: "stripe_connect",
          refund_of: idempotency_key,
        },
        dedupeBySourceId: true,
        reversesRedemption: true,
      });
      logger.error("[StripeConnect] transfer rejected; balance restored", {
        userId: user_id,
        stripeType,
        error: error instanceof Error ? error.message : String(error),
      });
      return Response.json(
        { success: false, error: "Transfer rejected; balance restored" },
        { status: 502 },
      );
    }

    // Ambiguous outcome — the transfer may have settled. Do NOT re-credit.
    logger.error(
      "[StripeConnect] transfer status UNKNOWN; balance HELD for reconciliation",
      {
        userId: user_id,
        idempotencyKey: idempotency_key,
        stripeType,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return Response.json(
      {
        success: false,
        error:
          "Transfer status unknown; balance held pending manual reconciliation",
        needsReconciliation: true,
      },
      { status: 502 },
    );
  }
}

const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", moneyRateLimit(RateLimitPresets.CRITICAL), async (c) => {
  try {
    return await handleTransfer(c);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
