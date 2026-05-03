/**
 * Redis-backed work queue.
 *
 * `enqueue` pushes a JSON-serialized envelope onto a list; `drain` pops
 * up to `max` envelopes and runs the handler. The handler reports either
 * `ack` (drop the message), `retry` (push back with attempts++ until
 * `maxAttempts`, then send to the DLQ list), or `dlq` (push straight to
 * the DLQ — used for permanent failures).
 *
 * Backed by the same shared `cache` client, so it follows the same
 * adapter selection (Upstash REST in cloud, native Redis or embedded
 * Wadis locally) and circuit-breaker behavior.
 */

import { cache } from "@/lib/cache/client";
import { logger } from "@/lib/utils/logger";

interface Envelope<T> {
  body: T;
  attempts: number;
  enqueuedAt: number;
}

export type DrainResult = "ack" | "retry" | "dlq";

export type DrainHandler<T> = (envelope: {
  body: T;
  attempts: number;
  enqueuedAt: number;
}) => Promise<DrainResult>;

export interface DrainOptions {
  /** Max messages to pop in one call (default 25). */
  max?: number;
  /** Max processing time before bailing on the remaining batch (default 25_000 ms). */
  budgetMs?: number;
  /** Max retry attempts before promoting a message to the DLQ (default 5). */
  maxAttempts?: number;
}

export interface DrainStats {
  attempted: number;
  acked: number;
  retried: number;
  dlqed: number;
  failed: number;
}

function dlqKey(queueKey: string): string {
  return `${queueKey}:dlq`;
}

async function pushRequired(queueKey: string, envelope: Envelope<unknown>): Promise<void> {
  const written = await cache.pushQueueHead(queueKey, JSON.stringify(envelope));
  if (written === null) {
    throw new Error(`[Queue] Redis unavailable; cannot push to ${queueKey}`);
  }
}

/**
 * Push a value onto the queue. Throws if Redis is unavailable so the caller
 * can return a 5xx and let the upstream producer (e.g. Stripe) retry.
 */
export async function enqueue<T>(queueKey: string, body: T): Promise<void> {
  const envelope: Envelope<T> = { body, attempts: 0, enqueuedAt: Date.now() };
  await pushRequired(queueKey, envelope);
}

/**
 * Drain a queue: pop up to `max` envelopes and run `handler` on each.
 * Returns counts so the cron route can log/observe.
 */
export async function drain<T>(
  queueKey: string,
  handler: DrainHandler<T>,
  options: DrainOptions = {},
): Promise<DrainStats> {
  const max = options.max ?? 25;
  const budgetMs = options.budgetMs ?? 25_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const start = Date.now();

  const stats: DrainStats = { attempted: 0, acked: 0, retried: 0, dlqed: 0, failed: 0 };

  for (let i = 0; i < max; i++) {
    if (Date.now() - start > budgetMs) {
      logger.warn(`[Queue] Drain budget exceeded for ${queueKey}`, { processed: stats.attempted });
      break;
    }

    const raw = await cache.popQueueTail(queueKey);
    if (raw === null) break;

    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(raw) as Envelope<T>;
    } catch (parseError) {
      logger.error(`[Queue] Dropping unparseable envelope from ${queueKey}`, {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        sample: raw.slice(0, 200),
      });
      stats.failed++;
      continue;
    }

    stats.attempted++;
    let result: DrainResult;
    try {
      result = await handler({
        body: envelope.body,
        attempts: envelope.attempts,
        enqueuedAt: envelope.enqueuedAt,
      });
    } catch (handlerError) {
      logger.error(`[Queue] Handler threw for ${queueKey}; treating as retry`, {
        error: handlerError instanceof Error ? handlerError.message : String(handlerError),
        attempts: envelope.attempts,
      });
      result = "retry";
    }

    switch (result) {
      case "ack":
        stats.acked++;
        break;
      case "dlq":
        await pushRequired(dlqKey(queueKey), envelope);
        stats.dlqed++;
        break;
      case "retry": {
        const next: Envelope<T> = { ...envelope, attempts: envelope.attempts + 1 };
        if (next.attempts >= maxAttempts) {
          await pushRequired(dlqKey(queueKey), next);
          stats.dlqed++;
        } else {
          await pushRequired(queueKey, next);
          stats.retried++;
        }
        break;
      }
    }
  }

  return stats;
}

/** Current depth of the queue (best-effort; eventually consistent on Upstash). */
export function queueLength(queueKey: string): Promise<number> {
  return cache.getQueueLength(queueKey);
}
