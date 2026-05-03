/**
 * Persistent webhook delivery queue backed by the `webhook_deliveries` DB table.
 *
 * Replaces the in-memory RetryQueue for production use. Webhooks survive
 * process restarts and use exponential backoff for retries.
 */

import { getDb, webhookDeliveries } from "@stwd/db";
import type { WebhookEvent } from "@stwd/shared";
import { and, eq, lte, sql } from "drizzle-orm";

import { WebhookDispatcher } from "./dispatcher";
import type { WebhookConfig, WebhookDeliveryResult } from "./types";

// Exponential backoff schedule: 1min, 5min, 30min, 2hr, 12hr
const RETRY_DELAYS_MS = [
  1 * 60 * 1000, // 1 minute
  5 * 60 * 1000, // 5 minutes
  30 * 60 * 1000, // 30 minutes
  2 * 60 * 60 * 1000, // 2 hours
  12 * 60 * 60 * 1000, // 12 hours
];

const DEFAULT_MAX_ATTEMPTS = 5;

export interface PersistentQueueOptions {
  maxAttempts?: number;
  /** How many deliveries to process per tick */
  batchSize?: number;
}

export interface PersistentQueueStats {
  pending: number;
  delivered: number;
  failed: number;
  dead: number;
}

export class PersistentQueue {
  private readonly dispatcher: WebhookDispatcher;
  private readonly maxAttempts: number;
  private readonly batchSize: number;

  constructor(dispatcher = new WebhookDispatcher(), options: PersistentQueueOptions = {}) {
    this.dispatcher = dispatcher;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.batchSize = options.batchSize ?? 50;
  }

  /**
   * Enqueue a webhook delivery to the database.
   * Returns the delivery ID.
   */
  async enqueue(event: WebhookEvent, webhook: WebhookConfig | string): Promise<string> {
    const db = getDb();
    const url = typeof webhook === "string" ? webhook : webhook.url;

    const [row] = await db
      .insert(webhookDeliveries)
      .values({
        tenantId: event.tenantId,
        agentId: event.agentId,
        eventType: event.type,
        payload: event as unknown as Record<string, unknown>,
        url,
        status: "pending",
        attempts: 0,
        maxAttempts: this.maxAttempts,
        nextRetryAt: new Date(),
      })
      .returning();

    return row.id;
  }

  /**
   * Process pending and retryable deliveries.
   * Picks up rows where status is 'pending' or 'failed' and nextRetryAt <= now.
   */
  async processQueue(): Promise<WebhookDeliveryResult[]> {
    const db = getDb();
    const now = new Date();
    const results: WebhookDeliveryResult[] = [];

    // Fetch deliveries ready for attempt
    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          sql`${webhookDeliveries.status} in ('pending', 'failed')`,
          lte(webhookDeliveries.nextRetryAt, now),
        ),
      )
      .limit(this.batchSize);

    for (const delivery of deliveries) {
      const event = delivery.payload as unknown as WebhookEvent;
      const result = await this.dispatcher.dispatch(event, delivery.url);
      const newAttempts = delivery.attempts + 1;

      if (result.success) {
        // Mark as delivered
        await db
          .update(webhookDeliveries)
          .set({
            status: "delivered",
            attempts: newAttempts,
            deliveredAt: new Date(),
            lastError: null,
          })
          .where(eq(webhookDeliveries.id, delivery.id));

        results.push({ ...result, attempts: newAttempts });
        continue;
      }

      // Failed — check if we should retry or mark dead
      if (newAttempts >= delivery.maxAttempts) {
        // Dead letter
        await db
          .update(webhookDeliveries)
          .set({
            status: "dead",
            attempts: newAttempts,
            lastError: result.error ?? "Max attempts exceeded",
          })
          .where(eq(webhookDeliveries.id, delivery.id));

        results.push({ ...result, attempts: newAttempts });
        continue;
      }

      // Schedule retry with exponential backoff
      const delayIndex = Math.min(newAttempts - 1, RETRY_DELAYS_MS.length - 1);
      const delayMs = RETRY_DELAYS_MS[delayIndex];
      const nextRetryAt = new Date(Date.now() + delayMs);

      await db
        .update(webhookDeliveries)
        .set({
          status: "failed",
          attempts: newAttempts,
          nextRetryAt,
          lastError: result.error ?? "Delivery failed",
        })
        .where(eq(webhookDeliveries.id, delivery.id));

      results.push({ ...result, attempts: newAttempts });
    }

    return results;
  }

  /**
   * Get queue statistics from the database.
   */
  async getStats(): Promise<PersistentQueueStats> {
    const db = getDb();

    const [stats] = await db
      .select({
        pending: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'pending')`,
        delivered: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'delivered')`,
        failed: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'failed')`,
        dead: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'dead')`,
      })
      .from(webhookDeliveries);

    return {
      pending: Number(stats?.pending ?? 0),
      delivered: Number(stats?.delivered ?? 0),
      failed: Number(stats?.failed ?? 0),
      dead: Number(stats?.dead ?? 0),
    };
  }

  /**
   * Get a specific delivery by ID (useful for checking status).
   */
  async getDelivery(id: string) {
    const db = getDb();
    const [delivery] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id));
    return delivery ?? null;
  }
}
