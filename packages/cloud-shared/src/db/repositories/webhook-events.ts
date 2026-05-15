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
    try {
      const [event] = await dbWrite
        .insert(webhookEvents)
        .values({
          ...data,
          processed_at: new Date(),
        })
        .onConflictDoNothing({ target: webhookEvents.event_id })
        .returning();

      // If no row returned, it means conflict (duplicate)
      if (!event) {
        return { created: false };
      }

      return { created: true, event };
    } catch {
      // Fallback for databases that don't support onConflictDoNothing well
      // or if there's a race condition with unique constraint
      return { created: false };
    }
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
