/**
 * Finishes x402 top-ups whose transfer settled. The top-up request does this
 * inline; the cron finishes any settled intent the request did not, so funds
 * taken on-chain always end in a credit. Every step is keyed on the intent:
 * the credit on its credit_key and the revenue splits on its source_id, so a
 * retry never credits twice.
 */
import {
  type X402SettlementIntent,
  x402SettlementIntentsRepository,
} from "../../db/repositories/x402-settlement-intents";
import type { UserWithOrganization } from "../types";
import { logger } from "../utils/logger";
import { creditsService } from "./credits";
import { redeemableEarningsService } from "./redeemable-earnings";
import { referralsService } from "./referrals";
import { findOrCreateUserByWalletAddress } from "./wallet-signup";

/** Settled intents younger than this are left to the request that settled them. */
const RECONCILE_MIN_AGE_MS = 5 * 60 * 1000;
const RECONCILE_BATCH = 25;

export interface X402TopupRecipient {
  user: UserWithOrganization;
  organizationId: string;
  walletAddress: string;
}

/**
 * Finds or opens the account for a wallet named without a signature. Called
 * only after settlement, so no account is opened for a payment that failed.
 */
export async function resolveX402TopupRecipient(
  walletAddress: string,
): Promise<X402TopupRecipient> {
  // No `walletProven`: the address was named, not signed for.
  const { user } = await findOrCreateUserByWalletAddress(walletAddress);
  return { user, organizationId: user.organization_id!, walletAddress };
}

export async function creditX402SettlementIntent(
  intent: X402SettlementIntent,
  recipient: X402TopupRecipient,
) {
  const amount = Number(intent.amount_usd);
  return creditsService.addCredits({
    organizationId: recipient.organizationId,
    amount,
    description: `x402 wallet top-up: $${amount}`,
    stripePaymentIntentId: intent.credit_key!,
    metadata: {
      payment_method: "x402",
      network: intent.network,
      transaction: intent.transaction,
      payer: intent.payer,
      wallet_address: recipient.walletAddress,
      amount_usd: amount,
    },
  });
}

export async function payX402RevenueSplits(
  intent: X402SettlementIntent,
  recipient: X402TopupRecipient,
): Promise<void> {
  const { user, organizationId } = recipient;
  const amount = Number(intent.amount_usd);
  const { splits } = await referralsService.calculateRevenueSplits(user.id, amount);
  for (const split of splits) {
    if (split.amount <= 0) continue;
    const source = split.role === "app_owner" ? "app_owner_revenue_share" : "creator_revenue_share";
    await redeemableEarningsService.addEarnings({
      userId: split.userId,
      amount: split.amount,
      source,
      sourceId: `x402_crypto_split_${intent.source_id}:${split.userId}`,
      dedupeBySourceId: true,
      description: `${split.role === "app_owner" ? "App Owner" : "Creator"} revenue share (${((split.amount / amount) * 100).toFixed(0)}%) for $${amount} crypto topup`,
      metadata: {
        buyer_user_id: user.id,
        buyer_org_id: organizationId,
        role: split.role,
        payment_method: "x402",
      },
    });
    logger.info(
      `[x402] Credited split: $${split.amount.toFixed(2)} to ${split.role} (${split.userId})`,
    );
  }
}

/** Credits a settled intent, pays its splits and marks it credited. */
export async function finishX402SettlementIntent(
  intent: X402SettlementIntent,
  recipient?: X402TopupRecipient,
) {
  const resolved = recipient ?? (await resolveX402TopupRecipient(intent.wallet_address));
  const credit = await creditX402SettlementIntent(intent, resolved);
  await payX402RevenueSplits(intent, resolved);
  await x402SettlementIntentsRepository.markCredited(intent.id, resolved.organizationId);
  return { recipient: resolved, credit };
}

/** Finishes settled top-ups that their request left uncredited. Runs on the crypto cron. */
export async function reconcileX402SettlementIntents(
  options: { now?: Date; limit?: number } = {},
): Promise<{ credited: number; failed: number }> {
  const now = options.now ?? new Date();
  const intents = await x402SettlementIntentsRepository.listSettledBefore(
    new Date(now.getTime() - RECONCILE_MIN_AGE_MS),
    options.limit ?? RECONCILE_BATCH,
  );
  let credited = 0;
  let failed = 0;
  for (const intent of intents) {
    try {
      await finishX402SettlementIntent(intent);
      credited += 1;
    } catch (error) {
      // error-policy:J1 one intent's failure must not stop the batch; the row
      // stays settled and is retried on the next tick.
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[x402] Finishing a settled top-up failed", {
        intentId: intent.id,
        transaction: intent.transaction,
        error: message,
      });
      await x402SettlementIntentsRepository.recordError(intent.id, message).catch(() => undefined);
    }
  }
  return { credited, failed };
}
