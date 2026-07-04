// Persists webhook events records for cloud services through the shared DB boundary.
import { and, eq, lt } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { type NewWebhookEvent, type WebhookEvent, webhookEvents } from "../schemas/webhook-events";

export type { NewWebhookEvent, WebhookEvent };

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
      .where(lt(webhookEvents.processed_at, cutoffDate))
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
      .where(and(eq(webhookEvents.provider, provider), lt(webhookEvents.processed_at, cutoffDate)))
      .returning();

    return result.length;
  }
}

export const webhookEventsRepository = new WebhookEventsRepository();
