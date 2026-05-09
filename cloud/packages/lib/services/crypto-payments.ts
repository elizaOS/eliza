import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { validate as uuidValidate } from "uuid";
import { z } from "zod";
import { dbWrite } from "@/db/client";
import { type CryptoPayment, cryptoPaymentsRepository } from "@/db/repositories/crypto-payments";
import { organizationsRepository } from "@/db/repositories/organizations";
import { cryptoPayments } from "@/db/schemas/crypto-payments";
import { PAYMENT_EXPIRATION_SECONDS, validatePaymentAmount } from "@/lib/config/crypto";
import { createCryptoCustomerId, createCryptoInvoiceId } from "@/lib/constants/invoice-ids";
import { logger, redact } from "@/lib/utils/logger";
import { appCreditsService } from "./app-credits";
import { creditsService } from "./credits";
import { discordService } from "./discord";
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
export class CryptoPaymentError extends Error {
  constructor(
    public readonly code: CryptoPaymentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CryptoPaymentError";
  }
}

export interface CreatePaymentParams {
  organizationId: string;
  userId?: string;
  amount: number;
  currency?: string;
  payCurrency?: string;
  network?: OxaPayNetwork;
  description?: string;
  callbackUrl?: string;
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
    fiat_amount: z.number().optional(),
  })
  .passthrough();

type PaymentMetadata = z.infer<typeof paymentMetadataSchema>;

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
      params.callbackUrl ||
      process.env.OXAPAY_CALLBACK_URL ||
      `${process.env.NEXT_PUBLIC_APP_URL}/api/crypto/webhook`;

    const returnUrl =
      params.returnUrl ||
      process.env.OXAPAY_RETURN_URL ||
      `${process.env.NEXT_PUBLIC_APP_URL}/payment/success`;

    // Add random suffix to prevent collision if two payments created in same millisecond
    const randomSuffix = Math.random().toString(36).slice(2, 6);
    const orderId = `${organizationId.replace(/-/g, "").slice(0, 12)}_${Date.now()}_${randomSuffix}`;

    const oxaInvoice = await oxaPayService.createInvoice({
      amount,
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
      expected_amount: amountDecimal.toFixed(3),
      credits_to_add: amountDecimal.toFixed(3),
      network: network || "AUTO",
      token: payCurrency || "AUTO",
      token_address: null,
      status: "pending",
      expires_at: oxaInvoice.expiresAt,
      metadata: {
        ...(metadata ?? {}),
        oxapay_track_id: oxaInvoice.trackId,
        pay_link: oxaInvoice.payLink,
        fiat_currency: currency,
        fiat_amount: amount,
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
      creditsToAdd: amountDecimal.toFixed(3),
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

    if (payment.status === "confirmed") {
      return {
        confirmed: true,
        payment: this.formatPaymentStatus(payment),
      };
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

        await this.confirmPayment(payment.id, tx.txHash, receivedAmount.toString(), tx.currency);

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
        await cryptoPaymentsRepository.markAsExpired(payment.id);
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
        await cryptoPaymentsRepository.markAsFailed(payment.id, oxaStatus.status);
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
      logger.error("[Crypto Payments] Failed to check OxaPay status", {
        paymentId: redact.paymentId(paymentId),
        trackId: redact.trackId(trackId),
        error,
      });
      throw error;
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
    receivedAmount: string,
    actualPayCurrency?: string,
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

      if (payment.status === "confirmed") {
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
        .where(eq(cryptoPayments.transaction_hash, txHash))
        .for("update");

      if (existingTx.length > 0 && existingTx[0].id !== paymentId) {
        logger.error("[Crypto Payments] Double-spend attempt detected", {
          paymentId: redact.paymentId(paymentId),
          txHash: redact.txHash(txHash),
          existingPaymentId: redact.paymentId(existingTx[0].id),
        });
        throw new Error("Transaction already processed for another payment");
      }

      // Credit user the exact received amount (no fee reversal)
      const receivedDecimal = new Decimal(receivedAmount);
      const creditsToAdd = receivedDecimal.toFixed(3);
      const payCurrency = actualPayCurrency || payment.token;
      const appPurchase = getAppCreditPurchaseMetadata(payment.metadata);

      await tx
        .update(cryptoPayments)
        .set({
          status: "confirmed",
          transaction_hash: txHash,
          received_amount: receivedAmount,
          credits_to_add: creditsToAdd,
          confirmed_at: new Date(),
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
          purchaseAmount: receivedDecimal.toNumber(),
          stripePaymentIntentId: `crypto:${payment.id}`,
        });

        await invoicesService.create({
          organization_id: payment.organization_id,
          stripe_invoice_id: createCryptoInvoiceId(payment.id),
          stripe_customer_id: createCryptoCustomerId(payment.organization_id),
          stripe_payment_intent_id: txHash,
          amount_due: payment.expected_amount,
          amount_paid: creditsToAdd,
          currency: payCurrency.toLowerCase(),
          status: "paid",
          invoice_type: "app_crypto_payment",
          credits_added: creditsToAdd,
          metadata: {
            payment_method: "crypto",
            provider: "oxapay",
            network: payment.network,
            token: payCurrency,
            transaction_hash: txHash,
            received_after_fee: receivedAmount,
            oxapay_track_id: getTrackId(payment.metadata),
            app_id: appPurchase.appId,
            charge_request_id: appPurchase.chargeRequestId,
            platform_offset: result.platformOffset,
            creator_earnings: result.creatorEarnings,
          },
        });

        logger.info("[Crypto Payments] App credit payment confirmed", {
          paymentId: redact.paymentId(paymentId),
          txHash: redact.txHash(txHash),
          appId: appPurchase.appId,
          creditsAdded: creditsToAdd,
          creatorEarnings: result.creatorEarnings,
          organizationId: redact.orgId(payment.organization_id),
        });

        return;
      }

      await creditsService.addCredits({
        organizationId: payment.organization_id,
        amount: receivedDecimal.toNumber(),
        description: `Crypto payment (${payCurrency} on ${payment.network})`,
        metadata: {
          crypto_payment_id: payment.id,
          transaction_hash: txHash,
          network: payment.network,
          token: payCurrency,
          received_after_fee: receivedAmount,
          user_paid_amount: creditsToAdd,
          oxapay_track_id: getTrackId(payment.metadata),
        },
      });

      // Create invoice with clearly namespaced IDs to distinguish from Stripe invoices.
      // These are NOT actual Stripe IDs - they use OXAPAY_* prefix for clarity.
      await invoicesService.create({
        organization_id: payment.organization_id,
        stripe_invoice_id: createCryptoInvoiceId(payment.id),
        stripe_customer_id: createCryptoCustomerId(payment.organization_id),
        stripe_payment_intent_id: txHash,
        amount_due: payment.expected_amount,
        amount_paid: creditsToAdd,
        currency: payCurrency.toLowerCase(),
        status: "paid",
        invoice_type: "crypto_payment",
        credits_added: creditsToAdd,
        metadata: {
          payment_method: "crypto",
          provider: "oxapay",
          network: payment.network,
          token: payCurrency,
          transaction_hash: txHash,
          received_after_fee: receivedAmount,
          oxapay_track_id: getTrackId(payment.metadata),
        },
      });

      await this.creditReferralRevenueSplits({
        payment,
        purchaseAmount: receivedDecimal.toNumber(),
        txHash,
      });

      logger.info("[Crypto Payments] Payment confirmed and credits added", {
        paymentId: redact.paymentId(paymentId),
        txHash: redact.txHash(txHash),
        creditsAdded: creditsToAdd,
        expectedAmount: payment.expected_amount,
        receivedAmount,
        organizationId: redact.orgId(payment.organization_id),
      });

      // Log payment to Discord (fire and forget)
      organizationsRepository.findById(payment.organization_id).then((org) => {
        discordService
          .logPaymentReceived({
            paymentId: txHash,
            amount: receivedDecimal.toNumber(),
            currency: payCurrency,
            credits: receivedDecimal.toNumber(),
            organizationId: payment.organization_id,
            organizationName: org?.name,
            paymentMethod: "crypto",
            paymentType: "Crypto Payment",
            network: payment.network,
          })
          .catch((err) => {
            logger.error("[Crypto Payments] Failed to log payment to Discord", {
              error: err,
            });
          });
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
      // Use a database transaction with row-level locking to prevent race conditions
      // This ensures only one request can process the confirmation at a time
      return await dbWrite.transaction(async (tx) => {
        // Acquire a row-level lock on the payment record
        const paymentResult = await tx
          .select()
          .from(cryptoPayments)
          .where(eq(cryptoPayments.id, paymentId))
          .for("update");

        const payment = paymentResult[0];

        if (!payment) {
          return { success: false, message: "Payment not found" };
        }

        if (payment.status === "confirmed") {
          return { success: true, message: "Payment already confirmed" };
        }

        if (payment.status === "expired") {
          return { success: false, message: "Payment has expired" };
        }

        if (payment.status === "failed") {
          return { success: false, message: "Payment has failed" };
        }

        // Get the OxaPay track ID to verify on-chain
        let trackId: string;
        try {
          trackId = getTrackId(payment.metadata);
        } catch {
          logger.error("[Crypto Payments] Missing track ID for on-chain verification", {
            paymentId: redact.paymentId(paymentId),
            txHash: redact.txHash(txHash),
          });
          return {
            success: false,
            message: "Payment configuration error - missing track ID",
          };
        }

        // Verify the transaction on-chain via OxaPay API
        const oxaStatus = await oxaPayService.getPaymentStatus(trackId);

        // Check if the payment is confirmed on OxaPay's side
        if (!oxaPayService.isPaymentConfirmed(oxaStatus.status)) {
          logger.warn("[Crypto Payments] On-chain verification failed - payment not confirmed", {
            paymentId: redact.paymentId(paymentId),
            txHash: redact.txHash(txHash),
            trackId: redact.trackId(trackId),
            oxaPayStatus: oxaStatus.status,
          });
          return {
            success: false,
            message: `Payment not yet confirmed by blockchain. Current status: ${oxaStatus.status}`,
          };
        }

        // Verify the provided transaction hash matches one from OxaPay
        const matchingTx = oxaStatus.transactions.find(
          (txn) => txn.txHash.toLowerCase() === txHash.toLowerCase(),
        );

        if (!matchingTx) {
          // List the valid transaction hashes for debugging (redacted)
          const validHashes = oxaStatus.transactions.map((txn) => redact.txHash(txn.txHash));
          logger.warn("[Crypto Payments] Transaction hash not found in OxaPay records", {
            paymentId: redact.paymentId(paymentId),
            providedTxHash: redact.txHash(txHash),
            trackId: redact.trackId(trackId),
            validTransactions: validHashes,
          });
          return {
            success: false,
            message:
              "Transaction hash not found in payment records. Please ensure you submitted the correct transaction hash.",
          };
        }

        // matchingTx.amount now correctly contains the USD credit amount (handles auto-conversion)
        const receivedAmount = new Decimal(matchingTx.amount);
        logger.info("[Crypto Payments] Manual verification - payment received", {
          paymentId: redact.paymentId(paymentId),
          txHash: redact.txHash(txHash),
          expectedAmount: payment.expected_amount,
          creditAmount: receivedAmount.toString(),
          nativeAmount: matchingTx.nativeAmount,
          usdAmount: matchingTx.usdAmount,
          payCurrency: matchingTx.currency,
        });

        // Check if this transaction hash is already used by another payment
        const existingTxResult = await tx
          .select()
          .from(cryptoPayments)
          .where(eq(cryptoPayments.transaction_hash, txHash))
          .for("update");

        if (existingTxResult.length > 0 && existingTxResult[0].id !== paymentId) {
          logger.error("[Crypto Payments] Double-spend attempt detected", {
            paymentId: redact.paymentId(paymentId),
            txHash: redact.txHash(txHash),
            existingPaymentId: redact.paymentId(existingTxResult[0].id),
          });
          return {
            success: false,
            message: "Transaction already processed for another payment",
          };
        }

        // Credit user the exact received amount (no fee reversal)
        const creditsToAdd = receivedAmount.toFixed(3);
        const payCurrency = matchingTx.currency || payment.token;
        const appPurchase = getAppCreditPurchaseMetadata(payment.metadata);

        logger.info("[Crypto Payments] On-chain verification successful", {
          paymentId: redact.paymentId(paymentId),
          txHash: redact.txHash(txHash),
          trackId: redact.trackId(trackId),
          receivedAmount: matchingTx.amount,
          creditsToAdd,
        });

        // Update the payment record
        await tx
          .update(cryptoPayments)
          .set({
            status: "confirmed",
            transaction_hash: txHash,
            received_amount: matchingTx.amount.toString(),
            credits_to_add: creditsToAdd,
            confirmed_at: new Date(),
          })
          .where(eq(cryptoPayments.id, paymentId));

        if (appPurchase) {
          if (!payment.user_id) {
            return {
              success: false,
              message: "App credit crypto payment is missing user ID",
            };
          }

          const result = await appCreditsService.processPurchase({
            appId: appPurchase.appId,
            userId: payment.user_id,
            organizationId: payment.organization_id,
            purchaseAmount: receivedAmount.toNumber(),
            stripePaymentIntentId: `crypto:${payment.id}`,
          });

          await invoicesService.create({
            organization_id: payment.organization_id,
            stripe_invoice_id: createCryptoInvoiceId(payment.id),
            stripe_customer_id: createCryptoCustomerId(payment.organization_id),
            stripe_payment_intent_id: txHash,
            amount_due: payment.expected_amount,
            amount_paid: creditsToAdd,
            currency: payCurrency.toLowerCase(),
            status: "paid",
            invoice_type: "app_crypto_payment",
            credits_added: creditsToAdd,
            metadata: {
              payment_method: "crypto",
              provider: "oxapay",
              network: payment.network,
              token: payCurrency,
              transaction_hash: txHash,
              received_after_fee: matchingTx.amount.toString(),
              oxapay_track_id: trackId,
              app_id: appPurchase.appId,
              charge_request_id: appPurchase.chargeRequestId,
              platform_offset: result.platformOffset,
              creator_earnings: result.creatorEarnings,
            },
          });

          logger.info("[Crypto Payments] Manual app credit confirmation successful", {
            paymentId: redact.paymentId(paymentId),
            txHash: redact.txHash(txHash),
            appId: appPurchase.appId,
            creditsAdded: creditsToAdd,
            creatorEarnings: result.creatorEarnings,
            organizationId: redact.orgId(payment.organization_id),
          });

          return {
            success: true,
            message: "Payment confirmed successfully",
          };
        }

        // Add credits based on exact received amount
        await creditsService.addCredits({
          organizationId: payment.organization_id,
          amount: receivedAmount.toNumber(),
          description: `Crypto payment (${payCurrency} on ${payment.network})`,
          metadata: {
            crypto_payment_id: payment.id,
            transaction_hash: txHash,
            network: payment.network,
            token: payCurrency,
            received_amount: matchingTx.amount.toString(),
            credits_added: creditsToAdd,
            oxapay_track_id: trackId,
          },
        });

        // Create invoice with clearly namespaced IDs to distinguish from Stripe invoices.
        // These are NOT actual Stripe IDs - they use OXAPAY_* prefix for clarity.
        await invoicesService.create({
          organization_id: payment.organization_id,
          stripe_invoice_id: createCryptoInvoiceId(payment.id),
          stripe_customer_id: createCryptoCustomerId(payment.organization_id),
          stripe_payment_intent_id: txHash,
          amount_due: payment.expected_amount,
          amount_paid: creditsToAdd,
          currency: payCurrency.toLowerCase(),
          status: "paid",
          invoice_type: "crypto_payment",
          credits_added: creditsToAdd,
          metadata: {
            payment_method: "crypto",
            provider: "oxapay",
            network: payment.network,
            token: payCurrency,
            transaction_hash: txHash,
            received_after_fee: matchingTx.amount.toString(),
            oxapay_track_id: trackId,
          },
        });

        await this.creditReferralRevenueSplits({
          payment,
          purchaseAmount: receivedAmount.toNumber(),
          txHash,
        });

        logger.info("[Crypto Payments] Manual confirmation successful", {
          paymentId: redact.paymentId(paymentId),
          txHash: redact.txHash(txHash),
          creditsAdded: creditsToAdd,
          organizationId: redact.orgId(payment.organization_id),
        });

        return {
          success: true,
          message: "Payment confirmed successfully",
        };
      });
    } catch (error) {
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
    purchaseAmount: number;
    txHash: string;
  }): Promise<void> {
    const { payment, purchaseAmount, txHash } = params;
    if (!payment.user_id) return;

    const { splits } = await referralsService.calculateRevenueSplits(payment.user_id, purchaseAmount);
    if (splits.length === 0) return;

    for (const split of splits) {
      if (split.amount <= 0) continue;
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
        } revenue share (${((split.amount / purchaseAmount) * 100).toFixed(0)}%) for crypto payment $${purchaseAmount.toFixed(2)}`,
        metadata: {
          buyer_user_id: payment.user_id,
          buyer_org_id: payment.organization_id,
          crypto_payment_id: payment.id,
          transaction_hash: txHash,
          role: split.role,
        },
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

    if (payment.status !== "pending") {
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

        await this.confirmPayment(
          payment.id,
          tx.txHash || txID || track_id,
          receivedAmount.toString(),
          tx.currency,
        );
        return { success: true, message: "Payment confirmed" };
      }

      if (oxaPayService.isPaymentExpired(status)) {
        await cryptoPaymentsRepository.markAsExpired(payment.id);
        return { success: true, message: "Payment marked as expired" };
      }

      if (oxaPayService.isPaymentFailed(status)) {
        await cryptoPaymentsRepository.markAsFailed(payment.id, status);
        return { success: true, message: "Payment marked as failed" };
      }

      return { success: true, message: "Webhook processed" };
    } catch (error) {
      logger.error("[Crypto Payments] Webhook processing error", {
        track_id: redact.trackId(track_id),
        error,
      });
      throw error;
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
