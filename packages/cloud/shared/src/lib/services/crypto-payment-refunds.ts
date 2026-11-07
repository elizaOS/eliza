/**
 * Refund path for direct crypto and x402 payments (#22968).
 *
 * Policy: crypto and x402 payments are refundable only as Eliza Cloud credits.
 * Nothing is ever sent back on-chain or to a card or bank account. Every
 * refund is bound to one `crypto_payments` record, capped at the USD actually
 * paid for it (never a promotional bonus), idempotent per refund key, and
 * written to the ledger as a `refund` row so it never qualifies an RPM tier.
 *
 * An x402 payment request's record belongs to the payee (the organization
 * that created the request, whose creator is paid at settlement); the payer
 * is an external wallet with no organization. Until a payer can be bound to
 * an organization, those refunds are refused rather than credited to the
 * payee.
 */

import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { writeTransaction } from "../../db/helpers";
import { creditTransactions } from "../../db/schemas/credit-transactions";
import { type CryptoPayment, cryptoPayments } from "../../db/schemas/crypto-payments";
import { logger } from "../utils/logger";
import { creditsService } from "./credits";

export type CryptoPaymentRail = "crypto" | "x402";

/** Where a refund could be sent. Only `cloud_credits` is allowed for crypto and x402. */
export type RefundDestination = "cloud_credits" | "on_chain" | "fiat";

/** The only refund destination per rail; there is no on-chain or fiat path. */
export const CRYPTO_REFUND_POLICY = Object.freeze({
  crypto: "cloud_credits",
  x402: "cloud_credits",
} as const satisfies Record<CryptoPaymentRail, RefundDestination>);

export type CryptoRefundErrorCode =
  | "CRYPTO_REFUND_DESTINATION_NOT_ALLOWED"
  | "CRYPTO_REFUND_PAYMENT_NOT_FOUND"
  | "CRYPTO_REFUND_PAYMENT_NOT_CONFIRMED"
  | "CRYPTO_REFUND_RECIPIENT_MISMATCH"
  | "CRYPTO_REFUND_X402_PAYER_UNBOUND"
  | "CRYPTO_REFUND_INVALID_KEY"
  | "CRYPTO_REFUND_KEY_AMOUNT_MISMATCH"
  | "CRYPTO_REFUND_INVALID_AMOUNT"
  | "CRYPTO_REFUND_EXCEEDS_PAYMENT";

export class CryptoRefundError extends ElizaError {
  override readonly name = "CryptoRefundError";
  constructor(code: CryptoRefundErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message, { code, context });
  }
}

/** Throws unless `destination` is the policy destination for the rail. */
export function assertCryptoRefundDestination(
  rail: CryptoPaymentRail,
  destination: unknown,
): asserts destination is "cloud_credits" {
  if (destination !== CRYPTO_REFUND_POLICY[rail]) {
    throw new CryptoRefundError(
      "CRYPTO_REFUND_DESTINATION_NOT_ALLOWED",
      "Crypto and x402 payments are refundable only as Eliza Cloud credits",
      { rail, destination },
    );
  }
}

export interface RefundCryptoPaymentInput {
  paymentId: string;
  /** Organization that receives the credits; must own the payment record. */
  organizationId: string;
  amountUsd: string | number;
  /** Stable operator-chosen key; a replay returns the original refund. */
  refundKey: string;
  reason: string;
  operatorUserId: string;
  destination: RefundDestination;
}

export interface CryptoPaymentRefund {
  transactionId: string;
  amountUsd: string;
  refundedTotalUsd: string;
  refundableUsd: string;
  replayed: boolean;
}

export function cryptoPaymentRail(payment: Pick<CryptoPayment, "metadata">): CryptoPaymentRail {
  return payment.metadata?.kind === "x402_payment_request" ? "x402" : "crypto";
}

const DECIMAL = /^\d+(?:\.\d+)?$/;

function decimalOrNull(value: unknown): Decimal | null {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && DECIMAL.test(text) ? new Decimal(text) : null;
}

/** USD actually paid for the payment: never a promotional bonus. */
export function cryptoPaymentPaidUsd(
  payment: Pick<CryptoPayment, "credits_to_add" | "metadata">,
): Decimal {
  const metadata = payment.metadata ?? {};
  const paid =
    decimalOrNull(metadata.paid_amount_usd) ??
    decimalOrNull(metadata.totalChargedUsd) ??
    decimalOrNull(payment.credits_to_add);
  if (!paid) {
    throw new CryptoRefundError(
      "CRYPTO_REFUND_PAYMENT_NOT_FOUND",
      "Crypto payment has no valid paid amount",
    );
  }
  return paid;
}

function refundIdentity(paymentId: string, refundKey: string): string {
  return `crypto-refund:${paymentId}:${refundKey}`;
}

export class CryptoPaymentRefundsService {
  /** Refunds part or all of a crypto or x402 payment as Cloud credits. */
  async refundAsCloudCredits(input: RefundCryptoPaymentInput): Promise<CryptoPaymentRefund> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.refundKey)) {
      throw new CryptoRefundError("CRYPTO_REFUND_INVALID_KEY", "Refund key is invalid");
    }
    const amount = decimalOrNull(input.amountUsd);
    if (!amount || !amount.gt(0) || amount.decimalPlaces() > 6) {
      throw new CryptoRefundError(
        "CRYPTO_REFUND_INVALID_AMOUNT",
        "Refund amount must be a positive USD amount with at most six decimals",
      );
    }
    const identity = refundIdentity(input.paymentId, input.refundKey);

    const result = await writeTransaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(cryptoPayments)
        .where(eq(cryptoPayments.id, input.paymentId))
        .for("update");
      if (!payment) {
        throw new CryptoRefundError("CRYPTO_REFUND_PAYMENT_NOT_FOUND", "Crypto payment not found", {
          paymentId: input.paymentId,
        });
      }
      const rail = cryptoPaymentRail(payment);
      // Policy first: an on-chain or fiat request is refused before any read
      // of refund state or ledger write.
      assertCryptoRefundDestination(rail, input.destination);
      if (rail === "x402") {
        // `organization_id` is the payee; crediting it would pay the creator
        // twice and leave the payer (`metadata.payer`, a wallet) with nothing.
        throw new CryptoRefundError(
          "CRYPTO_REFUND_X402_PAYER_UNBOUND",
          "x402 payment requests cannot be refunded as Cloud credits: the payer has no organization to credit",
          { paymentId: input.paymentId },
        );
      }
      if (payment.organization_id !== input.organizationId) {
        throw new CryptoRefundError(
          "CRYPTO_REFUND_RECIPIENT_MISMATCH",
          "Refund credits can only go to the organization that owns the payment",
          { paymentId: input.paymentId },
        );
      }

      if (payment.status !== "confirmed" || !payment.confirmed_at) {
        throw new CryptoRefundError(
          "CRYPTO_REFUND_PAYMENT_NOT_CONFIRMED",
          "Refund requires a confirmed payment settlement",
          { paymentId: input.paymentId, status: payment.status },
        );
      }

      const [prior] = await tx
        .select({
          total: sql<string>`COALESCE(SUM(${creditTransactions.amount}), 0)::text`,
          replayId: sql<
            string | null
          >`MAX(CASE WHEN ${creditTransactions.stripe_payment_intent_id} = ${identity} THEN ${creditTransactions.id}::text END)`,
          replayAmount: sql<
            string | null
          >`MAX(CASE WHEN ${creditTransactions.stripe_payment_intent_id} = ${identity} THEN ${creditTransactions.amount}::text END)`,
        })
        .from(creditTransactions)
        .where(
          sql`${creditTransactions.type} = 'refund'
            AND ${creditTransactions.metadata}->>'refunded_crypto_payment_id' = ${input.paymentId}`,
        );
      const refundable = cryptoPaymentPaidUsd(payment);
      const refundedBefore = new Decimal(prior?.total ?? "0");
      if (prior?.replayId) {
        if (!new Decimal(prior.replayAmount ?? "0").eq(amount)) {
          throw new CryptoRefundError(
            "CRYPTO_REFUND_KEY_AMOUNT_MISMATCH",
            "Refund key was already used for a different amount",
            { paymentId: input.paymentId },
          );
        }
        return {
          transactionId: prior.replayId,
          amountUsd: amount.toFixed(6),
          refundedTotalUsd: refundedBefore.toFixed(6),
          refundableUsd: refundable.toFixed(6),
          replayed: true,
        };
      }
      if (refundedBefore.plus(amount).gt(refundable)) {
        throw new CryptoRefundError(
          "CRYPTO_REFUND_EXCEEDS_PAYMENT",
          "Refund would exceed the amount paid for this payment",
          {
            paymentId: input.paymentId,
            refundableUsd: refundable.toFixed(6),
            refundedUsd: refundedBefore.toFixed(6),
          },
        );
      }
      const refund = await creditsService.refundCredits({
        organizationId: input.organizationId,
        amount: amount.toFixed(6),
        description: "Crypto payment refund as Cloud credits",
        metadata: {
          type: "crypto_payment_refund",
          payment_rail: rail,
          refund_destination: "cloud_credits",
          refunded_crypto_payment_id: input.paymentId,
          refund_key: input.refundKey,
          reason: input.reason,
          operator_user_id: input.operatorUserId,
        },
        stripePaymentIntentId: identity,
        db: tx,
        deferCacheInvalidation: true,
      });
      return {
        transactionId: refund.transaction.id,
        amountUsd: amount.toFixed(6),
        refundedTotalUsd: refundedBefore.plus(amount).toFixed(6),
        refundableUsd: refundable.toFixed(6),
        replayed: false,
      };
    });

    if (!result.replayed) {
      await creditsService.invalidateCreditCaches(input.organizationId);
      logger.info("[CryptoRefunds] Refunded crypto payment as Cloud credits", {
        paymentId: input.paymentId,
        amountUsd: result.amountUsd,
        operatorUserId: input.operatorUserId,
      });
    }
    return result;
  }
}

export const cryptoPaymentRefundsService = new CryptoPaymentRefundsService();
