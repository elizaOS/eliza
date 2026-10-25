/** Drains Stripe deliveries, reconciles uncertain cancellation commands, settles stale subscription checkouts and sweeps durable subscription notices through the authenticated cron owner. */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { webhookEventsRepository } from "@elizaos/cloud-shared/db/repositories/webhook-events";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { drain, queueLength } from "@elizaos/cloud-shared/lib/redis-queue";
import { recoverOrganizationSchedules } from "@elizaos/cloud-shared/lib/services/organization-schedule-maintenance";
import { recoverOrganizationUpgrades } from "@elizaos/cloud-shared/lib/services/organization-upgrade-maintenance";
import { recoverOriginalInvoiceObservations } from "@elizaos/cloud-shared/lib/services/original-invoice-maintenance";
import { recoverRenewalAdjustmentObservations } from "@elizaos/cloud-shared/lib/services/renewal-adjustment-maintenance";
import { recoverOrganizationSubscriptionCancellations } from "@elizaos/cloud-shared/lib/services/subscription-cancellation";
import { recoverStaleSubscriptionCheckouts } from "@elizaos/cloud-shared/lib/services/subscription-checkout";
import { sweepSubscriptionNotices } from "@elizaos/cloud-shared/lib/services/subscription-notices";
import { recoverMissedSubscriptionEvents } from "@elizaos/cloud-shared/lib/services/subscription-reconciliation";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { StripeEventMessage } from "@elizaos/cloud-shared/types/stripe-queue-message";
import type { Context } from "hono";
import { Hono } from "hono";
import { processStripeEvent } from "@/api-queue/stripe-event";

const STRIPE_QUEUE_KEY = "stripe-events";

const app = new Hono<AppEnv>();

/**
 * App-billing receipts carry their durable trigger and must stay; a legacy
 * delivery's marker is only dedupe, so removing it lets a Stripe dashboard
 * resend or replay re-enter after the retry budget is spent.
 */
async function releaseDeadLetterDedupe(envelope: {
  body: StripeEventMessage;
  attempts: number;
}) {
  if (envelope.body.appBilling) return;
  await webhookEventsRepository.deleteByEventId(
    envelope.body.eventId,
    "stripe",
  );
  logger.error(
    "[Stripe Queue] Delivery dead-lettered; dedupe marker released for resend",
    {
      code: "stripe_event_dead_lettered",
      eventId: envelope.body.eventId,
      eventType: envelope.body.eventType,
      attempts: envelope.attempts,
    },
  );
}

async function handleProcessStripeQueue(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);

    const lanes = await Promise.allSettled([
      (async () => {
        const before = await queueLength(STRIPE_QUEUE_KEY);
        const stats = await drain<StripeEventMessage>(
          STRIPE_QUEUE_KEY,
          (envelope) =>
            processStripeEvent({
              body: envelope.body,
              attempts: envelope.attempts,
            }),
          {
            max: 25,
            budgetMs: 25_000,
            // 1m, 2m, 4m ... capped at 1h: about two hours of retries before the DLQ.
            maxAttempts: 8,
            retryBaseDelayMs: 60_000,
            retryMaxDelayMs: 3_600_000,
            onDeadLetter: releaseDeadLetterDedupe,
          },
        );
        return { before, after: await queueLength(STRIPE_QUEUE_KEY), ...stats };
      })(),
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
    logger.info("[Stripe Queue] Redis drain complete", {
      ...queue.value,
      recovery: recovery.value.status,
    });
    return c.json({
      success: true,
      queue: STRIPE_QUEUE_KEY,
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
    logger.error("[Stripe Queue] Redis drain failed", { error });
    return failureResponse(c, error);
  }
}

app.post("/", handleProcessStripeQueue);

export default app;
