/**
 * Service for managing app-specific credit balances and purchases.
 */

import { eq, sql } from "drizzle-orm";
import { dbWrite } from "@/db/helpers";
import {
  type AppCreditBalance,
  appCreditBalancesRepository,
} from "@/db/repositories/app-credit-balances";
import { appEarningsRepository } from "@/db/repositories/app-earnings";
import { type App, appsRepository } from "@/db/repositories/apps";
import { organizationsRepository } from "@/db/repositories/organizations";
import { usersRepository } from "@/db/repositories/users";
import { apps } from "@/db/schemas/apps";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { logger } from "@/lib/utils/logger";
import { creditsService } from "./credits";
import { redeemableEarningsService } from "./redeemable-earnings";

/**
 * Subset of app row used to compute inference cost markup. Cached per appId on
 * the LLM hot path so /v1/messages, /v1/chat/completions, /v1/chat don't hit
 * Postgres for monetization config on every request. Re-derive per-call cost
 * from these inputs locally.
 */
interface CostMarkupConfig {
  monetizationEnabled: boolean;
  inferenceMarkupPercentage: number;
}

/** Negative-cache marker for missing apps. */
interface NoneMarker {
  __none: true;
}

/**
 * Invalidate the cached app row + markup config after a mutation that touches
 * fields read on the LLM hot path (monetization toggle, markup %, earnings
 * counters, etc.). Direct cache.del to avoid a circular dependency on
 * appsService — both modules sit in the same layer.
 */
async function invalidateAppCacheKeys(appId: string, slug?: string): Promise<void> {
  const promises: Promise<void>[] = [
    cache.del(CacheKeys.app.byId(appId)),
    cache.del(CacheKeys.app.costMarkup(appId)),
  ];
  if (slug) {
    promises.push(cache.del(CacheKeys.app.bySlug(slug)));
  }
  await Promise.all(promises);
}

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
    const creditBalance = await appCreditBalancesRepository.findByAppAndUser(appId, userId);

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
    return await appCreditBalancesRepository.getOrCreate(appId, userId, organizationId);
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

  async processPurchase(params: AppCreditPurchaseParams): Promise<AppCreditPurchaseResult> {
    const { appId, userId, organizationId, purchaseAmount, stripePaymentIntentId } = params;

    const app = await appsRepository.findById(appId);
    if (!app) {
      throw new Error(`App not found: ${appId}`);
    }

    // Deduplication check for Stripe webhook retries
    if (stripePaymentIntentId) {
      const existingTransaction = await appEarningsRepository.findTransactionByPaymentIntent(
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

    const { balance, newBalance } = await appCreditBalancesRepository.addCredits(
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

  async deductCredits(params: AppCreditDeductionParams): Promise<AppCreditDeductionResult> {
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
    const markupPercentage = app.monetization_enabled ? Number(app.inference_markup_percentage) : 0;
    const creatorMarkup = baseCost * (markupPercentage / 100);
    const totalCost = baseCost + creatorMarkup;

    // Debit from the user's organization credit balance. Atomic via row-lock.
    // Switched from `app_credit_balances` (per-app pre-purchased pool) to the
    // org balance so any signed-in user with cloud credits can use any
    // monetized app without a separate top-up. App dev still earns the
    // markup via `recordCreatorEarnings()` below.
    const user = await usersRepository.findById(userId);
    if (!user?.organization_id) {
      return {
        success: false,
        baseCost,
        creatorMarkup,
        totalCost,
        creatorEarnings: 0,
        newBalance: 0,
        message: `User has no organization: ${userId}`,
      };
    }
    const orgDeduct = await creditsService.reserveAndDeductCredits({
      organizationId: user.organization_id,
      amount: totalCost,
      description: description ?? `App inference (${app.name ?? appId})`,
      metadata: {
        appId,
        userId,
        baseCost,
        creatorMarkup,
        totalCost,
        markupPercentage,
        ...metadata,
      },
    });

    if (!orgDeduct.success) {
      return {
        success: false,
        baseCost,
        creatorMarkup,
        totalCost,
        creatorEarnings: 0,
        newBalance: orgDeduct.newBalance,
        message: `Insufficient cloud credits. Required: $${totalCost.toFixed(2)}, Available: $${orgDeduct.newBalance.toFixed(2)}`,
      };
    }

    // Track app user activity (creates/updates app_users record)
    await this.trackAppUserActivity(app, userId, totalCost.toFixed(4), metadata);

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
      newBalance: orgDeduct.newBalance,
    });

    return {
      success: true,
      baseCost,
      creatorMarkup,
      totalCost,
      creatorEarnings: creatorMarkup,
      newBalance: orgDeduct.newBalance,
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

    // Resolve the user's organization once — every branch below charges or
    // refunds against the org credit balance, not a per-app pool.
    const user = await usersRepository.findById(userId);
    if (!user?.organization_id) {
      logger.error("[AppCredits] User not found during reconciliation", { userId });
      return {
        reconciled: false,
        difference: baseCostDifference,
        action: "none",
        adjustedAmount: 0,
        newBalance: 0,
      };
    }
    const organizationId = user.organization_id;

    const readOrgBalance = async (): Promise<number> => {
      const org = await organizationsRepository.findById(organizationId);
      return org ? Number.parseFloat(String(org.credit_balance)) : 0;
    };

    // Skip reconciliation for negligible differences
    if (Math.abs(baseCostDifference) < RECONCILIATION_THRESHOLD) {
      return {
        reconciled: false,
        difference: 0,
        action: "none",
        adjustedAmount: 0,
        newBalance: await readOrgBalance(),
      };
    }

    // Use provided app to avoid N+1 query, or fetch if not provided
    const app = providedApp ?? (await appsRepository.findById(appId));
    if (!app) {
      logger.error("[AppCredits] App not found during reconciliation", { appId });
      return {
        reconciled: false,
        difference: baseCostDifference,
        action: "none",
        adjustedAmount: 0,
        newBalance: await readOrgBalance(),
      };
    }

    // Calculate the total cost difference including markup
    const markupPercentage = app.monetization_enabled ? Number(app.inference_markup_percentage) : 0;
    const markupMultiplier = 1 + markupPercentage / 100;
    const totalCostDifference = baseCostDifference * markupMultiplier;
    const creatorMarkupDifference = baseCostDifference * (markupPercentage / 100);

    if (baseCostDifference < 0) {
      // REFUND: Actual was less than estimated. Add credit back to the org
      // balance and reverse the creator's earnings for the over-charged delta.
      const refundAmount = Math.abs(totalCostDifference);
      const creatorEarningsReduction = Math.abs(creatorMarkupDifference);

      const { newBalance } = await creditsService.refundCredits({
        organizationId,
        amount: refundAmount,
        description: `App reconciliation refund (${app.name ?? appId})`,
        metadata: {
          appId,
          userId,
          baseCostDifference,
          estimatedBaseCost,
          actualBaseCost,
          markupPercentage,
          ...metadata,
        },
      });

      // Reverse creator earnings if monetization is enabled and there was markup
      if (app.monetization_enabled && creatorEarningsReduction > 0) {
        await this.reverseCreatorEarnings(appId, userId, creatorEarningsReduction, {
          type: "reconciliation_refund",
          baseCostDifference,
          estimatedBaseCost,
          actualBaseCost,
          description,
          ...metadata,
        });

        await dbWrite
          .update(apps)
          .set({
            total_creator_earnings: sql`GREATEST(0, ${apps.total_creator_earnings} - ${creatorEarningsReduction})`,
            total_platform_revenue: sql`GREATEST(0, ${apps.total_platform_revenue} - ${Math.abs(baseCostDifference)})`,
            updated_at: new Date(),
          })
          .where(eq(apps.id, appId));
      }

      logger.info("[AppCredits] Reconciliation: Refunded overcharge to org balance", {
        appId,
        userId,
        organizationId,
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

    // CHARGE: Actual exceeded estimated — debit the delta from the org balance.
    // `reserveAndDeductCredits` is atomic with row-level locking, so concurrent
    // calls can't double-spend.
    const additionalCharge = totalCostDifference;

    const orgDeduct = await creditsService.reserveAndDeductCredits({
      organizationId,
      amount: additionalCharge,
      description: `App reconciliation charge (${app.name ?? appId})`,
      metadata: {
        appId,
        userId,
        baseCostDifference,
        estimatedBaseCost,
        actualBaseCost,
        markupPercentage,
        creatorMarkupDifference,
        ...metadata,
      },
    });

    if (orgDeduct.success) {
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
          app,
        );

        await dbWrite
          .update(apps)
          .set({
            total_creator_earnings: sql`${apps.total_creator_earnings} + ${creatorMarkupDifference}`,
            total_platform_revenue: sql`${apps.total_platform_revenue} + ${baseCostDifference}`,
            updated_at: new Date(),
          })
          .where(eq(apps.id, appId));
      }

      logger.info("[AppCredits] Reconciliation: Charged additional to org balance", {
        appId,
        userId,
        organizationId,
        estimatedBaseCost,
        actualBaseCost,
        additionalCharge,
        newBalance: orgDeduct.newBalance,
      });

      return {
        reconciled: true,
        difference: baseCostDifference,
        action: "charge",
        adjustedAmount: additionalCharge,
        newBalance: orgDeduct.newBalance,
      };
    }

    // Insufficient balance — request already completed, platform absorbs the loss.
    // Logged so we can monitor and recover via debt tracking later.
    logger.warn(
      "[AppCredits] Reconciliation: Insufficient org balance for additional charge (platform absorbing loss)",
      {
        appId,
        userId,
        organizationId,
        additionalCharge,
        currentBalance: orgDeduct.newBalance,
        lossAmount: additionalCharge,
      },
    );

    return {
      reconciled: false,
      difference: baseCostDifference,
      action: "charge",
      adjustedAmount: 0,
      newBalance: orgDeduct.newBalance,
    };
  }

  /**
   * Read the cached markup config for an app, or fetch + cache it.
   *
   * Caches only the monetization fields (not the per-call computed cost — that
   * depends on `baseCost`). Negative-cached for short TTL when the app is missing.
   *
   * Invalidate via `appsService.invalidateCache()` (which clears `costMarkup`).
   */
  private async getCostMarkupConfig(appId: string): Promise<CostMarkupConfig | null> {
    const cacheKey = CacheKeys.app.costMarkup(appId);

    const cached = await cache.get<CostMarkupConfig | NoneMarker>(cacheKey);
    if (cached) {
      if ((cached as NoneMarker).__none) return null;
      return cached as CostMarkupConfig;
    }

    const app = await appsRepository.findById(appId);

    if (!app) {
      await cache.set(cacheKey, { __none: true } satisfies NoneMarker, CacheTTL.app.none);
      return null;
    }

    const config: CostMarkupConfig = {
      monetizationEnabled: app.monetization_enabled,
      inferenceMarkupPercentage: Number(app.inference_markup_percentage),
    };

    await cache.set(cacheKey, config, CacheTTL.app.costMarkup);
    return config;
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
    const config = await this.getCostMarkupConfig(appId);

    if (!config) {
      return {
        baseCost,
        creatorMarkup: 0,
        totalCost: baseCost,
        markupPercentage: 0,
      };
    }

    // Only apply markup if monetization is enabled
    const markupPercentage = config.monetizationEnabled ? config.inferenceMarkupPercentage : 0;
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
    // Read against the user's organization-level credit balance instead of a
    // per-app pool. The product flow is: the user signs in to Eliza Cloud
    // once, tops up their cloud balance once, and that balance funds every
    // monetized app they use. The app dev still earns the markup % via
    // `deductCredits()` -> `recordCreatorEarnings()` below.
    const user = await usersRepository.findById(userId);
    if (!user?.organization_id) {
      return { sufficient: false, balance: 0, required: requiredAmount };
    }
    const org = await organizationsRepository.findById(user.organization_id);
    const balance = org ? Number.parseFloat(String(org.credit_balance)) : 0;
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
        type === "inference_markup" ? "Inference markup earnings" : "Credit purchase share",
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
    await appsRepository.trackAppUserActivity(app.id, userId, creditsUsed, metadata);
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
      (settings.inferenceMarkupPercentage < 0 || settings.inferenceMarkupPercentage > 1000)
    ) {
      throw new Error("Inference markup must be between 0% and 1000%");
    }

    if (
      settings.purchaseSharePercentage !== undefined &&
      (settings.purchaseSharePercentage < 0 || settings.purchaseSharePercentage > 100)
    ) {
      throw new Error("Purchase share must be between 0% and 100%");
    }

    // Read existing slug before update so we can evict the bySlug cache entry too.
    const existing = await appsRepository.findById(appId);

    await appsRepository.update(appId, {
      ...(settings.monetizationEnabled !== undefined && {
        monetization_enabled: settings.monetizationEnabled,
      }),
      ...(settings.inferenceMarkupPercentage !== undefined && {
        inference_markup_percentage: settings.inferenceMarkupPercentage,
      }),
      ...(settings.purchaseSharePercentage !== undefined && {
        purchase_share_percentage: settings.purchaseSharePercentage,
      }),
    });

    // Critical: monetization config is read by /v1/messages and /v1/chat/* on
    // every inference via calculateCostWithMarkup(). Evict the cached app row
    // and the markup-config cache so the toggle takes effect immediately.
    await invalidateAppCacheKeys(appId, existing?.slug ?? undefined);

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
