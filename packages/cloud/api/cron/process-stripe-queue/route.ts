/** Drains the Stripe delivery outbox, reconciles uncertain cancellation commands, settles stale subscription checkouts and sweeps durable subscription notices through the authenticated cron owner. */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { recoverOrganizationSchedules } from "@elizaos/cloud-shared/lib/services/organization-schedule-maintenance";
import { recoverOrganizationUpgrades } from "@elizaos/cloud-shared/lib/services/organization-upgrade-maintenance";
import { recoverOriginalInvoiceObservations } from "@elizaos/cloud-shared/lib/services/original-invoice-maintenance";
import { recoverRenewalAdjustmentObservations } from "@elizaos/cloud-shared/lib/services/renewal-adjustment-maintenance";
import { drainStripeDeliveries } from "@elizaos/cloud-shared/lib/services/stripe-delivery-outbox";
import { recoverOrganizationSubscriptionCancellations } from "@elizaos/cloud-shared/lib/services/subscription-cancellation";
import { recoverStaleSubscriptionCheckouts } from "@elizaos/cloud-shared/lib/services/subscription-checkout";
import { sweepSubscriptionNotices } from "@elizaos/cloud-shared/lib/services/subscription-notices";
import { recoverMissedSubscriptionEvents } from "@elizaos/cloud-shared/lib/services/subscription-reconciliation";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Context } from "hono";
import { Hono } from "hono";
import { processStripeEvent } from "@/api-queue/stripe-event";

const app = new Hono<AppEnv>();

async function handleProcessStripeQueue(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);

    const lanes = await Promise.allSettled([
      drainStripeDeliveries(processStripeEvent, {
        max: 25,
        budgetMs: 25_000,
        // 1m, 2m, 4m ... capped at 1h: about two hours of retries before dead-lettering.
        maxAttempts: 8,
        retryBaseDelayMs: 60_000,
        retryMaxDelayMs: 3_600_000,
      }),
      recoverOrganizationSubscriptionCancellations(5),
      recoverOrganizationUpgrades(5),
      recoverOrganizationSchedules(5),
      sweepSubscriptionNotices(),
      recoverMissedSubscriptionEvents(),
      recoverStaleSubscriptionCheckouts(10),
      recoverRenewalAdjustmentObservations(),
      recoverOriginalInvoiceObservations(),
    ]);
    const [
      queue,
      cancellations,
      upgrades,
      schedules,
      notices,
      recovery,
      checkouts,
      adjustments,
      originalInvoices,
    ] = lanes;
    if (
      queue.status !== "fulfilled" ||
      cancellations.status !== "fulfilled" ||
      upgrades.status !== "fulfilled" ||
      schedules.status !== "fulfilled" ||
      notices.status !== "fulfilled" ||
      recovery.status !== "fulfilled" ||
      checkouts.status !== "fulfilled" ||
      adjustments.status !== "fulfilled" ||
      originalInvoices.status !== "fulfilled"
    ) {
      const names = [
        "queue",
        "cancellations",
        "upgrades",
        "schedules",
        "notices",
        "recovery",
        "checkouts",
        "adjustments",
        "originalInvoices",
      ];
      const failures = lanes.flatMap((lane, index) =>
        lane.status === "rejected" ? [names[index]] : [],
      );
      logger.error("[Stripe Queue] Independent maintenance lanes failed", {
        failures: lanes.flatMap((lane, index) =>
          lane.status === "rejected"
            ? [{ lane: names[index], error: lane.reason }]
            : [],
        ),
      });
      return c.json(
        {
          success: false,
          error: "stripe_maintenance_lane_failed",
          failedLanes: failures,
          lanes: lanes.map((lane, index) =>
            lane.status === "fulfilled"
              ? { lane: names[index], status: "fulfilled", result: lane.value }
              : { lane: names[index], status: "failed" },
          ),
        },
        503,
      );
    }
    // Per-subscription recovery degradation is durably retained (backoff and,
    // for policy failures, an incident) and reported in the body; only a failed
    // lane is an infrastructure failure that returns 503.
    logger.info("[Stripe Queue] Outbox drain complete", {
      ...queue.value,
      recovery: recovery.value.status,
    });
    return c.json({
      success: true,
      queue: "webhook_events",
      ...queue.value,
      cancellations: cancellations.value,
      upgrades: upgrades.value,
      schedules: schedules.value,
      notices: notices.value,
      recovery: recovery.value,
      checkouts: checkouts.value,
      adjustments: adjustments.value,
      originalInvoices: originalInvoices.value,
    });
  } catch (error) {
    // error-policy:J1 authenticated cron failures retain a structured retryable boundary.
    logger.error("[Stripe Queue] Outbox drain failed", { error });
    return failureResponse(c, error);
  }
}

app.post("/", handleProcessStripeQueue);

export default app;
