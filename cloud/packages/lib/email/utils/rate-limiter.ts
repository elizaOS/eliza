/**
 * Email rate limiting utilities to prevent spam.
 */

import { cache } from "@/lib/cache/client";
import { logger } from "@/lib/utils/logger";

/**
 * Checks if a low credits email can be sent (not sent in last 24 hours).
 *
 * @param organizationId - Organization ID.
 * @returns True if email can be sent.
 */
export async function canSendLowCreditsEmail(organizationId: string): Promise<boolean> {
  const cacheKey = `low-credits-email-sent:${organizationId}`;

  const lastSent = await cache.get<{ sentAt: string }>(cacheKey);

  if (lastSent) {
    logger.info("[EmailRateLimiter] Low credits email recently sent", {
      organizationId,
      lastSent: lastSent.sentAt,
    });
    return false;
  }

  return true;
}

/**
 * Marks that a low credits email was sent (24 hour cooldown).
 *
 * @param organizationId - Organization ID.
 */
export async function markLowCreditsEmailSent(organizationId: string): Promise<void> {
  const cacheKey = `low-credits-email-sent:${organizationId}`;
  const cooldownHours = 24;
  const cooldownSeconds = cooldownHours * 60 * 60;

  await cache.set(cacheKey, { sentAt: new Date().toISOString() }, cooldownSeconds);

  logger.info("[EmailRateLimiter] Marked low credits email sent", {
    organizationId,
    cooldownHours,
  });
}
