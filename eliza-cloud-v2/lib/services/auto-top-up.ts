import { dbRead } from "@/db/client";
import { organizations } from "@/db/schemas/organizations";
import { eq, and, sql } from "drizzle-orm";
import { requireStripe } from "@/lib/stripe";
import { organizationsRepository, usersRepository } from "@/db/repositories";
import type { Organization } from "@/db/repositories";
import { emailService } from "./email";
import { logger } from "@/lib/utils/logger";
import { trackServerEvent } from "@/lib/analytics/posthog-server";

/**
 * Constants for auto top-up validation
 */
export const AUTO_TOP_UP_LIMITS = {
  MIN_AMOUNT: 1,
  MAX_AMOUNT: 1000,
  MIN_THRESHOLD: 0,
  MAX_THRESHOLD: 1000,
} as const;

/**
 * Result of executing an auto top-up for an organization
 */
export interface AutoTopUpResult {
  organizationId: string;
  success: boolean;
  amount?: number;
  newBalance?: number;
  error?: string;
}

/**
 * Summary of auto top-up check run
 */
export interface AutoTopUpCheckResult {
  timestamp: Date;
  organizationsChecked: number;
  organizationsProcessed: number;
  successful: number;
  failed: number;
  results: AutoTopUpResult[];
}

/**
 * Service for managing automatic balance top-ups
 * Monitors organization balances and automatically charges when balance falls below threshold
 */
export class AutoTopUpService {
  /**
   * Validate auto top-up settings
   *
   * @param amount - The amount to charge on auto top-up
   * @param threshold - The balance threshold to trigger auto top-up
   * @throws Error if settings are invalid
   */
  validateSettings(amount: number, threshold: number): void {
    if (amount < AUTO_TOP_UP_LIMITS.MIN_AMOUNT) {
      throw new Error(
        `Auto top-up amount must be at least $${AUTO_TOP_UP_LIMITS.MIN_AMOUNT}`,
      );
    }
    if (amount > AUTO_TOP_UP_LIMITS.MAX_AMOUNT) {
      throw new Error(
        `Auto top-up amount cannot exceed $${AUTO_TOP_UP_LIMITS.MAX_AMOUNT}`,
      );
    }
    if (threshold < AUTO_TOP_UP_LIMITS.MIN_THRESHOLD) {
      throw new Error(
        `Auto top-up threshold must be at least $${AUTO_TOP_UP_LIMITS.MIN_THRESHOLD}`,
      );
    }
    if (threshold > AUTO_TOP_UP_LIMITS.MAX_THRESHOLD) {
      throw new Error(
        `Auto top-up threshold cannot exceed $${AUTO_TOP_UP_LIMITS.MAX_THRESHOLD}`,
      );
    }
    if (!Number.isFinite(amount) || !Number.isFinite(threshold)) {
      throw new Error("Auto top-up settings must be valid numbers");
    }
  }

  /**
   * Check and execute auto top-ups for all eligible organizations
   * This method is called periodically by a cron job
   *
   * @returns Summary of the auto top-up check run
   */
  async checkAndExecuteAutoTopUps(): Promise<AutoTopUpCheckResult> {
    const startTime = new Date();
    const results: AutoTopUpResult[] = [];

    logger.info(
      `[AutoTopUp] Starting auto top-up check at ${startTime.toISOString()}`,
    );

    // Find organizations that need auto top-up
    // Using raw SQL for numeric comparison to avoid type coercion issues
    const orgsNeedingTopUp = await dbRead
      .select()
      .from(organizations)
      .where(
        and(
          eq(organizations.auto_top_up_enabled, true),
          sql`CAST(${organizations.credit_balance} AS NUMERIC) < CAST(${organizations.auto_top_up_threshold} AS NUMERIC)`,
        ),
      );

    logger.info(
      `[AutoTopUp] Found ${orgsNeedingTopUp.length} organizations needing auto top-up`,
    );

    const settledResults = await Promise.allSettled(
      orgsNeedingTopUp.map((org) => this.executeAutoTopUp(org)),
    );

    for (const settled of settledResults) {
      if (settled.status === "fulfilled") {
        results.push(settled.value);
      } else {
        logger.error(`[AutoTopUp] Unexpected error:`, settled.reason);
        results.push({
          organizationId: "unknown",
          success: false,
          error:
            settled.reason instanceof Error
              ? settled.reason.message
              : String(settled.reason),
        });
      }
    }

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    logger.info(
      `[AutoTopUp] Completed check. Processed: ${results.length}, Successful: ${successful}, Failed: ${failed}`,
    );

    return {
      timestamp: startTime,
      organizationsChecked: orgsNeedingTopUp.length,
      organizationsProcessed: results.length,
      successful,
      failed,
      results,
    };
  }

  /**
   * Execute auto top-up for a specific organization
   * Creates a PaymentIntent with the saved payment method and processes the payment
   *
   * @param org - The organization to top up
   * @returns Result of the auto top-up operation
   */
  async executeAutoTopUp(org: Organization): Promise<AutoTopUpResult> {
    const organizationId = org.id;

    logger.info(`[AutoTopUp] Processing org ${organizationId} (${org.name})`);
    logger.info(
      `[AutoTopUp] Current balance: $${org.credit_balance}, Threshold: $${org.auto_top_up_threshold}`,
    );

    // Get user for PostHog tracking - wrapped in try-catch to prevent analytics
    // from blocking critical billing operations (database timeouts, etc.)
    //
    // User Attribution Strategy:
    // 1. Billing email owner - most likely the person responsible for billing decisions
    // 2. First organization user - fallback when billing email not set or no match
    // 3. Organization ID prefixed - final fallback for edge cases (no users, DB errors)
    //
    // Note: Consider adding configured_by_user_id to auto_top_up settings if more
    // accurate attribution is needed (track who enabled auto top-up vs who pays)
    let trackingId = `org:${organizationId}`;
    try {
      const users = await usersRepository.listByOrganization(organizationId);
      const billingUser = org.billing_email
        ? users.find((u) => u.email === org.billing_email)
        : null;
      const userId = billingUser?.id || (users.length > 0 ? users[0].id : null);
      trackingId = userId || `org:${organizationId}`;
    } catch (userLookupError) {
      logger.warn(
        `[AutoTopUp] Failed to fetch users for analytics, using org ID`,
        {
          organizationId,
          error:
            userLookupError instanceof Error
              ? userLookupError.message
              : "Unknown error",
        },
      );
    }

    const currentBalance = Number(org.credit_balance);
    const threshold = Number(org.auto_top_up_threshold);
    const topUpAmount = Number(org.auto_top_up_amount || 0);

    // Track auto top-up triggered
    trackServerEvent(trackingId, "auto_topup_triggered", {
      organization_id: organizationId,
      current_balance: currentBalance,
      threshold,
      top_up_amount: topUpAmount,
    });

    // Validate organization has necessary Stripe data
    if (!org.stripe_customer_id) {
      logger.error(`[AutoTopUp] Org ${organizationId} missing Stripe customer`);
      trackServerEvent(trackingId, "auto_topup_failed", {
        organization_id: organizationId,
        error_reason: "missing_stripe_customer",
        amount: topUpAmount,
      });
      await this.disableAutoTopUp(organizationId, "Missing Stripe customer");
      return {
        organizationId,
        success: false,
        error: "Missing Stripe customer",
      };
    }

    if (!org.stripe_default_payment_method) {
      logger.error(
        `[AutoTopUp] Org ${organizationId} missing default payment method`,
      );
      trackServerEvent(trackingId, "auto_topup_failed", {
        organization_id: organizationId,
        error_reason: "missing_payment_method",
        amount: topUpAmount,
      });
      await this.disableAutoTopUp(
        organizationId,
        "Missing default payment method",
      );
      return {
        organizationId,
        success: false,
        error: "Missing default payment method",
      };
    }

    const amount = Number(org.auto_top_up_amount || 0);
    if (amount <= 0 || amount > AUTO_TOP_UP_LIMITS.MAX_AMOUNT) {
      logger.error(
        `[AutoTopUp] Org ${organizationId} has invalid top-up amount: ${amount}`,
      );
      trackServerEvent(trackingId, "auto_topup_failed", {
        organization_id: organizationId,
        error_reason: "invalid_amount",
        amount,
      });
      await this.disableAutoTopUp(organizationId, "Invalid top-up amount");
      return {
        organizationId,
        success: false,
        error: "Invalid top-up amount",
      };
    }

    // Create and confirm PaymentIntent with saved payment method
    logger.info(`[AutoTopUp] Creating PaymentIntent for $${amount.toFixed(2)}`);

    const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;
    const idempotencyKey = `auto-topup-${organizationId}-${Math.floor(Date.now() / IDEMPOTENCY_WINDOW_MS)}`;

    const paymentIntent = await requireStripe().paymentIntents.create(
      {
        amount: Math.round(amount * 100), // Convert to cents
        currency: "usd",
        customer: org.stripe_customer_id,
        payment_method: org.stripe_default_payment_method,
        confirm: true,
        off_session: true, // Critical: allows charging without user present
        metadata: {
          organization_id: organizationId,
          credits: amount.toFixed(2),
          type: "auto_top_up",
        },
        description: `Auto top-up - $${amount.toFixed(2)}`,
      },
      { idempotencyKey },
    );

    logger.info(
      `[AutoTopUp] PaymentIntent ${paymentIntent.id} status: ${paymentIntent.status}`,
    );

    if (paymentIntent.status === "succeeded") {
      // Credits will be added by webhook, but we can return success here
      const previousBalance = Number(org.credit_balance);
      const newBalance = previousBalance + amount;

      logger.info(
        `[AutoTopUp] ✓ Auto top-up succeeded for org ${organizationId}. Payment: ${paymentIntent.id}`,
      );

      // Track auto top-up completed in PostHog
      trackServerEvent(trackingId, "auto_topup_completed", {
        organization_id: organizationId,
        amount,
        previous_balance: previousBalance,
        new_balance: newBalance,
        payment_intent_id: paymentIntent.id,
      });

      // Also track unified checkout_completed
      trackServerEvent(trackingId, "checkout_completed", {
        payment_method: "stripe",
        amount,
        currency: "usd",
        organization_id: organizationId,
        purchase_type: "auto_top_up",
        credits_added: amount,
      });

      // Send success email notification
      logger.info(
        `[AutoTopUp] About to call queueAutoTopUpSuccessEmail for org ${organizationId}`,
      );
      this.queueAutoTopUpSuccessEmail(
        org,
        amount,
        previousBalance,
        newBalance,
        paymentIntent.id,
      );

      // Note: Credits are added by webhook handler to avoid race conditions
      // We just return the expected new balance here for logging
      return {
        organizationId,
        success: true,
        amount,
        newBalance,
      };
    } else if (
      paymentIntent.status === "requires_action" ||
      paymentIntent.status === "requires_payment_method"
    ) {
      // Payment needs additional action or failed
      logger.error(
        `[AutoTopUp] Payment requires action for org ${organizationId}: ${paymentIntent.status}`,
      );

      // Track auto top-up failed
      trackServerEvent(trackingId, "auto_topup_failed", {
        organization_id: organizationId,
        amount,
        error_reason: `Payment ${paymentIntent.status}`,
      });

      await this.disableAutoTopUp(
        organizationId,
        `Payment ${paymentIntent.status}`,
      );
      return {
        organizationId,
        success: false,
        error: `Payment ${paymentIntent.status}`,
      };
    } else {
      logger.error(
        `[AutoTopUp] Payment in unexpected state for org ${organizationId}: ${paymentIntent.status}`,
      );

      // Track auto top-up failed
      trackServerEvent(trackingId, "auto_topup_failed", {
        organization_id: organizationId,
        amount,
        error_reason: `Payment ${paymentIntent.status}`,
      });

      return {
        organizationId,
        success: false,
        error: `Payment ${paymentIntent.status}`,
      };
    }
  }

  /**
   * Disable auto top-up for an organization
   * Called when payment fails or configuration is invalid
   *
   * @param organizationId - The organization ID
   * @param reason - Reason for disabling
   */
  private async disableAutoTopUp(
    organizationId: string,
    reason: string,
  ): Promise<void> {
    logger.info(
      `[AutoTopUp] Disabling auto top-up for org ${organizationId}: ${reason}`,
    );

    const org = await organizationsRepository.findById(organizationId);
    if (!org) {
      logger.error(`[AutoTopUp] Organization ${organizationId} not found`);
      return;
    }

    await organizationsRepository.update(organizationId, {
      auto_top_up_enabled: false,
      updated_at: new Date(),
    });

    // Send email notification
    void this.queueAutoTopUpDisabledEmail(org, reason);
  }

  /**
   * Queue success email notification for auto top-up
   */
  private async queueAutoTopUpSuccessEmail(
    org: Organization,
    amount: number,
    previousBalance: number,
    newBalance: number,
    paymentIntentId: string,
  ): Promise<void> {
    logger.info(
      `[AutoTopUp] queueAutoTopUpSuccessEmail START for org ${org.id}`,
    );

    const recipientEmail = await this.getUserEmail(org.id);
    logger.info(`[AutoTopUp] User email: ${recipientEmail || "NONE"}`);

    if (!recipientEmail) {
      logger.error(
        `[AutoTopUp] CRITICAL: No user email for org ${org.id} - EMAIL NOT SENT`,
      );
      return;
    }

    let paymentMethodDisplay = "Card on file";
    if (org.stripe_default_payment_method) {
      const pm = await requireStripe().paymentMethods.retrieve(
        org.stripe_default_payment_method,
      );
      if (pm.card) {
        paymentMethodDisplay = `${pm.card.brand} ••••${pm.card.last4}`;
      }
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://eliza.cloud";
    const emailData = {
      email: recipientEmail,
      organizationName: org.name,
      amount,
      previousBalance,
      newBalance,
      paymentMethod: paymentMethodDisplay,
      invoiceUrl: `${appUrl}/dashboard/invoices/${paymentIntentId}`,
      billingUrl: `${appUrl}/dashboard/settings`,
    };

    logger.info(
      `[AutoTopUp] Calling emailService.sendAutoTopUpSuccessEmail with:`,
    );
    logger.info(JSON.stringify(emailData, null, 2));

    const result = await emailService.sendAutoTopUpSuccessEmail(emailData);

    logger.info(`[AutoTopUp] Email service returned: ${result}`);
    if (result) {
      logger.info(
        `[AutoTopUp] ✓ SUCCESS: Auto top-up email sent to ${recipientEmail}`,
      );
    } else {
      logger.error(
        `[AutoTopUp] ✗ FAILED: Email service returned false for ${recipientEmail}`,
      );
    }
  }

  /**
   * Queue disabled email notification for auto top-up
   */
  private async queueAutoTopUpDisabledEmail(
    org: Organization,
    reason: string,
  ): Promise<void> {
    const recipientEmail = await this.getUserEmail(org.id);
    if (!recipientEmail) {
      logger.error(`[AutoTopUp] No user email for org ${org.id}`);
      return;
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://eliza.cloud";
    await emailService.sendAutoTopUpDisabledEmail({
      email: recipientEmail,
      organizationName: org.name,
      reason,
      currentBalance: Number(org.credit_balance || 0),
      settingsUrl: `${appUrl}/dashboard/settings`,
    });
  }

  /**
   * Get user email for organization
   */
  private async getUserEmail(orgId: string): Promise<string | null> {
    logger.info(`[AutoTopUp] getUserEmail: Fetching users for org ${orgId}`);
    const users = await usersRepository.listByOrganization(orgId);
    logger.info(`[AutoTopUp] getUserEmail: Found ${users.length} users`);
    const email = users.length > 0 && users[0].email ? users[0].email : null;
    logger.info(`[AutoTopUp] getUserEmail: Returning ${email || "NULL"}`);
    return email;
  }

  /**
   * Get auto top-up settings for an organization
   *
   * @param organizationId - The organization ID
   * @returns Auto top-up settings
   */
  async getSettings(organizationId: string): Promise<{
    enabled: boolean;
    amount: number;
    threshold: number;
    hasPaymentMethod: boolean;
  }> {
    const org = await organizationsRepository.findById(organizationId);

    if (!org) {
      throw new Error("Organization not found");
    }

    return {
      enabled: org.auto_top_up_enabled || false,
      amount: Number(org.auto_top_up_amount || 0),
      threshold: Number(org.auto_top_up_threshold || 0),
      hasPaymentMethod: !!org.stripe_default_payment_method,
    };
  }

  /**
   * Update auto top-up settings for an organization
   *
   * @param organizationId - The organization ID
   * @param settings - Settings to update
   * @throws Error if validation fails or no payment method exists
   */
  async updateSettings(
    organizationId: string,
    settings: {
      enabled?: boolean;
      amount?: number;
      threshold?: number;
    },
  ): Promise<void> {
    const org = await organizationsRepository.findById(organizationId);

    if (!org) {
      throw new Error("Organization not found");
    }

    // If enabling auto top-up, validate requirements
    if (settings.enabled === true) {
      if (!org.stripe_default_payment_method) {
        throw new Error(
          "Cannot enable auto top-up without a default payment method. Please add a payment method first.",
        );
      }

      // Get current or new values
      const amount = settings.amount ?? Number(org.auto_top_up_amount || 0);
      const threshold =
        settings.threshold ?? Number(org.auto_top_up_threshold || 0);

      // Validate settings
      this.validateSettings(amount, threshold);
    }

    // If amount or threshold are being updated, validate them
    if (settings.amount !== undefined || settings.threshold !== undefined) {
      const amount = settings.amount ?? Number(org.auto_top_up_amount || 0);
      const threshold =
        settings.threshold ?? Number(org.auto_top_up_threshold || 0);
      this.validateSettings(amount, threshold);
    }

    // Build update object
    const updates: Partial<Organization> = {
      updated_at: new Date(),
    };

    if (settings.enabled !== undefined) {
      updates.auto_top_up_enabled = settings.enabled;
    }
    if (settings.amount !== undefined) {
      updates.auto_top_up_amount = settings.amount.toFixed(2);
    }
    if (settings.threshold !== undefined) {
      updates.auto_top_up_threshold = settings.threshold.toFixed(2);
    }

    await organizationsRepository.update(organizationId, updates);

    logger.info(
      `[AutoTopUp] Updated settings for org ${organizationId}:`,
      updates,
    );
  }
}

// Export singleton instance
export const autoTopUpService = new AutoTopUpService();
