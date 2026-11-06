/** Persists deduplication receipts, the Stripe delivery outbox and incomplete app billing triggers for durable recovery. */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { StripeEventMessage } from "../../types/stripe-queue-message";
import { dbRead, dbWrite, writeTransaction } from "../helpers";
import { type NewWebhookEvent, type WebhookEvent, webhookEvents } from "../schemas/webhook-events";

export type { NewWebhookEvent, WebhookEvent };

/** A Stripe delivery claimed for one handler run. `attempts` counts this run. */
export interface ClaimedStripeDelivery {
  id: string;
  eventId: string;
  leaseToken: string;
  attempts: number;
  payload: StripeEventMessage;
}

/** Undelivered outbox work; retention never removes it. */
const pendingStripeDelivery = and(
  isNotNull(webhookEvents.delivery_payload),
  isNull(webhookEvents.delivery_completed_at),
  isNull(webhookEvents.delivery_dead_lettered_at),
);
/** Rows retention may delete once old: nothing left to recover. */
const expirable = and(
  or(isNull(webhookEvents.app_billing_trigger), isNotNull(webhookEvents.app_billing_completed_at)),
  or(
    isNull(webhookEvents.delivery_payload),
    isNotNull(webhookEvents.delivery_completed_at),
    isNotNull(webhookEvents.delivery_dead_lettered_at),
  ),
);

export class WebhookEventsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Find a webhook event by its unique event ID.
   */
  async findByEventId(eventId: string): Promise<WebhookEvent | undefined> {
    return await dbRead.query.webhookEvents.findFirst({
      where: eq(webhookEvents.event_id, eventId),
    });
  }

  async findByEventIdPrimary(eventId: string): Promise<WebhookEvent | undefined> {
    const [event] = await dbWrite
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.event_id, eventId));
    return event;
  }

  /**
   * Check if a webhook event has already been processed.
   */
  async isProcessed(eventId: string): Promise<boolean> {
    const event = await this.findByEventId(eventId);
    return !!event;
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Record a processed webhook event.
   */
  async create(data: NewWebhookEvent): Promise<WebhookEvent> {
    const [event] = await dbWrite
      .insert(webhookEvents)
      .values({
        ...data,
        processed_at: new Date(),
      })
      .returning();
    return event;
  }

  /**
   * Atomically try to create a webhook event record.
   * Returns { created: true, event } if successful, { created: false } if duplicate.
   * This eliminates race conditions by using the database's unique constraint.
   */
  async tryCreate(
    data: NewWebhookEvent,
  ): Promise<{ created: true; event: WebhookEvent } | { created: false }> {
    // `onConflictDoNothing` makes the unique-constraint race a no-op (returns
    // no row), so a genuine duplicate is the `!event` branch below. A real
    // write failure (connection/permission/schema) must propagate so the
    // webhook handler fails loudly (5xx → provider retries) instead of
    // masquerading as a duplicate and silently dropping the event.
    const [event] = await dbWrite
      .insert(webhookEvents)
      .values({
        ...data,
        processed_at: new Date(),
      })
      .onConflictDoNothing({ target: webhookEvents.event_id })
      .returning();

    // No row returned ⇒ the event_id already existed (duplicate delivery).
    if (!event) {
      return { created: false };
    }

    return { created: true, event };
  }

  /**
   * A Stripe resend of a dead-lettered delivery makes it due again with a fresh
   * retry budget and the newly verified payload. Returns false for any other row,
   * whose resend stays a duplicate.
   */
  async reviveDeadStripeDelivery(eventId: string, payload: StripeEventMessage): Promise<boolean> {
    const revived = await dbWrite
      .update(webhookEvents)
      .set({
        delivery_payload: payload,
        delivery_attempts: 0,
        delivery_next_attempt_at: sql`clock_timestamp()`,
        delivery_dead_lettered_at: null,
        delivery_lease_token: null,
        delivery_lease_expires_at: null,
      })
      .where(
        and(
          eq(webhookEvents.event_id, eventId),
          eq(webhookEvents.provider, "stripe"),
          isNotNull(webhookEvents.delivery_dead_lettered_at),
        ),
      )
      .returning({ id: webhookEvents.id });
    return revived.length > 0;
  }

  /**
   * Moves one delivery left on the pre-outbox queue into its dedupe row. A row
   * that already holds work keeps it; a missing row (its marker was released)
   * is recreated. Repeating this for the same delivery changes nothing.
   */
  async adoptLegacyStripeDelivery(payload: StripeEventMessage, payloadHash: string): Promise<void> {
    const eventId = payload.appBilling?.receiptKey ?? payload.eventId;
    const adopted = await dbWrite
      .update(webhookEvents)
      .set({ delivery_payload: payload, delivery_next_attempt_at: sql`clock_timestamp()` })
      .where(
        and(
          eq(webhookEvents.event_id, eventId),
          eq(webhookEvents.provider, "stripe"),
          isNull(webhookEvents.delivery_payload),
        ),
      )
      .returning({ id: webhookEvents.id });
    if (adopted.length > 0) return;
    await this.tryCreate({
      event_id: eventId,
      provider: "stripe",
      event_type: payload.eventType,
      payload_hash: payloadHash,
      source_ip: "legacy-queue",
      delivery_payload: payload,
    });
  }

  /**
   * Leases up to `limit` due Stripe deliveries. Each claim counts as one attempt,
   * so a run that dies mid-handler still spends its budget. Concurrent drains
   * skip each other's locked rows and an unexpired lease, so no row is claimed
   * twice; an expired lease is claimed again.
   */
  async claimDueStripeDeliveries(limit: number, leaseMs: number): Promise<ClaimedStripeDelivery[]> {
    return writeTransaction(async (tx) => {
      const due = await tx
        .select({ id: webhookEvents.id })
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.provider, "stripe"),
            pendingStripeDelivery,
            lte(webhookEvents.delivery_next_attempt_at, sql`clock_timestamp()`),
            or(
              isNull(webhookEvents.delivery_lease_expires_at),
              lte(webhookEvents.delivery_lease_expires_at, sql`clock_timestamp()`),
            ),
          ),
        )
        .orderBy(asc(webhookEvents.delivery_next_attempt_at))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (due.length === 0) return [];
      const leaseToken = randomUUID();
      const claimed = await tx
        .update(webhookEvents)
        .set({
          delivery_attempts: sql`${webhookEvents.delivery_attempts} + 1`,
          delivery_lease_token: leaseToken,
          delivery_lease_expires_at: sql`clock_timestamp() + make_interval(secs => ${leaseMs / 1000})`,
        })
        .where(
          inArray(
            webhookEvents.id,
            due.map((row) => row.id),
          ),
        )
        .returning();
      return claimed
        .filter((row): row is WebhookEvent & { delivery_payload: StripeEventMessage } =>
          Boolean(row.delivery_payload),
        )
        .map((row) => ({
          id: row.id,
          eventId: row.event_id,
          leaseToken,
          attempts: row.delivery_attempts,
          payload: row.delivery_payload,
        }));
    });
  }

  /** Settles a claimed delivery; false when its lease was lost to another drain. */
  private async settleStripeDelivery(
    delivery: ClaimedStripeDelivery,
    values: PgUpdateSetSource<typeof webhookEvents>,
  ): Promise<boolean> {
    const settled = await dbWrite
      .update(webhookEvents)
      .set({ ...values, delivery_lease_token: null, delivery_lease_expires_at: null })
      .where(
        and(
          eq(webhookEvents.id, delivery.id),
          eq(webhookEvents.delivery_lease_token, delivery.leaseToken),
          pendingStripeDelivery,
        ),
      )
      .returning({ id: webhookEvents.id });
    return settled.length > 0;
  }

  completeStripeDelivery(delivery: ClaimedStripeDelivery): Promise<boolean> {
    return this.settleStripeDelivery(delivery, {
      delivery_completed_at: sql`clock_timestamp()`,
    });
  }

  retryStripeDelivery(delivery: ClaimedStripeDelivery, delayMs: number): Promise<boolean> {
    return this.settleStripeDelivery(delivery, {
      delivery_next_attempt_at: sql`clock_timestamp() + make_interval(secs => ${delayMs / 1000})`,
    });
  }

  deadLetterStripeDelivery(delivery: ClaimedStripeDelivery): Promise<boolean> {
    return this.settleStripeDelivery(delivery, {
      delivery_dead_lettered_at: sql`clock_timestamp()`,
    });
  }

  /** Releases claimed deliveries a drain did not reach, so the next drain need not wait for the lease. */
  async releaseStripeDeliveries(deliveries: ClaimedStripeDelivery[]): Promise<void> {
    for (const delivery of deliveries)
      await dbWrite
        .update(webhookEvents)
        .set({
          delivery_attempts: sql`${webhookEvents.delivery_attempts} - 1`,
          delivery_lease_token: null,
          delivery_lease_expires_at: null,
        })
        .where(
          and(
            eq(webhookEvents.id, delivery.id),
            eq(webhookEvents.delivery_lease_token, delivery.leaseToken),
          ),
        );
  }

  /**
   * Delete a single webhook event's dedup marker by event id. Used to roll the
   * marker back when the durable enqueue fails AFTER tryCreate committed, so the
   * provider's retry re-processes the event instead of hitting `created:false`
   * and silently dropping a paid event.
   */
  async deleteByEventId(eventId: string, provider: string): Promise<void> {
    await dbWrite
      .delete(webhookEvents)
      .where(and(eq(webhookEvents.event_id, eventId), eq(webhookEvents.provider, provider)));
  }

  /**
   * Delete old webhook events to prevent table growth.
   * Keeps events from the last `retentionDays` days.
   */
  async cleanupOldEvents(retentionDays = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await dbWrite
      .delete(webhookEvents)
      .where(and(lt(webhookEvents.processed_at, cutoffDate), expirable))
      .returning();

    return result.length;
  }

  /**
   * Delete old webhook events for a specific provider.
   */
  async cleanupOldEventsForProvider(provider: string, retentionDays = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await dbWrite
      .delete(webhookEvents)
      .where(
        and(
          eq(webhookEvents.provider, provider),
          lt(webhookEvents.processed_at, cutoffDate),
          expirable,
        ),
      )
      .returning();

    return result.length;
  }
}

export const webhookEventsRepository = new WebhookEventsRepository();
