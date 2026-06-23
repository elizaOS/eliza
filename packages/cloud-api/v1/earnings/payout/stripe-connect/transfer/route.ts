import { stripeConnectAccountsRepository } from "@elizaos/cloud-shared/db/repositories/stripe-connect-accounts";
import { transferToConnectAccount } from "@elizaos/cloud-shared/lib/services/stripe-connect-payout";
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { redeemableEarningsService } from "@/lib/services/redeemable-earnings";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
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
 * Settle a creator's redeemable earnings to their connected account as fiat.
 * ADMIN-GATED (`requireAdmin`) — this is the approved-payout step, the same
 * admin-approval posture as token redemptions: a user can never self-trigger a
 * fiat transfer; an operator executes it. The money flow is a compensating
 * saga so a Stripe failure never leaves the balance debited:
 *   1. validate the connected account is active + balance ≥ amount
 *   2. debit the ledger (atomic; never goes negative)
 *   3. transfer to the connected account (Stripe idempotency key → no double-pay)
 *   4. on transfer failure, re-credit the debited amount
 *
 * (Follow-up: a dedicated `payout` ledger entry type — this currently records
 * the debit via reduceEarnings; the balance math is correct, the entry label is
 * the only thing to refine. Tracked on #8922.)
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

  const balance = await redeemableEarningsService.getBalance(user_id);
  if (!balance || balance.availableBalance < amount) {
    return Response.json(
      { success: false, error: "Insufficient redeemable balance" },
      { status: 400 },
    );
  }

  // Debit first so a crash can never transfer more than was reserved.
  const debit = await redeemableEarningsService.reduceEarnings({
    userId: user_id,
    amount,
    source: "creator_revenue_share",
    sourceId: idempotency_key,
    description: "Stripe Connect fiat payout",
    metadata: { payout_method: "stripe_connect" },
  });
  if (!debit.success) {
    return Response.json(
      { success: false, error: debit.error ?? "Failed to reserve balance" },
      { status: 409 },
    );
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
    // Compensate: the transfer never settled, so restore the debited balance.
    await redeemableEarningsService.addEarnings({
      userId: user_id,
      amount,
      source: "creator_revenue_share",
      sourceId: `${idempotency_key}:refund`,
      description: "Stripe Connect payout failed — balance restored",
      metadata: { payout_method: "stripe_connect", refund_of: idempotency_key },
    });
    logger.error("[StripeConnect] transfer failed; balance restored", {
      userId: user_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { success: false, error: "Transfer failed; balance restored" },
      { status: 502 },
    );
  }
}

const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", rateLimit(RateLimitPresets.CRITICAL), async (c) => {
  try {
    return await handleTransfer(c);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
