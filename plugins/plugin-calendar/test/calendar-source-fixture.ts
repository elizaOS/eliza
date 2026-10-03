/** Complete source-health fixture for tests using the real availability evaluator. */
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSummary,
} from "@elizaos/core/contracts/calendar";
export function freshCalendarSources(
  events: readonly LifeOpsCalendarEvent[] = [],
): LifeOpsCalendarSourceHealth[] {
  const identities = events.length
    ? events
    : [
        {
          provider: "eliza",
          side: "owner",
          grantId: "eliza-calendar",
          connectorAccountId: "eliza-calendar",
          calendarId: "primary",
        },
      ];
  const sources = new Map<string, LifeOpsCalendarSourceHealth>();
  for (const event of identities) {
    const key = {
      provider: event.provider,
      side: event.side,
      grantId: event.grantId ?? "fixture-grant",
      connectorAccountId: event.connectorAccountId ?? "fixture-account",
      calendarId: event.calendarId,
    };
    sources.set(JSON.stringify(key), {
      key,
      summary: "Fixture calendar",
      accessRole: "owner",
      visibility: "details",
      status: "fresh",
      syncedAt: "2026-01-01T00:00:00.000Z",
      error: null,
    } as LifeOpsCalendarSourceHealth);
  }
  return [...sources.values()];
}

/** Calendar discovery uses the same declared destinations as source health. */
export function calendarSummariesForEvents(
  events: readonly LifeOpsCalendarEvent[] = [],
): LifeOpsCalendarSummary[] {
  return freshCalendarSources(events).map(({ key, summary, accessRole }) => ({
    ...key,
    summary,
    accessRole,
    accountEmail:
      events.find((event) => event.grantId === key.grantId)?.accountEmail ??
      null,
    description: null,
    primary: true,
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "UTC",
    selected: true,
    includeInFeed: true,
    selectionVersion: 1,
  }));
}
