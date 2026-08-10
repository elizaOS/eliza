/** Seeds the durable read-only Google Calendar cache used by MCP-era PA tests. */
import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import {
  createLifeOpsCalendarSyncState,
  LifeOpsRepository,
} from "../../../src/lifeops/repository.ts";
import { seedGoogleConnectorGrant } from "./seed-grants.ts";

export interface DurableGoogleCalendarEventSeed {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  description?: string;
  location?: string;
  timezone?: string;
}

export async function seedDurableGoogleCalendar(args: {
  runtime: IAgentRuntime;
  grantId: string;
  events: readonly DurableGoogleCalendarEventSeed[];
}): Promise<LifeOpsRepository> {
  if (args.events.length === 0) {
    throw new Error("seedDurableGoogleCalendar requires at least one event");
  }

  await seedGoogleConnectorGrant(args.runtime, {
    capabilities: ["google.calendar.read"],
    grantId: args.grantId,
  });

  const repository = new LifeOpsRepository(args.runtime);
  const nowIso = new Date().toISOString();
  const agentId = String(args.runtime.agentId);
  const events: LifeOpsCalendarEvent[] = args.events.map((event) => ({
    id: event.id,
    externalId: `${event.id}-external`,
    agentId,
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: event.title,
    description: event.description ?? "",
    location: event.location ?? "",
    status: "confirmed",
    startAt: event.startAt,
    endAt: event.endAt,
    isAllDay: false,
    timezone: event.timezone ?? "America/New_York",
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    connectorAccountId: args.grantId,
    grantId: args.grantId,
    metadata: { fixture: "durable-google-calendar" },
    syncedAt: nowIso,
    updatedAt: nowIso,
  }));

  for (const event of events) {
    await repository.upsertCalendarEvent(event);
  }

  const startMillis = Math.min(
    ...events.map((event) => Date.parse(event.startAt)),
  );
  const endMillis = Math.max(...events.map((event) => Date.parse(event.endAt)));
  await repository.upsertCalendarSyncState(
    createLifeOpsCalendarSyncState({
      agentId,
      provider: "google",
      side: "owner",
      calendarId: "primary",
      connectorAccountId: args.grantId,
      grantId: args.grantId,
      windowStartAt: new Date(startMillis - 24 * 60 * 60_000).toISOString(),
      windowEndAt: new Date(endMillis + 24 * 60 * 60_000).toISOString(),
      syncedAt: nowIso,
    }),
  );

  return repository;
}
