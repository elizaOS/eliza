/** Durable webhook retries. Claims are fenced by a monotonically increasing attempt. */
import { ElizaError, logger } from "@elizaos/core";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { isEmbeddedDatabase } from "../db/client";
import {
  getDatabaseDriver,
  getDb,
  tenantContextForInternalJob,
  webhookConfigs,
  webhookDeliveries,
  withTenantRlsTransaction,
  withTenantTransactionDatabase,
} from "../db/index.ts";
import type { WebhookEvent } from "../shared/index.ts";
import { WebhookDispatcher } from "./dispatcher";
import { decryptWebhookSecret, encryptWebhookSecret } from "./secret-codec";
import type { WebhookConfig, WebhookDeliveryResult } from "./types";

const CLAIM_VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 12 * 60 * 60 * 1000;
type DatabaseOperation = <T>(callback: () => Promise<T>) => Promise<T>;
const currentDatabase: DatabaseOperation = (callback) => callback();
type Delivery = typeof webhookDeliveries.$inferSelect;

export interface PersistentQueueOptions {
  maxAttempts?: number;
  /** Maximum deliveries per tenant per tick; claim immediately before dispatch. */
  batchSize?: number;
}
export interface PersistentQueueStats {
  pending: number;
  delivered: number;
  failed: number;
  dead: number;
}

export class PersistentQueue {
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  constructor(
    private readonly dispatcher = new WebhookDispatcher({ maxRetries: 0 }),
    options: PersistentQueueOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.batchSize = options.batchSize ?? 50;
    if (
      ![this.maxAttempts, this.batchSize].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    ) {
      throw new ElizaError("Webhook queue limits must be positive integers", {
        code: "LOGIN_WEBHOOK_QUEUE_OPTIONS_INVALID",
      });
    }
  }

  async enqueue(event: WebhookEvent, webhook: WebhookConfig): Promise<string> {
    if (!webhook.id)
      throw new ElizaError("Webhook configuration ID is required", {
        code: "LOGIN_WEBHOOK_CONFIG_REQUIRED",
      });
    const [row] = await getDb()
      .insert(webhookDeliveries)
      .values({
        tenantId: event.tenantId,
        webhookConfigId: webhook.id,
        agentId: event.agentId,
        eventType: event.type,
        payload: event as unknown as Record<string, unknown>,
        url: webhook.url,
        secret: encryptWebhookSecret(webhook.secret),
        events: webhook.events ?? [],
        status: "pending",
        attempts: 0,
        maxAttempts: this.maxAttempts,
        nextRetryAt: new Date(),
      })
      .returning();
    return row.id;
  }

  private async claim(
    id?: string,
    tenantId?: string,
  ): Promise<Delivery | undefined> {
    return getDb().transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            inArray(webhookDeliveries.status, [
              "pending",
              "failed",
              "processing",
            ]),
            lte(webhookDeliveries.nextRetryAt, new Date()),
            ...(id ? [eq(webhookDeliveries.id, id)] : []),
            ...(tenantId ? [eq(webhookDeliveries.tenantId, tenantId)] : []),
          ),
        )
        .orderBy(webhookDeliveries.nextRetryAt)
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return undefined;
      const [claimed] = await tx
        .update(webhookDeliveries)
        .set({
          status: "processing",
          attempts: candidate.attempts + 1,
          nextRetryAt: new Date(Date.now() + CLAIM_VISIBILITY_TIMEOUT_MS),
        })
        .where(eq(webhookDeliveries.id, candidate.id))
        .returning();
      return claimed;
    });
  }

  /** Used by inline delivery and the runtime retry worker; both take the same claim. */
  async processDelivery(
    id: string,
    tenantId: string,
  ): Promise<WebhookDeliveryResult | undefined> {
    const delivery = await this.claim(id, tenantId);
    return delivery ? this.deliver(delivery) : undefined;
  }

  async processQueue(signal?: AbortSignal): Promise<WebhookDeliveryResult[]> {
    const results: WebhookDeliveryResult[] = [];
    const response:
      | { tenant_id: string }[]
      | { rows: { tenant_id: string }[] } = await getDb().execute<{
      tenant_id: string;
    }>(
      sql`SELECT tenant_id FROM steward_bootstrap.tenant_ids_for_internal_job()`,
    );
    const tenants = Array.isArray(response)
      ? response
      : (response as { rows: { tenant_id: string }[] }).rows;
    for (const { tenant_id: tenantId } of tenants) {
      const context = tenantContextForInternalJob({
        tenantId,
        job: "webhook-delivery",
      });
      const operation: DatabaseOperation = (callback) =>
        withTenantRlsTransaction(
          getDb(),
          isEmbeddedDatabase() ? "pglite" : getDatabaseDriver(),
          context,
          (tx) => withTenantTransactionDatabase(tx, { tenantId }, callback),
        );
      for (let i = 0; i < this.batchSize && !signal?.aborted; i++) {
        const delivery = await operation(() => this.claim(undefined, tenantId));
        if (!delivery) break;
        // Commit the claim before network I/O. Each receipt uses a fresh tenant
        // transaction, so a slow endpoint cannot retain locks or tenant state.
        results.push(await this.deliver(delivery, operation));
      }
      if (signal?.aborted) break;
    }
    return results;
  }

  private async deliver(
    delivery: Delivery,
    operation = currentDatabase,
  ): Promise<WebhookDeliveryResult> {
    const claim = and(
      eq(webhookDeliveries.id, delivery.id),
      eq(webhookDeliveries.tenantId, delivery.tenantId),
      eq(webhookDeliveries.status, "processing"),
      eq(webhookDeliveries.attempts, delivery.attempts),
    );
    const dead = async (error: string): Promise<WebhookDeliveryResult> => {
      await operation(async () =>
        getDb()
          .update(webhookDeliveries)
          .set({ status: "dead", nextRetryAt: null, lastError: error })
          .where(claim),
      );
      return { success: false, attempts: delivery.attempts, error };
    };
    if (delivery.attempts > delivery.maxAttempts)
      return dead("Maximum delivery attempts exceeded");
    if (!delivery.webhookConfigId || !delivery.secret)
      return dead(
        "Webhook delivery is missing original configuration snapshot",
      );
    const configId = delivery.webhookConfigId;
    const [config] = await operation(async () =>
      getDb()
        .select()
        .from(webhookConfigs)
        .where(
          and(
            eq(webhookConfigs.id, configId),
            eq(webhookConfigs.tenantId, delivery.tenantId),
            eq(webhookConfigs.enabled, true),
          ),
        )
        .limit(1),
    );
    if (!config) return dead("Webhook configuration is disabled or deleted");
    if (config.url !== delivery.url)
      return dead(
        "Webhook delivery URL no longer matches its original configuration",
      );
    const isTest = delivery.eventType === "webhook.test";
    if (
      !isTest &&
      config.events.length > 0 &&
      !config.events.includes(delivery.eventType)
    )
      return dead("Webhook configuration no longer subscribes to this event");
    const event = {
      ...delivery.payload,
      deliveryId: delivery.id,
    } as unknown as WebhookEvent;
    let secret: string;
    try {
      secret = decryptWebhookSecret(delivery.secret);
    } catch {
      logger.error(
        { deliveryId: delivery.id, tenantId: delivery.tenantId },
        "Webhook delivery secret could not be decoded",
      );
      return dead("Webhook delivery configuration could not be decoded");
    }
    const result = await this.dispatcher.dispatch(event, {
      id: config.id,
      url: delivery.url,
      secret,
      events: isTest ? [] : (delivery.events ?? undefined),
    });
    const retryable =
      !result.success && delivery.attempts < delivery.maxAttempts;
    const delay = Math.min(
      config.retryBackoffMs * 2 ** (delivery.attempts - 1),
      MAX_RETRY_DELAY_MS,
    );
    await operation(async () =>
      getDb()
        .update(webhookDeliveries)
        .set({
          status: result.success ? "delivered" : retryable ? "failed" : "dead",
          nextRetryAt: retryable ? new Date(Date.now() + delay) : null,
          deliveredAt: result.deliveredAt ?? null,
          lastError: result.error ?? null,
          payload: event as unknown as Record<string, unknown>,
        })
        .where(claim),
    );
    return { ...result, attempts: delivery.attempts };
  }

  async getStats(): Promise<PersistentQueueStats> {
    const [stats] = await getDb()
      .select({
        pending: sql<number>`count(*) filter (where ${webhookDeliveries.status} in ('pending', 'processing'))`,
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

  async getDelivery(id: string, tenantId: string): Promise<Delivery | null> {
    const [delivery] = await getDb()
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.id, id),
          eq(webhookDeliveries.tenantId, tenantId),
        ),
      );
    return delivery ?? null;
  }
}
