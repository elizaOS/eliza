/**
 * App Signup Tracking Service
 *
 * Tracks user signups that come through apps via affiliate codes or direct referrals
 */

import { appsRepository } from "@/db/repositories/apps";
import { logger } from "@/lib/utils/logger";
import { appsService } from "./apps";
import { creditsService } from "./credits";

/**
 * Data for tracking app signups.
 */
export interface SignupTrackingData {
  userId: string;
  appId?: string;
  affiliateCode?: string;
  referralCode?: string;
  signupSource?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Service for tracking user signups that come through apps.
 */
export class AppSignupTrackingService {
  /**
   * Track a user signup from an app
   * This should be called during user registration
   */
  async trackSignup(data: SignupTrackingData): Promise<void> {
    let appId = data.appId;

    // If no appId but we have an affiliate code, find the app
    if (!appId && data.affiliateCode) {
      const app = await appsService.getByAffiliateCode(data.affiliateCode);
      if (app) {
        appId = app.id;
      }
    }

    // If we still don't have an appId, we can't track
    if (!appId) {
      logger.info("No app found for signup tracking", { data });
      return;
    }

    // Create or update app user record
    const existingAppUser = await appsRepository.findAppUser(appId, data.userId);

    if (existingAppUser) {
      // User already exists for this app, just update metadata
      await appsRepository.updateAppUser(appId, data.userId, {
        metadata: {
          ...existingAppUser.metadata,
          signup_tracked: true,
          signup_source: data.signupSource,
        },
      });
    } else {
      // Create new app user record
      await appsRepository.createAppUser({
        app_id: appId,
        user_id: data.userId,
        signup_source: data.signupSource || "app_referral",
        referral_code_used: data.referralCode || data.affiliateCode,
        ip_address: data.ipAddress,
        user_agent: data.userAgent,
        metadata: data.metadata || {},
      });
    }

    logger.info("Tracked signup for app", {
      appId,
      userId: data.userId,
      affiliateCode: data.affiliateCode,
    });
  }

  /**
   * Get affiliate code from request (query params, headers, cookies, etc.)
   */
  async extractAffiliateCode(params: {
    queryParams?: URLSearchParams;
    cookies?: Map<string, string>;
  }): Promise<string | null> {
    const { queryParams, cookies } = params;

    // Check query params first
    if (queryParams) {
      const refCode = queryParams.get("ref");
      const affiliateCode = queryParams.get("affiliate");
      const appCode = queryParams.get("app");

      if (refCode) return refCode;
      if (affiliateCode) return affiliateCode;
      if (appCode) return appCode;
    }

    // Check cookies
    if (cookies) {
      const storedCode =
        cookies.get("affiliate_code") || cookies.get("ref_code") || cookies.get("app_code");

      if (storedCode) return storedCode;
    }

    return null;
  }

  /**
   * Get app from request context
   * Useful for identifying which app a user is coming from
   */
  async getAppFromRequest(params: {
    origin?: string;
    referrer?: string;
    affiliateCode?: string;
  }): Promise<string | null> {
    const { origin, referrer, affiliateCode } = params;

    // Try affiliate code first
    if (affiliateCode) {
      const app = await appsService.getByAffiliateCode(affiliateCode);
      if (app) return app.id;
    }

    // Try matching origin/referrer to app URLs
    if (origin || referrer) {
      const urlToMatch = origin || referrer;
      if (!urlToMatch) return null;

      // Get all apps and try to match URL
      // Note: This is not the most efficient approach for large numbers of apps
      // In production, you might want to index apps by domain
      const _hostname = new URL(urlToMatch).hostname;

      // For demo purposes, we'll skip the full lookup
      // In production, implement proper URL matching
      return null;
    }

    return null;
  }

  /**
   * Award referral bonus to app owner (if configured)
   */
  async awardReferralBonus(appId: string, userId: string): Promise<void> {
    const app = await appsRepository.findById(appId);

    if (!app) {
      logger.warn(`App not found: ${appId}`);
      return;
    }

    const bonusAmount = parseFloat(app.referral_bonus_credits || "0");

    if (bonusAmount <= 0) {
      logger.info("No referral bonus configured for app", { appId });
      return;
    }

    // Award bonus credits to the app's organization
    await creditsService.addCredits({
      organizationId: app.organization_id,
      amount: bonusAmount,
      description: "App signup referral bonus",
      metadata: { appId, userId, type: "app_signup_bonus" },
    });

    logger.info("Referral bonus awarded", {
      appId,
      userId,
      bonusAmount,
      organizationId: app.organization_id,
    });
  }
}

// Export singleton instance
export const appSignupTrackingService = new AppSignupTrackingService();
