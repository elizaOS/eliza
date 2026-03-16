/**
 * Service for managing app-specific credit balances and purchases.
 */

import {
  appCreditBalancesRepository,
  type AppCreditBalance,
} from "@/db/repositories/app-credit-balances";
import { appsRepository, type App } from "@/db/repositories/apps";
import { appEarningsRepository } from "@/db/repositories/app-earnings";
import { apps } from "@/db/schemas/apps";
import { appCreditBalances } from "@/db/schemas/app-credit-balances";
import { dbWrite } from "@/db/helpers";
import { eq, sql, and } from "drizzle-orm";
import { logger } from "@/lib/utils/logger";
import { usersRepository } from "@/db/repositories/users";
import { redeemableEarningsService } from "./redeemable-earnings";

/**
 * Threshold for reconciliation - differences below this are ignored (6 decimal precision)
 */
const RECONCILIATION_THRESHOLD = 0.000001;

/**
 * Maximum metadata size in bytes (10KB) to prevent storage bloat and DOS attacks
 */
const MAX_METADATA_SIZE_BYTES = 10240;

/**
 * Maximum nesting depth for metadata objects to prevent stack overflow
 */
const MAX_METADATA_DEPTH = 5;

/**
 * Validates metadata object for size and depth constraints.
 * Returns sanitized metadata or throws on violation.
 */
function validateMetadata(
  metadata: Record<string, unknown> | undefined,
  context: string,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  // Check serialized size
  const serialized = JSON.stringify(metadata);
  if (serialized.length > MAX_METADATA_SIZE_BYTES) {
    throw new Error(
      `${context}: Metadata exceeds maximum size of ${MAX_METADATA_SIZE_BYTES} bytes`,
    );
  }

  // Check nesting depth
  const checkDepth = (obj: unknown, depth: number): void => {
    if (depth > MAX_METADATA_DEPTH) {
      throw new Error(
        `${context}: Metadata exceeds maximum nesting depth of ${MAX_METADATA_DEPTH}`,
      );
    }
    if (obj && typeof obj === "object") {
      for (const value of Object.values(obj)) {
        checkDepth(value, depth + 1);
      }
    }
  };
  checkDepth(metadata, 1);

  return metadata;
}

/**
 * Parameters for purchasing app credits.
 */
export interface AppCreditPurchaseParams {
  appId: string;
  userId: string;
  organizationId: string;
  purchaseAmount: number;
  stripePaymentIntentId?: string; // For deduplication on webhook retries
}

/**
 * Result of purchasing app credits.
 */
export interface AppCreditPurchaseResult {
  success: boolean;
  creditsAdded: number;
  platformOffset: number;
  creatorEarnings: number;
  newBalance: number;
  balance: AppCreditBalance;
}

/**
 * Parameters for deducting app credits.
 */
export interface AppCreditDeductionParams {
  appId: string;
  userId: string;
  baseCost: number;
  description: string;
  metadata?: Record<string, unknown>;
  /** Optional: pass pre-fetched app to avoid N+1 query */
  app?: App;
}

/**
 * Result of deducting app credits.
 */
export interface AppCreditDeductionResult {
  success: boolean;
  baseCost: number;
  creatorMarkup: number;
  totalCost: number;
  creatorEarnings: number;
  newBalance: number;
  message?: string;
}

/**
 * Parameters for reconciling app credits after actual usage is known.
 */
export interface AppCreditReconciliationParams {
  appId: string;
  userId: string;
  estimatedBaseCost: number;
  actualBaseCost: number;
  description: string;
  metadata?: Record<string, unknown>;
  /** Optional: pass pre-fetched app to avoid N+1 query */
  app?: App;
}

/**
 * Result of reconciling app credits.
 */
export interface AppCreditReconciliationResult {
  reconciled: boolean;
  difference: number;
  action: "refund" | "charge" | "none";
  adjustedAmount: number;
  newBalance: number;
}

/**
 * Service for managing app-specific credit balances, purchases, and deductions.
 */
export class AppCreditsService {
  async getBalance(
    appId: string,
    userId: string,
  ): Promise<{
    balance: number;
    totalPurchased: number;
    totalSpent: number;
  } | null> {
    const creditBalance = await appCreditBalancesRepository.findByAppAndUser(
      appId,
      userId,
    );

    if (!creditBalance) {
      return null;
    }

    return {
      balance: Number(creditBalance.credit_balance),
      totalPurchased: Number(creditBalance.total_purchased),
      totalSpent: Number(creditBalance.total_spent),
    };
  }

  async getOrCreateBalance(
    appId: string,
    userId: string,
    organizationId: string,
  ): Promise<AppCreditBalance> {
    return await appCreditBalancesRepository.getOrCreate(
      appId,
      userId,
      organizationId,
    );
  }

  /**
   * Add credits to an app-specific balance (for rewards, bonuses, etc.)
   * Unlike processPurchase, this doesn't involve revenue sharing.
   */
  async addCredits(
    appId: string,
    userId: string,
    amount: number,
    description: string,
  ): Promise<{ newBalance: number }> {
    // Get user's organization ID to ensure balance exists
    const user = await usersRepository.findById(userId);

    if (!user?.organization_id) {
      throw new Error(`User not found or has no organization: ${userId}`);
    }

    const { newBalance } = await appCreditBalancesRepository.addCredits(
      appId,
      userId,
      user.organization_id,
      amount,
    );

    logger.info("[AppCredits] Added credits (reward/bonus)", {
      appId,
      userId,
      amount,
      description,
      newBalance,
    });

    return { newBalance };
  }

  async processPurchase(
    params: AppCreditPurchaseParams,
  ): Promise<AppCreditPurchaseResult> {
    const {
      appId,
      userId,
      organizationId,
      purchaseAmount,
      stripePaymentIntentId,
    } = params;

    const app = await appsRepository.findById(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }

    // Deduplication check for Stripe webhook retries
    if (stripePaymentIntentId) {
      const existingTransaction =
        await appEarningsRepository.findTransactionByPaymentIntent(
          appId,
          stripePaymentIntentId,
        );
      if (existingTransaction) {
        logger.info("[AppCredits] Duplicate purchase detected, skipping", {
          appId,
          userId,
          stripePaymentIntentId,
        });
        // Return existing balance info - get or create to ensure we always have a balance record
        const balance = await appCreditBalancesRepository.getOrCreate(
          appId,
          userId,
          organizationId,
        );
        return {
          success: true,
          creditsAdded: 0, // Already processed
          platformOffset: 0,
          creatorEarnings: 0,
          newBalance: Number(balance.credit_balance),
          balance,
        };
      }
    }

    // Only apply platform offset and creator share if monetization is enabled
    // Users always get full credits for their purchase
    const platformOffset = app.monetization_enabled
      ? Math.min(Number(app.platform_offset_amount), purchaseAmount)
      : 0;
    const amountAfterOffset = purchaseAmount - platformOffset;
    const creatorSharePercentage = app.monetization_enabled
      ? Number(app.purchase_share_percentage) / 100
      : 0;
    const creatorEarnings = amountAfterOffset * creatorSharePercentage;
    const creditsToAdd = purchaseAmount;

    logger.info("[AppCredits] Processing purchase", {
      appId,
      userId,
      purchaseAmount,
      platformOffset,
      creatorEarnings,
      creditsToAdd,
    });

    const { balance, newBalance } =
      await appCreditBalancesRepository.addCredits(
        appId,
        userId,
        organizationId,
        creditsToAdd,
      );

    // Track app user activity for purchase (this will create app_users record if new user)
    await this.trackAppUserActivity(app, userId, "0.00", {
      type: "purchase",
      purchaseAmount,
      creditsAdded: creditsToAdd,
      ...(stripePaymentIntentId && { stripePaymentIntentId }),
    });

    // CRITICAL: Always create a transaction record for deduplication purposes
    // Even when monetization is disabled, we need to track the purchase
    if (app.monetization_enabled && creatorEarnings > 0) {
      await this.recordCreatorEarnings(
        appId,
        userId,
        "purchase_share",
        creatorEarnings,
        {
          purchaseAmount,
          platformOffset,
          creatorSharePercentage: Number(app.purchase_share_percentage),
          ...(stripePaymentIntentId && { stripePaymentIntentId }),
        },
        app, // Pass app to avoid N+1 query
      );

      await dbWrite
        .update(apps)
        .set({
          total_creator_earnings: sql`${apps.total_creator_earnings} + ${creatorEarnings}`,
          total_platform_revenue: sql`${apps.total_platform_revenue} + ${platformOffset}`,
          updated_at: new Date(),
        })
        .where(eq(apps.id, appId));
    } else if (stripePaymentIntentId) {
      // Monetization disabled but still need transaction record for deduplication
      await appEarningsRepository.createTransaction({
        app_id: appId,
        user_id: userId,
        type: "credit_purchase",
        amount: "0", // No earnings when monetization disabled
        description: "Credit purchase (monetization disabled)",
        metadata: {
          purchaseAmount,
          creditsAdded: creditsToAdd,
          stripePaymentIntentId,
          monetizationDisabled: true,
        },
      });
    }

    return {
      success: true,
      creditsAdded: creditsToAdd,
      platformOffset,
      creatorEarnings,
      newBalance,
      balance,
    };
  }

  async deductCredits(
    params: AppCreditDeductionParams,
  ): Promise<AppCreditDeductionResult> {
    const {
      appId,
      userId,
      baseCost,
      description,
      metadata: rawMetadata,
      app: providedApp,
    } = params;

    // Validate metadata size and depth
    const metadata = validateMetadata(rawMetadata, "deductCredits");

    // Use provided app to avoid N+1 query, or fetch if not provided
    const app = providedApp ?? (await appsRepository.findById(appId));
    if (!app) {
      return {
        success: false,
        baseCost,
        creatorMarkup: 0,
        totalCost: baseCost,
        creatorEarnings: 0,
        newBalance: 0,
        message: `App not found: ${appId}`,
      };
    }

    // Only apply markup if monetization is enabled
    // Otherwise, users pay base cost only and creator earns nothing
    const markupPercentage = app.monetization_enabled
      ? Number(app.inference_markup_percentage)
      : 0;
    const creatorMarkup = baseCost * (markupPercentage / 100);
    const totalCost = baseCost + creatorMarkup;

    const result = await appCreditBalancesRepository.deductCredits(
      appId,
      userId,
      totalCost,
    );

    if (!result.success) {
      return {
        success: false,
        baseCost,
        creatorMarkup,
        totalCost,
        creatorEarnings: 0,
        newBalance: result.newBalance,
        message: result.balance
          ? `Insufficient balance. Required: $${totalCost.toFixed(2)}, Available: $${result.newBalance.toFixed(2)}`
          : "No credit balance found for this app",
      };
    }

    // Track app user activity (creates/updates app_users record)
    await this.trackAppUserActivity(
      app,
      userId,
      totalCost.toFixed(4),
      metadata,
    );

    if (app.monetization_enabled && creatorMarkup > 0) {
      await this.recordCreatorEarnings(
        appId,
        userId,
        "inference_markup",
        creatorMarkup,
        {
          baseCost,
          markupPercentage,
          totalCost,
          description,
          ...metadata,
        },
        app, // Pass app to avoid N+1 query
      );

      await dbWrite
        .update(apps)
        .set({
          total_creator_earnings: sql`${apps.total_creator_earnings} + ${creatorMarkup}`,
          total_platform_revenue: sql`${apps.total_platform_revenue} + ${baseCost}`,
          updated_at: new Date(),
        })
        .where(eq(apps.id, appId));
    }

    logger.info("[AppCredits] Deducted credits", {
      appId,
      userId,
      baseCost,
      creatorMarkup,
      totalCost,
      newBalance: result.newBalance,
    });

    return {
      success: true,
      baseCost,
      creatorMarkup,
      totalCost,
      creatorEarnings: creatorMarkup,
      newBalance: result.newBalance,
    };
  }

  /**
   * Reconcile credits after actual usage is known.
   *
   * This handles the difference between estimated and actual costs:
   * - If actual < estimated: refund the difference to user
   * - If actual > estimated: charge the additional amount (if balance allows)
   * - Also adjusts creator earnings accordingly
   *
   * Threshold: Only reconcile if difference > $0.000001 (6 decimal precision)
   */
  async reconcileCredits(
    params: AppCreditReconciliationParams,
  ): Promise<AppCreditReconciliationResult> {
    const {
      appId,
      userId,
      estimatedBaseCost,
      actualBaseCost,
      description,
      metadata: rawMetadata,
      app: providedApp,
    } = params;

    // Validate metadata size and depth
    const metadata = validateMetadata(rawMetadata, "reconcileCredits");

    const baseCostDifference = actualBaseCost - estimatedBaseCost;

    // Skip reconciliation for negligible differences
    if (Math.abs(baseCostDifference) < RECONCILIATION_THRESHOLD) {
      const currentBalance = await appCreditBalancesRepository.getBalance(
        appId,
        userId,
      );
      return {
        reconciled: false,
        difference: 0,
        action: "none",
        adjustedAmount: 0,
        newBalance: currentBalance,
      };
    }

    // Use provided app to avoid N+1 query, or fetch if not provided
    const app = providedApp ?? (await appsRepository.findById(appId));
    if (!app) {
      logger.error("[AppCredits] App not found during reconciliation", {
        appId,
      });
      const currentBalance = await appCreditBalancesRepository.getBalance(
        appId,
        userId,
      );
      return {
        reconciled: false,
        difference: baseCostDifference,
        action: "none",
        adjustedAmount: 0,
        newBalance: currentBalance,
      };
    }

    // Calculate the total cost difference including markup
    const markupPercentage = app.monetization_enabled
      ? Number(app.inference_markup_percentage)
      : 0;
    const markupMultiplier = 1 + markupPercentage / 100;
    const totalCostDifference = baseCostDifference * markupMultiplier;
    const creatorMarkupDifference =
      baseCostDifference * (markupPercentage / 100);

    if (baseCostDifference < 0) {
      // REFUND: Actual was less than estimated - need user for org ID
      const user = await usersRepository.findById(userId);
      if (!user?.organization_id) {
        logger.error("[AppCredits] User not found during reconciliation", {
          userId,
        });
        const currentBalance = await appCreditBalancesRepository.getBalance(
          appId,
          userId,
        );
        return {
          reconciled: false,
          difference: baseCostDifference,
          action: "none",
          adjustedAmount: 0,
          newBalance: currentBalance,
        };
      }

      const refundAmount = Math.abs(totalCostDifference);
      const creatorEarningsReduction = Math.abs(creatorMarkupDifference);

      const { newBalance } = await appCreditBalancesRepository.addCredits(
        appId,
        userId,
        user.organization_id,
        refundAmount,
      );

      // Reverse creator earnings if monetization is enabled and there was markup
      if (app.monetization_enabled && creatorEarningsReduction > 0) {
        await this.reverseCreatorEarnings(
          appId,
          userId,
          creatorEarningsReduction,
          {
            type: "reconciliation_refund",
            baseCostDifference,
            estimatedBaseCost,
            actualBaseCost,
            description,
            ...metadata,
          },
        );

        // Update app revenue counters
        await dbWrite
          .update(apps)
          .set({
            total_creator_earnings: sql`GREATEST(0, ${apps.total_creator_earnings} - ${creatorEarningsReduction})`,
            total_platform_revenue: sql`GREATEST(0, ${apps.total_platform_revenue} - ${Math.abs(baseCostDifference)})`,
            updated_at: new Date(),
          })
          .where(eq(apps.id, appId));
      }

      logger.info("[AppCredits] Reconciliation: Refunded overcharge", {
        appId,
        userId,
        estimatedBaseCost,
        actualBaseCost,
        refundAmount,
        creatorEarningsReduction,
        newBalance,
      });

      return {
        reconciled: true,
        difference: baseCostDifference,
        action: "refund",
        adjustedAmount: refundAmount,
        newBalance,
      };
    }

    // CHARGE: Actual was more than estimated
    // Use a single transaction with row-level locking to prevent race conditions
    const additionalCharge = totalCostDifference;

    const result = await dbWrite.transaction(async (tx) => {
      // Lock the balance row to prevent concurrent modifications
      const [balance] = await tx
        .select()
        .from(appCreditBalances)
        .where(
          and(
            eq(appCreditBalances.app_id, appId),
            eq(appCreditBalances.user_id, userId),
          ),
        )
        .for("update");

      if (!balance) {
        return {
          success: false,
          newBalance: 0,
        };
      }

      const currentBalance = Number(balance.credit_balance);

      if (currentBalance < additionalCharge) {
        return {
          success: false,
          newBalance: currentBalance,
        };
      }

      const newBalance = currentBalance - additionalCharge;

      // Deduct credits
      await tx
        .update(appCreditBalances)
        .set({
          credit_balance: String(newBalance),
          total_spent: sql`${appCreditBalances.total_spent} + ${additionalCharge}`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(appCreditBalances.app_id, appId),
            eq(appCreditBalances.user_id, userId),
          ),
        );

      // Update app revenue counters atomically with credit deduction
      if (app.monetization_enabled && creatorMarkupDifference > 0) {
        await tx
          .update(apps)
          .set({
            total_creator_earnings: sql`${apps.total_creator_earnings} + ${creatorMarkupDifference}`,
            total_platform_revenue: sql`${apps.total_platform_revenue} + ${baseCostDifference}`,
            updated_at: new Date(),
          })
          .where(eq(apps.id, appId));
      }

      return {
        success: true,
        newBalance,
      };
    });

    if (result.success) {
      // Record earnings audit trail outside transaction (non-critical for financial consistency)
      if (app.monetization_enabled && creatorMarkupDifference > 0) {
        await this.recordCreatorEarnings(
          appId,
          userId,
          "inference_markup",
          creatorMarkupDifference,
          {
            type: "reconciliation_adjustment",
            baseCostDifference,
            description,
            ...metadata,
          },
          app, // Pass app to avoid N+1 query
        );
      }

      logger.info("[AppCredits] Reconciliation: Charged additional", {
        appId,
        userId,
        estimatedBaseCost,
        actualBaseCost,
        additionalCharge,
        newBalance: result.newBalance,
      });

      return {
        reconciled: true,
        difference: baseCostDifference,
        action: "charge",
        adjustedAmount: additionalCharge,
        newBalance: result.newBalance,
      };
    }

    /**
     * SILENT LOSS ABSORPTION
     *
     * When actual cost exceeds estimated and user has insufficient balance,
     * the platform absorbs the loss rather than failing the request.
     *
     * Business rationale:
     * - The request has already completed (user received the response)
     * - Better UX to not fail mid-stream with payment errors
     * - Safety multiplier (1.5x) already minimizes occurrence
     *
     * Risk mitigation:
     * - Logged as WARN level for monitoring
     * - Tracked in metrics via reconciliation.action = "charge", adjustedAmount = 0
     * - Can be monitored via: grep "Insufficient balance for additional charge"
     *
     * Future improvements:
     * - Add debt tracking table to recover costs on next purchase
     * - Add admin dashboard metrics for loss monitoring
     * - Consider blocking users with repeated losses
     */
    logger.warn(
      "[AppCredits] Reconciliation: Insufficient balance for additional charge (platform absorbing loss)",
      {
        appId,
        userId,
        additionalCharge,
        currentBalance: result.newBalance,
        lossAmount: additionalCharge,
      },
    );

    return {
      reconciled: false,
      difference: baseCostDifference,
      action: "charge",
      adjustedAmount: 0,
      newBalance: result.newBalance,
    };
  }

  async calculateCostWithMarkup(
    appId: string,
    baseCost: number,
  ): Promise<{
    baseCost: number;
    creatorMarkup: number;
    totalCost: number;
    markupPercentage: number;
  }> {
    const app = await appsRepository.findById(appId);

    if (!app) {
      return {
        baseCost,
        creatorMarkup: 0,
        totalCost: baseCost,
        markupPercentage: 0,
      };
    }

    // Only apply markup if monetization is enabled
    const markupPercentage = app.monetization_enabled
      ? Number(app.inference_markup_percentage)
      : 0;
    const creatorMarkup = baseCost * (markupPercentage / 100);
    const totalCost = baseCost + creatorMarkup;

    return {
      baseCost,
      creatorMarkup,
      totalCost,
      markupPercentage,
    };
  }

  async checkBalance(
    appId: string,
    userId: string,
    requiredAmount: number,
  ): Promise<{
    sufficient: boolean;
    balance: number;
    required: number;
  }> {
    const balance = await appCreditBalancesRepository.getBalance(appId, userId);

    return {
      sufficient: balance >= requiredAmount,
      balance,
      required: requiredAmount,
    };
  }

  private async recordCreatorEarnings(
    appId: string,
    userId: string,
    type: "inference_markup" | "purchase_share",
    amount: number,
    metadata: Record<string, unknown>,
    providedApp?: App,
  ): Promise<void> {
    // Update app-level earnings tracking
    if (type === "inference_markup") {
      await appEarningsRepository.addInferenceEarnings(appId, amount);
    } else {
      await appEarningsRepository.addPurchaseEarnings(appId, amount);
    }

    // Create transaction record
    await appEarningsRepository.createTransaction({
      app_id: appId,
      user_id: userId,
      type,
      amount: String(amount),
      description:
        type === "inference_markup"
          ? "Inference markup earnings"
          : "Credit purchase share",
      metadata,
    });

    // CRITICAL: Credit the app creator's redeemable_earnings balance
    // This allows them to redeem earnings as elizaOS tokens
    // Use provided app to avoid N+1 query, or fetch if not provided
    const app = providedApp ?? (await appsRepository.findById(appId));
    if (app?.created_by_user_id) {
      const result = await redeemableEarningsService.addEarnings({
        userId: app.created_by_user_id,
        amount,
        source: "miniapp", // Database enum value - "miniapp" refers to apps
        sourceId: appId,
        description:
          type === "inference_markup"
            ? `Inference markup from app: ${app.name || appId}`
            : `Purchase share from app: ${app.name || appId}`,
        metadata: {
          appId,
          earningsType: type,
          transactionUserId: userId, // User who triggered this earning
          ...metadata,
        },
      });

      if (!result.success) {
        logger.error("[AppCredits] Failed to credit redeemable earnings", {
          appId,
          creatorId: app.created_by_user_id,
          amount,
          error: result.error,
        });
      } else {
        logger.info("[AppCredits] Credited redeemable earnings to creator", {
          appId,
          creatorId: app.created_by_user_id,
          amount,
          newBalance: result.newBalance,
        });
      }
    }
  }

  /**
   * Reverse creator earnings during reconciliation refunds.
   *
   * When actual cost is less than estimated, users get a refund.
   * This method reduces the creator's earnings proportionally.
   */
  private async reverseCreatorEarnings(
    appId: string,
    userId: string,
    amount: number,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // Reduce app-level inference earnings (use negative value)
    await appEarningsRepository.addInferenceEarnings(appId, -amount);

    // Create transaction record for audit trail
    await appEarningsRepository.createTransaction({
      app_id: appId,
      user_id: userId,
      type: "inference_markup",
      amount: String(-amount), // Negative to indicate reduction
      description: "Reconciliation adjustment (refund)",
      metadata: {
        ...metadata,
        type: "reconciliation_refund",
      },
    });

    // Reduce the app creator's redeemable_earnings balance
    const app = await appsRepository.findById(appId);
    if (app?.created_by_user_id) {
      const result = await redeemableEarningsService.reduceEarnings({
        userId: app.created_by_user_id,
        amount,
        source: "miniapp",
        sourceId: appId,
        description: `Reconciliation adjustment for app: ${app.name || appId}`,
        metadata: {
          appId,
          earningsType: "inference_markup",
          transactionUserId: userId,
          ...metadata,
        },
      });

      if (!result.success) {
        logger.error("[AppCredits] Failed to reduce redeemable earnings", {
          appId,
          creatorId: app.created_by_user_id,
          amount,
          error: result.error,
        });
      } else {
        logger.info("[AppCredits] Reduced redeemable earnings for creator", {
          appId,
          creatorId: app.created_by_user_id,
          amount,
          newBalance: result.newBalance,
        });
      }
    }
  }

  /**
   * Track app user activity - creates or updates app_users record
   * This tracks individual users per app for analytics and monetization
   */
  private async trackAppUserActivity(
    app: App,
    userId: string,
    creditsUsed: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await appsRepository.trackAppUserActivity(
      app.id,
      userId,
      creditsUsed,
      metadata,
    );
  }

  async getMonetizationSettings(appId: string): Promise<{
    monetizationEnabled: boolean;
    inferenceMarkupPercentage: number;
    purchaseSharePercentage: number;
    platformOffsetAmount: number;
    totalCreatorEarnings: number;
  } | null> {
    const app = await appsRepository.findById(appId);
    if (!app) return null;

    return {
      monetizationEnabled: app.monetization_enabled,
      inferenceMarkupPercentage: Number(app.inference_markup_percentage),
      purchaseSharePercentage: Number(app.purchase_share_percentage),
      platformOffsetAmount: Number(app.platform_offset_amount),
      totalCreatorEarnings: Number(app.total_creator_earnings),
    };
  }

  async updateMonetizationSettings(
    appId: string,
    settings: {
      monetizationEnabled?: boolean;
      inferenceMarkupPercentage?: number;
      purchaseSharePercentage?: number;
    },
  ): Promise<void> {
    if (
      settings.inferenceMarkupPercentage !== undefined &&
      (settings.inferenceMarkupPercentage < 0 ||
        settings.inferenceMarkupPercentage > 1000)
    ) {
      throw new Error("Inference markup must be between 0% and 1000%");
    }

    if (
      settings.purchaseSharePercentage !== undefined &&
      (settings.purchaseSharePercentage < 0 ||
        settings.purchaseSharePercentage > 100)
    ) {
      throw new Error("Purchase share must be between 0% and 100%");
    }

    await appsRepository.update(appId, {
      ...(settings.monetizationEnabled !== undefined && {
        monetization_enabled: settings.monetizationEnabled,
      }),
      ...(settings.inferenceMarkupPercentage !== undefined && {
        inference_markup_percentage: String(settings.inferenceMarkupPercentage),
      }),
      ...(settings.purchaseSharePercentage !== undefined && {
        purchase_share_percentage: String(settings.purchaseSharePercentage),
      }),
    });

    // When enabling monetization, ensure earnings record exists
    // This prevents null state when viewing earnings dashboard
    if (settings.monetizationEnabled === true) {
      await appEarningsRepository.getOrCreate(appId);
      logger.info("[AppCredits] Initialized earnings record for app", {
        appId,
      });
    }

    logger.info("[AppCredits] Updated monetization settings", {
      appId,
      settings,
    });
  }
}

// Export singleton instance
export const appCreditsService = new AppCreditsService();
