/**
 * Drains the Stripe delivery outbox kept on webhook_events rows.
 *
 * The webhook route writes each verified event's work into its dedupe row in
 * the same insert, so a 200 to Stripe always means the work is durable. A
 * drain leases due rows, runs the handler once per row and settles each by its
 * lease token: `ack` completes it, `retry` makes it due again with exponential
 * backoff until the budget is spent, and `dlq` or a spent budget dead-letters
 * it. A Stripe resend of a dead-lettered event makes it due again.
 *
 * Delivery is at least once: a drain that dies mid-handler leaves its lease to
 * expire, and the next drain runs the row again as a new attempt. The Stripe
 * consumer re-checks every downstream write, so a repeat run is safe.
 */

import {
  type ClaimedStripeDelivery,
  webhookEventsRepository,
} from "../../db/repositories/webhook-events";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { cache } from "../cache/client";
import { type DrainResult, retryDelayMs } from "../redis-queue";
import { logger } from "../utils/logger";

/**
 * Lists the pre-outbox queue used. The cron moves anything left there into the
 * outbox, the dead-letter list included: the old route answered those events
 * 200, so Stripe will not send them again, and in the outbox they get a fresh
 * budget. Remove this lane once the lists are seen empty.
 */
const LEGACY_STRIPE_QUEUE_KEYS = [
  "stripe-events",
  "stripe-events:processing",
  "stripe-events:dlq",
] as const;

export interface StripeOutboxDrainOptions {
  /** Max deliveries to claim in one drain (default 25). */
  max?: number;
  /** Processing time after which the rest of the batch is released (default 25_000 ms). */
  budgetMs?: number;
  /** Runs per delivery before it is dead-lettered (default 8). */
  maxAttempts?: number;
  /** First retry delay; doubles per attempt (default 60_000 ms). */
  retryBaseDelayMs?: number;
  /** Retry delay ceiling (default 3_600_000 ms). */
  retryMaxDelayMs?: number;
  /** How long a claim owns its rows (default `budgetMs` plus 60 s). */
  leaseMs?: number;
}

export interface StripeOutboxDrainStats {
  claimed: number;
  attempted: number;
  acked: number;
  retried: number;
  dlqed: number;
  /** Claimed rows not reached inside the budget, released for the next drain. */
  released: number;
  /** Rows another drain settled first after this drain's lease expired. */
  leaseLost: number;
}

export type StripeOutboxHandler = (delivery: {
  body: StripeEventMessage;
  /** Earlier runs of this delivery; 0 on the first. */
  attempts: number;
}) => Promise<DrainResult>;

async function drainStripeOutbox(
  handler: StripeOutboxHandler,
  options: StripeOutboxDrainOptions = {},
): Promise<StripeOutboxDrainStats> {
  const max = options.max ?? 25;
  const budgetMs = options.budgetMs ?? 25_000;
  const maxAttempts = options.maxAttempts ?? 8;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 60_000;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? 3_600_000;
  const leaseMs = options.leaseMs ?? budgetMs + 60_000;
  const start = Date.now();

  const claimed = await webhookEventsRepository.claimDueStripeDeliveries(max, leaseMs);
  const stats: StripeOutboxDrainStats = {
    claimed: claimed.length,
    attempted: 0,
    acked: 0,
    retried: 0,
    dlqed: 0,
    released: 0,
    leaseLost: 0,
  };
  const count = (settled: boolean, field: "acked" | "retried" | "dlqed") => {
    if (settled) stats[field]++;
    else stats.leaseLost++;
  };
  const deadLetter = async (delivery: ClaimedStripeDelivery) => {
    const settled = await webhookEventsRepository.deadLetterStripeDelivery(delivery);
    count(settled, "dlqed");
    if (!settled) return;
    logger.error("[Stripe Outbox] Delivery dead-lettered; a Stripe resend makes it due again", {
      code: "stripe_event_dead_lettered",
      eventId: delivery.payload.eventId,
      eventType: delivery.payload.eventType,
      attempts: delivery.attempts,
    });
  };

  for (const [index, delivery] of claimed.entries()) {
    if (Date.now() - start > budgetMs) {
      const rest = claimed.slice(index);
      await webhookEventsRepository.releaseStripeDeliveries(rest);
      stats.released = rest.length;
      logger.warn("[Stripe Outbox] Drain budget exceeded", { processed: stats.attempted });
      break;
    }
    // A run that died after its claim already spent the last attempt.
    if (delivery.attempts > maxAttempts) {
      await deadLetter(delivery);
      continue;
    }

    stats.attempted++;
    let result: DrainResult;
    try {
      result = await handler({ body: delivery.payload, attempts: delivery.attempts - 1 });
    } catch (handlerError) {
      logger.error("[Stripe Outbox] Handler threw; treating as retry", {
        error: handlerError instanceof Error ? handlerError.message : String(handlerError),
        eventId: delivery.payload.eventId,
        attempts: delivery.attempts,
      });
      result = "retry";
    }

    if (result === "ack")
      count(await webhookEventsRepository.completeStripeDelivery(delivery), "acked");
    else if (result === "dlq" || delivery.attempts >= maxAttempts) await deadLetter(delivery);
    else
      count(
        await webhookEventsRepository.retryStripeDelivery(
          delivery,
          retryDelayMs(delivery.attempts, retryBaseDelayMs, retryMaxDelayMs),
        ),
        "retried",
      );
  }
  return stats;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Moves deliveries left on the pre-outbox queue lists into the outbox. Each one
 * is written to its row before it is removed from the list, so a failure in
 * between only repeats the adoption, which changes nothing. An entry whose
 * adoption fails stays on its list for the next run.
 */
async function adoptLegacyStripeQueue(): Promise<number> {
  let adopted = 0;
  for (const key of LEGACY_STRIPE_QUEUE_KEYS) {
    const raws = await cache.listQueue(key);
    // No reachable cache means no legacy list to read.
    if (raws === null) return adopted;
    for (const raw of raws) {
      let body: StripeEventMessage | undefined;
      try {
        body = (JSON.parse(raw) as { body?: StripeEventMessage }).body;
      } catch {
        body = undefined;
      }
      if (body?.kind === "stripe.event") {
        try {
          await webhookEventsRepository.adoptLegacyStripeDelivery(
            body,
            await sha256Hex(JSON.stringify(body.event)),
          );
        } catch (error) {
          // error-policy:J7 one bad entry must not stop the rest; it stays listed and is logged.
          logger.error("[Stripe Outbox] Legacy queue entry not adopted; kept for the next run", {
            key,
            eventId: body.eventId,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        adopted++;
      } else logger.error("[Stripe Outbox] Dropping an unreadable legacy queue entry", { key });
      await cache.removeQueueValue(key, raw);
    }
  }
  return adopted;
}

/**
 * The cron lane: adopts what the pre-outbox queue still holds, then drains the
 * outbox. The cutover never blocks the drain: a failure there is logged and
 * the outbox is drained all the same.
 */
export async function drainStripeDeliveries(
  handler: StripeOutboxHandler,
  options: StripeOutboxDrainOptions = {},
): Promise<StripeOutboxDrainStats & { legacyAdopted: number }> {
  let legacyAdopted = 0;
  try {
    legacyAdopted = await adoptLegacyStripeQueue();
  } catch (error) {
    // error-policy:J7 the cutover is best effort; what it leaves stays on its list for the next run.
    logger.error("[Stripe Outbox] Legacy queue adoption failed; draining the outbox anyway", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { ...(await drainStripeOutbox(handler, options)), legacyAdopted };
}
