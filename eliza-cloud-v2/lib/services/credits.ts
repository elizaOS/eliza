/**
 * Credits service for managing organization credit balances and transactions.
 */

import { calculateCost, getProviderFromModel } from "@/lib/pricing";
import {
  creditTransactionsRepository,
  creditPacksRepository,
  organizationsRepository,
  type CreditTransaction,
  type NewCreditTransaction,
  type CreditPack,
} from "@/db/repositories";
import { dbWrite } from "@/db/helpers";
import { organizations } from "@/db/schemas/organizations";
import { creditTransactions } from "@/db/schemas/credit-transactions";
import { eq } from "drizzle-orm";
import { emailService } from "./email";
import { organizationsService } from "./organizations";
import {
  canSendLowCreditsEmail,
  markLowCreditsEmailSent,
} from "@/lib/email/utils/rate-limiter";
import { CacheInvalidation } from "@/lib/cache/invalidation";
import { invalidateOrganizationCache } from "@/lib/cache/organizations-cache";
import { userSessionsService } from "./user-sessions";
import { logger } from "@/lib/utils/logger";

// ============================================================================
// Constants
// ============================================================================

/** Buffer multiplier for cost estimation (default 50%). Configurable via env. */
export const COST_BUFFER = Number(process.env.CREDIT_COST_BUFFER) || 1.5;
/** Minimum reservation amount in USD */
export const MIN_RESERVATION = 0.01;
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
  reconcile: (actualCost: number) => Promise<void>;
}

export interface ReserveCreditsParams {
  organizationId: string;
  userId?: string;
  description: string;
  amount?: number;
  model?: string;
  provider?: string;
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

/**
 * Service for managing credits, transactions, and credit packs.
 */
export class CreditsService {
  // Credit Transactions
  async getTransactionById(id: string): Promise<CreditTransaction | undefined> {
    return await creditTransactionsRepository.findById(id);
  }

  async getTransactionByStripePaymentIntent(
    paymentIntentId: string,
  ): Promise<CreditTransaction | undefined> {
    return await creditTransactionsRepository.findByStripePaymentIntent(
      paymentIntentId,
    );
  }

  async listTransactionsByOrganization(
    organizationId: string,
    limit?: number,
  ): Promise<CreditTransaction[]> {
    return await creditTransactionsRepository.listByOrganization(
      organizationId,
      limit,
    );
  }

  async listTransactionsByOrganizationAndType(
    organizationId: string,
    type: string,
  ): Promise<CreditTransaction[]> {
    return await creditTransactionsRepository.listByOrganizationAndType(
      organizationId,
      type,
    );
  }

  async createTransaction(
    data: NewCreditTransaction,
  ): Promise<CreditTransaction> {
    return await creditTransactionsRepository.create(data);
  }

  async addCredits(params: AddCreditsParams): Promise<{
    transaction: CreditTransaction;
    newBalance: number;
  }> {
    const {
      organizationId,
      amount,
      description,
      metadata,
      stripePaymentIntentId,
    } = params;

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

    // FIXED: Wrap in atomic transaction to prevent inconsistency between
    // transaction record and balance update
    const result = await dbWrite
      .transaction(async (tx) => {
        // Double-check inside transaction to handle race condition where both
        // threads passed the first check but haven't inserted yet
        if (stripePaymentIntentId) {
          const existingInTx = await tx.query.creditTransactions.findFirst({
            where: eq(
              creditTransactions.stripe_payment_intent_id,
              stripePaymentIntentId,
            ),
          });

          if (existingInTx) {
            logger.info(
              `[CreditsService] Race condition detected: Payment intent ${stripePaymentIntentId} was inserted by another thread`,
            );

            // Get current balance
            const org = await tx.query.organizations.findFirst({
              where: eq(organizations.id, organizationId),
            });

            if (!org) {
              throw new Error("Organization not found");
            }

            return {
              transaction: existingInTx,
              newBalance: Number.parseFloat(String(org.credit_balance)),
            };
          }
        }

        // Create transaction record
        const [transaction] = await tx
          .insert(creditTransactions)
          .values({
            organization_id: organizationId,
            amount: String(amount),
            type: "credit",
            description,
            metadata: metadata || {},
            stripe_payment_intent_id: stripePaymentIntentId,
            created_at: new Date(),
          })
          .returning();

        // Get current organization state with row-level lock to prevent concurrent modifications
        const [org] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .for("update");

        if (!org) {
          throw new Error("Organization not found");
        }

        const currentBalance = Number.parseFloat(String(org.credit_balance));
        const newBalance = currentBalance + amount;

        // Update organization balance atomically
        await tx
          .update(organizations)
          .set({
            credit_balance: String(newBalance),
            updated_at: new Date(),
          })
          .where(eq(organizations.id, organizationId));

        return { transaction, newBalance };
      })
      .then(async (result) => {
        // Invalidate organization cache since balance changed
        invalidateOrganizationCache(organizationId).catch((error) => {
          logger.error(
            "[CreditsService] Failed to invalidate org cache:",
            error,
          );
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

    // CRITICAL FIX: Wrap entire operation in atomic transaction with row-level
    // locking to prevent race conditions where concurrent requests could cause
    // negative balance (TOCTOU vulnerability)
    return await dbWrite
      .transaction(async (tx) => {
        // Lock the organization row with FOR UPDATE to prevent concurrent access
        // This ensures atomicity and prevents race conditions
        const [org] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .for("update");

        if (!org) {
          return {
            success: false,
            newBalance: 0,
            transaction: null,
            reason: "org_not_found" as const,
          };
        }

        const currentBalance = Number.parseFloat(String(org.credit_balance));

        // Check if balance meets minimum requirement BEFORE deduction
        if (
          minimumBalanceRequired > 0 &&
          currentBalance < minimumBalanceRequired
        ) {
          return {
            success: false,
            newBalance: currentBalance,
            transaction: null,
            reason: "below_minimum" as const,
          };
        }

        const newBalance = currentBalance - amount;

        // Return early if insufficient credits, without creating a transaction
        if (newBalance < 0) {
          return {
            success: false,
            newBalance: currentBalance,
            transaction: null,
            reason: "insufficient_balance" as const,
          };
        }

        // Update balance atomically
        await tx
          .update(organizations)
          .set({
            credit_balance: String(newBalance),
            updated_at: new Date(),
          })
          .where(eq(organizations.id, organizationId));

        // Create transaction record
        const [transaction] = await tx
          .insert(creditTransactions)
          .values({
            organization_id: organizationId,
            amount: String(-amount),
            type: "debit",
            description,
            metadata: metadata || {},
            created_at: new Date(),
          })
          .returning();

        const result = { success: true, newBalance, transaction };

        return result;
      })
      .then(async (result) => {
        // Invalidate organization cache if balance changed
        if (result.success) {
          invalidateOrganizationCache(organizationId).catch((error) => {
            logger.error(
              "[CreditsService] Failed to invalidate org cache:",
              error,
            );
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
                logger.error(
                  "[CreditsService] Failed to track session usage:",
                  error,
                );
              });
          }

          // Check if auto top-up should be triggered
          this.checkAndTriggerAutoTopUp(
            organizationId,
            result.newBalance,
          ).catch((error) => {
            logger.error(
              "[CreditsService] Failed to check auto top-up:",
              error,
            );
          });

          // Queue low credits email
          this.queueLowCreditsEmail(organizationId, result.newBalance).catch(
            (error) => {
              logger.error(
                "[CreditsService] Failed to queue low credits email:",
                error,
              );
            },
          );
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
      logger.error(
        `[CreditsService] Error checking auto top-up for org ${organizationId}:`,
        error,
      );
    }
  }

  private async queueLowCreditsEmail(
    organizationId: string,
    currentBalance: number,
  ): Promise<void> {
    try {
      const threshold = parseInt(
        process.env.LOW_CREDITS_THRESHOLD || "1000",
        10,
      );

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
        console.warn("[CreditsService] No billing email for organization", {
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

    return await dbWrite
      .transaction(async (tx) => {
        // Lock the organization row
        const [org] = await tx
          .select()
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .for("update");

        if (!org) {
          throw new Error("Organization not found");
        }

        const currentBalance = Number.parseFloat(String(org.credit_balance));
        const newBalance = currentBalance + amount;

        // Update balance
        await tx
          .update(organizations)
          .set({
            credit_balance: String(newBalance),
            updated_at: new Date(),
          })
          .where(eq(organizations.id, organizationId));

        // Create refund transaction record
        const [transaction] = await tx
          .insert(creditTransactions)
          .values({
            organization_id: organizationId,
            amount: String(amount),
            type: "refund",
            description,
            metadata: metadata || {},
            created_at: new Date(),
          })
          .returning();

        return { transaction, newBalance };
      })
      .then(async (result) => {
        // Invalidate organization cache since balance changed
        invalidateOrganizationCache(organizationId).catch((error) => {
          logger.error(
            "[CreditsService] Failed to invalidate org cache:",
            error,
          );
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
  }): Promise<void> {
    const {
      organizationId,
      reservedAmount,
      actualCost,
      description,
      metadata,
    } = params;
    const difference = reservedAmount - actualCost;
    const EPSILON = 0.0001; // $0.0001 threshold for float comparison

    if (Math.abs(difference) < EPSILON) {
      return;
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
          await this.refundCredits({
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
          return;
        }

        const overage = -difference;
        await this.deductCredits({
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
        return;
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
          return;
        }
        logger.warn("[Credits] Reconciliation retry", {
          attempt,
          organizationId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS * attempt),
        );
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
      const estimatedOutputTokens =
        params.estimatedOutputTokens ?? DEFAULT_OUTPUT_TOKENS;

      const { totalCost: estimatedCost } = await calculateCost(
        params.model,
        provider,
        estimatedInputTokens,
        estimatedOutputTokens,
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
      throw new InsufficientCreditsError(
        reservedAmount,
        result.newBalance,
        result.reason,
      );
    }

    logger.info("[Credits] Reserved", {
      organizationId,
      reservedAmount,
      ...(model && { model }),
    });

    return {
      reservedAmount,
      reconcile: async (actualCost: number) => {
        await this.reconcile({
          organizationId,
          reservedAmount,
          actualCost,
          description,
          metadata: { user_id: userId, ...(model && { model }) },
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
      reconcile: async () => {},
    };
  }

  // Credit Packs
  async getCreditPackById(id: string): Promise<CreditPack | undefined> {
    return await creditPacksRepository.findById(id);
  }

  async getCreditPackByStripePriceId(
    stripePriceId: string,
  ): Promise<CreditPack | undefined> {
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
