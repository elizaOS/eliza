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

import { createHash } from "node:crypto";
import {
  finishLegacyStripeAdoptionSelection,
  selectLegacyStripeAdoptionDigests,
} from "../../db/repositories/stripe-legacy-adoption-cursors";
import {
  type ClaimedStripeDelivery,
  webhookEventsRepository,
} from "../../db/repositories/webhook-events";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { cache } from "../cache/client";
import { type DrainResult, retryDelayMs } from "../redis-queue";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { logger } from "../utils/logger";

/**
 * Lists the pre-outbox queue used. The cron moves anything left there into the
 * outbox, the dead-letter list included: the old route answered those events
 * 200, so Stripe will not send them again, and in the outbox they get a fresh
 * budget. Redis entries can be removed after adoption. KV entries are retained:
 * this owner has no durable fence proving that old KV writers are quiescent.
 */
const LEGACY_STRIPE_QUEUE_KEYS = [
  "stripe-events",
  "stripe-events:processing",
  "stripe-events:dlq",
] as const;
const LEGACY_STRIPE_ADOPTION_WORK_MS = 1_000;

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

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Moves deliveries left on the pre-outbox queue lists into the outbox. Each one
 * is confirmed in its own SQL row before removal. Cursor reservations only
 * select work; failures and malformed entries keep their complete original raw.
 * Each list has a separate work budget so one poisoned list cannot monopolize
 * the others. The full legacy KV-array read remains outside any hard time bound.
 */
async function adoptLegacyStripeQueue(): Promise<number> {
  let adopted = 0;
  for (const key of LEGACY_STRIPE_QUEUE_KEYS) {
    const started = performance.now();
    let entries: Map<string, string>;
    let selection: { digests: string[]; revision: bigint };
    let sourceKey: string;
    try {
      const raws = await cache.listQueue(key);
      if (!raws?.length) continue;
      entries = new Map();
      let nonStringEntries = 0;
      for (const raw of raws) {
        if (typeof raw !== "string") {
          nonStringEntries++;
          continue;
        }
        entries.set(sha256Hex(raw), raw);
      }
      if (nonStringEntries)
        logger.error("[Stripe Outbox] Non-string legacy values retained", {
          code: "stripe_legacy_invalid_list_values",
          key,
          count: nonStringEntries,
        });
      const environment = getCloudAwareEnv().ENVIRONMENT || "local";
      sourceKey = `${cache.getBackendKind()}:${environment}:${key}`;
      const reserved = await selectLegacyStripeAdoptionDigests(sourceKey, [...entries.keys()]);
      if (!reserved) continue;
      selection = reserved;
    } catch (error) {
      logger.error("[Stripe Outbox] Legacy selection unavailable; work retained", {
        code: "stripe_legacy_selection_failed",
        key,
        failureType: error instanceof Error ? error.name : "unknown",
      });
      continue;
    }
    let lastAttempted: string | null = null;
    for (const [index, digest] of selection.digests.entries()) {
      // Always try the first reservation. Advancing only to that digest keeps
      // later entries reachable even when every call exhausts its time budget.
      if (index > 0 && performance.now() - started >= LEGACY_STRIPE_ADOPTION_WORK_MS) break;
      lastAttempted = digest;
      const raw = entries.get(digest)!;
      let body: StripeEventMessage | undefined;
      try {
        body = (JSON.parse(raw) as { body?: StripeEventMessage }).body;
      } catch {
        body = undefined;
      }
      if (body?.kind === "stripe.event") {
        try {
          const receipt = await webhookEventsRepository.adoptLegacyStripeDelivery(
            body,
            sha256Hex(JSON.stringify(body.event)),
          );
          if (receipt.kind === "conflict" || receipt.kind === "unavailable") {
            logger.error("[Stripe Outbox] Legacy receipt unavailable; work retained", {
              code: `stripe_legacy_${receipt.kind}`,
              reason: receipt.reason,
              key,
              digest,
            });
            continue;
          }
        } catch (error) {
          // error-policy:J7 one bad entry must not stop the rest; it stays listed and is logged.
          logger.error("[Stripe Outbox] Legacy queue entry not adopted; kept for the next run", {
            code: "stripe_legacy_adoption_failed",
            key,
            digest,
            failureType: error instanceof Error ? error.name : "unknown",
          });
          continue;
        }
        adopted++;
      } else {
        logger.error("[Stripe Outbox] Unrecognized legacy entry retained", {
          code: "stripe_legacy_unrecognized",
          key,
          digest,
        });
        continue;
      }
      // KV removal is a read/modify/write that can erase an old writer's
      // concurrent append. SQL adoption is safe, but there is no durable writer
      // fence here to authorize deletion. Keep the complete original KV list.
      if (cache.getBackendKind() === "cloudflare_kv") continue;
      try {
        await cache.removeQueueValue(key, raw);
      } catch (error) {
        // error-policy:J7 the receipt is durable; retry this raw without starving other work.
        logger.warn("[Stripe Outbox] Legacy removal unavailable; receipt retained", {
          code: "stripe_legacy_removal_failed",
          key,
          digest,
          failureType: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    if (lastAttempted && lastAttempted !== selection.digests[0]) {
      try {
        await finishLegacyStripeAdoptionSelection(sourceKey, selection.revision, lastAttempted);
      } catch (error) {
        logger.warn("[Stripe Outbox] Legacy progress hint unavailable; original work retained", {
          code: "stripe_legacy_cursor_completion_failed",
          key,
          failureType: error instanceof Error ? error.name : "unknown",
        });
      }
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
      failureType: error instanceof Error ? error.name : "unknown",
    });
  }
  return { ...(await drainStripeOutbox(handler, options)), legacyAdopted };
}
