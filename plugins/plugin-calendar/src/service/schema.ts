/**
 * Calendar Drizzle schema.
 *
 * The calendar tables continue to live in the `app_lifeops` PostgreSQL schema
 * with their original table and column names (`life_calendar_events`,
 * `life_calendar_sync_states`) so rows written while the calendar domain was
 * part of `@elizaos/plugin-lifeops` remain valid after extraction. Do not
 * rename the schema, tables, or columns without a data migration.
 *
 * Raw SQL in this package must qualify table names with the `app_lifeops.`
 * prefix; the bare `life_*` names do not resolve in the default search path.
 */

import { boolean, pgSchema, text, unique } from "drizzle-orm/pg-core";

export const appLifeopsPgSchema = pgSchema("app_lifeops");

export const calendarEvents = appLifeopsPgSchema.table(
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

export const calendarSyncStates = appLifeopsPgSchema.table(
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
