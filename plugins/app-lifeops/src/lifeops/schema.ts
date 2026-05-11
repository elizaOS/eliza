/**
 * LifeOps Drizzle schema.
 *
 * Tables are placed in the `app_lifeops` PostgreSQL schema (matches the
 * `deriveSchemaName("@elizaos/app-lifeops")` result used by plugin-sql's
 * runtime migrator) so they no longer trip the
 * "Plugin table is using public schema" warning. The runtime migrator
 * issues `CREATE SCHEMA IF NOT EXISTS` automatically before applying
 * migrations.
 *
 * Tables and indexes are created and migrated via the elizaOS
 * plugin-migration system when the plugin's `schema` field is populated.
 *
 * IMPORTANT: All raw SQL inside this plugin's `src/` must qualify table
 * names with the `app_lifeops.` prefix. The bare `life_*` and `lifeops_*`
 * names no longer resolve in the default search path.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const appLifeopsPgSchema = pgSchema("app_lifeops");

// ---------------------------------------------------------------------------
// Wave 1+ additions — relationships, X read, screen time, scheduling.
// All life_* prefix, text IDs, ISO timestamps.
// ---------------------------------------------------------------------------

export const lifeConnectorGrants = appLifeopsPgSchema.table(
  "life_connector_grants",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    connectorAccountId: text("connector_account_id"),
    side: text("side").notNull().default("owner"),
    identityJson: text("identity_json").notNull().default("{}"),
    identityEmail: text("identity_email"),
    grantedScopesJson: text("granted_scopes_json").notNull().default("[]"),
    capabilitiesJson: text("capabilities_json").notNull().default("[]"),
    tokenRef: text("token_ref"),
    mode: text("mode").notNull().default("oauth"),
    executionTarget: text("execution_target").notNull().default("local"),
    sourceOfTruth: text("source_of_truth").notNull().default("local_storage"),
    preferredByAgent: boolean("preferred_by_agent").notNull().default(false),
    cloudConnectionId: text("cloud_connection_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    lastRefreshAt: text("last_refresh_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.provider, t.side, t.mode, t.identityEmail)],
);

export const lifeAccountPrivacy = appLifeopsPgSchema.table(
  "life_account_privacy",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    connectorAccountId: text("connector_account_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    allowedDataClassesJson: text("allowed_data_classes_json")
      .notNull()
      .default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.provider, t.connectorAccountId),
    index("idx_life_account_privacy_agent").on(t.agentId, t.provider),
  ],
);

export const lifeTaskDefinitions = appLifeopsPgSchema.table(
  "life_task_definitions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    domain: text("domain").notNull().default("user_lifeops"),
    subjectType: text("subject_type").notNull().default("owner"),
    subjectId: text("subject_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    contextPolicy: text("context_policy").notNull().default("explicit_only"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    originalIntent: text("original_intent").notNull().default(""),
    timezone: text("timezone").notNull().default("UTC"),
    status: text("status").notNull().default("active"),
    priority: integer("priority").notNull().default(3),
    cadenceJson: text("cadence_json").notNull().default("{}"),
    windowPolicyJson: text("window_policy_json").notNull().default("{}"),
    progressionRuleJson: text("progression_rule_json").notNull().default("{}"),
    websiteAccessJson: text("website_access_json"),
    reminderPlanId: text("reminder_plan_id"),
    goalId: text("goal_id"),
    source: text("source").notNull().default("manual"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_task_definitions_agent_status").on(t.agentId, t.status),
    index("idx_life_task_definitions_subject").on(
      t.agentId,
      t.domain,
      t.subjectType,
      t.subjectId,
      t.status,
    ),
  ],
);

export const lifeTaskOccurrences = appLifeopsPgSchema.table(
  "life_task_occurrences",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    domain: text("domain").notNull().default("user_lifeops"),
    subjectType: text("subject_type").notNull().default("owner"),
    subjectId: text("subject_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    contextPolicy: text("context_policy").notNull().default("explicit_only"),
    definitionId: text("definition_id").notNull(),
    occurrenceKey: text("occurrence_key").notNull(),
    scheduledAt: text("scheduled_at"),
    dueAt: text("due_at"),
    relevanceStartAt: text("relevance_start_at").notNull(),
    relevanceEndAt: text("relevance_end_at").notNull(),
    windowName: text("window_name"),
    state: text("state").notNull().default("pending"),
    snoozedUntil: text("snoozed_until"),
    completionPayloadJson: text("completion_payload_json"),
    derivedTargetJson: text("derived_target_json"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.definitionId, t.occurrenceKey),
    index("idx_life_task_occurrences_agent_state_start").on(
      t.agentId,
      t.state,
      t.relevanceStartAt,
    ),
    index("idx_life_task_occurrences_subject").on(
      t.agentId,
      t.domain,
      t.subjectType,
      t.subjectId,
      t.state,
      t.relevanceStartAt,
    ),
    index("idx_life_task_occurrences_definition").on(
      t.definitionId,
      t.relevanceStartAt,
    ),
  ],
);

export const lifeGoalDefinitions = appLifeopsPgSchema.table(
  "life_goal_definitions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    domain: text("domain").notNull().default("user_lifeops"),
    subjectType: text("subject_type").notNull().default("owner"),
    subjectId: text("subject_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    contextPolicy: text("context_policy").notNull().default("explicit_only"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    cadenceJson: text("cadence_json"),
    supportStrategyJson: text("support_strategy_json").notNull().default("{}"),
    successCriteriaJson: text("success_criteria_json").notNull().default("{}"),
    status: text("status").notNull().default("active"),
    reviewState: text("review_state").notNull().default("pending"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_goal_definitions_agent_status").on(t.agentId, t.status),
    index("idx_life_goal_definitions_subject").on(
      t.agentId,
      t.domain,
      t.subjectType,
      t.subjectId,
      t.status,
    ),
  ],
);

export const lifeGoalLinks = appLifeopsPgSchema.table(
  "life_goal_links",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    goalId: text("goal_id").notNull(),
    linkedType: text("linked_type").notNull(),
    linkedId: text("linked_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.goalId, t.linkedType, t.linkedId),
    index("idx_life_goal_links_goal").on(t.goalId),
    index("idx_life_goal_links_linked").on(t.linkedType, t.linkedId),
  ],
);

export const lifeReminderPlans = appLifeopsPgSchema.table(
  "life_reminder_plans",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    stepsJson: text("steps_json").notNull().default("[]"),
    mutePolicyJson: text("mute_policy_json").notNull().default("{}"),
    quietHoursJson: text("quiet_hours_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_reminder_plans_owner").on(
      t.agentId,
      t.ownerType,
      t.ownerId,
    ),
  ],
);

export const lifeReminderAttempts = appLifeopsPgSchema.table(
  "life_reminder_attempts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    planId: text("plan_id").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    occurrenceId: text("occurrence_id"),
    channel: text("channel").notNull(),
    stepIndex: integer("step_index").notNull().default(0),
    scheduledFor: text("scheduled_for").notNull(),
    attemptedAt: text("attempted_at"),
    outcome: text("outcome").notNull().default("pending"),
    connectorRef: text("connector_ref"),
    deliveryMetadataJson: text("delivery_metadata_json")
      .notNull()
      .default("{}"),
    reviewAt: text("review_at"),
    reviewStatus: text("review_status"),
    reviewClaimedAt: text("review_claimed_at"),
    reviewClaimedBy: text("review_claimed_by"),
    reviewAttemptCount: integer("review_attempt_count").notNull().default(0),
    reviewNextRetryAt: text("review_next_retry_at"),
    reviewLastError: text("review_last_error"),
  },
  (t) => [
    index("idx_life_reminder_attempts_plan").on(
      t.planId,
      t.ownerType,
      t.ownerId,
    ),
    index("idx_life_reminder_attempts_review_scan").on(
      t.agentId,
      t.outcome,
      t.reviewStatus,
      t.reviewAt,
    ),
  ],
);

export const lifeAuditEvents = appLifeopsPgSchema.table(
  "life_audit_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    eventType: text("event_type").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    reason: text("reason").notNull().default(""),
    inputsJson: text("inputs_json").notNull().default("{}"),
    decisionJson: text("decision_json").notNull().default("{}"),
    actor: text("actor").notNull().default("agent"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_life_audit_events_owner").on(
      t.agentId,
      t.ownerType,
      t.ownerId,
      t.createdAt,
    ),
  ],
);

export const lifeSubscriptionAudits = appLifeopsPgSchema.table("life_subscription_audits", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  source: text("source").notNull().default("gmail"),
  queryWindowDays: integer("query_window_days").notNull().default(180),
  status: text("status").notNull().default("completed"),
  totalCandidates: integer("total_candidates").notNull().default(0),
  activeCandidates: integer("active_candidates").notNull().default(0),
  canceledCandidates: integer("canceled_candidates").notNull().default(0),
  uncertainCandidates: integer("uncertain_candidates").notNull().default(0),
  summary: text("summary").notNull().default(""),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const lifeSubscriptionCandidates = appLifeopsPgSchema.table(
  "life_subscription_candidates",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    auditId: text("audit_id").notNull(),
    serviceSlug: text("service_slug").notNull(),
    serviceName: text("service_name").notNull(),
    provider: text("provider").notNull().default("unknown"),
    cadence: text("cadence").notNull().default("unknown"),
    state: text("state").notNull().default("uncertain"),
    confidence: real("confidence").notNull().default(0),
    annualCostEstimateUsd: real("annual_cost_estimate_usd"),
    managementUrl: text("management_url"),
    latestEvidenceAt: text("latest_evidence_at"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.auditId, t.serviceSlug)],
);

export const lifeSubscriptionCancellations = appLifeopsPgSchema.table(
  "life_subscription_cancellations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    auditId: text("audit_id"),
    candidateId: text("candidate_id"),
    serviceSlug: text("service_slug").notNull(),
    serviceName: text("service_name").notNull(),
    executor: text("executor").notNull().default("agent_browser"),
    status: text("status").notNull().default("draft"),
    confirmed: boolean("confirmed").notNull().default(false),
    currentStep: text("current_step"),
    browserSessionId: text("browser_session_id"),
    evidenceSummary: text("evidence_summary"),
    artifactCount: integer("artifact_count").notNull().default(0),
    managementUrl: text("management_url"),
    error: text("error"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
);

export const lifeEmailUnsubscribes = appLifeopsPgSchema.table("life_email_unsubscribes", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  senderEmail: text("sender_email").notNull(),
  senderDisplay: text("sender_display").notNull().default(""),
  senderDomain: text("sender_domain"),
  listId: text("list_id"),
  method: text("method").notNull().default("manual_only"),
  status: text("status").notNull().default("failed"),
  httpStatusCode: integer("http_status_code"),
  httpFinalUrl: text("http_final_url"),
  filterCreated: boolean("filter_created").notNull().default(false),
  filterId: text("filter_id"),
  threadsTrashed: integer("threads_trashed").notNull().default(0),
  errorMessage: text("error_message"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const lifePaymentSources = appLifeopsPgSchema.table("life_payment_sources", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  kind: text("kind").notNull().default("manual"),
  label: text("label").notNull().default(""),
  institution: text("institution"),
  accountMask: text("account_mask"),
  status: text("status").notNull().default("active"),
  lastSyncedAt: text("last_synced_at"),
  transactionCount: integer("transaction_count").notNull().default(0),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const lifePaymentTransactions = appLifeopsPgSchema.table(
  "life_payment_transactions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    sourceId: text("source_id").notNull(),
    externalId: text("external_id"),
    postedAt: text("posted_at").notNull(),
    amountUsd: real("amount_usd").notNull().default(0),
    direction: text("direction").notNull().default("debit"),
    merchantRaw: text("merchant_raw").notNull().default(""),
    merchantNormalized: text("merchant_normalized").notNull().default(""),
    description: text("description"),
    category: text("category"),
    currency: text("currency").notNull().default("USD"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique().on(
      t.agentId,
      t.sourceId,
      t.postedAt,
      t.amountUsd,
      t.merchantNormalized,
    ),
  ],
);

export const lifeActivitySignals = appLifeopsPgSchema.table(
  "life_activity_signals",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    source: text("source").notNull(),
    platform: text("platform").notNull().default(""),
    state: text("state").notNull(),
    observedAt: text("observed_at").notNull(),
    idleState: text("idle_state"),
    idleTimeSeconds: integer("idle_time_seconds"),
    onBattery: boolean("on_battery"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_life_activity_signals_agent").on(t.agentId, t.observedAt)],
);

export const lifeHealthMetricSamples = appLifeopsPgSchema.table(
  "life_health_metric_samples",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    grantId: text("grant_id").notNull(),
    metric: text("metric").notNull(),
    value: real("value").notNull(),
    unit: text("unit").notNull(),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    localDate: text("local_date").notNull(),
    sourceExternalId: text("source_external_id").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(
      t.agentId,
      t.provider,
      t.grantId,
      t.metric,
      t.startAt,
      t.sourceExternalId,
    ),
    index("idx_life_health_metric_samples_agent_date").on(
      t.agentId,
      t.provider,
      t.localDate,
    ),
  ],
);

export const lifeHealthWorkouts = appLifeopsPgSchema.table(
  "life_health_workouts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    grantId: text("grant_id").notNull(),
    sourceExternalId: text("source_external_id").notNull(),
    workoutType: text("workout_type").notNull(),
    title: text("title").notNull().default(""),
    startAt: text("start_at").notNull(),
    endAt: text("end_at"),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    distanceMeters: real("distance_meters"),
    calories: real("calories"),
    averageHeartRate: real("average_heart_rate"),
    maxHeartRate: real("max_heart_rate"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.provider, t.grantId, t.sourceExternalId),
    index("idx_life_health_workouts_agent_start").on(
      t.agentId,
      t.provider,
      t.startAt,
    ),
  ],
);

export const lifeHealthSyncStates = appLifeopsPgSchema.table(
  "life_health_sync_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    grantId: text("grant_id").notNull(),
    cursor: text("cursor"),
    lastSyncedAt: text("last_synced_at"),
    lastSyncStartedAt: text("last_sync_started_at"),
    lastSyncError: text("last_sync_error"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.provider, t.grantId)],
);

export const lifeHealthSleepEpisodes = appLifeopsPgSchema.table(
  "life_health_sleep_episodes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    grantId: text("grant_id").notNull(),
    sourceExternalId: text("source_external_id").notNull(),
    localDate: text("local_date").notNull(),
    timezone: text("timezone"),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    isMainSleep: boolean("is_main_sleep").notNull().default(false),
    sleepType: text("sleep_type"),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    timeInBedSeconds: integer("time_in_bed_seconds"),
    efficiency: real("efficiency"),
    latencySeconds: integer("latency_seconds"),
    awakeSeconds: integer("awake_seconds"),
    lightSleepSeconds: integer("light_sleep_seconds"),
    deepSleepSeconds: integer("deep_sleep_seconds"),
    remSleepSeconds: integer("rem_sleep_seconds"),
    sleepScore: real("sleep_score"),
    readinessScore: real("readiness_score"),
    averageHeartRate: real("average_heart_rate"),
    lowestHeartRate: real("lowest_heart_rate"),
    averageHrvMs: real("average_hrv_ms"),
    respiratoryRate: real("respiratory_rate"),
    bloodOxygenPercent: real("blood_oxygen_percent"),
    stageSamplesJson: text("stage_samples_json").notNull().default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.provider, t.grantId, t.sourceExternalId),
    index("idx_life_health_sleep_episodes_agent_date").on(
      t.agentId,
      t.provider,
      t.localDate,
    ),
  ],
);

export const lifeChannelPolicies = appLifeopsPgSchema.table(
  "life_channel_policies",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    channelType: text("channel_type").notNull(),
    channelRef: text("channel_ref").notNull(),
    privacyClass: text("privacy_class").notNull().default("private"),
    allowReminders: boolean("allow_reminders").notNull().default(true),
    allowEscalation: boolean("allow_escalation").notNull().default(false),
    allowPosts: boolean("allow_posts").notNull().default(false),
    requireConfirmationForActions: boolean("require_confirmation_for_actions")
      .notNull()
      .default(true),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.channelType, t.channelRef),
    index("idx_life_channel_policies_agent").on(t.agentId, t.channelType),
  ],
);

export const lifeWebsiteAccessGrants = appLifeopsPgSchema.table(
  "life_website_access_grants",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    groupKey: text("group_key").notNull(),
    definitionId: text("definition_id").notNull(),
    occurrenceId: text("occurrence_id"),
    websitesJson: text("websites_json").notNull().default("[]"),
    unlockMode: text("unlock_mode").notNull().default("fixed_duration"),
    unlockDurationMinutes: integer("unlock_duration_minutes"),
    callbackKey: text("callback_key"),
    unlockedAt: text("unlocked_at").notNull(),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_website_access_grants_group").on(
      t.agentId,
      t.groupKey,
      t.revokedAt,
      t.expiresAt,
    ),
  ],
);

export const lifeCalendarEvents = appLifeopsPgSchema.table(
  "life_calendar_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    calendarId: text("calendar_id").notNull(),
    externalEventId: text("external_event_id").notNull(),
    // New writes set connector_account_id from the owning account.
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

export const lifeCalendarSyncStates = appLifeopsPgSchema.table(
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

export const lifeGmailMessages = appLifeopsPgSchema.table(
  "life_gmail_messages",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    externalMessageId: text("external_message_id").notNull(),
    connectorAccountId: text("connector_account_id"),
    grantId: text("grant_id"),
    threadId: text("thread_id").notNull().default(""),
    subject: text("subject").notNull().default(""),
    fromDisplay: text("from_display").notNull().default(""),
    fromEmail: text("from_email"),
    replyTo: text("reply_to"),
    toJson: text("to_json").notNull().default("[]"),
    ccJson: text("cc_json").notNull().default("[]"),
    snippet: text("snippet").notNull().default(""),
    receivedAt: text("received_at").notNull(),
    isUnread: boolean("is_unread").notNull().default(true),
    isImportant: boolean("is_important").notNull().default(false),
    likelyReplyNeeded: boolean("likely_reply_needed").notNull().default(false),
    triageScore: integer("triage_score").notNull().default(0),
    triageReason: text("triage_reason").notNull().default(""),
    labelIdsJson: text("label_ids_json").notNull().default("[]"),
    htmlLink: text("html_link"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.provider, t.side, t.grantId, t.externalMessageId),
  ],
);

export const lifeInboxMessages = appLifeopsPgSchema.table(
  "life_inbox_messages",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    channel: text("channel").notNull(),
    externalId: text("external_id").notNull(),
    threadId: text("thread_id"),
    senderId: text("sender_id").notNull(),
    senderDisplay: text("sender_display").notNull(),
    senderEmail: text("sender_email"),
    subject: text("subject"),
    snippet: text("snippet").notNull().default(""),
    receivedAt: text("received_at").notNull(),
    isUnread: boolean("is_unread").notNull().default(true),
    deepLink: text("deep_link"),
    sourceRefJson: text("source_ref_json").notNull().default("{}"),
    chatType: text("chat_type").notNull().default("channel"),
    participantCount: integer("participant_count"),
    gmailAccountId: text("gmail_account_id"),
    gmailAccountEmail: text("gmail_account_email"),
    lastSeenAt: text("last_seen_at"),
    repliedAt: text("replied_at"),
    priorityScore: integer("priority_score"),
    priorityCategory: text("priority_category"),
    priorityFlagsJson: text("priority_flags_json").notNull().default("[]"),
    connectorAccountId: text("connector_account_id"),
    cachedAt: text("cached_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.channel, t.externalId),
    index("idx_life_inbox_messages_agent_received").on(t.agentId, t.receivedAt),
    index("idx_life_inbox_messages_agent_channel").on(t.agentId, t.channel),
  ],
);

export const lifeGmailSyncStates = appLifeopsPgSchema.table(
  "life_gmail_sync_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    mailbox: text("mailbox").notNull(),
    grantId: text("grant_id"),
    maxResults: integer("max_results").notNull().default(0),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.provider, t.side, t.grantId, t.mailbox)],
);

export const lifeGmailSpamReviewItems = appLifeopsPgSchema.table(
  "life_gmail_spam_review_items",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    grantId: text("grant_id").notNull(),
    accountEmail: text("account_email"),
    messageId: text("message_id").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    threadId: text("thread_id").notNull(),
    subject: text("subject").notNull().default(""),
    fromDisplay: text("from_display").notNull().default(""),
    fromEmail: text("from_email"),
    receivedAt: text("received_at").notNull(),
    snippet: text("snippet").notNull().default(""),
    labelIdsJson: text("label_ids_json").notNull().default("[]"),
    rationale: text("rationale").notNull().default(""),
    confidence: real("confidence").notNull().default(0),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    reviewedAt: text("reviewed_at"),
  },
  (t) => [
    unique().on(t.agentId, t.provider, t.side, t.grantId, t.externalMessageId),
    index("idx_life_gmail_spam_review_status").on(
      t.agentId,
      t.status,
      t.updatedAt,
    ),
  ],
);

export const lifeWorkflowDefinitions = appLifeopsPgSchema.table(
  "life_workflow_definitions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    domain: text("domain").notNull().default("user_lifeops"),
    subjectType: text("subject_type").notNull().default("owner"),
    subjectId: text("subject_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    contextPolicy: text("context_policy").notNull().default("explicit_only"),
    title: text("title").notNull(),
    triggerType: text("trigger_type").notNull(),
    scheduleJson: text("schedule_json").notNull().default("{}"),
    actionPlanJson: text("action_plan_json").notNull().default("{}"),
    permissionPolicyJson: text("permission_policy_json")
      .notNull()
      .default("{}"),
    status: text("status").notNull().default("active"),
    createdBy: text("created_by").notNull().default("agent"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_workflow_definitions_agent").on(
      t.agentId,
      t.status,
      t.updatedAt,
    ),
    index("idx_life_workflow_definitions_subject").on(
      t.agentId,
      t.domain,
      t.subjectType,
      t.subjectId,
      t.status,
      t.updatedAt,
    ),
  ],
);

export const lifeWorkflowRuns = appLifeopsPgSchema.table(
  "life_workflow_runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    status: text("status").notNull().default("running"),
    resultJson: text("result_json").notNull().default("{}"),
    auditRef: text("audit_ref"),
  },
  (t) => [
    index("idx_life_workflow_runs_workflow").on(
      t.agentId,
      t.workflowId,
      t.startedAt,
    ),
  ],
);

// Workflow-bound browser session table. The 4 generic browser tables
// (companions, settings, tabs, page_contexts) moved to
// `@elizaos/plugin-browser/schema`. Only `life_workflow_browser_sessions`
// stays here because it carries `workflowId` plus LifeOps scoping columns.
// The `companionId` column is a soft FK to
// `browser_bridge_companions.id` (no hard constraint so the plugin package
// remains the schema owner of that table).
export const lifeWorkflowBrowserSessions = appLifeopsPgSchema.table(
  "life_workflow_browser_sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    domain: text("domain").notNull().default("user_lifeops"),
    subjectType: text("subject_type").notNull().default("owner"),
    subjectId: text("subject_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    contextPolicy: text("context_policy").notNull().default("explicit_only"),
    workflowId: text("workflow_id"),
    browser: text("browser"),
    companionId: text("companion_id"),
    profileId: text("profile_id"),
    windowId: text("window_id"),
    tabId: text("tab_id"),
    title: text("title").notNull().default(""),
    status: text("status").notNull().default("pending"),
    actionsJson: text("actions_json").notNull().default("[]"),
    currentActionIndex: integer("current_action_index").notNull().default(0),
    awaitingConfirmationForActionId: text(
      "awaiting_confirmation_for_action_id",
    ),
    resultJson: text("result_json").notNull().default("{}"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [
    index("idx_life_workflow_browser_sessions_agent").on(
      t.agentId,
      t.status,
      t.updatedAt,
    ),
    index("idx_life_workflow_browser_sessions_subject").on(
      t.agentId,
      t.domain,
      t.subjectType,
      t.subjectId,
      t.status,
      t.updatedAt,
    ),
  ],
);

export const lifeEscalationStates = appLifeopsPgSchema.table(
  "life_escalation_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    reason: text("reason").notNull().default(""),
    text: text("text").notNull().default(""),
    currentStep: integer("current_step").notNull().default(0),
    channelsSentJson: text("channels_sent_json").notNull().default("[]"),
    startedAt: text("started_at").notNull(),
    lastSentAt: text("last_sent_at").notNull(),
    resolved: boolean("resolved").notNull().default(false),
    resolvedAt: text("resolved_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_escalation_states_agent_resolved").on(
      t.agentId,
      t.resolved,
    ),
  ],
);

export const lifeInboxTriageEntries = appLifeopsPgSchema.table("life_inbox_triage_entries", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  source: text("source").notNull(),
  sourceRoomId: text("source_room_id"),
  sourceEntityId: text("source_entity_id"),
  sourceMessageId: text("source_message_id"),
  channelName: text("channel_name").notNull(),
  channelType: text("channel_type").notNull(),
  deepLink: text("deep_link"),
  classification: text("classification").notNull(),
  urgency: text("urgency").notNull().default("low"),
  confidence: real("confidence").notNull().default(0.5),
  snippet: text("snippet").notNull().default(""),
  senderName: text("sender_name"),
  threadContext: text("thread_context"),
  triageReasoning: text("triage_reasoning"),
  suggestedResponse: text("suggested_response"),
  draftResponse: text("draft_response"),
  autoReplied: boolean("auto_replied").notNull().default(false),
  resolved: boolean("resolved").notNull().default(false),
  resolvedAt: text("resolved_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const lifeInboxTriageExamples = appLifeopsPgSchema.table("life_inbox_triage_examples", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  source: text("source").notNull(),
  snippet: text("snippet").notNull().default(""),
  classification: text("classification").notNull(),
  ownerAction: text("owner_action").notNull(),
  ownerClassification: text("owner_classification"),
  contextJson: text("context_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});

export const lifeIntents = appLifeopsPgSchema.table("life_intents", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  kind: text("kind").notNull(),
  target: text("target").notNull(),
  targetDeviceId: text("target_device_id"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  actionUrl: text("action_url"),
  priority: text("priority").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
  acknowledgedAt: text("acknowledged_at"),
  acknowledgedBy: text("acknowledged_by"),
  metadataJson: text("metadata_json"),
});

export const lifeCheckinReports = appLifeopsPgSchema.table("life_checkin_reports", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  kind: text("kind").notNull(),
  generatedAt: text("generated_at").notNull(),
  generatedAtMs: bigint("generated_at_ms", { mode: "number" }).notNull(),
  escalationLevel: integer("escalation_level").notNull(),
  payloadJson: text("payload_json").notNull(),
  acknowledgedAt: text("acknowledged_at"),
});

export const lifeopsFeaturesTable = appLifeopsPgSchema.table("lifeops_features", {
  featureKey: text("feature_key").primaryKey(),
  enabled: boolean("enabled").notNull(),
  source: text("source").notNull(),
  enabledAt: timestamp("enabled_at", { withTimezone: true, mode: "date" }),
  enabledBy: uuid("enabled_by"),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .defaultNow(),
});

export const lifeRelationships = appLifeopsPgSchema.table(
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

export const lifeRelationshipInteractions = appLifeopsPgSchema.table(
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

export const lifeFollowUps = appLifeopsPgSchema.table("life_follow_ups", {
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

// Knowledge graph: entities + relationships.
//
// `life_entities` stores nodes (person, organization, place, project,
// concept, ...). Per-connector identity claims are stored in
// `life_entity_identities`; open-keyed extracted attributes in
// `life_entity_attributes`. The `(agent_id, entity_id)` pair is unique;
// `entityId === "self"` is the special user node.
//
// `life_relationships_v2` stores typed edges. `(agent_id, from_entity_id,
// to_entity_id, type)` is unique for active edges (a retired edge of the
// same triple may co-exist with a new active one). `cadence_days` is
// surfaced as a column-level shortcut for the cadence-overdue filter
// even though it also appears inside `metadata_json`.
export const lifeEntities = appLifeopsPgSchema.table(
  "life_entities",
  {
    entityId: text("entity_id").notNull(),
    agentId: text("agent_id").notNull(),
    type: text("type").notNull(),
    preferredName: text("preferred_name").notNull(),
    fullName: text("full_name"),
    tagsJson: text("tags_json").notNull().default("[]"),
    visibility: text("visibility").notNull().default("owner_agent_admin"),
    stateLastObservedAt: text("state_last_observed_at"),
    stateLastInboundAt: text("state_last_inbound_at"),
    stateLastOutboundAt: text("state_last_outbound_at"),
    stateLastInteractionPlatform: text("state_last_interaction_platform"),
    legacyRelationshipId: text("legacy_relationship_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.entityId),
    index("life_entities_agent_type_idx").on(t.agentId, t.type),
    index("life_entities_agent_name_idx").on(t.agentId, t.preferredName),
  ],
);

export const lifeEntityIdentities = appLifeopsPgSchema.table(
  "life_entity_identities",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    entityId: text("entity_id").notNull(),
    platform: text("platform").notNull(),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    verified: boolean("verified").notNull().default(false),
    confidence: real("confidence").notNull().default(0),
    addedAt: text("added_at").notNull(),
    addedVia: text("added_via").notNull(),
    evidenceJson: text("evidence_json").notNull().default("[]"),
  },
  (t) => [
    unique().on(t.agentId, t.entityId, t.platform, t.handle),
    index("life_entity_identities_lookup_idx").on(
      t.agentId,
      t.platform,
      t.handle,
    ),
  ],
);

export const lifeEntityAttributes = appLifeopsPgSchema.table(
  "life_entity_attributes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    entityId: text("entity_id").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull().default("null"),
    confidence: real("confidence").notNull().default(0),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.entityId, t.key),
    index("life_entity_attributes_lookup_idx").on(t.agentId, t.entityId),
  ],
);

export const lifeRelationshipsV2 = appLifeopsPgSchema.table(
  "life_relationships_v2",
  {
    relationshipId: text("relationship_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    fromEntityId: text("from_entity_id").notNull(),
    toEntityId: text("to_entity_id").notNull(),
    type: text("type").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    cadenceDays: integer("cadence_days"),
    stateLastObservedAt: text("state_last_observed_at"),
    stateLastInteractionAt: text("state_last_interaction_at"),
    stateInteractionCount: integer("state_interaction_count")
      .notNull()
      .default(0),
    stateSentimentTrend: text("state_sentiment_trend"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    confidence: real("confidence").notNull().default(0),
    source: text("source").notNull(),
    status: text("status").notNull().default("active"),
    retiredAt: text("retired_at"),
    retiredReason: text("retired_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("life_relationships_v2_edge_idx").on(
      t.agentId,
      t.fromEntityId,
      t.toEntityId,
      t.type,
    ),
    index("life_relationships_v2_to_idx").on(t.agentId, t.toEntityId),
    index("life_relationships_v2_cadence_idx").on(
      t.agentId,
      t.cadenceDays,
      t.stateLastInteractionAt,
    ),
  ],
);

export const lifeRelationshipAuditEvents = appLifeopsPgSchema.table(
  "life_relationship_audit_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    relationshipId: text("relationship_id").notNull(),
    kind: text("kind").notNull(),
    detailsJson: text("details_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("life_relationship_audit_events_lookup_idx").on(
      t.agentId,
      t.relationshipId,
    ),
  ],
);

export const lifeXDms = appLifeopsPgSchema.table(
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

export const lifeXFeedItems = appLifeopsPgSchema.table(
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

export const lifeXSyncStates = appLifeopsPgSchema.table(
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

export const lifeScreenTimeSessions = appLifeopsPgSchema.table("life_screen_time_sessions", {
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

export const lifeScreenTimeDaily = appLifeopsPgSchema.table(
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

export const lifeSleepEpisodes = appLifeopsPgSchema.table(
  "life_sleep_episodes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    startAt: text("start_at").notNull(),
    endAt: text("end_at"),
    source: text("source").notNull(),
    confidence: real("confidence").notNull().default(0),
    cycleType: text("cycle_type").notNull().default("unknown"),
    sealed: boolean("sealed").notNull().default(false),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.startAt),
    index("idx_life_sleep_episodes_agent_start").on(t.agentId, t.startAt),
    index("idx_life_sleep_episodes_agent_sealed").on(
      t.agentId,
      t.sealed,
      t.startAt,
    ),
  ],
);

/**
 * Canonical telemetry store. Replaces per-source tables (life_activity_signals,
 * life_activity_events, life_screen_time_*) with a single append-only event
 * store keyed by `(agentId, family, occurredAt)`. Payload shape is validated
 * at ingestion time against `LifeOpsTelemetryPayload` in shared contracts.
 *
 * Retention: 60 days for raw events, daily rollups retained indefinitely
 * (see `pruneTelemetryEvents` + `life_telemetry_rollup_daily` below).
 */
export const lifeTelemetryEvents = appLifeopsPgSchema.table(
  "life_telemetry_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    family: text("family").notNull(),
    occurredAt: text("occurred_at").notNull(),
    ingestedAt: text("ingested_at").notNull(),
    /** Content hash used to dedupe at ingest time. */
    dedupeKey: text("dedupe_key").notNull(),
    /** Snapshotted source reliability so historical analysis stays stable. */
    sourceReliability: real("source_reliability").notNull().default(0.5),
    /** Payload — must match the discriminated union shape for `family`. */
    payloadJson: text("payload_json").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.dedupeKey),
    index("idx_life_telemetry_agent_family_occurred").on(
      t.agentId,
      t.family,
      t.occurredAt,
    ),
    index("idx_life_telemetry_agent_occurred").on(t.agentId, t.occurredAt),
  ],
);

/**
 * Daily rollup of telemetry events per (agent, family, local_date). Retained
 * indefinitely so the scorer's 28-day regularity window and the longer-term
 * baseline query remain cheap even after raw events age out.
 */
export const lifeTelemetryRollupDaily = appLifeopsPgSchema.table(
  "life_telemetry_rollup_daily",
  {
    agentId: text("agent_id").notNull(),
    family: text("family").notNull(),
    localDate: text("local_date").notNull(),
    eventCount: integer("event_count").notNull().default(0),
    lastObservedAt: text("last_observed_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.family, t.localDate)],
);

/**
 * Persisted canonical circadian state per agent. One-row-per-agent with a
 * history trail in the audit log (life_audit_events with ownerType
 * circadian_state). Boot rehydration reads this row and downgrades to
 * `unclear` if it's older than MAX_STATE_AGE_MS. Every scheduler tick that
 * produces a state update writes here.
 */
export const lifeCircadianStates = appLifeopsPgSchema.table(
  "life_circadian_states",
  {
    agentId: text("agent_id").primaryKey(),
    circadianState: text("circadian_state").notNull().default("unclear"),
    stateConfidence: real("state_confidence").notNull().default(0),
    uncertaintyReason: text("uncertainty_reason"),
    enteredAt: text("entered_at").notNull(),
    sinceSleepDetectedAt: text("since_sleep_detected_at"),
    sinceWakeObservedAt: text("since_wake_observed_at"),
    sinceWakeConfirmedAt: text("since_wake_confirmed_at"),
    evidenceRefsJson: text("evidence_refs_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_circadian_states_updated").on(t.agentId, t.updatedAt),
  ],
);

export const lifeScheduleInsights = appLifeopsPgSchema.table(
  "life_schedule_insights",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    effectiveDayKey: text("effective_day_key").notNull(),
    localDate: text("local_date").notNull(),
    timezone: text("timezone").notNull(),
    inferredAt: text("inferred_at").notNull(),
    // Canonical circadian state - default `unclear` so migrations on existing
    // rows succeed; new rows always write the real value from the scorer.
    circadianState: text("circadian_state").notNull().default("unclear"),
    stateConfidence: real("state_confidence").notNull().default(0),
    uncertaintyReason: text("uncertainty_reason"),
    sleepStatus: text("sleep_status").notNull(),
    sleepConfidence: real("sleep_confidence").notNull().default(0),
    currentSleepStartedAt: text("current_sleep_started_at"),
    lastSleepStartedAt: text("last_sleep_started_at"),
    lastSleepEndedAt: text("last_sleep_ended_at"),
    lastSleepDurationMinutes: integer("last_sleep_duration_minutes"),
    wakeAt: text("wake_at"),
    firstActiveAt: text("first_active_at"),
    lastActiveAt: text("last_active_at"),
    lastMealAt: text("last_meal_at"),
    nextMealLabel: text("next_meal_label"),
    nextMealWindowStartAt: text("next_meal_window_start_at"),
    nextMealWindowEndAt: text("next_meal_window_end_at"),
    nextMealConfidence: real("next_meal_confidence").notNull().default(0),
    mealsJson: text("meals_json").notNull().default("[]"),
    awakeProbabilityJson: text("awake_probability_json")
      .notNull()
      .default("{}"),
    regularityJson: text("regularity_json").notNull().default("{}"),
    baselineJson: text("baseline_json"),
    /**
     * Scorer rule firings that fed this insight, as a JSON array of
     * `LifeOpsCircadianRuleFiring`. Surfaced by the inspection UI so the
     * user can see exactly which rules drove the current state.
     */
    circadianRuleFiringsJson: text("circadian_rule_firings_json")
      .notNull()
      .default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.effectiveDayKey)],
);

export const lifeScheduleObservations = appLifeopsPgSchema.table("life_schedule_observations", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  origin: text("origin").notNull(),
  deviceId: text("device_id").notNull(),
  deviceKind: text("device_kind").notNull(),
  timezone: text("timezone").notNull(),
  observedAt: text("observed_at").notNull(),
  windowStartAt: text("window_start_at").notNull(),
  windowEndAt: text("window_end_at"),
  // Default `unclear` so ADD COLUMN migrations succeed on tables with rows.
  circadianState: text("circadian_state").notNull().default("unclear"),
  stateConfidence: real("state_confidence").notNull().default(0),
  uncertaintyReason: text("uncertainty_reason"),
  mealLabel: text("meal_label"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const lifeScheduleMergedStates = appLifeopsPgSchema.table(
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
    circadianState: text("circadian_state").notNull().default("unclear"),
    stateConfidence: real("state_confidence").notNull().default(0),
    uncertaintyReason: text("uncertainty_reason"),
    sleepStatus: text("sleep_status").notNull(),
    sleepConfidence: real("sleep_confidence").notNull().default(0),
    currentSleepStartedAt: text("current_sleep_started_at"),
    lastSleepStartedAt: text("last_sleep_started_at"),
    lastSleepEndedAt: text("last_sleep_ended_at"),
    lastSleepDurationMinutes: integer("last_sleep_duration_minutes"),
    wakeAt: text("wake_at"),
    firstActiveAt: text("first_active_at"),
    lastActiveAt: text("last_active_at"),
    lastMealAt: text("last_meal_at"),
    nextMealLabel: text("next_meal_label"),
    nextMealWindowStartAt: text("next_meal_window_start_at"),
    nextMealWindowEndAt: text("next_meal_window_end_at"),
    nextMealConfidence: real("next_meal_confidence").notNull().default(0),
    mealsJson: text("meals_json").notNull().default("[]"),
    awakeProbabilityJson: text("awake_probability_json")
      .notNull()
      .default("{}"),
    regularityJson: text("regularity_json").notNull().default("{}"),
    baselineJson: text("baseline_json"),
    circadianRuleFiringsJson: text("circadian_rule_firings_json")
      .notNull()
      .default("[]"),
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

export const lifeSchedulingNegotiations = appLifeopsPgSchema.table(
  "life_scheduling_negotiations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    relationshipId: text("relationship_id"),
    subject: text("subject").notNull(),
    state: text("state").notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    timezone: text("timezone").notNull(),
    acceptedProposalId: text("accepted_proposal_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    startedAt: text("started_at").notNull(),
    finalizedAt: text("finalized_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const lifeSchedulingProposals = appLifeopsPgSchema.table("life_scheduling_proposals", {
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
export const lifeActivityEvents = appLifeopsPgSchema.table("life_activity_events", {
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

// T7g — Website blocker chat integration (plan §6.8).
// Stores block rules whose lifecycle is driven by todo completion, fixed
// duration, or an explicit ISO target. The reconciler releases rules when
// their gate is fulfilled; harsh_no_bypass rules can only be released by the
// reconciler on gate fulfillment (never by the user).
export const lifeBlockRules = appLifeopsPgSchema.table("life_block_rules", {
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

// ScheduledTask spine + state log.
//
// `life_scheduled_tasks` stores the typed ScheduledTask record. The
// runner is the only writer; each row's `state_json` carries the
// `ScheduledTaskState` fields (status, firedAt, …). `idempotency_key`
// is unique per agent and dedupes schedule() calls.
//
// `life_scheduled_task_log` is the append-only state-log; the nightly
// rollup pass folds expired raw rows into a daily summary row keyed by
// (task, day, transition).

export const lifeScheduledTasks = appLifeopsPgSchema.table(
  "life_scheduled_tasks",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    kind: text("kind").notNull(),
    promptInstructions: text("prompt_instructions").notNull(),
    contextRequestJson: text("context_request_json"),
    triggerJson: text("trigger_json").notNull(),
    priority: text("priority").notNull().default("medium"),
    shouldFireJson: text("should_fire_json"),
    completionCheckJson: text("completion_check_json"),
    escalationJson: text("escalation_json"),
    outputJson: text("output_json"),
    pipelineJson: text("pipeline_json"),
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    idempotencyKey: text("idempotency_key"),
    respectsGlobalPause: boolean("respects_global_pause")
      .notNull()
      .default(true),
    stateJson: text("state_json").notNull().default("{}"),
    source: text("source").notNull().default("user_chat"),
    createdBy: text("created_by").notNull().default(""),
    ownerVisible: boolean("owner_visible").notNull().default(true),
    metadataJson: text("metadata_json").notNull().default("{}"),
    // Optimistic concurrency version. Incremented on each update.
    // Used by withTransaction-wrapped operations to detect concurrent updates
    // and surface OptimisticLockError instead of silently overwriting.
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.idempotencyKey),
    index("idx_life_scheduled_tasks_agent_kind").on(t.agentId, t.kind),
    index("idx_life_scheduled_tasks_subject").on(
      t.agentId,
      t.subjectKind,
      t.subjectId,
    ),
  ],
);

export const lifeScheduledTaskLog = appLifeopsPgSchema.table(
  "life_scheduled_task_log",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    taskId: text("task_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    transition: text("transition").notNull(),
    reason: text("reason"),
    rolledUp: boolean("rolled_up").notNull().default(false),
    detailJson: text("detail_json"),
  },
  (t) => [
    index("idx_life_scheduled_task_log_agent_task").on(t.agentId, t.taskId),
    index("idx_life_scheduled_task_log_agent_time").on(
      t.agentId,
      t.occurredAt,
    ),
  ],
);

// Work-thread coordination index. Threads are not schedulers; they point at
// ScheduledTask/workflow/approval/pending-prompt state that owns durable work.

export const lifeWorkThreads = appLifeopsPgSchema.table(
  "life_work_threads",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    ownerEntityId: text("owner_entity_id"),
    status: text("status").notNull().default("active"),
    title: text("title").notNull().default(""),
    summary: text("summary").notNull().default(""),
    currentPlanSummary: text("current_plan_summary"),
    primarySourceRefJson: text("primary_source_ref_json").notNull(),
    sourceRefsJson: text("source_refs_json").notNull().default("[]"),
    participantEntityIdsJson: text("participant_entity_ids_json")
      .notNull()
      .default("[]"),
    currentScheduledTaskId: text("current_scheduled_task_id"),
    workflowRunId: text("workflow_run_id"),
    approvalId: text("approval_id"),
    lastMessageMemoryId: text("last_message_memory_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    // Optimistic concurrency version. Incremented on each update.
    // Used by withTransaction-wrapped operations to detect concurrent updates
    // (e.g., two simultaneous merges) and surface OptimisticLockError instead
    // of silently overwriting one merge's sourceRefs with the other.
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
  },
  (t) => [
    index("idx_life_work_threads_agent_status").on(t.agentId, t.status),
    index("idx_life_work_threads_agent_owner").on(
      t.agentId,
      t.ownerEntityId,
      t.status,
    ),
    index("idx_life_work_threads_agent_activity").on(
      t.agentId,
      t.lastActivityAt,
    ),
  ],
);

export const lifeWorkThreadEvents = appLifeopsPgSchema.table(
  "life_work_thread_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    workThreadId: text("work_thread_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    type: text("type").notNull(),
    reason: text("reason"),
    detailJson: text("detail_json"),
  },
  (t) => [
    index("idx_life_work_thread_events_thread").on(
      t.agentId,
      t.workThreadId,
      t.occurredAt,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Aggregate export for plugin schema property
// ---------------------------------------------------------------------------

export const lifeOpsSchema = {
  lifeConnectorGrants,
  lifeAccountPrivacy,
  lifeTaskDefinitions,
  lifeTaskOccurrences,
  lifeGoalDefinitions,
  lifeGoalLinks,
  lifeReminderPlans,
  lifeReminderAttempts,
  lifeAuditEvents,
  lifeSubscriptionAudits,
  lifeSubscriptionCandidates,
  lifeSubscriptionCancellations,
  lifeEmailUnsubscribes,
  lifePaymentSources,
  lifePaymentTransactions,
  lifeActivitySignals,
  lifeHealthMetricSamples,
  lifeHealthWorkouts,
  lifeHealthSyncStates,
  lifeHealthSleepEpisodes,
  lifeChannelPolicies,
  lifeWebsiteAccessGrants,
  lifeCalendarEvents,
  lifeCalendarSyncStates,
  lifeGmailMessages,
  lifeInboxMessages,
  lifeGmailSyncStates,
  lifeGmailSpamReviewItems,
  lifeWorkflowDefinitions,
  lifeWorkflowRuns,
  lifeWorkflowBrowserSessions,
  lifeEscalationStates,
  lifeIntents,
  lifeCheckinReports,
  lifeRelationships,
  lifeRelationshipInteractions,
  lifeFollowUps,
  lifeEntities,
  lifeEntityIdentities,
  lifeEntityAttributes,
  lifeRelationshipsV2,
  lifeRelationshipAuditEvents,
  lifeInboxTriageEntries,
  lifeInboxTriageExamples,
  lifeXDms,
  lifeXFeedItems,
  lifeXSyncStates,
  lifeScreenTimeSessions,
  lifeScreenTimeDaily,
  lifeSleepEpisodes,
  lifeCircadianStates,
  lifeTelemetryEvents,
  lifeTelemetryRollupDaily,
  lifeScheduleInsights,
  lifeScheduleObservations,
  lifeScheduleMergedStates,
  lifeActivityEvents,
  lifeSchedulingNegotiations,
  lifeSchedulingProposals,
  lifeBlockRules,
  lifeScheduledTasks,
  lifeScheduledTaskLog,
  lifeWorkThreads,
  lifeWorkThreadEvents,
  lifeopsFeaturesTable,
} as const;

// Zod schemas for `ScheduledTask`. Runtime validators used at the REST
// boundary (`src/routes/scheduled-tasks.ts`). Runtime types live in
// `./scheduled-task/types.ts`; Zod is the validator at the
// untyped-input edge.
import { z } from "zod";

const isoString = z
  .string()
  .min(1)
  .refine(
    (v) => !Number.isNaN(new Date(v).getTime()),
    "must be an ISO timestamp",
  );

const terminalStateSchema = z.enum([
  "completed",
  "skipped",
  "expired",
  "failed",
  "dismissed",
]);

const scheduledTaskKindSchema = z.enum([
  "reminder",
  "checkin",
  "followup",
  "approval",
  "recap",
  "watcher",
  "output",
  "custom",
]);

const scheduledTaskPrioritySchema = z.enum(["low", "medium", "high"]);

const scheduledTaskSourceSchema = z.enum([
  "default_pack",
  "user_chat",
  "first_run",
  "plugin",
]);

const scheduledTaskSubjectSchema = z.object({
  kind: z.enum([
    "entity",
    "relationship",
    "thread",
    "document",
    "calendar_event",
    "self",
  ]),
  id: z.string().min(1),
});

const scheduledTaskTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), atIso: isoString }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().min(1),
    tz: z.string().min(1),
  }),
  z.object({
    kind: z.literal("interval"),
    everyMinutes: z.number().int().positive(),
    from: isoString.optional(),
    until: isoString.optional(),
  }),
  z.object({
    kind: z.literal("relative_to_anchor"),
    anchorKey: z.string().min(1),
    offsetMinutes: z.number().int(),
  }),
  z.object({
    kind: z.literal("during_window"),
    windowKey: z.string().min(1),
  }),
  z.object({
    kind: z.literal("event"),
    eventKind: z.string().min(1),
    filter: z.unknown().optional(),
  }),
  z.object({ kind: z.literal("manual") }),
  z.object({
    kind: z.literal("after_task"),
    taskId: z.string().min(1),
    outcome: terminalStateSchema,
  }),
]);

const scheduledTaskShouldFireSchema = z.object({
  compose: z.enum(["all", "any", "first_deny"]).optional(),
  gates: z
    .array(
      z.object({
        kind: z.string().min(1),
        params: z.unknown().optional(),
      }),
    )
    .min(1),
});

const scheduledTaskCompletionCheckSchema = z.object({
  kind: z.string().min(1),
  params: z.unknown().optional(),
  followupAfterMinutes: z.number().int().positive().optional(),
});

const escalationStepSchema = z.object({
  delayMinutes: z.number().int().min(0),
  channelKey: z.string().min(1),
  intensity: z.enum(["soft", "normal", "urgent"]).optional(),
});

const scheduledTaskEscalationSchema = z.object({
  ladderKey: z.string().min(1).optional(),
  steps: z.array(escalationStepSchema).optional(),
});

const scheduledTaskOutputSchema = z.object({
  destination: z.enum([
    "in_app_card",
    "channel",
    "apple_notes",
    "gmail_draft",
    "memory",
  ]),
  target: z.string().min(1).optional(),
  persistAs: z.enum(["task_metadata", "external_only"]).optional(),
});

const scheduledTaskRefSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string().min(1), scheduledTaskInputBaseSchema]),
);

const scheduledTaskPipelineSchema = z.object({
  onComplete: z.array(scheduledTaskRefSchema).optional(),
  onSkip: z.array(scheduledTaskRefSchema).optional(),
  onFail: z.array(scheduledTaskRefSchema).optional(),
});

const scheduledTaskContextRequestSchema = z.object({
  includeOwnerFacts: z
    .array(
      z.enum([
        "preferredName",
        "timezone",
        "morningWindow",
        "eveningWindow",
        "locale",
      ]),
    )
    .optional(),
  includeEntities: z
    .object({
      entityIds: z.array(z.string().min(1)),
      fields: z
        .array(
          z.enum([
            "preferredName",
            "type",
            "identities",
            "state.lastInteractionPlatform",
          ]),
        )
        .optional(),
    })
    .optional(),
  includeRelationships: z
    .object({
      relationshipIds: z.array(z.string().min(1)).optional(),
      forEntityIds: z.array(z.string().min(1)).optional(),
      types: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  includeRecentTaskStates: z
    .object({
      kind: scheduledTaskKindSchema.optional(),
      lookbackHours: z.number().int().positive().optional(),
    })
    .optional(),
  includeEventPayload: z.boolean().optional(),
});

/**
 * The "input shape" for `runner.schedule()` — omits server-managed
 * `taskId` and `state` so callers cannot fabricate a state. The route
 * layer accepts this shape; the runner generates the rest.
 */
const scheduledTaskInputBaseSchema = z.object({
  kind: scheduledTaskKindSchema,
  promptInstructions: z.string().min(1),
  contextRequest: scheduledTaskContextRequestSchema.optional(),
  trigger: scheduledTaskTriggerSchema,
  priority: scheduledTaskPrioritySchema,
  shouldFire: scheduledTaskShouldFireSchema.optional(),
  completionCheck: scheduledTaskCompletionCheckSchema.optional(),
  escalation: scheduledTaskEscalationSchema.optional(),
  output: scheduledTaskOutputSchema.optional(),
  pipeline: scheduledTaskPipelineSchema.optional(),
  subject: scheduledTaskSubjectSchema.optional(),
  idempotencyKey: z.string().min(1).optional(),
  respectsGlobalPause: z.boolean(),
  source: scheduledTaskSourceSchema,
  createdBy: z.string().min(1),
  ownerVisible: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const scheduledTaskInputSchema = scheduledTaskInputBaseSchema;

export const scheduledTaskStateSchema = z.object({
  status: z.enum([
    "completed",
    "skipped",
    "expired",
    "failed",
    "dismissed",
    "scheduled",
    "fired",
    "acknowledged",
  ]),
  firedAt: isoString.optional(),
  acknowledgedAt: isoString.optional(),
  completedAt: isoString.optional(),
  followupCount: z.number().int().min(0),
  lastFollowupAt: isoString.optional(),
  pipelineParentId: z.string().min(1).optional(),
  lastDecisionLog: z.string().optional(),
});

export const scheduledTaskSchema = scheduledTaskInputBaseSchema.extend({
  taskId: z.string().min(1),
  state: scheduledTaskStateSchema,
});

export const scheduledTaskVerbSchema = z.enum([
  "snooze",
  "skip",
  "complete",
  "dismiss",
  "escalate",
  "acknowledge",
  "edit",
  "reopen",
]);

export const scheduledTaskSnoozePayloadSchema = z
  .object({
    minutes: z.number().int().positive().optional(),
    untilIso: isoString.optional(),
  })
  .refine(
    (v) => typeof v.minutes === "number" || typeof v.untilIso === "string",
    "snooze: provide minutes or untilIso",
  );

export const scheduledTaskFilterSchema = z.object({
  kind: scheduledTaskKindSchema.optional(),
  status: z
    .union([scheduledTaskStateSchema.shape.status, z.array(scheduledTaskStateSchema.shape.status)])
    .optional(),
  subject: scheduledTaskSubjectSchema.optional(),
  source: scheduledTaskSourceSchema.optional(),
  firedSince: isoString.optional(),
  ownerVisibleOnly: z.boolean().optional(),
});
