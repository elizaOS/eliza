/**
 * LifeOps Drizzle schema.
 *
 * Tables and indexes are created and migrated via the elizaOS
 * plugin-migration system when the plugin's `schema` field is populated.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
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
// Wave 1+ additions — relationships, X read, screen time, scheduling.
// All life_* prefix, text IDs, ISO timestamps.
//
// TODO(schema-isolation): plugin-sql warns these tables sit in the `public`
// schema. Moving them to `pgSchema("app_lifeops")` requires a coordinated
// migration — the same tables are also created and queried via raw SQL in
// `repository.ts` (bootstrapSchema + 50+ queries). Do that in one atomic
// pass or the app will split-brain between `app_lifeops.*` and `public.*`.
// ---------------------------------------------------------------------------

export const lifeConnectorGrants = pgTable(
  "life_connector_grants",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
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

export const lifeTaskDefinitions = pgTable(
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

export const lifeTaskOccurrences = pgTable(
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

export const lifeGoalDefinitions = pgTable(
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

export const lifeGoalLinks = pgTable(
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

export const lifeReminderPlans = pgTable(
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

export const lifeReminderAttempts = pgTable(
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

export const lifeAuditEvents = pgTable(
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

export const lifeSubscriptionAudits = pgTable("life_subscription_audits", {
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

export const lifeSubscriptionCandidates = pgTable(
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

export const lifeSubscriptionCancellations = pgTable(
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

export const lifeEmailUnsubscribes = pgTable("life_email_unsubscribes", {
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

export const lifePaymentSources = pgTable("life_payment_sources", {
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

export const lifePaymentTransactions = pgTable(
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

export const lifeActivitySignals = pgTable(
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

export const lifeHealthMetricSamples = pgTable(
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

export const lifeHealthWorkouts = pgTable(
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

export const lifeHealthSyncStates = pgTable(
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

export const lifeHealthSleepEpisodes = pgTable(
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

export const lifeChannelPolicies = pgTable(
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

export const lifeWebsiteAccessGrants = pgTable(
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

export const lifeCalendarEvents = pgTable(
  "life_calendar_events",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    calendarId: text("calendar_id").notNull(),
    externalEventId: text("external_event_id").notNull(),
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

export const lifeCalendarSyncStates = pgTable(
  "life_calendar_sync_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    calendarId: text("calendar_id").notNull(),
    grantId: text("grant_id"),
    windowStartAt: text("window_start_at").notNull(),
    windowEndAt: text("window_end_at").notNull(),
    syncedAt: text("synced_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique().on(t.agentId, t.provider, t.side, t.calendarId)],
);

export const lifeGmailMessages = pgTable(
  "life_gmail_messages",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull().default("google"),
    side: text("side").notNull().default("owner"),
    externalMessageId: text("external_message_id").notNull(),
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

export const lifeInboxMessages = pgTable(
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
    cachedAt: text("cached_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.channel, t.externalId),
    index("idx_life_inbox_messages_agent_received").on(t.agentId, t.receivedAt),
    index("idx_life_inbox_messages_agent_channel").on(t.agentId, t.channel),
  ],
);

export const lifeGmailSyncStates = pgTable(
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

export const lifeGmailSpamReviewItems = pgTable(
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

export const lifeWorkflowDefinitions = pgTable(
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

export const lifeWorkflowRuns = pgTable(
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
export const lifeWorkflowBrowserSessions = pgTable(
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

export const lifeEscalationStates = pgTable(
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

export const lifeInboxTriageEntries = pgTable("life_inbox_triage_entries", {
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

export const lifeInboxTriageExamples = pgTable("life_inbox_triage_examples", {
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

export const lifeIntents = pgTable("life_intents", {
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

export const lifeCheckinReports = pgTable("life_checkin_reports", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  kind: text("kind").notNull(),
  generatedAt: text("generated_at").notNull(),
  generatedAtMs: bigint("generated_at_ms", { mode: "number" }).notNull(),
  escalationLevel: integer("escalation_level").notNull(),
  payloadJson: text("payload_json").notNull(),
  acknowledgedAt: text("acknowledged_at"),
});

export const lifeopsFeaturesTable = pgTable("lifeops_features", {
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

export const lifeSleepEpisodes = pgTable(
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
export const lifeTelemetryEvents = pgTable(
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
export const lifeTelemetryRollupDaily = pgTable(
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
export const lifeCircadianStates = pgTable(
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

export const lifeScheduleInsights = pgTable(
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
  // Canonical circadian state replaces the legacy `state` + `phase` columns.
  // Default `unclear` so ADD COLUMN migrations succeed on tables with rows.
  circadianState: text("circadian_state").notNull().default("unclear"),
  stateConfidence: real("state_confidence").notNull().default(0),
  uncertaintyReason: text("uncertainty_reason"),
  mealLabel: text("meal_label"),
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
    acceptedProposalId: text("accepted_proposal_id"),
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

// ---------------------------------------------------------------------------
// Aggregate export for plugin schema property
// ---------------------------------------------------------------------------

export const lifeOpsSchema = {
  lifeConnectorGrants,
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
  lifeopsFeaturesTable,
} as const;
