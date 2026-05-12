import { and, eq, sql } from "drizzle-orm";
import { dbRead } from "@/db/client";
import type { Organization } from "@/db/repositories";
import { organizationsRepository, usersRepository } from "@/db/repositories";
import { organizations } from "@/db/schemas/organizations";
import { requireStripe } from "@/lib/stripe";
import { logger } from "@/lib/utils/logger";
import { emailService } from "./email";

export const AUTO_TOP_UP_LIMITS = {
  MIN_AMOUNT: 1,
  MAX_AMOUNT: 1000,
  MIN_THRESHOLD: 0,
  MAX_THRESHOLD: 1000,
} as const;

export interface AutoTopUpResult {
  organizationId: string;
  success: boolean;
  amount?: number;
  newBalance?: number;
  error?: string;
}

export interface AutoTopUpCheckResult {
  timestamp: Date;
  organizationsChecked: number;
  organizationsProcessed: number;
  successful: number;
  failed: number;
  results: AutoTopUpResult[];
}

export class AutoTopUpService {
  validateSettings(amount: number, threshold: number): void {
    if (amount < AUTO_TOP_UP_LIMITS.MIN_AMOUNT) {
      throw new Error(`Auto top-up amount must be at least $${AUTO_TOP_UP_LIMITS.MIN_AMOUNT}`);
    }
    if (amount > AUTO_TOP_UP_LIMITS.MAX_AMOUNT) {
      throw new Error(`Auto top-up amount cannot exceed $${AUTO_TOP_UP_LIMITS.MAX_AMOUNT}`);
    }
    if (threshold < AUTO_TOP_UP_LIMITS.MIN_THRESHOLD) {
      throw new Error(
        `Auto top-up threshold must be at least $${AUTO_TOP_UP_LIMITS.MIN_THRESHOLD}`,
      );
    }
    if (threshold > AUTO_TOP_UP_LIMITS.MAX_THRESHOLD) {
      throw new Error(`Auto top-up threshold cannot exceed $${AUTO_TOP_UP_LIMITS.MAX_THRESHOLD}`);
    }
    if (!Number.isFinite(amount) || !Number.isFinite(threshold)) {
      throw new Error("Auto top-up settings must be valid numbers");
    }
  }

  async checkAndExecuteAutoTopUps(): Promise<AutoTopUpCheckResult> {
    const startTime = new Date();
    const results: AutoTopUpResult[] = [];

    logger.info(`[AutoTopUp] Starting auto top-up check at ${startTime.toISOString()}`);

    const orgsNeedingTopUp = await dbRead
      .select()
      .from(organizations)
      .where(
        and(
          eq(organizations.auto_top_up_enabled, true),
          sql`CAST(${organizations.credit_balance} AS NUMERIC) < CAST(${organizations.auto_top_up_threshold} AS NUMERIC)`,
        ),
      );

    logger.info(`[AutoTopUp] Found ${orgsNeedingTopUp.length} organizations needing auto top-up`);

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
          error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
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

  async executeAutoTopUp(org: Organization): Promise<AutoTopUpResult> {
    const organizationId = org.id;

    logger.info(`[AutoTopUp] Processing org ${organizationId} (${org.name})`);
    logger.info(
      `[AutoTopUp] Current balance: $${org.credit_balance}, Threshold: $${org.auto_top_up_threshold}`,
    );

    let trackingId = `org:${organizationId}`;
    try {
      const users = await usersRepository.listByOrganization(organizationId);
      const billingUser = org.billing_email
        ? users.find((u) => u.email === org.billing_email)
        : null;
      const userId = billingUser?.id || (users.length > 0 ? users[0].id : null);
      trackingId = userId || `org:${organizationId}`;
    } catch (userLookupError) {
      logger.warn(`[AutoTopUp] Failed to fetch users for payment metadata, using org ID`, {
        organizationId,
        error: userLookupError instanceof Error ? userLookupError.message : "Unknown error",
      });
    }

    if (!org.stripe_customer_id) {
      logger.error(`[AutoTopUp] Org ${organizationId} missing Stripe customer`);
      await this.disableAutoTopUp(organizationId, "Missing Stripe customer");
      return {
        organizationId,
        success: false,
        error: "Missing Stripe customer",
      };
    }

    if (!org.stripe_default_payment_method) {
      logger.error(`[AutoTopUp] Org ${organizationId} missing default payment method`);
      await this.disableAutoTopUp(organizationId, "Missing default payment method");
      return {
        organizationId,
        success: false,
        error: "Missing default payment method",
      };
    }

    const amount = Number(org.auto_top_up_amount || 0);
    if (amount <= 0 || amount > AUTO_TOP_UP_LIMITS.MAX_AMOUNT) {
      logger.error(`[AutoTopUp] Org ${organizationId} has invalid top-up amount: ${amount}`);
      await this.disableAutoTopUp(organizationId, "Invalid top-up amount");
      return {
        organizationId,
        success: false,
        error: "Invalid top-up amount",
      };
    }

    // WHY affiliate lookup here: Affiliate markup is added to what the customer pays
    // (we don't eat it). So totalAmount = amount + affiliate% + platform%; credits
    // added = amount. Revenue splits are not run for auto top-up (see Stripe webhook).
    let affiliateFeeAmount = 0;
    let platformFeeAmount = 0;
    let affiliateOwnerId: string | null = null;
    let affiliateCodeId: string | null = null;
    let totalAmount: number;

    try {
      const { affiliatesService } = await import("@/lib/services/affiliates");
      let checkUserId = trackingId.startsWith("org:") ? null : trackingId;

      if (!checkUserId) {
        const users = await usersRepository.listByOrganization(organizationId);
        if (users.length > 0) checkUserId = users[0].id;
      }

      if (checkUserId) {
        const referrer = await affiliatesService.getReferrer(checkUserId);
        if (referrer) {
          affiliateOwnerId = referrer.user_id;
          affiliateCodeId = referrer.id;
          const affiliatePercent = Number(referrer.markup_percent);
          const platformPercent = 20.0;

          affiliateFeeAmount = amount * (affiliatePercent / 100);
          platformFeeAmount = amount * (platformPercent / 100);
          logger.info("Affiliate metadata applied", referrer);
        }
      }
    } catch (e) {
      logger.error(`[AutoTopUp] Failed to lookup affiliate for org ${organizationId}`, e);
    }

    totalAmount = amount + affiliateFeeAmount + platformFeeAmount;

    const metadata: Record<string, string> = {
      organization_id: organizationId,
      credits: amount.toFixed(2),
      type: "auto_top_up",
      base_amount: amount.toFixed(2),
      total_charged: totalAmount.toFixed(2),
      platform_fee_amount: platformFeeAmount.toFixed(2),
      fees_included: "true",
    };

    if (!trackingId.startsWith("org:")) {
      metadata.user_id = trackingId;
    }

    if (affiliateFeeAmount > 0 && affiliateOwnerId && affiliateCodeId) {
      metadata.affiliate_fee_amount = affiliateFeeAmount.toFixed(2);
      metadata.affiliate_owner_id = affiliateOwnerId;
      metadata.affiliate_code_id = affiliateCodeId;
    }

    logger.info(
      `[AutoTopUp] Creating PaymentIntent for $${totalAmount.toFixed(
        2,
      )} (Base: $${amount.toFixed(2)})`,
    );

    const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;
    const idempotencyKey = `auto-topup-${organizationId}-${Math.floor(
      Date.now() / IDEMPOTENCY_WINDOW_MS,
    )}`;

    const paymentIntent = await requireStripe().paymentIntents.create(
      {
        amount: Math.round(totalAmount * 100),
        currency: "usd",
        customer: org.stripe_customer_id,
        payment_method: org.stripe_default_payment_method,
        confirm: true,
        off_session: true,
        metadata: metadata,
        description: `Auto top-up - $${totalAmount.toFixed(2)}`,
      },
      { idempotencyKey },
    );

    logger.info(`[AutoTopUp] PaymentIntent ${paymentIntent.id} status: ${paymentIntent.status}`);

    if (paymentIntent.status === "succeeded") {
      const previousBalance = Number(org.credit_balance);
      const newBalance = previousBalance + amount;

      logger.info(
        `[AutoTopUp] ✓ Auto top-up succeeded for org ${organizationId}. Payment: ${paymentIntent.id}`,
      );

      logger.info(`[AutoTopUp] About to call queueAutoTopUpSuccessEmail for org ${organizationId}`);
      this.queueAutoTopUpSuccessEmail(org, amount, previousBalance, newBalance, paymentIntent.id);

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
      logger.error(
        `[AutoTopUp] Payment requires action for org ${organizationId}: ${paymentIntent.status}`,
      );

      await this.disableAutoTopUp(organizationId, `Payment ${paymentIntent.status}`);
      return {
        organizationId,
        success: false,
        error: `Payment ${paymentIntent.status}`,
      };
    } else {
      logger.error(
        `[AutoTopUp] Payment in unexpected state for org ${organizationId}: ${paymentIntent.status}`,
      );

      return {
        organizationId,
        success: false,
        error: `Payment ${paymentIntent.status}`,
      };
    }
  }

  private async disableAutoTopUp(organizationId: string, reason: string): Promise<void> {
    logger.info(`[AutoTopUp] Disabling auto top-up for org ${organizationId}: ${reason}`);

    const org = await organizationsRepository.findById(organizationId);
    if (!org) {
      logger.error(`[AutoTopUp] Organization ${organizationId} not found`);
      return;
    }

    await organizationsRepository.update(organizationId, {
      auto_top_up_enabled: false,
      updated_at: new Date(),
    });

    void this.queueAutoTopUpDisabledEmail(org, reason);
  }

  private async queueAutoTopUpSuccessEmail(
    org: Organization,
    amount: number,
    previousBalance: number,
    newBalance: number,
    paymentIntentId: string,
  ): Promise<void> {
    logger.info(`[AutoTopUp] queueAutoTopUpSuccessEmail START for org ${org.id}`);

    const recipientEmail = await this.getUserEmail(org.id);
    logger.info(`[AutoTopUp] User email: ${recipientEmail || "NONE"}`);

    if (!recipientEmail) {
      logger.error(`[AutoTopUp] CRITICAL: No user email for org ${org.id} - EMAIL NOT SENT`);
      return;
    }

    let paymentMethodDisplay = "Card on file";
    if (org.stripe_default_payment_method) {
      const pm = await requireStripe().paymentMethods.retrieve(org.stripe_default_payment_method);
      if (pm.card) {
        paymentMethodDisplay = `${pm.card.brand} ••••${pm.card.last4}`;
      }
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
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

    logger.info(`[AutoTopUp] Calling emailService.sendAutoTopUpSuccessEmail with:`);
    logger.info(JSON.stringify(emailData, null, 2));

    const result = await emailService.sendAutoTopUpSuccessEmail(emailData);

    logger.info(`[AutoTopUp] Email service returned: ${result}`);
    if (result) {
      logger.info(`[AutoTopUp] ✓ SUCCESS: Auto top-up email sent to ${recipientEmail}`);
    } else {
      logger.error(`[AutoTopUp] ✗ FAILED: Email service returned false for ${recipientEmail}`);
    }
  }

  private async queueAutoTopUpDisabledEmail(org: Organization, reason: string): Promise<void> {
    const recipientEmail = await this.getUserEmail(org.id);
    if (!recipientEmail) {
      logger.error(`[AutoTopUp] No user email for org ${org.id}`);
      return;
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
    await emailService.sendAutoTopUpDisabledEmail({
      email: recipientEmail,
      organizationName: org.name,
      reason,
      currentBalance: Number(org.credit_balance || 0),
      settingsUrl: `${appUrl}/dashboard/settings`,
    });
  }

  private async getUserEmail(orgId: string): Promise<string | null> {
    logger.info(`[AutoTopUp] getUserEmail: Fetching users for org ${orgId}`);
    const users = await usersRepository.listByOrganization(orgId);
    logger.info(`[AutoTopUp] getUserEmail: Found ${users.length} users`);
    const email = users.length > 0 && users[0].email ? users[0].email : null;
    logger.info(`[AutoTopUp] getUserEmail: Returning ${email || "NULL"}`);
    return email;
  }

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

    if (settings.enabled === true) {
      if (!org.stripe_default_payment_method) {
        throw new Error(
          "Cannot enable auto top-up without a default payment method. Please add a payment method first.",
        );
      }

      const amount = settings.amount ?? Number(org.auto_top_up_amount || 0);
      const threshold = settings.threshold ?? Number(org.auto_top_up_threshold || 0);

      this.validateSettings(amount, threshold);
    }

    if (settings.amount !== undefined || settings.threshold !== undefined) {
      const amount = settings.amount ?? Number(org.auto_top_up_amount || 0);
      const threshold = settings.threshold ?? Number(org.auto_top_up_threshold || 0);
      this.validateSettings(amount, threshold);
    }

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

    logger.info(`[AutoTopUp] Updated settings for org ${organizationId}:`, updates);
  }
}

export const autoTopUpService = new AutoTopUpService();
