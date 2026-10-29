/**
 * Redis-backed work queue.
 *
 * `enqueue` pushes a JSON-serialized envelope onto a list; `drain` moves
 * up to `max` envelopes onto the queue's processing list and runs the
 * handler on each. The handler reports either `ack` (drop the message),
 * `retry` (push back with attempts++ and an exponential `notBefore` delay
 * until `maxAttempts`, then send to the DLQ list), or `dlq` (push straight
 * to the DLQ — used for permanent failures). A message whose `notBefore` is
 * in the future is requeued untouched, and a drain stops once it pops a
 * message it already requeued, so one cron tick never burns a retry budget.
 * `onDeadLetter` lets the owner release producer-side dedupe so a provider
 * resend can re-enter the queue.
 *
 * A claimed message stays on `<queue>:processing` until its outcome is
 * written back, so a drain that dies mid-handler or cannot reach Redis for
 * the write-back leaves it there instead of nowhere. The next drain treats
 * every message still on the processing list as a failed attempt: it is
 * requeued with the retry delay or, once the retry budget is spent,
 * dead-lettered. A short lease (`<queue>:drain-lease`) keeps two drains from
 * treating each other's in-flight messages as abandoned; a drain that
 * outlives its lease can see one message handled twice, which the handler
 * must tolerate (the Stripe consumer re-checks every downstream write).
 * The processing list and the lease need atomic list moves and SET NX, so a
 * backend without them (Cloudflare KV) keeps the plain pop-then-settle drain.
 *
 * Backed by the same shared `cache` client, so it follows the same
 * adapter selection (Upstash REST in cloud, native Redis or embedded
 * Wadis locally) and circuit-breaker behavior.
 */

import { randomUUID } from "node:crypto";
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
  /**
   * How long this drain owns the queue (default `budgetMs` plus 60 s). Messages
   * left on the processing list are recovered only by a drain that holds the
   * lease, so the lease must outlive one handler run.
   */
  leaseMs?: number;
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
  /** Messages an earlier drain left on the processing list, requeued or dead-lettered here. */
  recovered: number;
  /** True when nothing ran: another drain holds the lease or Redis is unavailable. */
  skipped: boolean;
}

export function retryDelayMs(attempts: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, Math.min(attempts - 1, 30)), maxMs);
}

function dlqKey(queueKey: string): string {
  return `${queueKey}:dlq`;
}

function processingKey(queueKey: string): string {
  return `${queueKey}:processing`;
}

function leaseKey(queueKey: string): string {
  return `${queueKey}:drain-lease`;
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

/** Drops a settled message from the processing list; throws so the message stays claimed when Redis is unavailable. */
async function settleRequired(queueKey: string, raw: string): Promise<void> {
  const removed = await cache.removeQueueValue(processingKey(queueKey), raw);
  if (removed === null) {
    throw new Error(`[Queue] Redis unavailable; cannot settle ${processingKey(queueKey)}`);
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

async function acquireLease(queueKey: string, token: string, leaseMs: number): Promise<boolean> {
  try {
    return await cache.setIfNotExists(leaseKey(queueKey), token, leaseMs);
  } catch (error) {
    logger.warn(`[Queue] Redis unavailable; drain of ${queueKey} skipped`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// A failed release must not replace the drain result; the lease expires on its own.
async function releaseLease(queueKey: string, token: string): Promise<void> {
  const key = leaseKey(queueKey);
  try {
    if ((await cache.get<string>(key)) === token) {
      await cache.del(key);
    }
  } catch (error) {
    logger.warn(`[Queue] Could not release the drain lease of ${queueKey}; it expires on its own`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
  const leaseMs = options.leaseMs ?? budgetMs + 60_000;
  const start = Date.now();

  const stats: DrainStats = {
    attempted: 0,
    acked: 0,
    retried: 0,
    dlqed: 0,
    failed: 0,
    deferred: 0,
    recovered: 0,
    skipped: false,
  };

  const run: DrainRun<T> = {
    max,
    budgetMs,
    maxAttempts,
    retryBaseDelayMs,
    retryMaxDelayMs,
    start,
    durable: cache.supportsAtomicOperations(),
    onDeadLetter: options.onDeadLetter,
  };
  if (!run.durable) {
    await drainClaimed(queueKey, handler, stats, run);
    return stats;
  }

  const leaseToken = randomUUID();
  if (!(await acquireLease(queueKey, leaseToken, leaseMs))) {
    logger.info(`[Queue] Drain of ${queueKey} skipped; another drain holds the lease`);
    return { ...stats, skipped: true };
  }
  try {
    await drainClaimed(queueKey, handler, stats, run);
  } finally {
    await releaseLease(queueKey, leaseToken);
  }
  return stats;
}

interface DrainRun<T> {
  max: number;
  budgetMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  start: number;
  /** Claim onto the processing list and settle after the write-back; false on non-atomic backends. */
  durable: boolean;
  onDeadLetter: DrainOptions<T>["onDeadLetter"];
}

async function drainClaimed<T>(
  queueKey: string,
  handler: DrainHandler<T>,
  stats: DrainStats,
  run: DrainRun<T>,
): Promise<void> {
  const { max, budgetMs, maxAttempts, retryBaseDelayMs, retryMaxDelayMs, start, durable } = run;
  const claim = () =>
    durable ? cache.moveQueueTail(queueKey, processingKey(queueKey)) : cache.popQueueTail(queueKey);
  const settle = async (raw: string) => {
    if (durable) await settleRequired(queueKey, raw);
  };
  // Serialized envelopes this drain pushed back; popping one means the queue wrapped.
  const requeued = new Set<string>();
  const deadLetter = async (envelope: Envelope<T>) => {
    await pushRequired(dlqKey(queueKey), envelope);
    stats.dlqed++;
    if (!run.onDeadLetter) return;
    try {
      await run.onDeadLetter({
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
  const parse = (raw: string): Envelope<T> | null => {
    try {
      return JSON.parse(raw) as Envelope<T>;
    } catch (parseError) {
      logger.error(`[Queue] Dropping unparseable envelope from ${queueKey}`, {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        sample: truncateWellFormed(toWellFormedUnicode(raw), 200),
      });
      stats.failed++;
      return null;
    }
  };
  // Counts one more attempt and requeues with the retry delay, or dead-letters once the budget is spent.
  const retryOrDeadLetter = async (envelope: Envelope<T>) => {
    const attempts = envelope.attempts + 1;
    if (attempts >= maxAttempts) {
      const { notBefore: _notBefore, ...dead } = envelope;
      await deadLetter({ ...dead, attempts });
      return;
    }
    const next: Envelope<T> = {
      ...envelope,
      attempts,
      notBefore: Date.now() + retryDelayMs(attempts, retryBaseDelayMs, retryMaxDelayMs),
    };
    requeued.add(await pushRequired(queueKey, next));
    stats.retried++;
  };

  // Messages an earlier drain claimed but never settled: it died mid-handler or
  // lost Redis before the write-back. Each one counts as a failed attempt.
  const abandoned = durable ? await cache.listQueue(processingKey(queueKey)) : [];
  for (const raw of abandoned ?? []) {
    const envelope = parse(raw);
    if (envelope) {
      await retryOrDeadLetter(envelope);
      stats.recovered++;
      logger.warn(`[Queue] Recovered an abandoned message on ${queueKey}`, {
        attempts: envelope.attempts + 1,
      });
    }
    await settleRequired(queueKey, raw);
  }

  for (let i = 0; i < max; i++) {
    if (Date.now() - start > budgetMs) {
      logger.warn(`[Queue] Drain budget exceeded for ${queueKey}`, { processed: stats.attempted });
      break;
    }

    const raw = await claim();
    if (raw === null) break;
    if (requeued.has(raw)) {
      await pushRawRequired(queueKey, raw);
      await settle(raw);
      break;
    }

    const envelope = parse(raw);
    if (!envelope) {
      await settle(raw);
      continue;
    }

    if (typeof envelope.notBefore === "number" && envelope.notBefore > Date.now()) {
      await pushRawRequired(queueKey, raw);
      await settle(raw);
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
      case "retry":
        await retryOrDeadLetter(envelope);
        break;
    }
    await settle(raw);
  }
}

/** Current depth of the queue (best-effort; eventually consistent on Upstash). */
export function queueLength(queueKey: string): Promise<number> {
  return cache.getQueueLength(queueKey);
}
