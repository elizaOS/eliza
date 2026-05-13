/**
 * Credits service for managing organization credit balances and transactions.
 */

import { sql } from "drizzle-orm";
import { sqlRows } from "@/db/execute-helpers";
import { dbWrite } from "@/db/helpers";
import {
  type CreditPack,
  type CreditTransaction,
  creditPacksRepository,
  creditTransactionsRepository,
  type NewCreditTransaction,
  organizationsRepository,
} from "@/db/repositories";
import { CacheInvalidation } from "@/lib/cache/invalidation";
import { invalidateOrganizationCache } from "@/lib/cache/organizations-cache";
import { canSendLowCreditsEmail, markLowCreditsEmailSent } from "@/lib/email/utils/rate-limiter";
import { calculateCost, getProviderFromModel } from "@/lib/pricing";
import { logger } from "@/lib/utils/logger";
import type { PricingBillingSource } from "./ai-pricing-definitions";
import { emailService } from "./email";
import { organizationsService } from "./organizations";
import { userSessionsService } from "./user-sessions";

// ============================================================================
// Constants
// ============================================================================

/** Buffer multiplier for cost estimation (default 50%). Configurable via env. */
export const COST_BUFFER = Number(process.env.CREDIT_COST_BUFFER) || 1.5;
/** Minimum reservation amount in USD */
export const MIN_RESERVATION = 0.000001;
/** Epsilon for reconcile float comparisons — 10% of MIN_RESERVATION */
export const EPSILON = MIN_RESERVATION * 0.1;
/** Default estimated output tokens when not specified */
export const DEFAULT_OUTPUT_TOKENS = 500;

// ============================================================================
// Types
// ============================================================================

export class InsufficientCreditsError extends Error {
  constructor(
    public readonly required: number,
    public readonly available: number,
    public readonly reason?: string,
  ) {
    super(
      `Insufficient credits. Required: $${required.toFixed(4)}, Available: $${available.toFixed(4)}`,
    );
    this.name = "InsufficientCreditsError";
  }
}

export interface CreditReservation {
  reservedAmount: number;
  reservationTransactionId?: string | null;
  reconcile: (actualCost: number) => Promise<CreditReconciliationResult | void>;
}

export interface CreditReconciliationResult {
  reservedAmount: number;
  actualCost: number;
  reservationTransactionId?: string | null;
  settlementTransactionIds: string[];
  adjustmentType: "none" | "refund" | "overage";
}

export interface ReserveCreditsParams {
  organizationId: string;
  userId?: string;
  description: string;
  amount?: number;
  model?: string;
  provider?: string;
  billingSource?: PricingBillingSource;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

/**
 * Parameters for adding credits to an organization.
 */
export interface AddCreditsParams {
  organizationId: string;
  amount: number;
  description: string;
  metadata?: Record<string, unknown>;
  stripePaymentIntentId?: string;
}

/**
 * Parameters for deducting credits from an organization.
 */
export interface DeductCreditsParams {
  /** Organization ID. */
  organizationId: string;
  /** Amount to deduct in USD. */
  amount: number;
  /** Description of the deduction. */
  description: string;
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
  /** Optional session token for tracking. */
  session_token?: string;
  /** Optional tokens consumed for usage tracking. */
  tokens_consumed?: number;
}

export interface ReserveAndDeductParams extends DeductCreditsParams {
  /** Minimum balance required before deduction (prevents race conditions) */
  minimumBalanceRequired?: number;
}

interface CreditMutationRow {
  org_exists: boolean | string | number | null;
  current_balance: string | number | null;
  new_balance: string | number | null;
  id: string | null;
  organization_id: string | null;
  user_id: string | null;
  amount: string | number | null;
  type: string | null;
  description: string | null;
  metadata: Record<string, unknown> | string | null;
  stripe_payment_intent_id: string | null;
  created_at: Date | string | null;
}

function isPgTrue(value: boolean | string | number | null | undefined): boolean {
  return value === true || value === 1 || value === "1" || value === "t" || value === "true";
}

function parseNumeric(value: string | number | null | undefined, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    throw new Error(`[CreditsService] Invalid numeric ${fieldName}`);
  }
  return parsed;
}

function parseMetadata(value: CreditMutationRow["metadata"]): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }
  return value;
}

function toCreditTransaction(row: CreditMutationRow): CreditTransaction {
  if (!row.id || !row.organization_id || !row.amount || !row.type || !row.created_at) {
    throw new Error("[CreditsService] Credit mutation did not return a transaction row");
  }

  return {
    id: row.id,
    organization_id: row.organization_id,
    user_id: row.user_id,
    amount: String(row.amount),
    type: row.type,
    description: row.description,
    metadata: parseMetadata(row.metadata),
    stripe_payment_intent_id: row.stripe_payment_intent_id,
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

/**
 * Service for managing credits, transactions, and credit packs.
 */
export class CreditsService {
  private async applyCreditIncrease(
    params: AddCreditsParams & { transactionType: "credit" | "refund" },
  ): Promise<{
    transaction: CreditTransaction;
    newBalance: number;
  }> {
    const {
      organizationId,
      amount,
      description,
      metadata,
      stripePaymentIntentId,
      transactionType,
    } = params;
    const metadataJson = JSON.stringify(metadata ?? {});
    const stripeId = stripePaymentIntentId ?? null;

    const rows = await sqlRows<CreditMutationRow>(
      dbWrite,
      sql`
        WITH org AS (
          SELECT id, credit_balance::numeric AS current_balance
          FROM organizations
          WHERE id = ${organizationId}
          FOR UPDATE
        ),
        inserted AS (
          INSERT INTO credit_transactions (
            organization_id,
            amount,
            type,
            description,
            metadata,
            stripe_payment_intent_id,
            created_at
          )
          SELECT
            org.id,
            ${String(amount)}::numeric,
            ${transactionType},
            ${description},
            ${metadataJson}::jsonb,
            ${stripeId},
            NOW()
          FROM org
          WHERE ${stripeId}::text IS NULL
             OR NOT EXISTS (
               SELECT 1
               FROM credit_transactions
               WHERE stripe_payment_intent_id = ${stripeId}
             )
          ON CONFLICT (stripe_payment_intent_id) DO NOTHING
          RETURNING
            id,
            organization_id,
            user_id,
            amount,
            type,
            description,
            metadata,
            stripe_payment_intent_id,
            created_at
        ),
        updated AS (
          UPDATE organizations AS o
          SET
            credit_balance = org.current_balance + ${String(amount)}::numeric,
            updated_at = NOW()
          FROM org
          WHERE o.id = org.id
            AND EXISTS (SELECT 1 FROM inserted)
          RETURNING o.credit_balance AS new_balance
        )
        SELECT
          EXISTS(SELECT 1 FROM org) AS org_exists,
          (SELECT current_balance FROM org) AS current_balance,
          COALESCE((SELECT new_balance FROM updated), (SELECT current_balance FROM org)) AS new_balance,
          inserted.id,
          inserted.organization_id,
          inserted.user_id,
          inserted.amount,
          inserted.type,
          inserted.description,
          inserted.metadata,
          inserted.stripe_payment_intent_id,
          inserted.created_at
        FROM (SELECT 1) AS singleton
        LEFT JOIN inserted ON true
      `,
    );

    const row = rows[0];
    if (!row || !isPgTrue(row.org_exists)) {
      throw new Error("Organization not found");
    }

    if (!row.id && stripePaymentIntentId) {
      const existingTransaction =
        await this.getTransactionByStripePaymentIntent(stripePaymentIntentId);
      if (existingTransaction) {
        const org = await organizationsRepository.findById(organizationId);
        if (!org) {
          throw new Error("Organization not found");
        }
        return {
          transaction: existingTransaction,
          newBalance: Number.parseFloat(String(org.credit_balance)),
        };
      }
    }

    return {
      transaction: toCreditTransaction(row),
      newBalance: parseNumeric(row.new_balance, "new_balance"),
    };
  }

  // Credit Transactions
  async getTransactionById(id: string): Promise<CreditTransaction | undefined> {
    return await creditTransactionsRepository.findById(id);
  }

  async getTransactionByStripePaymentIntent(
    paymentIntentId: string,
  ): Promise<CreditTransaction | undefined> {
    return await creditTransactionsRepository.findByStripePaymentIntent(paymentIntentId);
  }

  async listTransactionsByOrganization(
    organizationId: string,
    limit?: number,
  ): Promise<CreditTransaction[]> {
    return await creditTransactionsRepository.listByOrganization(organizationId, limit);
  }

  async listTransactionsByOrganizationAndType(
    organizationId: string,
    type: string,
  ): Promise<CreditTransaction[]> {
    return await creditTransactionsRepository.listByOrganizationAndType(organizationId, type);
  }

  async createTransaction(data: NewCreditTransaction): Promise<CreditTransaction> {
    return await creditTransactionsRepository.create(data);
  }

  async addCredits(params: AddCreditsParams): Promise<{
    transaction: CreditTransaction;
    newBalance: number;
  }> {
    const { organizationId, amount, description, metadata, stripePaymentIntentId } = params;

    // IDEMPOTENCY: If stripePaymentIntentId is provided, check for existing transaction
    // This prevents race conditions when both synchronous and webhook calls try to add credits
    if (stripePaymentIntentId) {
      const existingTransaction =
        await this.getTransactionByStripePaymentIntent(stripePaymentIntentId);

      if (existingTransaction) {
        logger.info(
          `[CreditsService] Idempotency: Payment intent ${stripePaymentIntentId} already processed (transaction ${existingTransaction.id})`,
        );

        // Get current balance to return consistent response
        const org = await organizationsRepository.findById(organizationId);
        if (!org) {
          throw new Error("Organization not found");
        }

        return {
          transaction: existingTransaction,
          newBalance: Number.parseFloat(String(org.credit_balance)),
        };
      }
    }

    const result = await this.applyCreditIncrease({
      organizationId,
      amount,
      description,
      metadata,
      stripePaymentIntentId,
      transactionType: "credit",
    }).then(async (result) => {
      invalidateOrganizationCache(organizationId).catch((error) => {
        logger.error("[CreditsService] Failed to invalidate org cache:", error);
      });
      return result;
    });

    // Invalidate balance cache immediately after transaction
    await CacheInvalidation.onCreditMutation(organizationId);

    return result;
  }

  async deductCredits(params: DeductCreditsParams): Promise<{
    success: boolean;
    newBalance: number;
    transaction: CreditTransaction | null;
  }> {
    // Delegate to reserveAndDeduct with no minimum balance requirement
    return this.reserveAndDeductCredits(params);
  }

  /**
   * Atomically check balance and deduct credits in a single transaction.
   * This prevents TOCTOU race conditions by using row-level locking.
   *
   * @param minimumBalanceRequired - Optional minimum balance that must exist BEFORE deduction
   *                                 (useful for reserving credits for estimated costs)
   */
  async reserveAndDeductCredits(params: ReserveAndDeductParams): Promise<{
    success: boolean;
    newBalance: number;
    transaction: CreditTransaction | null;
    reason?: "insufficient_balance" | "below_minimum" | "org_not_found";
  }> {
    const {
      organizationId,
      amount,
      description,
      metadata,
      session_token,
      tokens_consumed,
      minimumBalanceRequired = 0,
    } = params;

    if (amount <= 0) {
      throw new Error("Amount must be positive");
    }

    const metadataJson = JSON.stringify(metadata ?? {});
    const rows = await sqlRows<CreditMutationRow>(
      dbWrite,
      sql`
        WITH org AS (
          SELECT id, credit_balance::numeric AS current_balance
          FROM organizations
          WHERE id = ${organizationId}
          FOR UPDATE
        ),
        eligible AS (
          SELECT
            id,
            current_balance,
            current_balance - ${String(amount)}::numeric AS new_balance
          FROM org
          WHERE current_balance >= ${String(minimumBalanceRequired)}::numeric
            AND current_balance >= ${String(amount)}::numeric
        ),
        updated AS (
          UPDATE organizations AS o
          SET
            credit_balance = eligible.new_balance,
            updated_at = NOW()
          FROM eligible
          WHERE o.id = eligible.id
          RETURNING eligible.new_balance
        ),
        inserted AS (
          INSERT INTO credit_transactions (
            organization_id,
            amount,
            type,
            description,
            metadata,
            created_at
          )
          SELECT
            eligible.id,
            ${String(-amount)}::numeric,
            'debit',
            ${description},
            ${metadataJson}::jsonb,
            NOW()
          FROM eligible
          WHERE EXISTS (SELECT 1 FROM updated)
          RETURNING
            id,
            organization_id,
            user_id,
            amount,
            type,
            description,
            metadata,
            stripe_payment_intent_id,
            created_at
        )
        SELECT
          EXISTS(SELECT 1 FROM org) AS org_exists,
          (SELECT current_balance FROM org) AS current_balance,
          (SELECT new_balance FROM updated) AS new_balance,
          inserted.id,
          inserted.organization_id,
          inserted.user_id,
          inserted.amount,
          inserted.type,
          inserted.description,
          inserted.metadata,
          inserted.stripe_payment_intent_id,
          inserted.created_at
        FROM (SELECT 1) AS singleton
        LEFT JOIN inserted ON true
      `,
    );

    const row = rows[0];
    let result:
      | {
          success: true;
          newBalance: number;
          transaction: CreditTransaction;
        }
      | {
          success: false;
          newBalance: number;
          transaction: null;
          reason: "insufficient_balance" | "below_minimum" | "org_not_found";
        };

    if (!row || !isPgTrue(row.org_exists)) {
      result = {
        success: false,
        newBalance: 0,
        transaction: null,
        reason: "org_not_found",
      };
    } else if (!row.id) {
      const currentBalance = parseNumeric(row.current_balance, "current_balance");
      result = {
        success: false,
        newBalance: currentBalance,
        transaction: null,
        reason:
          minimumBalanceRequired > 0 && currentBalance < minimumBalanceRequired
            ? "below_minimum"
            : "insufficient_balance",
      };
    } else {
      result = {
        success: true,
        newBalance: parseNumeric(row.new_balance, "new_balance"),
        transaction: toCreditTransaction(row),
      };
    }

    return await Promise.resolve(result).then(async (result) => {
      // Invalidate organization cache if balance changed
      if (result.success) {
        invalidateOrganizationCache(organizationId).catch((error) => {
          logger.error("[CreditsService] Failed to invalidate org cache:", error);
        });
        // Invalidate balance cache immediately after successful deduction
        await CacheInvalidation.onCreditMutation(organizationId);

        // Track session usage if session_token is provided
        if (session_token) {
          userSessionsService
            .trackUsage({
              session_token,
              credits_used: amount,
              requests_made: 1,
              tokens_consumed: tokens_consumed || 0,
            })
            .catch((error) => {
              logger.error("[CreditsService] Failed to track session usage:", error);
            });
        }

        // Check if auto top-up should be triggered
        this.checkAndTriggerAutoTopUp(organizationId, result.newBalance).catch((error) => {
          logger.error("[CreditsService] Failed to check auto top-up:", error);
        });

        // Queue low credits email
        this.queueLowCreditsEmail(organizationId, result.newBalance).catch((error) => {
          logger.error("[CreditsService] Failed to queue low credits email:", error);
        });
      }
      return result;
    });
  }

  /**
   * Check if auto top-up should be triggered after credit deduction
   * This is called automatically after every successful credit deduction
   */
  private async checkAndTriggerAutoTopUp(
    organizationId: string,
    newBalance: number,
  ): Promise<void> {
    try {
      // Get organization details
      const org = await organizationsRepository.findById(organizationId);
      if (!org) {
        return;
      }

      // Check if auto top-up is enabled
      if (!org.auto_top_up_enabled) {
        return;
      }

      const threshold = Number(org.auto_top_up_threshold || 0);

      // Check if balance is below threshold
      if (newBalance >= threshold) {
        return;
      }

      logger.info(
        `[CreditsService] Auto top-up triggered: balance $${newBalance.toFixed(2)} < threshold $${threshold.toFixed(2)}`,
      );

      // Import auto top-up service dynamically for lazy loading (only when needed)
      const { autoTopUpService } = await import("./auto-top-up");

      // Execute auto top-up asynchronously (don't block the main operation)
      autoTopUpService.executeAutoTopUp(org).catch((error) => {
        logger.error(
          `[CreditsService] Auto top-up execution failed for org ${organizationId}:`,
          error,
        );
      });
    } catch (error) {
      logger.error(`[CreditsService] Error checking auto top-up for org ${organizationId}:`, error);
    }
  }

  private async queueLowCreditsEmail(
    organizationId: string,
    currentBalance: number,
  ): Promise<void> {
    try {
      const threshold = parseInt(process.env.LOW_CREDITS_THRESHOLD || "1000", 10);

      if (currentBalance <= 0 || currentBalance > threshold) {
        return;
      }

      const canSend = await canSendLowCreditsEmail(organizationId);
      if (!canSend) {
        return;
      }

      const org = await organizationsService.getById(organizationId);
      if (!org) {
        return;
      }

      const recipientEmail = org.billing_email;
      if (!recipientEmail) {
        logger.warn("[CreditsService] No billing email for organization", {
          organizationId,
        });
        return;
      }

      const sent = await emailService.sendLowCreditsEmail({
        email: recipientEmail,
        organizationName: org.name,
        currentBalance,
        threshold,
        billingUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/billing`,
      });

      if (sent) {
        await markLowCreditsEmailSent(organizationId);
      }
    } catch (error) {
      logger.error(
        `[CreditsService] Error queueing low credits email for org ${organizationId}:`,
        error,
      );
    }
  }

  /**
   * Refund credits (e.g., when a generation fails after deduction)
   * Creates a credit transaction to restore the amount
   */
  async refundCredits(params: AddCreditsParams): Promise<{
    transaction: CreditTransaction;
    newBalance: number;
  }> {
    const { organizationId, amount, description, metadata } = params;

    if (amount <= 0) {
      throw new Error("Refund amount must be positive");
    }

    return await this.applyCreditIncrease({
      organizationId,
      amount,
      description,
      metadata,
      transactionType: "refund",
    }).then(async (result) => {
      invalidateOrganizationCache(organizationId).catch((error) => {
        logger.error("[CreditsService] Failed to invalidate org cache:", error);
      });
      return result;
    });
  }

  /**
   * Reconcile credits after a request completes.
   * Adjusts credits based on actual vs reserved cost.
   * - Refunds excess if actual < reserved
   * - Charges overage if actual > reserved
   * - No-op if costs match (within epsilon for float precision)
   *
   * Includes retry logic for transient failures.
   */
  async reconcile(params: {
    organizationId: string;
    reservedAmount: number;
    actualCost: number;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<CreditReconciliationResult> {
    const { organizationId, reservedAmount, actualCost, description, metadata } = params;
    const difference = reservedAmount - actualCost;

    if (Math.abs(difference) < EPSILON) {
      return {
        reservedAmount,
        actualCost,
        reservationTransactionId:
          typeof metadata?.reservation_transaction_id === "string"
            ? metadata.reservation_transaction_id
            : null,
        settlementTransactionIds: [],
        adjustmentType: "none",
      };
    }

    const baseMetadata = {
      ...metadata,
      reserved: reservedAmount,
      actual: actualCost,
    };

    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 100;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (difference > 0) {
          const refund = await this.refundCredits({
            organizationId,
            amount: difference,
            description: `${description} (refund)`,
            metadata: { ...baseMetadata, type: "reconciliation_refund" },
          });
          logger.info("[Credits] Reconciled - refunded excess", {
            organizationId,
            reserved: reservedAmount,
            actual: actualCost,
            refunded: difference,
          });
          return {
            reservedAmount,
            actualCost,
            reservationTransactionId:
              typeof metadata?.reservation_transaction_id === "string"
                ? metadata.reservation_transaction_id
                : null,
            settlementTransactionIds: [refund.transaction.id],
            adjustmentType: "refund",
          };
        }

        const overage = -difference;
        const overageResult = await this.deductCredits({
          organizationId,
          amount: overage,
          description: `${description} (overage)`,
          metadata: { ...baseMetadata, type: "reconciliation_overage" },
        });
        logger.warn("[Credits] Reconciled - charged overage", {
          organizationId,
          reserved: reservedAmount,
          actual: actualCost,
          overage,
        });
        return {
          reservedAmount,
          actualCost,
          reservationTransactionId:
            typeof metadata?.reservation_transaction_id === "string"
              ? metadata.reservation_transaction_id
              : null,
          settlementTransactionIds: overageResult.transaction ? [overageResult.transaction.id] : [],
          adjustmentType: "overage",
        };
      } catch (error) {
        if (attempt === MAX_RETRIES) {
          logger.error("[Credits] Reconciliation failed after retries", {
            organizationId,
            reserved: reservedAmount,
            actual: actualCost,
            difference,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          // Don't throw - operation completed, just log for manual review
          return {
            reservedAmount,
            actualCost,
            reservationTransactionId:
              typeof metadata?.reservation_transaction_id === "string"
                ? metadata.reservation_transaction_id
                : null,
            settlementTransactionIds: [],
            adjustmentType: "none",
          };
        }
        logger.warn("[Credits] Reconciliation retry", {
          attempt,
          organizationId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    }
  }

  // ============================================================================
  // Reserve Credits (High-level API)
  // ============================================================================

  /**
   * Reserve credits before an operation.
   * - If `amount` is provided: fixed cost (images, videos, etc.)
   * - If `model` is provided: estimates cost from tokens with 50% buffer
   *
   * Returns a CreditReservation object with a reconcile() method.
   */
  async reserve(params: ReserveCreditsParams): Promise<CreditReservation> {
    const { organizationId, userId, description } = params;

    // Input validation
    if (!organizationId) {
      throw new Error("reserve() requires organizationId");
    }
    if (!description) {
      throw new Error("reserve() requires description");
    }
    if (params.amount !== undefined && params.amount < 0) {
      throw new Error("reserve() amount must be non-negative");
    }

    let reservedAmount: number;
    let model: string | undefined;

    if (params.amount !== undefined) {
      reservedAmount = params.amount;
    } else if (params.model) {
      model = params.model;
      const provider = params.provider ?? getProviderFromModel(params.model);
      const estimatedInputTokens = params.estimatedInputTokens ?? 0;
      const estimatedOutputTokens = params.estimatedOutputTokens ?? DEFAULT_OUTPUT_TOKENS;

      const { totalCost: estimatedCost } = await calculateCost(
        params.model,
        provider,
        estimatedInputTokens,
        estimatedOutputTokens,
        params.billingSource,
      );

      reservedAmount = Math.max(estimatedCost * COST_BUFFER, MIN_RESERVATION);
    } else {
      throw new Error("reserve() requires either `amount` or `model`");
    }

    const result = await this.reserveAndDeductCredits({
      organizationId,
      amount: reservedAmount,
      description: `${description} (reserved)`,
      metadata: {
        user_id: userId,
        type: "reservation",
        ...(model && { model }),
      },
    });

    if (!result.success) {
      logger.warn("[Credits] Insufficient credits for reservation", {
        organizationId,
        required: reservedAmount,
        available: result.newBalance,
        reason: result.reason,
      });
      throw new InsufficientCreditsError(reservedAmount, result.newBalance, result.reason);
    }

    logger.info("[Credits] Reserved", {
      organizationId,
      reservedAmount,
      ...(model && { model }),
    });

    return {
      reservedAmount,
      reservationTransactionId: result.transaction.id,
      reconcile: async (actualCost: number) => {
        return await this.reconcile({
          organizationId,
          reservedAmount,
          actualCost,
          description,
          metadata: {
            user_id: userId,
            reservation_transaction_id: result.transaction.id,
            ...(model && { model }),
          },
        });
      },
    };
  }

  /**
   * Create a no-op reservation for anonymous users.
   */
  createAnonymousReservation(): CreditReservation {
    return {
      reservedAmount: 0,
      reservationTransactionId: null,
      reconcile: async () => {},
    };
  }

  // Credit Packs
  async getCreditPackById(id: string): Promise<CreditPack | undefined> {
    return await creditPacksRepository.findById(id);
  }

  async getCreditPackByStripePriceId(stripePriceId: string): Promise<CreditPack | undefined> {
    return await creditPacksRepository.findByStripePriceId(stripePriceId);
  }

  /**
   * List active credit packs with caching.
   * Credit packs rarely change so we cache aggressively with SWR.
   */
  async listActiveCreditPacks(): Promise<CreditPack[]> {
    // Import cache lazily to avoid circular dependencies
    const { creditPacksCache } = await import("@/lib/cache/credit-packs-cache");

    return await creditPacksCache.getWithSWR(async () => {
      return await creditPacksRepository.listActive();
    });
  }

  async listAllCreditPacks(): Promise<CreditPack[]> {
    return await creditPacksRepository.listAll();
  }
}

// Export singleton instance
export const creditsService = new CreditsService();
