/**
 * Redis-backed work queue.
 *
 * `enqueue` pushes a JSON-serialized envelope onto a list; `drain` pops
 * up to `max` envelopes and runs the handler. The handler reports either
 * `ack` (drop the message), `retry` (push back with attempts++ and an
 * exponential `notBefore` delay until `maxAttempts`, then send to the DLQ
 * list), or `dlq` (push straight to the DLQ — used for permanent failures).
 * A message whose `notBefore` is in the future is requeued untouched, and a
 * drain stops once it pops a message it already requeued, so one cron tick
 * never burns a retry budget. `onDeadLetter` lets the owner release
 * producer-side dedupe so a provider resend can re-enter the queue.
 *
 * Backed by the same shared `cache` client, so it follows the same
 * adapter selection (Upstash REST in cloud, native Redis or embedded
 * Wadis locally) and circuit-breaker behavior.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { cache } from "./cache/client";
import { logger } from "./utils/logger";

interface Envelope<T> {
  body: T;
  attempts: number;
  enqueuedAt: number;
  /** Epoch ms before which a retried message is not handled. */
  notBefore?: number;
}

export type DrainResult = "ack" | "retry" | "dlq";

export type DrainHandler<T> = (envelope: {
  body: T;
  attempts: number;
  enqueuedAt: number;
}) => Promise<DrainResult>;

export interface DrainOptions<T = unknown> {
  /** Max messages to pop in one call (default 25). */
  max?: number;
  /** Max processing time before bailing on the remaining batch (default 25_000 ms). */
  budgetMs?: number;
  /** Max retry attempts before promoting a message to the DLQ (default 5). */
  maxAttempts?: number;
  /** First retry delay; doubles per attempt (default 60_000 ms). */
  retryBaseDelayMs?: number;
  /** Retry delay ceiling (default 3_600_000 ms). */
  retryMaxDelayMs?: number;
  /** Runs after a message is durably written to the DLQ; failures are logged, the message stays in the DLQ. */
  onDeadLetter?: (envelope: { body: T; attempts: number; enqueuedAt: number }) => Promise<void>;
}

export interface DrainStats {
  attempted: number;
  acked: number;
  retried: number;
  dlqed: number;
  failed: number;
  /** Messages requeued untouched because their retry delay has not elapsed. */
  deferred: number;
}

export function retryDelayMs(attempts: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, Math.min(attempts - 1, 30)), maxMs);
}

function dlqKey(queueKey: string): string {
  return `${queueKey}:dlq`;
}

async function pushRawRequired(queueKey: string, raw: string): Promise<void> {
  const written = await cache.pushQueueHead(queueKey, raw);
  if (written === null) {
    throw new Error(`[Queue] Redis unavailable; cannot push to ${queueKey}`);
  }
}

async function pushRequired(queueKey: string, envelope: Envelope<unknown>): Promise<string> {
  const raw = JSON.stringify(envelope);
  await pushRawRequired(queueKey, raw);
  return raw;
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
  options: DrainOptions<T> = {},
): Promise<DrainStats> {
  const max = options.max ?? 25;
  const budgetMs = options.budgetMs ?? 25_000;
  const maxAttempts = options.maxAttempts ?? 5;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? 60_000;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? 3_600_000;
  const start = Date.now();

  const stats: DrainStats = {
    attempted: 0,
    acked: 0,
    retried: 0,
    dlqed: 0,
    failed: 0,
    deferred: 0,
  };
  // Serialized envelopes this drain pushed back; popping one means the queue wrapped.
  const requeued = new Set<string>();
  const deadLetter = async (envelope: Envelope<T>) => {
    await pushRequired(dlqKey(queueKey), envelope);
    stats.dlqed++;
    if (!options.onDeadLetter) return;
    try {
      await options.onDeadLetter({
        body: envelope.body,
        attempts: envelope.attempts,
        enqueuedAt: envelope.enqueuedAt,
      });
    } catch (hookError) {
      // error-policy:J7 the message is already durable in the DLQ; the release hook failure is surfaced, not retried.
      logger.error(`[Queue] Dead-letter hook failed for ${queueKey}`, {
        error: hookError instanceof Error ? hookError.message : String(hookError),
        attempts: envelope.attempts,
      });
    }
  };

  for (let i = 0; i < max; i++) {
    if (Date.now() - start > budgetMs) {
      logger.warn(`[Queue] Drain budget exceeded for ${queueKey}`, { processed: stats.attempted });
      break;
    }

    const raw = await cache.popQueueTail(queueKey);
    if (raw === null) break;
    if (requeued.has(raw)) {
      await pushRawRequired(queueKey, raw);
      break;
    }

    let envelope: Envelope<T>;
    try {
      envelope = JSON.parse(raw) as Envelope<T>;
    } catch (parseError) {
      logger.error(`[Queue] Dropping unparseable envelope from ${queueKey}`, {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        sample: truncateWellFormed(toWellFormedUnicode(raw), 200),
      });
      stats.failed++;
      continue;
    }

    if (typeof envelope.notBefore === "number" && envelope.notBefore > Date.now()) {
      await pushRawRequired(queueKey, raw);
      requeued.add(raw);
      stats.deferred++;
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
      case "dlq": {
        const { notBefore: _notBefore, ...dead } = envelope;
        await deadLetter(dead);
        break;
      }
      case "retry": {
        const attempts = envelope.attempts + 1;
        if (attempts >= maxAttempts) {
          const { notBefore: _notBefore, ...dead } = envelope;
          await deadLetter({ ...dead, attempts });
        } else {
          const next: Envelope<T> = {
            ...envelope,
            attempts,
            notBefore: Date.now() + retryDelayMs(attempts, retryBaseDelayMs, retryMaxDelayMs),
          };
          requeued.add(await pushRequired(queueKey, next));
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
