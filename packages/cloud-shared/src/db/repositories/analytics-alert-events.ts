import { and, desc, eq, gte } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type AnalyticsAlertEvent,
  analyticsAlertEvents,
  type NewAnalyticsAlertEvent,
} from "../schemas/analytics-alert-events";

export type { AnalyticsAlertEvent, NewAnalyticsAlertEvent };

export class AnalyticsAlertEventsRepository {
  async createManyDeduped(events: NewAnalyticsAlertEvent[]): Promise<AnalyticsAlertEvent[]> {
    if (events.length === 0) return [];

    const created = await dbWrite
      .insert(analyticsAlertEvents)
      .values(events)
      .onConflictDoNothing({
        target: [analyticsAlertEvents.organization_id, analyticsAlertEvents.dedupe_key],
      })
      .returning();

    const missingCount = events.length - created.length;
    if (missingCount <= 0) return created;

    const existing = await Promise.all(
      events.map((event) =>
        this.findByOrganizationAndDedupeKey(event.organization_id, event.dedupe_key),
      ),
    );
    return [...created, ...existing.filter((event): event is AnalyticsAlertEvent => !!event)];
  }

  async findByOrganizationAndDedupeKey(
    organizationId: string,
    dedupeKey: string,
  ): Promise<AnalyticsAlertEvent | undefined> {
    return await dbRead.query.analyticsAlertEvents.findFirst({
      where: and(
        eq(analyticsAlertEvents.organization_id, organizationId),
        eq(analyticsAlertEvents.dedupe_key, dedupeKey),
      ),
    });
  }

  async listRecentByOrganization(
    organizationId: string,
    options: { since?: Date; limit?: number } = {},
  ): Promise<AnalyticsAlertEvent[]> {
    const conditions = [eq(analyticsAlertEvents.organization_id, organizationId)];
    if (options.since) conditions.push(gte(analyticsAlertEvents.created_at, options.since));

    return await dbRead.query.analyticsAlertEvents.findMany({
      where: and(...conditions),
      orderBy: desc(analyticsAlertEvents.created_at),
      limit: Math.min(Math.max(options.limit ?? 50, 1), 500),
    });
  }
}

export const analyticsAlertEventsRepository = new AnalyticsAlertEventsRepository();
