/** Coordinates atomic provider-backed crypto settlement and recovery behind route handlers. */
import { ElizaError } from "@elizaos/core";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import { validate as uuidValidate } from "uuid";
import { z } from "zod";
import { type DbTransaction, dbWrite } from "../../db/client";
import {
  canonicalizeCryptoTransactionHash,
  cryptoTransactionHashesEqual,
  isHexTransactionHash,
} from "../../db/crypto-payment-transaction-hash";
import {
  type CryptoPayment,
  cryptoPaymentsRepository,
} from "../../db/repositories/crypto-payments";
import { cryptoPayments } from "../../db/schemas/crypto-payments";
import type { NewInvoice } from "../../db/schemas/invoices";
import { PAYMENT_EXPIRATION_SECONDS, validatePaymentAmount } from "../config/crypto";
import { createCryptoCustomerId, createCryptoInvoiceId } from "../constants/invoice-ids";
import { logger, redact } from "../utils/logger";
import {
  type AppChargeCallbackDispatchParams,
  appChargeCallbacksService,
  parseAppChargeCallbackDispatchParams,
} from "./app-charge-callbacks";
import { appCreditsService } from "./app-credits";
import { creditsService } from "./credits";
import { invoicesService } from "./invoices";
import { isOxaPayConfigured, type OxaPayNetwork, oxaPayService } from "./oxapay";
import { redeemableEarningsService } from "./redeemable-earnings";
import { referralsService } from "./referrals";

/**
 * Typed error codes for crypto payment operations.
 */
export type CryptoPaymentErrorCode =
  | "INVALID_UUID"
  | "AMOUNT_TOO_SMALL"
  | "AMOUNT_TOO_LARGE"
  | "INVALID_CURRENCY"
  | "SERVICE_NOT_CONFIGURED"
  | "PAYMENT_NOT_FOUND"
  | "PAYMENT_ALREADY_CONFIRMED"
  | "INSUFFICIENT_PAYMENT"
  | "DOUBLE_SPEND_DETECTED"
  | "WEBHOOK_INVALID"
  | "UNKNOWN_ERROR";

/**
 * Custom error class for crypto payment operations.
 * Provides typed error codes for clean API error handling.
 */
export class CryptoPaymentError extends ElizaError {
  override readonly name = "CryptoPaymentError";

  constructor(
    public readonly code: CryptoPaymentErrorCode,
    message: string,
  ) {
    super(message, { code, severity: "fatal" });
  }
}

export interface CreatePaymentParams {
  organizationId: string;
  userId?: string;
  amount: string | number;
  currency?: string;
  payCurrency?: string;
  network?: OxaPayNetwork;
  description?: string;
  returnUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentStatus {
  id: string;
  trackId: string;
  status: string;
  expectedAmount: string;
  receivedAmount?: string;
  creditsToAdd: string;
  network: string;
  token: string;
  payLink?: string;
  transactionHash?: string;
  expiresAt: Date;
  createdAt: Date;
  confirmedAt?: Date;
}

const paymentMetadataSchema = z
  .object({
    oxapay_track_id: z.string().optional(),
    pay_link: z.string().optional(),
    fiat_currency: z.string().optional(),
    fiat_amount: z.union([z.string(), z.number()]).optional(),
    oxapay_order_id: z.string().optional(),
  })
  .passthrough();

type PaymentMetadata = z.infer<typeof paymentMetadataSchema>;
const storedInvoiceSettlementSchema = z.object({
  organization_id: z.string().uuid(),
  stripe_invoice_id: z.string().min(1),
  stripe_customer_id: z.string().min(1),
  stripe_payment_intent_id: z.string().min(1),
  amount_due: z.string().min(1),
  amount_paid: z.string().min(1),
  currency: z.string().min(1),
  status: z.string().min(1),
  invoice_type: z.string().min(1),
  credits_added: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
});

function storedInvoiceSettlement(value: unknown): NewInvoice {
  const result = storedInvoiceSettlementSchema.safeParse(value);
  if (!result.success) {
    throw new ElizaError("Confirmed payment has an invalid canonical invoice settlement", {
      code: "INVALID_CRYPTO_INVOICE_SETTLEMENT",
      context: { issues: result.error.issues },
    });
  }
  return result.data;
}

interface OxaSettlementEvidence {
  trackId: string;
  orderId: string;
  invoiceAmount: string;
  invoiceCurrency: string;
  payCurrency: string;
}

function oxaQuoteForPayment(payment: CryptoPayment): {
  trackId: string;
  orderId?: string;
  fiatAmount: string;
  fiatCurrency: string;
} {
  const metadata = extractMetadata(payment.metadata);
  const trackId = getTrackId(metadata);
  const orderId = metadata.oxapay_order_id?.trim();
  const rawAmount = metadata.fiat_amount ?? payment.expected_amount;
  const fiatAmount = new Decimal(rawAmount).toFixed();
  const fiatCurrency = metadata.fiat_currency?.trim().toUpperCase();
  if (!fiatCurrency || !new Decimal(fiatAmount).isFinite() || !new Decimal(fiatAmount).gt(0)) {
    throw new ElizaError("Crypto payment has an invalid stored fiat quote", {
      code: "INVALID_CRYPTO_PAYMENT_QUOTE",
      context: { paymentId: payment.id },
    });
  }
  return { trackId, orderId, fiatAmount, fiatCurrency };
}

function validateOxaSettlementEvidence(
  payment: CryptoPayment,
  evidence: OxaSettlementEvidence,
): void {
  const quote = oxaQuoteForPayment(payment);
  let invoiceAmount: Decimal;
  try {
    invoiceAmount = new Decimal(evidence.invoiceAmount);
  } catch (cause) {
    // error-policy:J2 convert malformed provider money into a typed settlement failure.
    throw new ElizaError("OxaPay returned an invalid invoice amount", {
      code: "INVALID_OXAPAY_SETTLEMENT",
      context: { paymentId: payment.id },
      cause,
    });
  }
  if (
    evidence.trackId !== quote.trackId ||
    (quote.orderId !== undefined && evidence.orderId !== quote.orderId) ||
    !invoiceAmount.equals(quote.fiatAmount) ||
    evidence.invoiceCurrency.trim().toUpperCase() !== quote.fiatCurrency
  ) {
    throw new ElizaError("OxaPay settlement does not match the server-stored fiat quote", {
      code: "OXAPAY_QUOTE_MISMATCH",
      context: { paymentId: payment.id },
    });
  }
}

/**
 * Safely extract metadata with runtime validation.
 */
function extractMetadata(metadata: unknown): PaymentMetadata {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }

  const result = paymentMetadataSchema.safeParse(metadata);
  if (!result.success) {
    logger.warn("[Crypto Payments] Invalid metadata format", {
      error: result.error,
    });
    return {};
  }

  return result.data;
}

/**
 * Safely extract track ID from metadata.
 */
function getTrackId(metadata: unknown): string {
  const meta = extractMetadata(metadata);
  const trackId = meta.oxapay_track_id;

  if (typeof trackId !== "string" || !trackId) {
    throw new Error("Missing or invalid OxaPay track ID");
  }

  return trackId;
}

function getStringMetadata(metadata: PaymentMetadata, key: string): string | undefined {
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getAppCreditPurchaseMetadata(
  metadata: unknown,
): { appId: string; chargeRequestId?: string } | null {
  const meta = extractMetadata(metadata);
  const kind = getStringMetadata(meta, "kind") ?? getStringMetadata(meta, "type");
  const appId = getStringMetadata(meta, "app_id");

  if (kind !== "app_credit_purchase" || !appId) {
    return null;
  }

  return {
    appId,
    chargeRequestId: getStringMetadata(meta, "charge_request_id"),
  };
}

function appChargeFailureCallbackForPayment(
  payment: CryptoPayment,
  reason: string,
): AppChargeCallbackDispatchParams | null {
  const appPurchase = getAppCreditPurchaseMetadata(payment.metadata);
  if (!appPurchase?.chargeRequestId) return null;

  return {
    appId: appPurchase.appId,
    chargeRequestId: appPurchase.chargeRequestId,
    status: "failed",
    provider: "oxapay",
    providerPaymentId: payment.id,
    amountUsd: payment.expected_amount,
    payerUserId: payment.user_id,
    payerOrganizationId: payment.organization_id,
    reason,
    metadata: {
      crypto_payment_id: payment.id,
      network: payment.network,
      token: payment.token,
    },
  };
}

async function persistAppChargeFailureForPayment(
  payment: CryptoPayment,
  status: "expired" | "failed",
  reason: string,
): Promise<void> {
  const callback = appChargeFailureCallbackForPayment(payment, reason);
  await dbWrite.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(cryptoPayments)
      .where(eq(cryptoPayments.id, payment.id))
      .for("update")
      .limit(1);
    if (!locked || locked.status === "confirmed") return;
    await tx
      .update(cryptoPayments)
      .set({
        status,
        metadata: {
          ...(locked.metadata ?? {}),
          failureReason: reason,
        },
        updated_at: new Date(),
      })
      .where(eq(cryptoPayments.id, payment.id));
    if (!callback) return;
    const [chargeRequest] = await tx
      .select({ status: cryptoPayments.status })
      .from(cryptoPayments)
      .where(eq(cryptoPayments.id, callback.chargeRequestId))
      .for("update")
      .limit(1);
    if (!chargeRequest || chargeRequest.status === "confirmed") return;
    await tx
      .update(cryptoPayments)
      .set({ status: "failed", updated_at: new Date() })
      .where(eq(cryptoPayments.id, callback.chargeRequestId));
    await appChargeCallbacksService.enqueue(callback, tx);
  });
}

/**
 * Validate UUID format.
 */
function validateUuid(id: string, fieldName: string): void {
  if (!uuidValidate(id)) {
    throw new CryptoPaymentError("INVALID_UUID", `Invalid ${fieldName}: must be a valid UUID`);
  }
}

class CryptoPaymentsService {
  /**
   * Create a crypto payment invoice using OxaPay's redirect flow.
   * Returns a payLink that redirects users to OxaPay's hosted payment page.
   */
  async createPayment(params: CreatePaymentParams): Promise<{
    payment: CryptoPayment;
    payLink: string;
    expiresAt: Date;
    trackId: string;
    creditsToAdd: string;
  }> {
    const {
      organizationId,
      userId,
      amount,
      currency = "USD",
      payCurrency,
      network,
      description,
      metadata,
    } = params;

    validateUuid(organizationId, "organization ID");

    if (userId) {
      validateUuid(userId, "user ID");
    }

    if (!isOxaPayConfigured()) {
      throw new CryptoPaymentError("SERVICE_NOT_CONFIGURED", "Payment service not configured");
    }

    if (currency.trim().toUpperCase() !== "USD") {
      throw new CryptoPaymentError(
        "INVALID_CURRENCY",
        "Crypto credit purchases are priced only in USD",
      );
    }

    const amountDecimal = new Decimal(amount);
    const validation = validatePaymentAmount(amountDecimal);

    if (!validation.valid) {
      const errorCode = validation.error?.includes("at least")
        ? "AMOUNT_TOO_SMALL"
        : "AMOUNT_TOO_LARGE";
      throw new CryptoPaymentError(errorCode, validation.error || "Invalid amount");
    }

    // OXAPAY_CALLBACK_URL: Override for local development with ngrok.
    // In production, falls back to NEXT_PUBLIC_APP_URL which points to the live domain.
    const callbackUrl =
      process.env.OXAPAY_CALLBACK_URL || `${process.env.NEXT_PUBLIC_APP_URL}/api/crypto/webhook`;

    const returnUrl =
      params.returnUrl ||
      process.env.OXAPAY_RETURN_URL ||
      `${process.env.NEXT_PUBLIC_APP_URL}/payment/success`;

    // Add random suffix to prevent collision if two payments created in same millisecond
    const randomSuffix = Math.random().toString(36).slice(2, 6);
    const orderId = `${organizationId.replace(/-/g, "").slice(0, 12)}_${Date.now()}_${randomSuffix}`;

    const oxaInvoice = await oxaPayService.createInvoice({
      amount: amountDecimal.toFixed(),
      currency,
      payCurrency,
      network,
      orderId,
      description: description ?? `Credit purchase - $${amount}`,
      callbackUrl,
      returnUrl,
      lifetime: PAYMENT_EXPIRATION_SECONDS,
    });

    const payment = await cryptoPaymentsRepository.create({
      organization_id: organizationId,
      user_id: userId,
      payment_address: oxaInvoice.trackId,
      expected_amount: amountDecimal.toFixed(),
      credits_to_add: amountDecimal.toFixed(),
      network: network || "AUTO",
      token: payCurrency || "AUTO",
      token_address: null,
      status: "pending",
      expires_at: oxaInvoice.expiresAt,
      metadata: {
        ...(metadata ?? {}),
        oxapay_track_id: oxaInvoice.trackId,
        oxapay_order_id: orderId,
        pay_link: oxaInvoice.payLink,
        fiat_currency: currency,
        fiat_amount: amountDecimal.toFixed(),
      },
    });

    logger.info("[Crypto Payments] Invoice created via OxaPay", {
      paymentId: redact.paymentId(payment.id),
      trackId: redact.trackId(oxaInvoice.trackId),
      organizationId: redact.orgId(organizationId),
      amount,
    });

    return {
      payment,
      payLink: oxaInvoice.payLink,
      expiresAt: oxaInvoice.expiresAt,
      trackId: oxaInvoice.trackId,
      creditsToAdd: amountDecimal.toFixed(),
    };
  }

  async getPaymentStatus(paymentId: string): Promise<PaymentStatus | null> {
    validateUuid(paymentId, "payment ID");

    const payment = await cryptoPaymentsRepository.findById(paymentId);
    if (!payment) return null;

    return this.formatPaymentStatus(payment);
  }

  async checkAndConfirmPayment(paymentId: string): Promise<{
    confirmed: boolean;
    payment: PaymentStatus;
  }> {
    validateUuid(paymentId, "payment ID");

    const payment = await cryptoPaymentsRepository.findById(paymentId);
    if (!payment) {
      throw new Error("Payment not found");
    }

    if (payment.status === "expired" || payment.status === "failed") {
      return {
        confirmed: false,
        payment: this.formatPaymentStatus(payment),
      };
    }

    const trackId = getTrackId(payment.metadata);

    try {
      const oxaStatus = await oxaPayService.getPaymentStatus(trackId);

      if (oxaPayService.isPaymentConfirmed(oxaStatus.status)) {
        const tx = oxaStatus.transactions[0];
        if (!tx) {
          logger.error("[Crypto Payments] Payment confirmed but no transactions found", {
            paymentId: redact.paymentId(paymentId),
            trackId: redact.trackId(trackId),
          });
          throw new Error("Payment confirmed but no transaction data available");
        }

        // tx.amount now correctly contains the USD credit amount (handles auto-conversion)
        const receivedAmount = new Decimal(tx.amount);
        logger.info("[Crypto Payments] Payment received", {
          paymentId: redact.paymentId(paymentId),
          expectedAmount: payment.expected_amount,
          creditAmount: receivedAmount.toString(),
          nativeAmount: tx.nativeAmount,
          usdAmount: tx.usdAmount,
          payCurrency: tx.currency,
          network: payment.network,
        });

        await this.confirmPayment(payment.id, tx.txHash, {
          trackId: oxaStatus.trackId,
          orderId: oxaStatus.orderId,
          invoiceAmount: oxaStatus.amount,
          invoiceCurrency: oxaStatus.currency,
          payCurrency: tx.currency,
        });

        const confirmedPayment = await cryptoPaymentsRepository.findById(payment.id);
        if (!confirmedPayment) {
          throw new Error("Failed to retrieve confirmed payment");
        }

        return {
          confirmed: true,
          payment: this.formatPaymentStatus(confirmedPayment),
        };
      }

      if (oxaPayService.isPaymentExpired(oxaStatus.status)) {
        await persistAppChargeFailureForPayment(payment, "expired", "expired");
        const expiredPayment = await cryptoPaymentsRepository.findById(payment.id);
        if (!expiredPayment) {
          throw new Error("Failed to retrieve expired payment");
        }

        return {
          confirmed: false,
          payment: this.formatPaymentStatus(expiredPayment),
        };
      }

      if (oxaPayService.isPaymentFailed(oxaStatus.status)) {
        await persistAppChargeFailureForPayment(payment, "failed", oxaStatus.status);
        const failedPayment = await cryptoPaymentsRepository.findById(payment.id);
        if (!failedPayment) {
          throw new Error("Failed to retrieve failed payment");
        }

        return {
          confirmed: false,
          payment: this.formatPaymentStatus(failedPayment),
        };
      }
    } catch (error) {
      // error-policy:J2 preserve provider/payment context on an inner failure.
      logger.error("[Crypto Payments] Failed to check OxaPay status", {
        paymentId: redact.paymentId(paymentId),
        trackId: redact.trackId(trackId),
        error,
      });
      if (error instanceof ElizaError) throw error;
      throw new ElizaError("Failed to verify OxaPay payment status", {
        code: "OXAPAY_STATUS_VERIFICATION_FAILED",
        context: { paymentId, trackId },
        cause: error,
      });
    }

    return {
      confirmed: false,
      payment: this.formatPaymentStatus(payment),
    };
  }

  /**
   * Confirm a payment with database transaction to prevent race conditions.
   * Uses row-level locking to prevent double-spending attacks.
   */
  async confirmPayment(
    paymentId: string,
    txHash: string,
    evidence: OxaSettlementEvidence,
  ): Promise<void> {
    validateUuid(paymentId, "payment ID");

    await dbWrite.transaction(async (tx) => {
      const paymentResult = await tx
        .select()
        .from(cryptoPayments)
        .where(eq(cryptoPayments.id, paymentId))
        .for("update");

      const payment = paymentResult[0];

      if (!payment) {
        throw new Error("Payment not found");
      }
      validateOxaSettlementEvidence(payment, evidence);
      const canonicalTxHash = canonicalizeCryptoTransactionHash(txHash, payment.network);
      const receivedAmount = evidence.invoiceAmount;
      const actualPayCurrency = evidence.payCurrency;
      const quote = oxaQuoteForPayment(payment);

      if (payment.status === "confirmed") {
        const settledCurrency =
          typeof payment.metadata?.settlement_currency === "string"
            ? payment.metadata.settlement_currency
            : payment.token;
        if (
          !cryptoTransactionHashesEqual(payment.transaction_hash, canonicalTxHash) ||
          !payment.received_amount ||
          !new Decimal(payment.received_amount).equals(receivedAmount) ||
          settledCurrency.toLowerCase() !== actualPayCurrency.toLowerCase()
        ) {
          throw new Error("Payment confirmation replay does not match the committed settlement");
        }
        const invoiceSettlement = storedInvoiceSettlement(payment.metadata?.invoice_settlement);
        await invoicesService.create(invoiceSettlement, tx);
        const callbackSettlement = payment.metadata?.callback_settlement;
        if (callbackSettlement !== undefined) {
          await appChargeCallbacksService.enqueue(
            parseAppChargeCallbackDispatchParams(callbackSettlement),
            tx,
          );
        }
        logger.info("[Crypto Payments] Payment already confirmed", {
          paymentId: redact.paymentId(paymentId),
        });
        return;
      }

      if (payment.expires_at < new Date()) {
        logger.error("[Crypto Payments] Cannot confirm expired payment", {
          paymentId: redact.paymentId(paymentId),
          expiresAt: payment.expires_at,
        });
        throw new Error("Payment has expired");
      }

      const existingTx = await tx
        .select()
        .from(cryptoPayments)
        .where(
          isHexTransactionHash(canonicalTxHash)
            ? sql`lower(${cryptoPayments.transaction_hash}) = ${canonicalTxHash}`
            : eq(cryptoPayments.transaction_hash, canonicalTxHash),
        )
        .for("update");

      const collision = existingTx.find((candidate) => candidate.id !== paymentId);
      if (collision) {
        logger.error("[Crypto Payments] Double-spend attempt detected", {
          paymentId: redact.paymentId(paymentId),
          txHash: redact.txHash(canonicalTxHash),
          existingPaymentId: redact.paymentId(collision.id),
        });
        throw new Error("Transaction already processed for another payment");
      }

      // Credit user the exact received amount (no fee reversal)
      const receivedDecimal = new Decimal(receivedAmount);
      if (!receivedDecimal.isFinite() || !receivedDecimal.gt(0)) {
        throw new Error("Received payment amount must be a positive decimal");
      }
      const receivedAmountExact = receivedDecimal.toFixed();
      const creditsToAdd = receivedDecimal.toDecimalPlaces(6).toFixed(6);
      // Invoice columns are intentionally cent-denominated. Keep the provider's
      // exact decimal on the payment and in metadata, while explicitly rounding
      // the invoice projection to its declared database scale.
      const invoiceAmountDue = new Decimal(quote.fiatAmount).toDecimalPlaces(2).toFixed(2);
      const invoiceAmountPaid = receivedDecimal.toDecimalPlaces(2).toFixed(2);
      const payCurrency = actualPayCurrency;
      const invoiceCurrency = quote.fiatCurrency.toLowerCase();
      const appPurchase = getAppCreditPurchaseMetadata(payment.metadata);
      const confirmedAt = new Date();

      const markChargeRequestPaid = async () => {
        if (!appPurchase?.chargeRequestId) return;

        const [chargeRequest] = await tx
          .select()
          .from(cryptoPayments)
          .where(eq(cryptoPayments.id, appPurchase.chargeRequestId))
          .for("update")
          .limit(1);

        if (!chargeRequest) {
          throw new Error("Charge request not found");
        }

        const chargeMetadata = chargeRequest.metadata ?? {};
        if (
          chargeMetadata.kind !== "app_charge_request" ||
          chargeMetadata.app_id !== appPurchase.appId ||
          chargeMetadata.creator_organization_id !== chargeRequest.organization_id ||
          !new Decimal(chargeRequest.expected_amount).equals(payment.expected_amount)
        ) {
          throw new Error("Charge request metadata mismatch");
        }

        const callbackSettlement: AppChargeCallbackDispatchParams = {
          appId: appPurchase.appId,
          chargeRequestId: appPurchase.chargeRequestId,
          status: "paid",
          provider: "oxapay",
          providerPaymentId: payment.id,
          amountUsd: creditsToAdd,
          payerUserId: payment.user_id,
          payerOrganizationId: payment.organization_id,
          metadata: {
            crypto_payment_id: payment.id,
            transaction_hash: canonicalTxHash,
            network: payment.network,
            token: payCurrency,
          },
        };

        if (chargeRequest.status === "confirmed") {
          if (
            chargeMetadata.paid_provider !== "oxapay" ||
            chargeMetadata.paid_provider_payment_id !== payment.id ||
            chargeMetadata.paid_crypto_payment_id !== payment.id
          ) {
            throw new Error("Charge request is already settled by another payment");
          }
          await appChargeCallbacksService.enqueue(callbackSettlement, tx);
          return callbackSettlement;
        }
        if (chargeRequest.status !== "pending") {
          throw new Error(`Charge request cannot settle from status ${chargeRequest.status}`);
        }

        await tx
          .update(cryptoPayments)
          .set({
            status: "confirmed",
            received_amount: creditsToAdd,
            credits_to_add: creditsToAdd,
            confirmed_at: confirmedAt,
            updated_at: confirmedAt,
            metadata: {
              ...chargeMetadata,
              paid_at: confirmedAt.toISOString(),
              paid_provider: "oxapay",
              paid_provider_payment_id: payment.id,
              payer_user_id: payment.user_id ?? undefined,
              payer_organization_id: payment.organization_id,
              paid_crypto_payment_id: payment.id,
              paid_transaction_hash: canonicalTxHash,
              paid_network: payment.network,
              paid_token: payCurrency,
            },
          })
          .where(eq(cryptoPayments.id, appPurchase.chargeRequestId));

        await appChargeCallbacksService.enqueue(callbackSettlement, tx);
        return callbackSettlement;
      };

      await tx
        .update(cryptoPayments)
        .set({
          status: "confirmed",
          transaction_hash: canonicalTxHash,
          received_amount: receivedAmountExact,
          credits_to_add: creditsToAdd,
          confirmed_at: confirmedAt,
          metadata: {
            ...(payment.metadata ?? {}),
            settlement_currency: payCurrency,
            settlement_amount: receivedAmountExact,
            settlement_transaction_hash: canonicalTxHash,
          },
        })
        .where(eq(cryptoPayments.id, paymentId));

      if (appPurchase) {
        if (!payment.user_id) {
          throw new Error("App credit crypto payment is missing user ID");
        }

        const result = await appCreditsService.processPurchase({
          appId: appPurchase.appId,
          userId: payment.user_id,
          organizationId: payment.organization_id,
          purchaseAmount: creditsToAdd,
          stripePaymentIntentId: `crypto:${payment.id}`,
          transaction: tx,
        });

        const callbackSettlement = await markChargeRequestPaid();

        const invoiceSettlement = {
          organization_id: payment.organization_id,
          stripe_invoice_id: createCryptoInvoiceId(payment.id),
          stripe_customer_id: createCryptoCustomerId(payment.organization_id),
          stripe_payment_intent_id: canonicalTxHash,
          amount_due: invoiceAmountDue,
          amount_paid: invoiceAmountPaid,
          currency: invoiceCurrency,
          status: "paid",
          invoice_type: "app_crypto_payment",
          credits_added: invoiceAmountPaid,
          metadata: {
            payment_method: "crypto",
            provider: "oxapay",
            network: payment.network,
            token: payCurrency,
            transaction_hash: canonicalTxHash,
            received_after_fee: receivedAmountExact,
            oxapay_track_id: getTrackId(payment.metadata),
            app_id: appPurchase.appId,
            charge_request_id: appPurchase.chargeRequestId,
            platform_offset: result.platformOffset,
            creator_earnings: result.creatorEarnings,
          },
        };
        await invoicesService.create(invoiceSettlement, tx);
        await tx
          .update(cryptoPayments)
          .set({
            metadata: {
              ...(payment.metadata ?? {}),
              settlement_currency: payCurrency,
              settlement_amount: receivedAmountExact,
              settlement_transaction_hash: canonicalTxHash,
              invoice_settlement: invoiceSettlement,
              ...(callbackSettlement && { callback_settlement: callbackSettlement }),
            },
          })
          .where(eq(cryptoPayments.id, paymentId));

        logger.info("[Crypto Payments] App credit payment confirmed", {
          paymentId: redact.paymentId(paymentId),
          txHash: redact.txHash(canonicalTxHash),
          appId: appPurchase.appId,
          creditsAdded: creditsToAdd,
          creatorEarnings: result.creatorEarnings,
          organizationId: redact.orgId(payment.organization_id),
        });

        return;
      }

      await creditsService.addCredits({
        organizationId: payment.organization_id,
        amount: creditsToAdd,
        description: `Crypto payment (${payCurrency} on ${payment.network})`,
        // Grant the credit INSIDE the confirmation transaction so it commits
        // atomically with the status="confirmed" flip: a throw later in the tx
        // (invoice insert conflict, referral split, etc.) rolls the credit back
        // together with the status, instead of leaving credits committed on the
        // global connection while the row reverts to "pending" and gets
        // reprocessed. And key it on the stable per-payment id (as the adjacent
        // app-purchase path already does) so the SQL-level dedupe makes a re-credit
        // of the same payment a no-op. Without both, a partial post-credit failure
        // followed by a reprocess (e.g. the user-pollable status endpoint) could
        // double-credit — or, if the invoice's unique id already committed,
        // repeatedly re-credit — one crypto payment.
        stripePaymentIntentId: `crypto:${payment.id}`,
        db: tx,
        metadata: {
          crypto_payment_id: payment.id,
          transaction_hash: canonicalTxHash,
          network: payment.network,
          token: payCurrency,
          received_after_fee: receivedAmountExact,
          user_paid_amount: creditsToAdd,
          oxapay_track_id: getTrackId(payment.metadata),
        },
      });

      // Create invoice with clearly namespaced IDs to distinguish from Stripe invoices.
      // These are NOT actual Stripe IDs - they use OXAPAY_* prefix for clarity.
      const invoiceSettlement = {
        organization_id: payment.organization_id,
        stripe_invoice_id: createCryptoInvoiceId(payment.id),
        stripe_customer_id: createCryptoCustomerId(payment.organization_id),
        stripe_payment_intent_id: canonicalTxHash,
        amount_due: invoiceAmountDue,
        amount_paid: invoiceAmountPaid,
        currency: invoiceCurrency,
        status: "paid",
        invoice_type: "crypto_payment",
        credits_added: invoiceAmountPaid,
        metadata: {
          payment_method: "crypto",
          provider: "oxapay",
          network: payment.network,
          token: payCurrency,
          transaction_hash: canonicalTxHash,
          received_after_fee: receivedAmountExact,
          oxapay_track_id: getTrackId(payment.metadata),
        },
      };
      await invoicesService.create(invoiceSettlement, tx);
      await tx
        .update(cryptoPayments)
        .set({
          metadata: {
            ...(payment.metadata ?? {}),
            settlement_currency: payCurrency,
            settlement_amount: receivedAmountExact,
            settlement_transaction_hash: canonicalTxHash,
            invoice_settlement: invoiceSettlement,
          },
        })
        .where(eq(cryptoPayments.id, paymentId));

      await this.creditReferralRevenueSplits({
        payment,
        purchaseAmount: creditsToAdd,
        txHash: canonicalTxHash,
        transaction: tx,
      });

      logger.info("[Crypto Payments] Payment confirmed and credits added", {
        paymentId: redact.paymentId(paymentId),
        txHash: redact.txHash(canonicalTxHash),
        creditsAdded: creditsToAdd,
        expectedAmount: payment.expected_amount,
        receivedAmount,
        organizationId: redact.orgId(payment.organization_id),
      });
    });
  }

  /**
   * Verify and confirm a payment using a provided transaction hash.
   * This allows users to manually confirm payments by providing their transaction hash.
   *
   * SECURITY: This method performs verification via OxaPay API to ensure:
   * - The transaction hash exists and is associated with this payment
   * - OxaPay confirms the payment status (status-based confirmation)
   * - Uses database transaction with row-level locking to prevent race conditions
   */
  async verifyAndConfirmByTxHash(
    paymentId: string,
    txHash: string,
  ): Promise<{ success: boolean; message: string }> {
    validateUuid(paymentId, "payment ID");

    try {
      const payment = await cryptoPaymentsRepository.findById(paymentId);
      if (!payment) {
        return { success: false, message: "Payment not found" };
      }
      if (
        payment.status === "confirmed" &&
        !cryptoTransactionHashesEqual(payment.transaction_hash, txHash, payment.network)
      ) {
        return {
          success: false,
          message: "Payment confirmation replay does not match the committed settlement",
        };
      }
      if (payment.status === "expired") {
        return { success: false, message: "Payment has expired" };
      }
      if (payment.status === "failed") {
        return { success: false, message: "Payment has failed" };
      }

      let trackId: string;
      try {
        trackId = getTrackId(payment.metadata);
      } catch {
        // error-policy:J1 the manual-confirmation boundary reports malformed
        // persisted provider configuration as an explicit failed result.
        logger.error("[Crypto Payments] Missing track ID for on-chain verification", {
          paymentId: redact.paymentId(paymentId),
          txHash: redact.txHash(txHash),
        });
        return {
          success: false,
          message: "Payment configuration error - missing track ID",
        };
      }

      const oxaStatus = await oxaPayService.getPaymentStatus(trackId);
      if (!oxaPayService.isPaymentConfirmed(oxaStatus.status)) {
        return {
          success: false,
          message: `Payment not yet confirmed by blockchain. Current status: ${oxaStatus.status}`,
        };
      }

      const matchingTx = oxaStatus.transactions.find((transaction) =>
        cryptoTransactionHashesEqual(transaction.txHash, txHash, payment.network),
      );
      if (!matchingTx) {
        return {
          success: false,
          message:
            "Transaction hash not found in payment records. Please ensure you submitted the correct transaction hash.",
        };
      }

      await this.confirmPayment(payment.id, matchingTx.txHash, {
        trackId: oxaStatus.trackId,
        orderId: oxaStatus.orderId,
        invoiceAmount: oxaStatus.amount,
        invoiceCurrency: oxaStatus.currency,
        payCurrency: matchingTx.currency || payment.token,
      });
      return { success: true, message: "Payment confirmed successfully" };
    } catch (error) {
      // error-policy:J1 the route translates this explicit failed result.
      logger.error("[Crypto Payments] Manual confirmation failed", {
        paymentId: redact.paymentId(paymentId),
        txHash: redact.txHash(txHash),
        error,
      });
      return {
        success: false,
        message: error instanceof Error ? error.message : "Confirmation failed",
      };
    }
  }

  private async creditReferralRevenueSplits(params: {
    payment: CryptoPayment;
    purchaseAmount: string;
    txHash: string;
    transaction: DbTransaction;
  }): Promise<void> {
    const { payment, purchaseAmount, txHash, transaction } = params;
    if (!payment.user_id) return;

    const purchase = new Decimal(purchaseAmount);
    const { splits } = await referralsService.calculateRevenueSplitsExact(
      payment.user_id,
      purchaseAmount,
      transaction,
    );
    if (splits.length === 0) return;

    for (const split of splits) {
      const splitAmount = new Decimal(split.amount);
      if (!splitAmount.gt(0)) continue;
      const source =
        split.role === "app_owner" ? "app_owner_revenue_share" : "creator_revenue_share";
      const sourceId = `crypto_revenue_split:${payment.id}:${split.userId}`;
      const result = await redeemableEarningsService.addEarnings({
        userId: split.userId,
        amount: split.amount,
        source,
        sourceId,
        dedupeBySourceId: true,
        description: `${
          split.role === "app_owner" ? "App Owner" : "Creator"
        } revenue share (${splitAmount.div(purchase).mul(100).toDecimalPlaces(0).toFixed()}%) for crypto payment $${purchase.toFixed(2)}`,
        metadata: {
          buyer_user_id: payment.user_id,
          buyer_org_id: payment.organization_id,
          crypto_payment_id: payment.id,
          transaction_hash: txHash,
          role: split.role,
        },
        transaction,
      });

      if (!result.success) {
        throw new Error(`Failed to process crypto revenue split: ${result.error}`);
      }
    }
  }

  async handleWebhook(payload: {
    track_id: string;
    status: string;
    amount?: number;
    pay_amount?: number;
    address?: string;
    txID?: string;
  }): Promise<{ success: boolean; message: string }> {
    const { track_id, status, amount: webhookAmount, pay_amount: webhookPayAmount, txID } = payload;

    if (typeof track_id !== "string" || typeof status !== "string") {
      throw new Error("Invalid webhook payload");
    }

    logger.info("[Crypto Payments] Webhook received", {
      track_id: redact.trackId(track_id),
      status,
      webhookAmount,
      webhookPayAmount,
    });

    const payment = await cryptoPaymentsRepository.findByTrackId(track_id);

    if (!payment) {
      logger.warn("[Crypto Payments] Payment not found for webhook", {
        track_id: redact.trackId(track_id),
      });
      return { success: false, message: "Payment not found" };
    }

    if (payment.status !== "pending" && payment.status !== "confirmed") {
      logger.info("[Crypto Payments] Payment already processed", {
        track_id: redact.trackId(track_id),
        status: payment.status,
      });
      return { success: true, message: "Payment already processed" };
    }

    try {
      if (oxaPayService.isPaymentConfirmed(status)) {
        const oxaStatus = await oxaPayService.getPaymentStatus(track_id);

        if (!oxaPayService.isPaymentConfirmed(oxaStatus.status)) {
          logger.warn("[Crypto Payments] Webhook status mismatch - OxaPay API disagrees", {
            track_id: redact.trackId(track_id),
            webhookStatus: status,
            apiStatus: oxaStatus.status,
          });
          return {
            success: false,
            message: "Payment status verification failed",
          };
        }

        const tx = oxaStatus.transactions[0];
        if (!tx) {
          logger.error("[Crypto Payments] Webhook confirmed but no transaction data from API", {
            track_id: redact.trackId(track_id),
          });
          return { success: false, message: "No transaction data available" };
        }

        // Credit invoice USD amount for ALL currencies
        // - Underpayments: Rejected by OxaPay (underPaidCover: 0)
        // - Overpayments: User's responsibility
        const creditAmount = tx.amount; // Invoice USD amount from API
        const receivedAmount = new Decimal(creditAmount);

        logger.info("[Crypto Payments] Webhook - payment received", {
          track_id: redact.trackId(track_id),
          expectedAmount: payment.expected_amount,
          creditAmount: receivedAmount.toString(),
          nativeAmount: tx.nativeAmount,
          payCurrency: tx.currency,
          network: payment.network,
        });

        await this.confirmPayment(payment.id, tx.txHash || txID || track_id, {
          trackId: oxaStatus.trackId,
          orderId: oxaStatus.orderId,
          invoiceAmount: oxaStatus.amount,
          invoiceCurrency: oxaStatus.currency,
          payCurrency: tx.currency,
        });
        return { success: true, message: "Payment confirmed" };
      }

      if (oxaPayService.isPaymentExpired(status)) {
        await persistAppChargeFailureForPayment(payment, "expired", "expired");
        return { success: true, message: "Payment marked as expired" };
      }

      if (oxaPayService.isPaymentFailed(status)) {
        await persistAppChargeFailureForPayment(payment, "failed", status);
        return { success: true, message: "Payment marked as failed" };
      }

      return { success: true, message: "Webhook processed" };
    } catch (error) {
      // error-policy:J2 keep webhook identity while preserving the cause for retry.
      logger.error("[Crypto Payments] Webhook processing error", {
        track_id: redact.trackId(track_id),
        error,
      });
      if (error instanceof ElizaError) throw error;
      throw new ElizaError("Crypto payment webhook settlement failed", {
        code: "CRYPTO_WEBHOOK_SETTLEMENT_FAILED",
        context: { trackId: track_id },
        cause: error,
      });
    }
  }

  async listPaymentsByOrganization(organizationId: string): Promise<PaymentStatus[]> {
    validateUuid(organizationId, "organization ID");

    const payments = await cryptoPaymentsRepository.listByOrganization(organizationId);
    return payments.map((p) => this.formatPaymentStatus(p));
  }

  async getSupportedCurrencies() {
    return oxaPayService.getSupportedCurrencies();
  }

  async getSystemStatus() {
    return oxaPayService.getSystemStatus();
  }

  async listExpiredPendingPayments(): Promise<CryptoPayment[]> {
    return cryptoPaymentsRepository.listExpiredPendingPayments();
  }

  async expirePaymentWithCallback(payment: CryptoPayment): Promise<void> {
    await persistAppChargeFailureForPayment(payment, "expired", "expired");
  }

  private formatPaymentStatus(payment: CryptoPayment): PaymentStatus {
    const metadata = extractMetadata(payment.metadata);

    return {
      id: payment.id,
      trackId: typeof metadata.oxapay_track_id === "string" ? metadata.oxapay_track_id : "",
      status: payment.status,
      expectedAmount: payment.expected_amount,
      receivedAmount: payment.received_amount || undefined,
      creditsToAdd: payment.credits_to_add,
      network: payment.network,
      token: payment.token,
      payLink: typeof metadata.pay_link === "string" ? metadata.pay_link : undefined,
      transactionHash: payment.transaction_hash || undefined,
      expiresAt: payment.expires_at,
      createdAt: payment.created_at,
      confirmedAt: payment.confirmed_at || undefined,
    };
  }
}

export const cryptoPaymentsService = new CryptoPaymentsService();
