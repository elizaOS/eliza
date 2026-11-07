/**
 * Email rate limiting utilities to prevent spam.
 */

import { cache } from "../cache/client";
import { logger } from "../utils/logger";

const LOW_CREDITS_EMAIL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function lowCreditsEmailKey(organizationId: string): string {
  return `low-credits-email-sent:${organizationId}`;
}

/**
 * Claims the organization's one low-credits email for the next 24 hours.
 *
 * Every debit under the threshold asks, often concurrently, so the claim is
 * atomic (SET NX). With the cache unavailable no claim can be made and the
 * email is skipped: a missed warning is better than one email per debit.
 */
export async function claimLowCreditsEmail(organizationId: string): Promise<boolean> {
  try {
    return await cache.setIfNotExists(
      lowCreditsEmailKey(organizationId),
      { sentAt: new Date().toISOString() },
      LOW_CREDITS_EMAIL_COOLDOWN_MS,
    );
  } catch (error) {
    logger.warn("[EmailRateLimiter] Low credits email skipped: cache unavailable", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Releases a claim whose email was not sent, so a later debit can retry. */
export async function releaseLowCreditsEmailClaim(organizationId: string): Promise<void> {
  await cache.del(lowCreditsEmailKey(organizationId));
}
