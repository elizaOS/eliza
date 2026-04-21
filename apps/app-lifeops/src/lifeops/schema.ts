/**
 * LifeOps Drizzle schema.
 *
 * Tables are created and migrated via the elizaOS plugin-migration system
 * when the plugin's `schema` field is populated. Indexes are intentionally
 * NOT declared here — the runtime migrator does not emit `CREATE INDEX IF
 * NOT EXISTS`, which would collide with pre-existing production databases
 * that already received indexes from the prior manual DDL path.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Wave 1+ additions — relationships, X read, screen time, scheduling,
// dossier. All life_* prefix, text IDs, ISO timestamps.
//
// TODO(schema-isolation): plugin-sql warns these tables sit in the `public`
// schema. Moving them to `pgSchema("app_lifeops")` requires a coordinated
// migration — the same tables are also created and queried via raw SQL in
// `repository.ts` (bootstrapSchema + 50+ queries). Do that in one atomic
// pass or the app will split-brain between `app_lifeops.*` and `public.*`.
// ---------------------------------------------------------------------------

export const lifeRelationships = pgTable(
  "life_relationships",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    primaryChannel: text("primary_channel").notNull(),
    primaryHandle: text("primary_handle").notNull(),
    email: text("email"),
    phone: text("phone"),
    notes: text("notes").notNull().default(""),
    tagsJson: text("tags_json").notNull().default("[]"),
    relationshipType: text("relationship_type").notNull(),
    lastContactedAt: text("last_contacted_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.primaryChannel, t.primaryHandle)],
);

export const lifeRelationshipInteractions = pgTable(
  "life_relationship_interactions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    relationshipId: text("relationship_id").notNull(),
    channel: text("channel").notNull(),
    direction: text("direction").notNull(),
    summary: text("summary").notNull(),
    occurredAt: text("occurred_at").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
);

export const lifeFollowUps = pgTable("life_follow_ups", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  relationshipId: text("relationship_id").notNull(),
  dueAt: text("due_at").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull(),
  priority: integer("priority").notNull().default(3),
  draftJson: text("draft_json"),
  completedAt: text("completed_at"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const lifeXDms = pgTable(
  "life_x_dms",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    externalDmId: text("external_dm_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    senderHandle: text("sender_handle").notNull(),
    senderId: text("sender_id").notNull(),
    isInbound: boolean("is_inbound").notNull(),
    text: text("text").notNull(),
    receivedAt: text("received_at").notNull(),
    readAt: text("read_at"),
    repliedAt: text("replied_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.externalDmId)],
);

export const lifeXFeedItems = pgTable(
  "life_x_feed_items",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    externalTweetId: text("external_tweet_id").notNull(),
    authorHandle: text("author_handle").notNull(),
    authorId: text("author_id").notNull(),
    text: text("text").notNull(),
    createdAtSource: text("created_at_source").notNull(),
    feedType: text("feed_type").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.externalTweetId, t.feedType)],
);

export const lifeXSyncStates = pgTable(
  "life_x_sync_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    feedType: text("feed_type").notNull(),
    lastCursor: text("last_cursor"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.feedType)],
);

export const lifeScreenTimeSessions = pgTable("life_screen_time_sessions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  source: text("source").notNull(),
  identifier: text("identifier").notNull(),
  displayName: text("display_name").notNull(),
  startAt: text("start_at").notNull(),
  endAt: text("end_at"),
  durationSeconds: integer("duration_seconds").notNull().default(0),
  isActive: boolean("is_active").notNull().default(false),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const lifeScreenTimeDaily = pgTable(
  "life_screen_time_daily",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    source: text("source").notNull(),
    identifier: text("identifier").notNull(),
    date: text("date").notNull(),
    totalSeconds: integer("total_seconds").notNull().default(0),
    sessionCount: integer("session_count").notNull().default(0),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.source, t.identifier, t.date)],
);

export const lifeScheduleInsights = pgTable(
  "life_schedule_insights",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    effectiveDayKey: text("effective_day_key").notNull(),
    localDate: text("local_date").notNull(),
    timezone: text("timezone").notNull(),
    inferredAt: text("inferred_at").notNull(),
    phase: text("phase").notNull(),
    sleepStatus: text("sleep_status").notNull(),
    isProbablySleeping: boolean("is_probably_sleeping").notNull().default(false),
    sleepConfidence: real("sleep_confidence").notNull().default(0),
    currentSleepStartedAt: text("current_sleep_started_at"),
    lastSleepStartedAt: text("last_sleep_started_at"),
    lastSleepEndedAt: text("last_sleep_ended_at"),
    lastSleepDurationMinutes: integer("last_sleep_duration_minutes"),
    typicalWakeHour: real("typical_wake_hour"),
    typicalSleepHour: real("typical_sleep_hour"),
    wakeAt: text("wake_at"),
    firstActiveAt: text("first_active_at"),
    lastActiveAt: text("last_active_at"),
    lastMealAt: text("last_meal_at"),
    nextMealLabel: text("next_meal_label"),
    nextMealWindowStartAt: text("next_meal_window_start_at"),
    nextMealWindowEndAt: text("next_meal_window_end_at"),
    nextMealConfidence: real("next_meal_confidence").notNull().default(0),
    mealsJson: text("meals_json").notNull().default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.effectiveDayKey)],
);

export const lifeScheduleObservations = pgTable("life_schedule_observations", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  origin: text("origin").notNull(),
  deviceId: text("device_id").notNull(),
  deviceKind: text("device_kind").notNull(),
  timezone: text("timezone").notNull(),
  observedAt: text("observed_at").notNull(),
  windowStartAt: text("window_start_at").notNull(),
  windowEndAt: text("window_end_at"),
  state: text("state").notNull(),
  phase: text("phase"),
  mealLabel: text("meal_label"),
  confidence: real("confidence").notNull().default(0),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const lifeScheduleMergedStates = pgTable(
  "life_schedule_merged_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    scope: text("scope").notNull(),
    effectiveDayKey: text("effective_day_key").notNull(),
    localDate: text("local_date").notNull(),
    timezone: text("timezone").notNull(),
    mergedAt: text("merged_at").notNull(),
    inferredAt: text("inferred_at").notNull(),
    phase: text("phase").notNull(),
    sleepStatus: text("sleep_status").notNull(),
    isProbablySleeping: boolean("is_probably_sleeping").notNull().default(false),
    sleepConfidence: real("sleep_confidence").notNull().default(0),
    currentSleepStartedAt: text("current_sleep_started_at"),
    lastSleepStartedAt: text("last_sleep_started_at"),
    lastSleepEndedAt: text("last_sleep_ended_at"),
    lastSleepDurationMinutes: integer("last_sleep_duration_minutes"),
    typicalWakeHour: real("typical_wake_hour"),
    typicalSleepHour: real("typical_sleep_hour"),
    wakeAt: text("wake_at"),
    firstActiveAt: text("first_active_at"),
    lastActiveAt: text("last_active_at"),
    lastMealAt: text("last_meal_at"),
    nextMealLabel: text("next_meal_label"),
    nextMealWindowStartAt: text("next_meal_window_start_at"),
    nextMealWindowEndAt: text("next_meal_window_end_at"),
    nextMealConfidence: real("next_meal_confidence").notNull().default(0),
    mealsJson: text("meals_json").notNull().default("[]"),
    observationCount: integer("observation_count").notNull().default(0),
    deviceCount: integer("device_count").notNull().default(0),
    contributingDeviceKindsJson: text("contributing_device_kinds_json")
      .notNull()
      .default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.scope, t.timezone)],
);

export const lifeSchedulingNegotiations = pgTable(
  "life_scheduling_negotiations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    relationshipId: text("relationship_id"),
    subject: text("subject").notNull(),
    state: text("state").notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    timezone: text("timezone").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    startedAt: text("started_at").notNull(),
    finalizedAt: text("finalized_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const lifeSchedulingProposals = pgTable("life_scheduling_proposals", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  negotiationId: text("negotiation_id").notNull(),
  startAt: text("start_at").notNull(),
  endAt: text("end_at").notNull(),
  status: text("status").notNull(),
  proposedBy: text("proposed_by").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// T8d — Activity tracker (WakaTime-like).
// Append-only per-event log produced by the macOS Swift collector.
export const lifeActivityEvents = pgTable("life_activity_events", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  observedAt: text("observed_at").notNull(),
  eventKind: text("event_kind").notNull(),
  bundleId: text("bundle_id").notNull(),
  appName: text("app_name").notNull(),
  windowTitle: text("window_title"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});

export const lifeDossiers = pgTable("life_dossiers", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  calendarEventId: text("calendar_event_id"),
  subject: text("subject").notNull(),
  generatedForAt: text("generated_for_at").notNull(),
  contentMd: text("content_md").notNull(),
  sourcesJson: text("sources_json").notNull().default("[]"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// T7g — Website blocker chat integration (plan §6.8).
// Stores block rules whose lifecycle is driven by todo completion, fixed
// duration, or an explicit ISO target. The reconciler releases rules when
// their gate is fulfilled; harsh_no_bypass rules can only be released by the
// reconciler on gate fulfillment (never by the user).
export const lifeBlockRules = pgTable("life_block_rules", {
  id: uuid("id").primaryKey(),
  agentId: uuid("agent_id").notNull(),
  profile: text("profile").notNull(),
  websites: jsonb("websites").notNull(),
  gateType: text("gate_type").notNull(),
  gateTodoId: text("gate_todo_id"),
  gateUntilMs: bigint("gate_until_ms", { mode: "number" }),
  fixedDurationMs: bigint("fixed_duration_ms", { mode: "number" }),
  unlockDurationMs: bigint("unlock_duration_ms", { mode: "number" }),
  active: boolean("active").default(true),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  releasedAt: bigint("released_at", { mode: "number" }),
  releasedReason: text("released_reason"),
});

export const lifeopsFeaturesTable = pgTable("lifeops_features", {
  featureKey: text("feature_key").primaryKey(),
  enabled: boolean("enabled").notNull(),
  source: text("source").notNull(),
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  enabledBy: uuid("enabled_by"),
  metadata: jsonb("metadata")
    .$type<Record<string, unknown>>()
    .default(sql`'{}'::jsonb`)
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

// ---------------------------------------------------------------------------
// Aggregate export for plugin schema property
// ---------------------------------------------------------------------------

export const lifeOpsSchema = {
  lifeRelationships,
  lifeRelationshipInteractions,
  lifeFollowUps,
  lifeXDms,
  lifeXFeedItems,
  lifeXSyncStates,
  lifeScreenTimeSessions,
  lifeScreenTimeDaily,
  lifeScheduleInsights,
  lifeScheduleObservations,
  lifeScheduleMergedStates,
  lifeActivityEvents,
  lifeSchedulingNegotiations,
  lifeSchedulingProposals,
  lifeDossiers,
  lifeBlockRules,
  lifeopsFeaturesTable,
} as const;
