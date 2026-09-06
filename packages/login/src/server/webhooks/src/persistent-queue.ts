/**
 * Persistent webhook delivery queue backed by the `webhook_deliveries` DB table.
 *
 * Replaces the in-memory RetryQueue for production use. Webhooks survive
 * process restarts and use exponential backoff for retries.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  webhookConfigs,
  webhookDeliveries,
} from "../../db/src/index.ts";
import type { WebhookEvent } from "../../shared/src/index.ts";

import { WebhookDispatcher } from "./dispatcher";
import { decryptWebhookSecret, encryptWebhookSecret } from "./secret-codec";
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
const CLAIM_VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000;

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

  constructor(
    dispatcher = new WebhookDispatcher({ maxRetries: 0 }),
    options: PersistentQueueOptions = {},
  ) {
    this.dispatcher = dispatcher;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.batchSize = options.batchSize ?? 50;
  }

  /**
   * Enqueue a webhook delivery to the database.
   * Returns the delivery ID.
   */
  async enqueue(
    event: WebhookEvent,
    webhook: WebhookConfig | string,
  ): Promise<string> {
    const db = getDb();
    const url = typeof webhook === "string" ? webhook : webhook.url;
    const webhookConfigId =
      typeof webhook === "string" ? null : (webhook.id ?? null);
    const secret =
      typeof webhook === "string" ? null : encryptWebhookSecret(webhook.secret);
    const events = typeof webhook === "string" ? null : (webhook.events ?? []);

    const [row] = await db
      .insert(webhookDeliveries)
      .values({
        tenantId: event.tenantId,
        webhookConfigId,
        agentId: event.agentId,
        eventType: event.type,
        payload: event as unknown as Record<string, unknown>,
        url,
        secret,
        events,
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

    // Atomically claim due deliveries before dispatch. The temporary
    // nextRetryAt push acts as a visibility timeout if a worker crashes mid-send.
    const claimed = (await db.transaction(async (tx) =>
      tx.execute(sql`
        UPDATE ${webhookDeliveries}
        SET
          "status" = 'processing',
          "next_retry_at" = ${new Date(now.getTime() + CLAIM_VISIBILITY_TIMEOUT_MS).toISOString()}
        WHERE "id" IN (
          SELECT "id"
          FROM ${webhookDeliveries}
          WHERE (
            ${webhookDeliveries.status} in ('pending', 'failed')
            OR ${webhookDeliveries.status} = 'processing'
          )
            AND ${webhookDeliveries.nextRetryAt} <= ${now.toISOString()}
          ORDER BY ${webhookDeliveries.nextRetryAt} ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${this.batchSize}
        )
        RETURNING *
      `),
    )) as unknown;
    const claimedRows =
      typeof claimed === "object" &&
      claimed !== null &&
      "rows" in claimed &&
      Array.isArray((claimed as { rows?: unknown }).rows)
        ? (claimed as { rows: unknown[] }).rows
        : [];
    const deliveries = (
      Array.isArray(claimed) ? claimed : claimedRows
    ) as (typeof webhookDeliveries.$inferSelect)[];

    for (const delivery of deliveries) {
      const event = delivery.payload as unknown as WebhookEvent;
      const newAttempts = delivery.attempts + 1;
      if (!delivery.webhookConfigId || !delivery.secret) {
        await db
          .update(webhookDeliveries)
          .set({
            status: "dead",
            attempts: newAttempts,
            lastError:
              "Webhook delivery is missing original configuration snapshot",
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        results.push({
          success: false,
          attempts: newAttempts,
          error: "Webhook delivery is missing original configuration snapshot",
        });
        continue;
      }

      const [webhook] = await db
        .select({
          id: webhookConfigs.id,
          url: webhookConfigs.url,
          events: webhookConfigs.events,
        })
        .from(webhookConfigs)
        .where(
          and(
            eq(webhookConfigs.tenantId, delivery.tenantId),
            eq(webhookConfigs.id, delivery.webhookConfigId),
            eq(webhookConfigs.enabled, true),
          ),
        )
        .limit(1);

      if (!webhook) {
        await db
          .update(webhookDeliveries)
          .set({
            status: "dead",
            attempts: newAttempts,
            lastError: "Webhook configuration is disabled or deleted",
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        results.push({
          success: false,
          attempts: newAttempts,
          error: "Webhook configuration is disabled or deleted",
        });
        continue;
      }
      if (webhook.url !== delivery.url) {
        await db
          .update(webhookDeliveries)
          .set({
            status: "dead",
            attempts: newAttempts,
            lastError:
              "Webhook delivery URL no longer matches its original configuration",
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        results.push({
          success: false,
          attempts: newAttempts,
          error:
            "Webhook delivery URL no longer matches its original configuration",
        });
        continue;
      }
      if (
        webhook.events.length > 0 &&
        !webhook.events.includes(delivery.eventType)
      ) {
        await db
          .update(webhookDeliveries)
          .set({
            status: "dead",
            attempts: newAttempts,
            lastError:
              "Webhook configuration no longer subscribes to this event",
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        results.push({
          success: false,
          attempts: newAttempts,
          error: "Webhook configuration no longer subscribes to this event",
        });
        continue;
      }

      // A poisoned row must not reject the whole batch: an undecryptable
      // secret (e.g. after STEWARD_WEBHOOK_SECRET_ENCRYPTION_KEY rotation, or
      // a malformed stwd_whsec_v1: payload) throws deterministically, and an
      // un-wrapped throw would reclaim the row forever and block every later
      // delivery in the batch. Dead-letter it (attempts incremented) and move
      // on — the row never becomes deliverable again on its own.
      let result: WebhookDeliveryResult;
      try {
        result = await this.dispatcher.dispatch(event, {
          id: webhook.id,
          url: delivery.url,
          secret: decryptWebhookSecret(delivery.secret),
          events: delivery.events ?? undefined,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown webhook delivery error";
        await db
          .update(webhookDeliveries)
          .set({
            status: "dead",
            attempts: newAttempts,
            lastError: `Webhook delivery failed deterministically: ${message}`,
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        results.push({
          success: false,
          attempts: newAttempts,
          error: message,
        });
        continue;
      }

      // dispatch() mutates `event` with a stable deliveryId + signedAt; persist it
      // so retries reuse the same id/timestamp/signature instead of re-signing fresh.
      const persistedPayload = event as unknown as Record<string, unknown>;

      if (result.success) {
        // Mark as delivered
        await db
          .update(webhookDeliveries)
          .set({
            status: "delivered",
            attempts: newAttempts,
            deliveredAt: new Date(),
            lastError: null,
            payload: persistedPayload,
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
            payload: persistedPayload,
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
          payload: persistedPayload,
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
