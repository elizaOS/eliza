/** Drains Stripe deliveries, reconciles uncertain cancellation commands and sweeps durable subscription notices through the authenticated cron owner. */
import type { Context } from "hono";
import { Hono } from "hono";
import { processStripeEvent } from "@/api-queue/stripe-event";
import type { StripeEventMessage } from "@/api-queue/types";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { drain, queueLength } from "@/lib/queue/redis-queue";
import { recoverOrganizationSubscriptionCancellations } from "@/lib/services/subscription-cancellation";
import { sweepSubscriptionNotices } from "@/lib/services/subscription-notices";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const STRIPE_QUEUE_KEY = "stripe-events";

const app = new Hono<AppEnv>();

async function handleProcessStripeQueue(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);

    const before = await queueLength(STRIPE_QUEUE_KEY);
    const stats = await drain<StripeEventMessage>(
      STRIPE_QUEUE_KEY,
      (envelope) =>
        processStripeEvent({
          body: envelope.body,
          attempts: envelope.attempts,
        }),
      { max: 25, budgetMs: 25_000, maxAttempts: 5 },
    );
    const after = await queueLength(STRIPE_QUEUE_KEY);
    const cancellations = await recoverOrganizationSubscriptionCancellations(5);
    const notices = await sweepSubscriptionNotices();

    logger.info("[Stripe Queue] Redis drain complete", {
      before,
      after,
      ...stats,
    });

    return c.json({
      success: true,
      queue: STRIPE_QUEUE_KEY,
      notices,
      cancellations,
      before,
      after,
      ...stats,
    });
  } catch (error) {
    // error-policy:J1 authenticated cron failures retain a structured retryable boundary.
    logger.error("[Stripe Queue] Redis drain failed", { error });
    return failureResponse(c, error);
  }
}

app.post("/", handleProcessStripeQueue);

export default app;
