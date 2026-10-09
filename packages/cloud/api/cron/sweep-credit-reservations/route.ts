/**
 * Recovers stranded credit and subscription-funding reservations, retires ended
 * allowance periods, and projects durable affiliate payout and app-usage events.
 * Cron authentication keeps repair lanes off public APIs.
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { subscriptionAllowanceRepository } from "@elizaos/cloud-shared/db/repositories/subscription-allowance";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { drainAffiliatePayoutOutbox } from "@elizaos/cloud-shared/lib/services/affiliate-payout-outbox";
import { sweepPendingAppUsageProjections } from "@elizaos/cloud-shared/lib/services/app-usage-projections";
import { creditsService } from "@elizaos/cloud-shared/lib/services/credits";
import { reconcileNativeStoragePuts } from "@elizaos/cloud-shared/lib/services/storage/native-storage-put";
import { subscriptionFundingService } from "@elizaos/cloud-shared/lib/services/subscription-funding";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Context } from "hono";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

/**
 * Backstop for synchronous credit reservations (#11169): settle reservation
 * debits whose post-response waitUntil reconciliation never ran.
 */
async function handleSweepCreditReservations(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);
    // Native storage owns its provider-backed holds. Reconcile them before the
    // generic stale-hold sweep so a strong R2 HEAD, not age alone, decides
    // whether an ambiguous PUT settles or refunds.
    const nativeStorage = await reconcileNativeStoragePuts(c.env.BLOB);
    const [stats, fundingReservations, affiliatePayouts, appUsageProjections] =
      await Promise.all([
        creditsService.sweepStaleReservations(),
        subscriptionFundingService.sweepStaleReservations(),
        drainAffiliatePayoutOutbox(),
        sweepPendingAppUsageProjections(),
      ]);
    // Retire ended periods after stranded holds released, so a released
    // remainder is forfeited in the same tick instead of the next one.
    const allowancePeriods =
      await subscriptionAllowanceRepository.expireEndedPeriods();
    logger.info("[Credits] durable billing projection sweep complete", {
      creditReservations: stats,
      fundingReservations,
      allowancePeriods,
      affiliatePayouts,
      appUsageProjections,
    });
    return c.json({
      success: true,
      stats,
      fundingReservations,
      allowancePeriods,
      nativeStorage,
      affiliatePayouts,
      appUsageProjections,
    });
  } catch (error) {
    // error-policy:J1 cron is the outer transport boundary for durable
    // recovery lanes; preserve the structured failure response for retry.
    logger.error("[Credits] stale reservation sweep failed", { error });
    return failureResponse(c, error);
  }
}

app.post("/", handleSweepCreditReservations);

export default app;
