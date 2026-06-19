/**
 * Calendar Drizzle schema.
 *
 * The calendar tables (`life_calendar_events`, `life_calendar_sync_states`)
 * were carved out of `@elizaos/plugin-personal-assistant`'s `app_lifeops`
 * schema into `app_calendar`, owned by this plugin. Table + column names are
 * preserved verbatim so the non-destructive `CalendarMigrationService` can copy
 * existing `app_lifeops` rows across on first boot. Do not rename the tables or
 * columns without updating that migration.
 *
 * Raw SQL in this package must qualify table names with the `app_calendar.`
 * prefix; the bare `life_*` names do not resolve in the default search path.
 */

import { boolean, pgSchema, text, unique } from "drizzle-orm/pg-core";

export const calendarPgSchema = pgSchema("app_calendar");

export const calendarEvents = calendarPgSchema.table(
  "life_calendar_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    calendarId: text("calendar_id").notNull(),
    externalEventId: text("external_event_id").notNull(),
    connectorAccountId: text("connector_account_id"),
    purgeResyncRequired: boolean("purge_resync_required")
      .notNull()
      .default(false),
    purgeResyncReason: text("purge_resync_reason"),
    grantId: text("grant_id"),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    location: text("location").notNull().default(""),
    status: text("status").notNull().default(""),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    isAllDay: boolean("is_all_day").notNull().default(false),
    timezone: text("timezone"),
    htmlLink: text("html_link"),
    conferenceLink: text("conference_link"),
    organizerJson: text("organizer_json"),
    attendeesJson: text("attendees_json").notNull().default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.provider, t.side, t.calendarId, t.externalEventId),
  ],
);

export const calendarSyncStates = calendarPgSchema.table(
  "life_calendar_sync_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    calendarId: text("calendar_id").notNull(),
    connectorAccountId: text("connector_account_id"),
    grantId: text("grant_id"),
    purgeResyncRequired: boolean("purge_resync_required")
      .notNull()
      .default(false),
    purgeResyncReason: text("purge_resync_reason"),
    windowStartAt: text("window_start_at").notNull(),
    windowEndAt: text("window_end_at").notNull(),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.provider, t.side, t.calendarId)],
);

export const calendarSchema = {
  calendarEvents,
  calendarSyncStates,
};
