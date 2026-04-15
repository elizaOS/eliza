import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsActivitySignal,
  LifeOpsAuditEvent,
  LifeOpsBrowserCompanionStatus,
  LifeOpsBrowserPageContext,
  LifeOpsBrowserPermissionState,
  LifeOpsBrowserSession,
  LifeOpsBrowserSettings,
  LifeOpsBrowserTabSummary,
  LifeOpsCalendarEvent,
  LifeOpsChannelPolicy,
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
  LifeOpsGmailMessageSummary,
  LifeOpsGoalDefinition,
  LifeOpsGoalLink,
  LifeOpsHealthSignal,
  LifeOpsOccurrence,
  LifeOpsOccurrenceView,
  LifeOpsReminderAttempt,
  LifeOpsReminderPlan,
  LifeOpsTaskDefinition,
  LifeOpsWorkflowDefinition,
  LifeOpsWorkflowRun,
} from "@elizaos/shared/contracts/lifeops";
import {
  executeRawSql,
  getRuntimeDbCacheKey,
  isRetryableLifeOpsStorageError,
  listTableColumns,
  parseJsonArray,
  parseJsonRecord,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
} from "./sql.js";

type BrowserCompanionCredential = {
  companion: LifeOpsBrowserCompanionStatus;
  pairingTokenHash: string | null;
  pendingPairingTokenHashes: string[];
};

const schemaReady = new WeakSet<object>();
const schemaInitializing = new WeakMap<object, Promise<void>>();
const LIFEOPS_SCHEMA_RETRY_DELAY_MS = 150;

function normalizeConnectorIdentityEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function deriveConnectorIdentityEmail(
  identity: Record<string, unknown>,
): string | null {
  return (
    normalizeConnectorIdentityEmail(identity.email) ??
    normalizeConnectorIdentityEmail(identity.emailAddress) ??
    normalizeConnectorIdentityEmail(identity.primaryEmail)
  );
}

async function hasLifeOpsSchema(runtime: IAgentRuntime): Promise<boolean> {
  try {
    const rows = await executeRawSql(
      runtime,
      `SELECT 1
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'life_task_definitions'
        LIMIT 1`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export interface LifeOpsWebsiteAccessGrant {
  id: string;
  agentId: string;
  groupKey: string;
  definitionId: string;
  occurrenceId: string | null;
  websites: string[];
  unlockMode: "fixed_duration" | "until_manual_lock" | "until_callback";
  unlockDurationMinutes: number | null;
  callbackKey: string | null;
  unlockedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

async function runMigrationWithSavepoint(
  runtime: IAgentRuntime,
  name: string,
  migration: () => Promise<void>,
): Promise<void> {
  const safeName = name.replace(/[^a-zA-Z0-9_]/g, "_");
  // Postgres / PGlite: SAVEPOINT only works inside a transaction. Each raw
  // execute is typically autocommit, so open an explicit outer transaction.
  // SQLite: BEGIN + SAVEPOINT is also valid.
  await executeRawSql(runtime, "BEGIN");
  try {
    await executeRawSql(runtime, `SAVEPOINT ${safeName}`);
    try {
      await migration();
      await executeRawSql(runtime, `RELEASE SAVEPOINT ${safeName}`);
    } catch (error) {
      await executeRawSql(runtime, `ROLLBACK TO SAVEPOINT ${safeName}`).catch(
        () => {},
      );
      throw error;
    }
    await executeRawSql(runtime, "COMMIT");
  } catch (error) {
    await executeRawSql(runtime, "ROLLBACK").catch(() => {});
    throw error;
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function parseOwnershipFields(row: Record<string, unknown>) {
  const subjectType =
    toText(row.subject_type, "owner") === "agent" ? "agent" : "owner";
  return {
    domain:
      toText(
        row.domain,
        subjectType === "agent" ? "agent_ops" : "user_lifeops",
      ) === "agent_ops"
        ? "agent_ops"
        : "user_lifeops",
    subjectType,
    subjectId: toText(row.subject_id, toText(row.agent_id)),
    visibilityScope:
      toText(
        row.visibility_scope,
        subjectType === "agent" ? "agent_and_admin" : "owner_agent_admin",
      ) === "owner_only"
        ? "owner_only"
        : toText(
              row.visibility_scope,
              subjectType === "agent" ? "agent_and_admin" : "owner_agent_admin",
            ) === "agent_and_admin"
          ? "agent_and_admin"
          : "owner_agent_admin",
    contextPolicy:
      toText(
        row.context_policy,
        subjectType === "agent" ? "never" : "explicit_only",
      ) === "never"
        ? "never"
        : toText(
              row.context_policy,
              subjectType === "agent" ? "never" : "explicit_only",
            ) === "sidebar_only"
          ? "sidebar_only"
          : toText(
                row.context_policy,
                subjectType === "agent" ? "never" : "explicit_only",
              ) === "allowed_in_private_chat"
            ? "allowed_in_private_chat"
            : "explicit_only",
  } as const;
}

function parseTaskDefinition(
  row: Record<string, unknown>,
): LifeOpsTaskDefinition {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ...parseOwnershipFields(row),
    kind: toText(row.kind) as LifeOpsTaskDefinition["kind"],
    title: toText(row.title),
    description: toText(row.description),
    originalIntent: toText(row.original_intent),
    timezone: toText(row.timezone),
    status: toText(row.status) as LifeOpsTaskDefinition["status"],
    priority: toNumber(row.priority, 3),
    cadence: parseJsonRecord(
      row.cadence_json,
    ) as unknown as LifeOpsTaskDefinition["cadence"],
    windowPolicy: parseJsonRecord(
      row.window_policy_json,
    ) as unknown as LifeOpsTaskDefinition["windowPolicy"],
    progressionRule: parseJsonRecord(
      row.progression_rule_json,
    ) as unknown as LifeOpsTaskDefinition["progressionRule"],
    websiteAccess: row.website_access_json
      ? (parseJsonRecord(
          row.website_access_json,
        ) as unknown as LifeOpsTaskDefinition["websiteAccess"])
      : null,
    reminderPlanId: row.reminder_plan_id ? toText(row.reminder_plan_id) : null,
    goalId: row.goal_id ? toText(row.goal_id) : null,
    source: toText(row.source),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseOccurrence(row: Record<string, unknown>): LifeOpsOccurrence {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ...parseOwnershipFields(row),
    definitionId: toText(row.definition_id),
    occurrenceKey: toText(row.occurrence_key),
    scheduledAt: row.scheduled_at ? toText(row.scheduled_at) : null,
    dueAt: row.due_at ? toText(row.due_at) : null,
    relevanceStartAt: toText(row.relevance_start_at),
    relevanceEndAt: toText(row.relevance_end_at),
    windowName: row.window_name ? toText(row.window_name) : null,
    state: toText(row.state) as LifeOpsOccurrence["state"],
    snoozedUntil: row.snoozed_until ? toText(row.snoozed_until) : null,
    completionPayload: row.completion_payload_json
      ? parseJsonRecord(row.completion_payload_json)
      : null,
    derivedTarget: row.derived_target_json
      ? parseJsonRecord(row.derived_target_json)
      : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseOccurrenceView(
  row: Record<string, unknown>,
): LifeOpsOccurrenceView {
  return {
    ...parseOccurrence(row),
    definitionKind: toText(
      row.definition_kind,
    ) as LifeOpsOccurrenceView["definitionKind"],
    definitionStatus: toText(
      row.definition_status,
    ) as LifeOpsOccurrenceView["definitionStatus"],
    cadence: parseJsonRecord(
      row.definition_cadence_json,
    ) as unknown as LifeOpsOccurrenceView["cadence"],
    title: toText(row.definition_title),
    description: toText(row.definition_description),
    priority: toNumber(row.definition_priority, 3),
    timezone: toText(row.definition_timezone),
    source: toText(row.definition_source, "manual"),
    goalId: row.definition_goal_id ? toText(row.definition_goal_id) : null,
  };
}

function parseGoal(row: Record<string, unknown>): LifeOpsGoalDefinition {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ...parseOwnershipFields(row),
    title: toText(row.title),
    description: toText(row.description),
    cadence: row.cadence_json ? parseJsonRecord(row.cadence_json) : null,
    supportStrategy: parseJsonRecord(row.support_strategy_json),
    successCriteria: parseJsonRecord(row.success_criteria_json),
    status: toText(row.status) as LifeOpsGoalDefinition["status"],
    reviewState: toText(
      row.review_state,
    ) as LifeOpsGoalDefinition["reviewState"],
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseGoalLink(row: Record<string, unknown>): LifeOpsGoalLink {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    goalId: toText(row.goal_id),
    linkedType: toText(row.linked_type) as LifeOpsGoalLink["linkedType"],
    linkedId: toText(row.linked_id),
    createdAt: toText(row.created_at),
  };
}

function parseReminderPlan(row: Record<string, unknown>): LifeOpsReminderPlan {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ownerType: toText(row.owner_type) as LifeOpsReminderPlan["ownerType"],
    ownerId: toText(row.owner_id),
    steps: parseJsonArray(row.steps_json),
    mutePolicy: parseJsonRecord(row.mute_policy_json),
    quietHours: parseJsonRecord(row.quiet_hours_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseChannelPolicy(
  row: Record<string, unknown>,
): LifeOpsChannelPolicy {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    channelType: toText(
      row.channel_type,
    ) as LifeOpsChannelPolicy["channelType"],
    channelRef: toText(row.channel_ref),
    privacyClass: toText(
      row.privacy_class,
    ) as LifeOpsChannelPolicy["privacyClass"],
    allowReminders: toBoolean(row.allow_reminders),
    allowEscalation: toBoolean(row.allow_escalation),
    allowPosts: toBoolean(row.allow_posts),
    requireConfirmationForActions: toBoolean(
      row.require_confirmation_for_actions,
    ),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseWebsiteAccessGrant(
  row: Record<string, unknown>,
): LifeOpsWebsiteAccessGrant {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    groupKey: toText(row.group_key),
    definitionId: toText(row.definition_id),
    occurrenceId: row.occurrence_id ? toText(row.occurrence_id) : null,
    websites: parseJsonArray(row.websites_json),
    unlockMode: toText(
      row.unlock_mode,
    ) as LifeOpsWebsiteAccessGrant["unlockMode"],
    unlockDurationMinutes: row.unlock_duration_minutes
      ? toNumber(row.unlock_duration_minutes, 0)
      : null,
    callbackKey: row.callback_key ? toText(row.callback_key) : null,
    unlockedAt: toText(row.unlocked_at),
    expiresAt: row.expires_at ? toText(row.expires_at) : null,
    revokedAt: row.revoked_at ? toText(row.revoked_at) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseConnectorGrant(
  row: Record<string, unknown>,
): LifeOpsConnectorGrant {
  const identity = parseJsonRecord(row.identity_json);
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider) as LifeOpsConnectorGrant["provider"],
    side: toText(row.side, "owner") as LifeOpsConnectorGrant["side"],
    identity,
    grantedScopes: parseJsonArray(row.granted_scopes_json),
    capabilities: parseJsonArray(row.capabilities_json),
    tokenRef: row.token_ref ? toText(row.token_ref) : null,
    mode: toText(row.mode) as LifeOpsConnectorGrant["mode"],
    executionTarget: toText(
      row.execution_target ?? "local",
    ) as LifeOpsConnectorGrant["executionTarget"],
    sourceOfTruth: toText(
      row.source_of_truth ?? "local_storage",
    ) as LifeOpsConnectorGrant["sourceOfTruth"],
    preferredByAgent: toBoolean(row.preferred_by_agent ?? false),
    cloudConnectionId: row.cloud_connection_id
      ? toText(row.cloud_connection_id)
      : null,
    metadata: parseJsonRecord(row.metadata_json),
    lastRefreshAt: row.last_refresh_at ? toText(row.last_refresh_at) : null,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseAuditEvent(row: Record<string, unknown>): LifeOpsAuditEvent {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    eventType: toText(row.event_type) as LifeOpsAuditEvent["eventType"],
    ownerType: toText(row.owner_type) as LifeOpsAuditEvent["ownerType"],
    ownerId: toText(row.owner_id),
    reason: toText(row.reason),
    inputs: parseJsonRecord(row.inputs_json),
    decision: parseJsonRecord(row.decision_json),
    actor: toText(row.actor) as LifeOpsAuditEvent["actor"],
    createdAt: toText(row.created_at),
  };
}

function parseOptionalFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function parseHealthSignal(value: unknown): LifeOpsHealthSignal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sleepRecord =
    record.sleep &&
    typeof record.sleep === "object" &&
    !Array.isArray(record.sleep)
      ? (record.sleep as Record<string, unknown>)
      : null;
  const biometricsRecord =
    record.biometrics &&
    typeof record.biometrics === "object" &&
    !Array.isArray(record.biometrics)
      ? (record.biometrics as Record<string, unknown>)
      : null;
  const permissionsRecord =
    record.permissions &&
    typeof record.permissions === "object" &&
    !Array.isArray(record.permissions)
      ? (record.permissions as Record<string, unknown>)
      : null;

  return {
    source:
      toText(record.source, "healthkit") === "health_connect"
        ? "health_connect"
        : "healthkit",
    permissions: {
      sleep: toBoolean(permissionsRecord?.sleep ?? false),
      biometrics: toBoolean(permissionsRecord?.biometrics ?? false),
    },
    sleep: {
      available: toBoolean(sleepRecord?.available ?? false),
      isSleeping: toBoolean(sleepRecord?.isSleeping ?? false),
      asleepAt: sleepRecord?.asleepAt ? toText(sleepRecord.asleepAt) : null,
      awakeAt: sleepRecord?.awakeAt ? toText(sleepRecord.awakeAt) : null,
      durationMinutes: parseOptionalFiniteNumber(sleepRecord?.durationMinutes),
      stage: sleepRecord?.stage ? toText(sleepRecord.stage) : null,
    },
    biometrics: {
      sampleAt: biometricsRecord?.sampleAt
        ? toText(biometricsRecord.sampleAt)
        : null,
      heartRateBpm: parseOptionalFiniteNumber(biometricsRecord?.heartRateBpm),
      restingHeartRateBpm: parseOptionalFiniteNumber(
        biometricsRecord?.restingHeartRateBpm,
      ),
      heartRateVariabilityMs: parseOptionalFiniteNumber(
        biometricsRecord?.heartRateVariabilityMs,
      ),
      respiratoryRate: parseOptionalFiniteNumber(
        biometricsRecord?.respiratoryRate,
      ),
      bloodOxygenPercent: parseOptionalFiniteNumber(
        biometricsRecord?.bloodOxygenPercent,
      ),
    },
    warnings: Array.isArray(record.warnings)
      ? record.warnings
          .map((warning) => toText(warning))
          .filter((warning) => warning.length > 0)
      : [],
  };
}

function parseActivitySignal(
  row: Record<string, unknown>,
): LifeOpsActivitySignal {
  const metadata = parseJsonRecord(row.metadata_json);
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    source: toText(row.source) as LifeOpsActivitySignal["source"],
    platform: toText(row.platform),
    state: toText(row.state) as LifeOpsActivitySignal["state"],
    observedAt: toText(row.observed_at),
    idleState: row.idle_state
      ? (toText(row.idle_state) as LifeOpsActivitySignal["idleState"])
      : null,
    idleTimeSeconds:
      row.idle_time_seconds === null || row.idle_time_seconds === undefined
        ? null
        : toNumber(row.idle_time_seconds, 0),
    onBattery:
      row.on_battery === null || row.on_battery === undefined
        ? null
        : toBoolean(row.on_battery),
    health: parseHealthSignal(metadata.health),
    metadata,
    createdAt: toText(row.created_at),
  };
}

function parseCalendarEvent(
  row: Record<string, unknown>,
): LifeOpsCalendarEvent {
  return {
    id: toText(row.id),
    externalId: toText(row.external_event_id),
    agentId: toText(row.agent_id),
    provider: "google",
    side: toText(row.side, "owner") as LifeOpsCalendarEvent["side"],
    calendarId: toText(row.calendar_id),
    title: toText(row.title),
    description: toText(row.description),
    location: toText(row.location),
    status: toText(row.status),
    startAt: toText(row.start_at),
    endAt: toText(row.end_at),
    isAllDay: toBoolean(row.is_all_day),
    timezone: row.timezone ? toText(row.timezone) : null,
    htmlLink: row.html_link ? toText(row.html_link) : null,
    conferenceLink: row.conference_link ? toText(row.conference_link) : null,
    organizer: row.organizer_json ? parseJsonRecord(row.organizer_json) : null,
    attendees: parseJsonArray(
      row.attendees_json,
    ) as unknown as LifeOpsCalendarEvent["attendees"],
    metadata: parseJsonRecord(row.metadata_json),
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseGmailMessageSummary(
  row: Record<string, unknown>,
): LifeOpsGmailMessageSummary {
  return {
    id: toText(row.id),
    externalId: toText(row.external_message_id),
    agentId: toText(row.agent_id),
    provider: "google",
    side: toText(row.side, "owner") as LifeOpsGmailMessageSummary["side"],
    threadId: toText(row.thread_id),
    subject: toText(row.subject),
    from: toText(row.from_display),
    fromEmail: row.from_email ? toText(row.from_email) : null,
    replyTo: row.reply_to ? toText(row.reply_to) : null,
    to: parseJsonArray(row.to_json),
    cc: parseJsonArray(row.cc_json),
    snippet: toText(row.snippet),
    receivedAt: toText(row.received_at),
    isUnread: toBoolean(row.is_unread),
    isImportant: toBoolean(row.is_important),
    likelyReplyNeeded: toBoolean(row.likely_reply_needed),
    triageScore: toNumber(row.triage_score),
    triageReason: toText(row.triage_reason),
    labels: parseJsonArray(row.label_ids_json),
    htmlLink: row.html_link ? toText(row.html_link) : null,
    metadata: parseJsonRecord(row.metadata_json),
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseWorkflowDefinition(
  row: Record<string, unknown>,
): LifeOpsWorkflowDefinition {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ...parseOwnershipFields(row),
    title: toText(row.title),
    triggerType: toText(
      row.trigger_type,
    ) as LifeOpsWorkflowDefinition["triggerType"],
    schedule: parseJsonRecord(
      row.schedule_json,
    ) as unknown as LifeOpsWorkflowDefinition["schedule"],
    actionPlan: parseJsonRecord(
      row.action_plan_json,
    ) as unknown as LifeOpsWorkflowDefinition["actionPlan"],
    permissionPolicy: parseJsonRecord(
      row.permission_policy_json,
    ) as unknown as LifeOpsWorkflowDefinition["permissionPolicy"],
    status: toText(row.status) as LifeOpsWorkflowDefinition["status"],
    createdBy: toText(row.created_by) as LifeOpsWorkflowDefinition["createdBy"],
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseWorkflowRun(row: Record<string, unknown>): LifeOpsWorkflowRun {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    workflowId: toText(row.workflow_id),
    startedAt: toText(row.started_at),
    finishedAt: row.finished_at ? toText(row.finished_at) : null,
    status: toText(row.status) as LifeOpsWorkflowRun["status"],
    result: parseJsonRecord(row.result_json),
    auditRef: row.audit_ref ? toText(row.audit_ref) : null,
  };
}

function parseReminderAttempt(
  row: Record<string, unknown>,
): LifeOpsReminderAttempt {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    planId: toText(row.plan_id),
    ownerType: toText(row.owner_type) as LifeOpsReminderAttempt["ownerType"],
    ownerId: toText(row.owner_id),
    occurrenceId: row.occurrence_id ? toText(row.occurrence_id) : null,
    channel: toText(row.channel) as LifeOpsReminderAttempt["channel"],
    stepIndex: toNumber(row.step_index, 0),
    scheduledFor: toText(row.scheduled_for),
    attemptedAt: row.attempted_at ? toText(row.attempted_at) : null,
    outcome: toText(row.outcome) as LifeOpsReminderAttempt["outcome"],
    connectorRef: row.connector_ref ? toText(row.connector_ref) : null,
    deliveryMetadata: parseJsonRecord(row.delivery_metadata_json),
  };
}

function parseBrowserSession(
  row: Record<string, unknown>,
): LifeOpsBrowserSession {
  const rawStatus = toText(row.status);
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    ...parseOwnershipFields(row),
    workflowId: row.workflow_id ? toText(row.workflow_id) : null,
    browser: row.browser
      ? (toText(row.browser) as LifeOpsBrowserSession["browser"])
      : null,
    companionId: row.companion_id ? toText(row.companion_id) : null,
    profileId: row.profile_id ? toText(row.profile_id) : null,
    windowId: row.window_id ? toText(row.window_id) : null,
    tabId: row.tab_id ? toText(row.tab_id) : null,
    title: toText(row.title),
    status:
      rawStatus === "navigating"
        ? "running"
        : (rawStatus as LifeOpsBrowserSession["status"]),
    actions: parseJsonArray(
      row.actions_json,
    ) as unknown as LifeOpsBrowserSession["actions"],
    currentActionIndex: toNumber(row.current_action_index, 0),
    awaitingConfirmationForActionId: row.awaiting_confirmation_for_action_id
      ? toText(row.awaiting_confirmation_for_action_id)
      : null,
    result: parseJsonRecord(row.result_json),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    finishedAt: row.finished_at ? toText(row.finished_at) : null,
  };
}

function parseBrowserPermissionState(
  value: unknown,
): LifeOpsBrowserPermissionState {
  const input = parseJsonRecord(value);
  return {
    tabs: Boolean(input.tabs),
    scripting: Boolean(input.scripting),
    activeTab: Boolean(input.activeTab),
    allOrigins: Boolean(input.allOrigins),
    grantedOrigins: Array.isArray(input.grantedOrigins)
      ? input.grantedOrigins
          .filter(
            (candidate): candidate is string => typeof candidate === "string",
          )
          .map((candidate) => candidate.trim())
          .filter((candidate) => candidate.length > 0)
      : [],
    incognitoEnabled: Boolean(input.incognitoEnabled),
  };
}

function parseBrowserSettings(
  row: Record<string, unknown>,
): LifeOpsBrowserSettings {
  return {
    enabled: toBoolean(row.enabled, false),
    trackingMode: toText(
      row.tracking_mode,
      "current_tab",
    ) as LifeOpsBrowserSettings["trackingMode"],
    allowBrowserControl: toBoolean(row.allow_browser_control, false),
    requireConfirmationForAccountAffecting: toBoolean(
      row.require_confirmation_for_account_affecting,
      true,
    ),
    incognitoEnabled: toBoolean(row.incognito_enabled, false),
    siteAccessMode: toText(
      row.site_access_mode,
      "current_site_only",
    ) as LifeOpsBrowserSettings["siteAccessMode"],
    grantedOrigins: parseJsonArray(row.granted_origins_json).filter(
      (candidate): candidate is string => typeof candidate === "string",
    ),
    blockedOrigins: parseJsonArray(row.blocked_origins_json).filter(
      (candidate): candidate is string => typeof candidate === "string",
    ),
    maxRememberedTabs: toNumber(row.max_remembered_tabs, 10),
    pauseUntil: row.pause_until ? toText(row.pause_until) : null,
    metadata: parseJsonRecord(row.metadata_json),
    updatedAt: row.updated_at ? toText(row.updated_at) : null,
  };
}

function parseBrowserCompanion(
  row: Record<string, unknown>,
): LifeOpsBrowserCompanionStatus {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    browser: toText(row.browser) as LifeOpsBrowserCompanionStatus["browser"],
    profileId: toText(row.profile_id),
    profileLabel: toText(row.profile_label),
    label: toText(row.label),
    extensionVersion: row.extension_version
      ? toText(row.extension_version)
      : null,
    connectionState: toText(
      row.connection_state,
    ) as LifeOpsBrowserCompanionStatus["connectionState"],
    permissions: parseBrowserPermissionState(row.permissions_json),
    lastSeenAt: row.last_seen_at ? toText(row.last_seen_at) : null,
    pairedAt: row.paired_at ? toText(row.paired_at) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseBrowserCompanionCredential(
  row: Record<string, unknown>,
): BrowserCompanionCredential {
  return {
    companion: parseBrowserCompanion(row),
    pairingTokenHash: row.pairing_token_hash
      ? toText(row.pairing_token_hash)
      : null,
    pendingPairingTokenHashes: parseJsonArray(
      row.pending_pairing_token_hashes_json,
    ).filter(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.length > 0,
    ),
  };
}

function parseBrowserTabSummary(
  row: Record<string, unknown>,
): LifeOpsBrowserTabSummary {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    companionId: row.companion_id ? toText(row.companion_id) : null,
    browser: toText(row.browser) as LifeOpsBrowserTabSummary["browser"],
    profileId: toText(row.profile_id),
    windowId: toText(row.window_id),
    tabId: toText(row.tab_id),
    url: toText(row.url),
    title: toText(row.title),
    activeInWindow: toBoolean(row.active_in_window, false),
    focusedWindow: toBoolean(row.focused_window, false),
    focusedActive: toBoolean(row.focused_active, false),
    incognito: toBoolean(row.incognito, false),
    faviconUrl: row.favicon_url ? toText(row.favicon_url) : null,
    lastSeenAt: toText(row.last_seen_at),
    lastFocusedAt: row.last_focused_at ? toText(row.last_focused_at) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseBrowserPageContext(
  row: Record<string, unknown>,
): LifeOpsBrowserPageContext {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    browser: toText(row.browser) as LifeOpsBrowserPageContext["browser"],
    profileId: toText(row.profile_id),
    windowId: toText(row.window_id),
    tabId: toText(row.tab_id),
    url: toText(row.url),
    title: toText(row.title),
    selectionText: row.selection_text ? toText(row.selection_text) : null,
    mainText: row.main_text ? toText(row.main_text) : null,
    headings: parseJsonArray(row.headings_json).filter(
      (candidate): candidate is string => typeof candidate === "string",
    ),
    links: parseJsonArray(row.links_json).filter(
      (candidate): candidate is LifeOpsBrowserPageContext["links"][number] =>
        (() => {
          if (!candidate || typeof candidate !== "object") {
            return false;
          }
          const record = candidate as Record<string, unknown>;
          return (
            typeof record.href === "string" && typeof record.text === "string"
          );
        })(),
    ),
    forms: parseJsonArray(row.forms_json).filter(
      (candidate): candidate is LifeOpsBrowserPageContext["forms"][number] =>
        (() => {
          if (!candidate || typeof candidate !== "object") {
            return false;
          }
          const record = candidate as Record<string, unknown>;
          return (
            (record.action === null ||
              record.action === undefined ||
              typeof record.action === "string") &&
            Array.isArray(record.fields) &&
            record.fields.every((field) => typeof field === "string")
          );
        })(),
    ),
    capturedAt: toText(row.captured_at),
    metadata: parseJsonRecord(row.metadata_json),
  };
}

interface LifeOpsCalendarSyncState {
  id: string;
  agentId: string;
  provider: LifeOpsConnectorGrant["provider"];
  side: LifeOpsConnectorSide;
  calendarId: string;
  windowStartAt: string;
  windowEndAt: string;
  syncedAt: string;
  updatedAt: string;
}

function parseCalendarSyncState(
  row: Record<string, unknown>,
): LifeOpsCalendarSyncState {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider) as LifeOpsConnectorGrant["provider"],
    side: toText(row.side, "owner") as LifeOpsConnectorSide,
    calendarId: toText(row.calendar_id),
    windowStartAt: toText(row.window_start_at),
    windowEndAt: toText(row.window_end_at),
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

interface LifeOpsGmailSyncState {
  id: string;
  agentId: string;
  provider: LifeOpsConnectorGrant["provider"];
  side: LifeOpsConnectorSide;
  mailbox: string;
  maxResults: number;
  syncedAt: string;
  updatedAt: string;
}

function parseGmailSyncState(
  row: Record<string, unknown>,
): LifeOpsGmailSyncState {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: toText(row.provider) as LifeOpsConnectorGrant["provider"],
    side: toText(row.side, "owner") as LifeOpsConnectorSide,
    mailbox: toText(row.mailbox),
    maxResults: toNumber(row.max_results, 0),
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Escalation state row — used by EscalationService for write-through cache
// ---------------------------------------------------------------------------

export interface LifeOpsEscalationStateRow {
  id: string;
  agentId: string;
  reason: string;
  text: string;
  currentStep: number;
  channelsSent: string[];
  startedAt: string;
  lastSentAt: string;
  resolved: boolean;
  resolvedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function parseEscalationStateRow(
  row: Record<string, unknown>,
): LifeOpsEscalationStateRow {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    reason: toText(row.reason),
    text: toText(row.text),
    currentStep: toNumber(row.current_step, 0),
    channelsSent: parseJsonArray<string>(row.channels_sent_json),
    startedAt: toText(row.started_at),
    lastSentAt: toText(row.last_sent_at),
    resolved: toBoolean(row.resolved),
    resolvedAt: row.resolved_at ? toText(row.resolved_at) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export async function ensureLifeOpsTables(
  runtime: IAgentRuntime,
): Promise<void> {
  // Cache schema readiness per underlying DB connection rather than per
  // runtime or per Drizzle wrapper. Multiple runtimes/adapters can share the
  // same PGlite connection manager, and keying on the wrapper lets concurrent
  // lifeops bootstraps race the same DDL.
  const key = getRuntimeDbCacheKey(runtime);
  if (schemaReady.has(key)) {
    if (await hasLifeOpsSchema(runtime)) return;
    schemaReady.delete(key);
  }

  // Prevent concurrent migration runs — PGlite cannot handle concurrent DDL.
  // The first caller creates the migration promise; concurrent callers await it.
  const pending = schemaInitializing.get(key);
  if (pending) return pending;

  const migrationPromise = runLifeOpsSchemaSetupWithRetry(runtime, key);
  schemaInitializing.set(key, migrationPromise);
  try {
    await migrationPromise;
  } finally {
    schemaInitializing.delete(key);
  }
}

async function runLifeOpsSchemaSetup(
  runtime: IAgentRuntime,
  key: object,
): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS life_task_definitions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      visibility_scope TEXT NOT NULL,
      context_policy TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      original_intent TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 3,
      cadence_json TEXT NOT NULL,
      window_policy_json TEXT NOT NULL,
      progression_rule_json TEXT NOT NULL,
      website_access_json TEXT,
      reminder_plan_id TEXT,
      goal_id TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS life_task_occurrences (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      visibility_scope TEXT NOT NULL,
      context_policy TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      scheduled_at TEXT,
      due_at TEXT,
      relevance_start_at TEXT NOT NULL,
      relevance_end_at TEXT NOT NULL,
      window_name TEXT,
      state TEXT NOT NULL,
      snoozed_until TEXT,
      completion_payload_json TEXT,
      derived_target_json TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, definition_id, occurrence_key)
    )`,
    `CREATE TABLE IF NOT EXISTS life_goal_definitions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      visibility_scope TEXT NOT NULL,
      context_policy TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      cadence_json TEXT,
      support_strategy_json TEXT NOT NULL DEFAULT '{}',
      success_criteria_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      review_state TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS life_goal_links (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      linked_type TEXT NOT NULL,
      linked_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(agent_id, goal_id, linked_type, linked_id)
    )`,
    `CREATE TABLE IF NOT EXISTS life_workflow_definitions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      visibility_scope TEXT NOT NULL,
      context_policy TEXT NOT NULL,
      title TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      action_plan_json TEXT NOT NULL,
      permission_policy_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS life_workflow_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',
      audit_ref TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS life_browser_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      visibility_scope TEXT NOT NULL,
      context_policy TEXT NOT NULL,
      workflow_id TEXT,
      browser TEXT,
      companion_id TEXT,
      profile_id TEXT,
      window_id TEXT,
      tab_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      actions_json TEXT NOT NULL DEFAULT '[]',
      current_action_index INTEGER NOT NULL DEFAULT 0,
      awaiting_confirmation_for_action_id TEXT,
      result_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS life_browser_settings (
      agent_id TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      tracking_mode TEXT NOT NULL DEFAULT 'current_tab',
      allow_browser_control BOOLEAN NOT NULL DEFAULT FALSE,
      require_confirmation_for_account_affecting BOOLEAN NOT NULL DEFAULT TRUE,
      incognito_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      site_access_mode TEXT NOT NULL DEFAULT 'current_site_only',
      granted_origins_json TEXT NOT NULL DEFAULT '[]',
      blocked_origins_json TEXT NOT NULL DEFAULT '[]',
      max_remembered_tabs INTEGER NOT NULL DEFAULT 10,
      pause_until TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS life_browser_companions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      browser TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      profile_label TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL,
      extension_version TEXT,
      connection_state TEXT NOT NULL DEFAULT 'disconnected',
      permissions_json TEXT NOT NULL DEFAULT '{}',
      last_seen_at TEXT,
      paired_at TEXT,
      pairing_token_hash TEXT,
      pending_pairing_token_hashes_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, browser, profile_id)
    )`,
    `CREATE TABLE IF NOT EXISTS life_browser_tabs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      companion_id TEXT,
      browser TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      active_in_window BOOLEAN NOT NULL DEFAULT FALSE,
      focused_window BOOLEAN NOT NULL DEFAULT FALSE,
      focused_active BOOLEAN NOT NULL DEFAULT FALSE,
      incognito BOOLEAN NOT NULL DEFAULT FALSE,
      favicon_url TEXT,
      last_seen_at TEXT NOT NULL,
      last_focused_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, browser, profile_id, window_id, tab_id)
    )`,
    `CREATE TABLE IF NOT EXISTS life_browser_page_contexts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      browser TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      window_id TEXT NOT NULL,
      tab_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      selection_text TEXT,
      main_text TEXT,
      headings_json TEXT NOT NULL DEFAULT '[]',
      links_json TEXT NOT NULL DEFAULT '[]',
      forms_json TEXT NOT NULL DEFAULT '[]',
      captured_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(agent_id, browser, profile_id, window_id, tab_id)
    )`,
    `CREATE TABLE IF NOT EXISTS life_reminder_plans (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      mute_policy_json TEXT NOT NULL DEFAULT '{}',
      quiet_hours_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS life_reminder_attempts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      occurrence_id TEXT,
      channel TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      scheduled_for TEXT NOT NULL,
      attempted_at TEXT,
      outcome TEXT NOT NULL,
      connector_ref TEXT,
      delivery_metadata_json TEXT NOT NULL DEFAULT '{}'
    )`,
    `CREATE TABLE IF NOT EXISTS life_connector_grants (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'owner',
      identity_json TEXT NOT NULL DEFAULT '{}',
      granted_scopes_json TEXT NOT NULL DEFAULT '[]',
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      token_ref TEXT,
      mode TEXT NOT NULL,
      execution_target TEXT NOT NULL DEFAULT 'local',
      source_of_truth TEXT NOT NULL DEFAULT 'local_storage',
      preferred_by_agent BOOLEAN NOT NULL DEFAULT FALSE,
      cloud_connection_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      last_refresh_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, provider, side, mode)
    )`,
    `CREATE TABLE IF NOT EXISTS life_calendar_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'owner',
      calendar_id TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      is_all_day BOOLEAN NOT NULL,
      timezone TEXT,
      html_link TEXT,
      conference_link TEXT,
      organizer_json TEXT,
      attendees_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      synced_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, provider, side, calendar_id, external_event_id)
    )`,
    `CREATE TABLE IF NOT EXISTS life_calendar_sync_states (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'owner',
      calendar_id TEXT NOT NULL,
      window_start_at TEXT NOT NULL,
      window_end_at TEXT NOT NULL,
      synced_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, provider, side, calendar_id)
    )`,
    `CREATE TABLE IF NOT EXISTS life_gmail_messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'owner',
      external_message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      from_display TEXT NOT NULL DEFAULT '',
      from_email TEXT,
      reply_to TEXT,
      to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      snippet TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL,
      is_unread BOOLEAN NOT NULL DEFAULT FALSE,
      is_important BOOLEAN NOT NULL DEFAULT FALSE,
      likely_reply_needed BOOLEAN NOT NULL DEFAULT FALSE,
      triage_score INTEGER NOT NULL DEFAULT 0,
      triage_reason TEXT NOT NULL DEFAULT '',
      label_ids_json TEXT NOT NULL DEFAULT '[]',
      html_link TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      synced_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, provider, side, external_message_id)
    )`,
    `CREATE TABLE IF NOT EXISTS life_gmail_sync_states (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'owner',
      mailbox TEXT NOT NULL,
      max_results INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, provider, side, mailbox)
    )`,
    `CREATE TABLE IF NOT EXISTS life_channel_policies (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      channel_ref TEXT NOT NULL,
      privacy_class TEXT NOT NULL,
      allow_reminders BOOLEAN NOT NULL,
      allow_escalation BOOLEAN NOT NULL,
      allow_posts BOOLEAN NOT NULL,
      require_confirmation_for_actions BOOLEAN NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, channel_type, channel_ref)
    )`,
    `CREATE TABLE IF NOT EXISTS life_website_access_grants (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      group_key TEXT NOT NULL,
      definition_id TEXT NOT NULL,
      occurrence_id TEXT,
      websites_json TEXT NOT NULL DEFAULT '[]',
      unlock_mode TEXT NOT NULL,
      unlock_duration_minutes INTEGER,
      callback_key TEXT,
      unlocked_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS life_audit_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      inputs_json TEXT NOT NULL DEFAULT '{}',
      decision_json TEXT NOT NULL DEFAULT '{}',
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS life_activity_signals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL,
      platform TEXT NOT NULL,
      state TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      idle_state TEXT,
      idle_time_seconds INTEGER,
      on_battery BOOLEAN,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS life_escalation_states (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      text TEXT NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 0,
      channels_sent_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      last_sent_at TEXT NOT NULL,
      resolved BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ];

  /** Applied after legacy ownership columns are added — old DBs may lack domain/subject_* until ALTERs below. */
  const coreIndexStatements = [
    `CREATE INDEX IF NOT EXISTS idx_life_task_definitions_agent_status
      ON life_task_definitions(agent_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_life_task_definitions_subject
      ON life_task_definitions(agent_id, domain, subject_type, subject_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_life_task_occurrences_agent_state_start
      ON life_task_occurrences(agent_id, state, relevance_start_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_task_occurrences_subject
      ON life_task_occurrences(agent_id, domain, subject_type, subject_id, state, relevance_start_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_task_occurrences_definition
      ON life_task_occurrences(definition_id, relevance_start_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_goal_definitions_agent_status
      ON life_goal_definitions(agent_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_life_goal_definitions_subject
      ON life_goal_definitions(agent_id, domain, subject_type, subject_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_life_reminder_plans_owner
      ON life_reminder_plans(agent_id, owner_type, owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_life_audit_events_owner
      ON life_audit_events(agent_id, owner_type, owner_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_activity_signals_agent
      ON life_activity_signals(agent_id, observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_life_workflow_definitions_agent
      ON life_workflow_definitions(agent_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_workflow_definitions_subject
      ON life_workflow_definitions(agent_id, domain, subject_type, subject_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_workflow_runs_workflow
      ON life_workflow_runs(agent_id, workflow_id, started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_browser_sessions_agent
      ON life_browser_sessions(agent_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_browser_sessions_subject
      ON life_browser_sessions(agent_id, domain, subject_type, subject_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_browser_companions_agent
      ON life_browser_companions(agent_id, browser, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_browser_tabs_agent
      ON life_browser_tabs(agent_id, focused_active, active_in_window, last_seen_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_browser_page_contexts_agent
      ON life_browser_page_contexts(agent_id, captured_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_goal_links_goal
      ON life_goal_links(goal_id)`,
    `CREATE INDEX IF NOT EXISTS idx_life_goal_links_linked
      ON life_goal_links(linked_type, linked_id)`,
    `CREATE INDEX IF NOT EXISTS idx_life_reminder_attempts_plan
      ON life_reminder_attempts(plan_id, owner_type, owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_life_channel_policies_agent
      ON life_channel_policies(agent_id, channel_type)`,
    `CREATE INDEX IF NOT EXISTS idx_life_website_access_grants_group
      ON life_website_access_grants(agent_id, group_key, revoked_at, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_escalation_states_agent_resolved
      ON life_escalation_states(agent_id, resolved)`,
  ] as const;

  for (const statement of statements) {
    await executeRawSql(runtime, statement);
  }

  const ownershipTables = [
    "life_task_definitions",
    "life_task_occurrences",
    "life_goal_definitions",
    "life_workflow_definitions",
    "life_browser_sessions",
  ] as const;
  const ownershipColumns = [
    {
      name: "domain",
      definition: "TEXT NOT NULL DEFAULT 'user_lifeops'",
    },
    {
      name: "subject_type",
      definition: "TEXT NOT NULL DEFAULT 'owner'",
    },
    {
      name: "subject_id",
      definition: "TEXT NOT NULL DEFAULT ''",
    },
    {
      name: "visibility_scope",
      definition: "TEXT NOT NULL DEFAULT 'owner_agent_admin'",
    },
    {
      name: "context_policy",
      definition: "TEXT NOT NULL DEFAULT 'explicit_only'",
    },
  ] as const;

  for (const tableName of ownershipTables) {
    const existingColumns = new Set(await listTableColumns(runtime, tableName));
    for (const column of ownershipColumns) {
      if (existingColumns.has(column.name)) continue;
      await executeRawSql(
        runtime,
        `ALTER TABLE ${tableName} ADD COLUMN ${column.name} ${column.definition}`,
      );
    }
    await executeRawSql(
      runtime,
      `UPDATE ${tableName}
          SET subject_id = agent_id
        WHERE subject_id = '' OR subject_id IS NULL`,
    );
  }

  const browserSessionColumns = [
    { name: "browser", definition: "TEXT" },
    { name: "companion_id", definition: "TEXT" },
    { name: "profile_id", definition: "TEXT" },
    { name: "window_id", definition: "TEXT" },
    { name: "tab_id", definition: "TEXT" },
  ] as const;
  const existingBrowserSessionColumns = new Set(
    await listTableColumns(runtime, "life_browser_sessions"),
  );
  for (const column of browserSessionColumns) {
    if (existingBrowserSessionColumns.has(column.name)) continue;
    await executeRawSql(
      runtime,
      `ALTER TABLE life_browser_sessions ADD COLUMN ${column.name} ${column.definition}`,
    );
  }

  const browserCompanionColumns = [
    { name: "pairing_token_hash", definition: "TEXT" },
    {
      name: "pending_pairing_token_hashes_json",
      definition: "TEXT NOT NULL DEFAULT '[]'",
    },
  ] as const;
  const existingBrowserCompanionColumns = new Set(
    await listTableColumns(runtime, "life_browser_companions"),
  );
  for (const column of browserCompanionColumns) {
    if (existingBrowserCompanionColumns.has(column.name)) continue;
    await executeRawSql(
      runtime,
      `ALTER TABLE life_browser_companions ADD COLUMN ${column.name} ${column.definition}`,
    );
  }

  const existingDefinitionColumns = new Set(
    await listTableColumns(runtime, "life_task_definitions"),
  );
  if (!existingDefinitionColumns.has("website_access_json")) {
    await executeRawSql(
      runtime,
      "ALTER TABLE life_task_definitions ADD COLUMN website_access_json TEXT",
    );
  }

  // Indexes reference ownership columns (see coreIndexStatements doc). Running
  // this loop before the ALTERs above used to break legacy DBs that lacked
  // domain / subject_* until migration — PGlite would fail CREATE INDEX.
  for (const statement of coreIndexStatements) {
    await executeRawSql(runtime, statement);
  }

  const existingConnectorGrantColumns = new Set(
    await listTableColumns(runtime, "life_connector_grants"),
  );
  if (
    existingConnectorGrantColumns.size > 0 &&
    !existingConnectorGrantColumns.has("side")
  ) {
    await runMigrationWithSavepoint(
      runtime,
      "migrate_connector_grants",
      async () => {
        await executeRawSql(
          runtime,
          `DROP TABLE IF EXISTS life_connector_grants_next`,
        );
        await executeRawSql(
          runtime,
          `CREATE TABLE life_connector_grants_next (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'owner',
        identity_json TEXT NOT NULL DEFAULT '{}',
        identity_email TEXT,
        granted_scopes_json TEXT NOT NULL DEFAULT '[]',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        token_ref TEXT,
        mode TEXT NOT NULL,
        execution_target TEXT NOT NULL DEFAULT 'local',
        source_of_truth TEXT NOT NULL DEFAULT 'local_storage',
        preferred_by_agent BOOLEAN NOT NULL DEFAULT FALSE,
        cloud_connection_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        last_refresh_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, provider, side, mode)
      )`,
        );
        await executeRawSql(
          runtime,
          `INSERT INTO life_connector_grants_next (
        id, agent_id, provider, side, identity_json, identity_email, granted_scopes_json,
        capabilities_json, token_ref, mode, execution_target, source_of_truth,
        preferred_by_agent, cloud_connection_id, metadata_json,
        last_refresh_at, created_at, updated_at
      )
      SELECT
        id,
        agent_id,
        provider,
        'owner',
        identity_json,
        NULL,
        granted_scopes_json,
        capabilities_json,
        token_ref,
        mode,
        'local',
        'local_storage',
        FALSE,
        NULL,
        COALESCE(metadata_json, '{}'),
        last_refresh_at,
        created_at,
        updated_at
      FROM life_connector_grants`,
        );
        await executeRawSql(runtime, `DROP TABLE life_connector_grants`);
        await executeRawSql(
          runtime,
          `ALTER TABLE life_connector_grants_next RENAME TO life_connector_grants`,
        );
      },
    );
  }

  const connectorGrantColumns = [
    {
      name: "side",
      definition: "TEXT NOT NULL DEFAULT 'owner'",
    },
    {
      name: "identity_email",
      definition: "TEXT",
    },
    {
      name: "execution_target",
      definition: "TEXT NOT NULL DEFAULT 'local'",
    },
    {
      name: "source_of_truth",
      definition: "TEXT NOT NULL DEFAULT 'local_storage'",
    },
    {
      name: "preferred_by_agent",
      definition: "BOOLEAN NOT NULL DEFAULT FALSE",
    },
    {
      name: "cloud_connection_id",
      definition: "TEXT",
    },
  ] as const;

  const refreshedConnectorGrantColumns = new Set(
    await listTableColumns(runtime, "life_connector_grants"),
  );
  for (const column of connectorGrantColumns) {
    if (refreshedConnectorGrantColumns.has(column.name)) continue;
    await executeRawSql(
      runtime,
      `ALTER TABLE life_connector_grants ADD COLUMN ${column.name} ${column.definition}`,
    );
  }

  const existingCalendarEventColumns = new Set(
    await listTableColumns(runtime, "life_calendar_events"),
  );
  if (
    existingCalendarEventColumns.size > 0 &&
    !existingCalendarEventColumns.has("side")
  ) {
    await runMigrationWithSavepoint(
      runtime,
      "migrate_calendar_events",
      async () => {
        await executeRawSql(
          runtime,
          `DROP TABLE IF EXISTS life_calendar_events_next`,
        );
        await executeRawSql(
          runtime,
          `CREATE TABLE life_calendar_events_next (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'owner',
        calendar_id TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        is_all_day BOOLEAN NOT NULL,
        timezone TEXT,
        html_link TEXT,
        conference_link TEXT,
        organizer_json TEXT,
        attendees_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, provider, side, calendar_id, external_event_id)
      )`,
        );
        await executeRawSql(
          runtime,
          `INSERT INTO life_calendar_events_next (
        id, agent_id, provider, side, calendar_id, external_event_id, title,
        description, location, status, start_at, end_at, is_all_day, timezone,
        html_link, conference_link, organizer_json, attendees_json,
        metadata_json, synced_at, updated_at
      )
      SELECT
        id, agent_id, provider, 'owner', calendar_id, external_event_id, title,
        description, location, status, start_at, end_at, is_all_day, timezone,
        html_link, conference_link, organizer_json, attendees_json,
        COALESCE(metadata_json, '{}'), synced_at, updated_at
      FROM life_calendar_events`,
        );
        await executeRawSql(runtime, `DROP TABLE life_calendar_events`);
        await executeRawSql(
          runtime,
          `ALTER TABLE life_calendar_events_next RENAME TO life_calendar_events`,
        );
      },
    );
  }

  const existingCalendarSyncStateColumns = new Set(
    await listTableColumns(runtime, "life_calendar_sync_states"),
  );
  if (
    existingCalendarSyncStateColumns.size > 0 &&
    !existingCalendarSyncStateColumns.has("side")
  ) {
    await runMigrationWithSavepoint(
      runtime,
      "migrate_calendar_sync_states",
      async () => {
        await executeRawSql(
          runtime,
          `DROP TABLE IF EXISTS life_calendar_sync_states_next`,
        );
        await executeRawSql(
          runtime,
          `CREATE TABLE life_calendar_sync_states_next (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'owner',
        calendar_id TEXT NOT NULL,
        window_start_at TEXT NOT NULL,
        window_end_at TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, provider, side, calendar_id)
      )`,
        );
        await executeRawSql(
          runtime,
          `INSERT INTO life_calendar_sync_states_next (
        id, agent_id, provider, side, calendar_id, window_start_at,
        window_end_at, synced_at, updated_at
      )
      SELECT
        id, agent_id, provider, 'owner', calendar_id, window_start_at,
        window_end_at, synced_at, updated_at
      FROM life_calendar_sync_states`,
        );
        await executeRawSql(runtime, `DROP TABLE life_calendar_sync_states`);
        await executeRawSql(
          runtime,
          `ALTER TABLE life_calendar_sync_states_next RENAME TO life_calendar_sync_states`,
        );
      },
    );
  }

  const existingGmailMessageColumns = new Set(
    await listTableColumns(runtime, "life_gmail_messages"),
  );
  if (
    existingGmailMessageColumns.size > 0 &&
    !existingGmailMessageColumns.has("side")
  ) {
    await runMigrationWithSavepoint(
      runtime,
      "migrate_gmail_messages",
      async () => {
        await executeRawSql(
          runtime,
          `DROP TABLE IF EXISTS life_gmail_messages_next`,
        );
        await executeRawSql(
          runtime,
          `CREATE TABLE life_gmail_messages_next (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'owner',
        external_message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        from_display TEXT NOT NULL DEFAULT '',
        from_email TEXT,
        reply_to TEXT,
        to_json TEXT NOT NULL DEFAULT '[]',
        cc_json TEXT NOT NULL DEFAULT '[]',
        snippet TEXT NOT NULL DEFAULT '',
        received_at TEXT NOT NULL,
        is_unread BOOLEAN NOT NULL DEFAULT FALSE,
        is_important BOOLEAN NOT NULL DEFAULT FALSE,
        likely_reply_needed BOOLEAN NOT NULL DEFAULT FALSE,
        triage_score INTEGER NOT NULL DEFAULT 0,
        triage_reason TEXT NOT NULL DEFAULT '',
        label_ids_json TEXT NOT NULL DEFAULT '[]',
        html_link TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, provider, side, external_message_id)
      )`,
        );
        await executeRawSql(
          runtime,
          `INSERT INTO life_gmail_messages_next (
        id, agent_id, provider, side, external_message_id, thread_id, subject,
        from_display, from_email, reply_to, to_json, cc_json, snippet,
        received_at, is_unread, is_important, likely_reply_needed,
        triage_score, triage_reason, label_ids_json, html_link, metadata_json,
        synced_at, updated_at
      )
      SELECT
        id, agent_id, provider, 'owner', external_message_id, thread_id,
        subject, from_display, from_email, reply_to, to_json, cc_json,
        snippet, received_at, is_unread, is_important, likely_reply_needed,
        triage_score, triage_reason, label_ids_json, html_link,
        COALESCE(metadata_json, '{}'), synced_at, updated_at
      FROM life_gmail_messages`,
        );
        await executeRawSql(runtime, `DROP TABLE life_gmail_messages`);
        await executeRawSql(
          runtime,
          `ALTER TABLE life_gmail_messages_next RENAME TO life_gmail_messages`,
        );
      },
    );
  }

  const existingGmailSyncStateColumns = new Set(
    await listTableColumns(runtime, "life_gmail_sync_states"),
  );
  if (
    existingGmailSyncStateColumns.size > 0 &&
    !existingGmailSyncStateColumns.has("side")
  ) {
    await runMigrationWithSavepoint(
      runtime,
      "migrate_gmail_sync_states",
      async () => {
        await executeRawSql(
          runtime,
          `DROP TABLE IF EXISTS life_gmail_sync_states_next`,
        );
        await executeRawSql(
          runtime,
          `CREATE TABLE life_gmail_sync_states_next (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'owner',
        mailbox TEXT NOT NULL,
        max_results INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_id, provider, side, mailbox)
      )`,
        );
        await executeRawSql(
          runtime,
          `INSERT INTO life_gmail_sync_states_next (
        id, agent_id, provider, side, mailbox, max_results, synced_at, updated_at
      )
      SELECT
        id, agent_id, provider, 'owner', mailbox, max_results, synced_at,
        updated_at
      FROM life_gmail_sync_states`,
        );
        await executeRawSql(runtime, `DROP TABLE life_gmail_sync_states`);
        await executeRawSql(
          runtime,
          `ALTER TABLE life_gmail_sync_states_next RENAME TO life_gmail_sync_states`,
        );
      },
    );
  }

  const postMigrationIndexStatements = [
    `CREATE INDEX IF NOT EXISTS idx_life_task_definitions_agent_status
      ON life_task_definitions(agent_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_life_task_definitions_subject
      ON life_task_definitions(agent_id, domain, subject_type, subject_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_life_task_occurrences_agent_state_start
      ON life_task_occurrences(agent_id, state, relevance_start_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_task_occurrences_subject
      ON life_task_occurrences(agent_id, domain, subject_type, subject_id, state, relevance_start_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_task_occurrences_definition
      ON life_task_occurrences(definition_id, relevance_start_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_goal_definitions_agent_status
      ON life_goal_definitions(agent_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_life_goal_definitions_subject
      ON life_goal_definitions(agent_id, domain, subject_type, subject_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_life_reminder_plans_owner
      ON life_reminder_plans(agent_id, owner_type, owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_life_audit_events_owner
      ON life_audit_events(agent_id, owner_type, owner_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_activity_signals_agent
      ON life_activity_signals(agent_id, observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_life_workflow_definitions_agent
      ON life_workflow_definitions(agent_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_workflow_definitions_subject
      ON life_workflow_definitions(agent_id, domain, subject_type, subject_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_workflow_runs_workflow
      ON life_workflow_runs(agent_id, workflow_id, started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_browser_sessions_agent
      ON life_browser_sessions(agent_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_browser_sessions_subject
      ON life_browser_sessions(agent_id, domain, subject_type, subject_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_goal_links_goal
      ON life_goal_links(goal_id)`,
    `CREATE INDEX IF NOT EXISTS idx_life_goal_links_linked
      ON life_goal_links(linked_type, linked_id)`,
    `CREATE INDEX IF NOT EXISTS idx_life_reminder_attempts_plan
      ON life_reminder_attempts(plan_id, owner_type, owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_life_channel_policies_agent
      ON life_channel_policies(agent_id, channel_type)`,
    `CREATE INDEX IF NOT EXISTS idx_life_website_access_grants_group
      ON life_website_access_grants(agent_id, group_key, revoked_at, expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_calendar_events_agent
      ON life_calendar_events(agent_id, provider, side)`,
    `CREATE INDEX IF NOT EXISTS idx_life_calendar_events_window
      ON life_calendar_events(agent_id, provider, side, start_at, end_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_calendar_sync_states_agent
      ON life_calendar_sync_states(agent_id, provider, side, calendar_id)`,
    `CREATE INDEX IF NOT EXISTS idx_life_gmail_messages_agent
      ON life_gmail_messages(agent_id, provider, side, triage_score DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_life_gmail_messages_priority
      ON life_gmail_messages(agent_id, provider, side, triage_score, received_at)`,
    `CREATE INDEX IF NOT EXISTS idx_life_gmail_sync_states_agent
      ON life_gmail_sync_states(agent_id, provider, side, mailbox)`,
  ] as const;

  for (const statement of postMigrationIndexStatements) {
    await executeRawSql(runtime, statement);
  }

  schemaReady.add(key);
}

async function runLifeOpsSchemaSetupWithRetry(
  runtime: IAgentRuntime,
  key: object,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await runLifeOpsSchemaSetup(runtime, key);
      return;
    } catch (error) {
      if (attempt >= 2 || !isRetryableLifeOpsStorageError(error)) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, LIFEOPS_SCHEMA_RETRY_DELAY_MS),
      );
    }
  }
}

export class LifeOpsRepository {
  constructor(private readonly runtime: IAgentRuntime) {}

  async ensureReady(): Promise<void> {
    await ensureLifeOpsTables(this.runtime);
  }

  async createDefinition(definition: LifeOpsTaskDefinition): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_task_definitions (
        id, agent_id, domain, subject_type, subject_id, visibility_scope,
        context_policy, kind, title, description, original_intent, timezone,
        status, priority, cadence_json, window_policy_json,
        progression_rule_json, website_access_json, reminder_plan_id, goal_id, source,
        metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(definition.id)},
        ${sqlQuote(definition.agentId)},
        ${sqlQuote(definition.domain)},
        ${sqlQuote(definition.subjectType)},
        ${sqlQuote(definition.subjectId)},
        ${sqlQuote(definition.visibilityScope)},
        ${sqlQuote(definition.contextPolicy)},
        ${sqlQuote(definition.kind)},
        ${sqlQuote(definition.title)},
        ${sqlQuote(definition.description)},
        ${sqlQuote(definition.originalIntent)},
        ${sqlQuote(definition.timezone)},
        ${sqlQuote(definition.status)},
        ${sqlInteger(definition.priority)},
        ${sqlJson(definition.cadence)},
        ${sqlJson(definition.windowPolicy)},
        ${sqlJson(definition.progressionRule)},
        ${sqlText(
          definition.websiteAccess
            ? JSON.stringify(definition.websiteAccess)
            : null,
        )},
        ${sqlText(definition.reminderPlanId)},
        ${sqlText(definition.goalId)},
        ${sqlQuote(definition.source)},
        ${sqlJson(definition.metadata)},
        ${sqlQuote(definition.createdAt)},
        ${sqlQuote(definition.updatedAt)}
      )`,
    );
  }

  async updateDefinition(definition: LifeOpsTaskDefinition): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `UPDATE life_task_definitions
         SET domain = ${sqlQuote(definition.domain)},
             subject_type = ${sqlQuote(definition.subjectType)},
             subject_id = ${sqlQuote(definition.subjectId)},
             visibility_scope = ${sqlQuote(definition.visibilityScope)},
             context_policy = ${sqlQuote(definition.contextPolicy)},
             title = ${sqlQuote(definition.title)},
             description = ${sqlQuote(definition.description)},
             original_intent = ${sqlQuote(definition.originalIntent)},
             timezone = ${sqlQuote(definition.timezone)},
             status = ${sqlQuote(definition.status)},
             priority = ${sqlInteger(definition.priority)},
             cadence_json = ${sqlJson(definition.cadence)},
             window_policy_json = ${sqlJson(definition.windowPolicy)},
             progression_rule_json = ${sqlJson(definition.progressionRule)},
             website_access_json = ${sqlText(
               definition.websiteAccess
                 ? JSON.stringify(definition.websiteAccess)
                 : null,
             )},
             reminder_plan_id = ${sqlText(definition.reminderPlanId)},
             goal_id = ${sqlText(definition.goalId)},
             source = ${sqlQuote(definition.source)},
             metadata_json = ${sqlJson(definition.metadata)},
             updated_at = ${sqlQuote(definition.updatedAt)}
       WHERE id = ${sqlQuote(definition.id)}
         AND agent_id = ${sqlQuote(definition.agentId)}`,
    );
  }

  async getDefinition(
    agentId: string,
    definitionId: string,
  ): Promise<LifeOpsTaskDefinition | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_task_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(definitionId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseTaskDefinition(row) : null;
  }

  async listDefinitions(agentId: string): Promise<LifeOpsTaskDefinition[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_task_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseTaskDefinition);
  }

  async listActiveDefinitions(
    agentId: string,
  ): Promise<LifeOpsTaskDefinition[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_task_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND status = 'active'
        ORDER BY created_at ASC`,
    );
    return rows.map(parseTaskDefinition);
  }

  async deleteDefinition(agentId: string, definitionId: string): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_reminder_plans
        WHERE agent_id = ${sqlQuote(agentId)}
          AND owner_type = 'definition'
          AND owner_id = ${sqlQuote(definitionId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_goal_links
        WHERE agent_id = ${sqlQuote(agentId)}
          AND linked_type = 'definition'
          AND linked_id = ${sqlQuote(definitionId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_task_occurrences
        WHERE agent_id = ${sqlQuote(agentId)}
          AND definition_id = ${sqlQuote(definitionId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_task_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(definitionId)}`,
    );
  }

  async upsertOccurrence(occurrence: LifeOpsOccurrence): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_task_occurrences (
        id, agent_id, domain, subject_type, subject_id, visibility_scope,
        context_policy, definition_id, occurrence_key, scheduled_at, due_at,
        relevance_start_at, relevance_end_at, window_name, state,
        snoozed_until, completion_payload_json, derived_target_json,
        metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(occurrence.id)},
        ${sqlQuote(occurrence.agentId)},
        ${sqlQuote(occurrence.domain)},
        ${sqlQuote(occurrence.subjectType)},
        ${sqlQuote(occurrence.subjectId)},
        ${sqlQuote(occurrence.visibilityScope)},
        ${sqlQuote(occurrence.contextPolicy)},
        ${sqlQuote(occurrence.definitionId)},
        ${sqlQuote(occurrence.occurrenceKey)},
        ${sqlText(occurrence.scheduledAt)},
        ${sqlText(occurrence.dueAt)},
        ${sqlQuote(occurrence.relevanceStartAt)},
        ${sqlQuote(occurrence.relevanceEndAt)},
        ${sqlText(occurrence.windowName)},
        ${sqlQuote(occurrence.state)},
        ${sqlText(occurrence.snoozedUntil)},
        ${occurrence.completionPayload ? sqlJson(occurrence.completionPayload) : "NULL"},
        ${occurrence.derivedTarget ? sqlJson(occurrence.derivedTarget) : "NULL"},
        ${sqlJson(occurrence.metadata)},
        ${sqlQuote(occurrence.createdAt)},
        ${sqlQuote(occurrence.updatedAt)}
      )
      ON CONFLICT(agent_id, definition_id, occurrence_key) DO UPDATE SET
        domain = excluded.domain,
        subject_type = excluded.subject_type,
        subject_id = excluded.subject_id,
        visibility_scope = excluded.visibility_scope,
        context_policy = excluded.context_policy,
        scheduled_at = excluded.scheduled_at,
        due_at = excluded.due_at,
        relevance_start_at = excluded.relevance_start_at,
        relevance_end_at = excluded.relevance_end_at,
        window_name = excluded.window_name,
        state = excluded.state,
        snoozed_until = excluded.snoozed_until,
        completion_payload_json = excluded.completion_payload_json,
        derived_target_json = excluded.derived_target_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listOccurrencesForDefinition(
    agentId: string,
    definitionId: string,
  ): Promise<LifeOpsOccurrence[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_task_occurrences
        WHERE agent_id = ${sqlQuote(agentId)}
          AND definition_id = ${sqlQuote(definitionId)}
        ORDER BY relevance_start_at ASC`,
    );
    return rows.map(parseOccurrence);
  }

  async listOccurrencesForDefinitions(
    agentId: string,
    definitionIds: string[],
  ): Promise<LifeOpsOccurrence[]> {
    await this.ensureReady();
    if (definitionIds.length === 0) {
      return [];
    }
    const definitionList = definitionIds
      .map((definitionId) => sqlQuote(definitionId))
      .join(", ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_task_occurrences
        WHERE agent_id = ${sqlQuote(agentId)}
          AND definition_id IN (${definitionList})
        ORDER BY definition_id ASC, relevance_start_at ASC`,
    );
    return rows.map(parseOccurrence);
  }

  async getOccurrence(
    agentId: string,
    occurrenceId: string,
  ): Promise<LifeOpsOccurrence | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_task_occurrences
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(occurrenceId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseOccurrence(row) : null;
  }

  async getOccurrenceView(
    agentId: string,
    occurrenceId: string,
  ): Promise<LifeOpsOccurrenceView | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT occurrence.*,
              definition.kind AS definition_kind,
              definition.status AS definition_status,
              definition.cadence_json AS definition_cadence_json,
              definition.title AS definition_title,
              definition.description AS definition_description,
              definition.priority AS definition_priority,
              definition.timezone AS definition_timezone,
              definition.source AS definition_source,
              definition.goal_id AS definition_goal_id
         FROM life_task_occurrences AS occurrence
         JOIN life_task_definitions AS definition
           ON definition.id = occurrence.definition_id
          AND definition.agent_id = occurrence.agent_id
        WHERE occurrence.agent_id = ${sqlQuote(agentId)}
          AND occurrence.id = ${sqlQuote(occurrenceId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseOccurrenceView(row) : null;
  }

  async listOccurrenceViewsForOverview(
    agentId: string,
    horizonIso: string,
  ): Promise<LifeOpsOccurrenceView[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT occurrence.*,
              definition.kind AS definition_kind,
              definition.status AS definition_status,
              definition.cadence_json AS definition_cadence_json,
              definition.title AS definition_title,
              definition.description AS definition_description,
              definition.priority AS definition_priority,
              definition.timezone AS definition_timezone,
              definition.source AS definition_source,
              definition.goal_id AS definition_goal_id
         FROM life_task_occurrences AS occurrence
         JOIN life_task_definitions AS definition
           ON definition.id = occurrence.definition_id
          AND definition.agent_id = occurrence.agent_id
        WHERE occurrence.agent_id = ${sqlQuote(agentId)}
          AND definition.status = 'active'
          AND (
            occurrence.state IN ('visible', 'snoozed')
            OR (
              occurrence.state = 'pending'
              AND occurrence.relevance_start_at <= ${sqlQuote(horizonIso)}
            )
          )
        ORDER BY occurrence.relevance_start_at ASC, definition.priority ASC`,
    );
    return rows.map(parseOccurrenceView);
  }

  async updateOccurrence(occurrence: LifeOpsOccurrence): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `UPDATE life_task_occurrences
          SET domain = ${sqlQuote(occurrence.domain)},
              subject_type = ${sqlQuote(occurrence.subjectType)},
              subject_id = ${sqlQuote(occurrence.subjectId)},
              visibility_scope = ${sqlQuote(occurrence.visibilityScope)},
              context_policy = ${sqlQuote(occurrence.contextPolicy)},
              scheduled_at = ${sqlText(occurrence.scheduledAt)},
              due_at = ${sqlText(occurrence.dueAt)},
              relevance_start_at = ${sqlQuote(occurrence.relevanceStartAt)},
              relevance_end_at = ${sqlQuote(occurrence.relevanceEndAt)},
              window_name = ${sqlText(occurrence.windowName)},
              state = ${sqlQuote(occurrence.state)},
              snoozed_until = ${sqlText(occurrence.snoozedUntil)},
              completion_payload_json = ${occurrence.completionPayload ? sqlJson(occurrence.completionPayload) : "NULL"},
              derived_target_json = ${occurrence.derivedTarget ? sqlJson(occurrence.derivedTarget) : "NULL"},
              metadata_json = ${sqlJson(occurrence.metadata)},
              updated_at = ${sqlQuote(occurrence.updatedAt)}
        WHERE id = ${sqlQuote(occurrence.id)}
          AND agent_id = ${sqlQuote(occurrence.agentId)}`,
    );
  }

  async pruneNonTerminalOccurrences(
    agentId: string,
    definitionId: string,
    keepOccurrenceKeys: string[],
  ): Promise<void> {
    await this.ensureReady();
    const keepClause =
      keepOccurrenceKeys.length > 0
        ? `AND occurrence_key NOT IN (${keepOccurrenceKeys
            .map((occurrenceKey) => sqlQuote(occurrenceKey))
            .join(", ")})`
        : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_task_occurrences
        WHERE agent_id = ${sqlQuote(agentId)}
          AND definition_id = ${sqlQuote(definitionId)}
          AND state IN ('pending', 'visible', 'snoozed', 'expired')
          ${keepClause}`,
    );
  }

  async createGoal(goal: LifeOpsGoalDefinition): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_goal_definitions (
        id, agent_id, domain, subject_type, subject_id, visibility_scope,
        context_policy, title, description, cadence_json, support_strategy_json,
        success_criteria_json, status, review_state, metadata_json,
        created_at, updated_at
      ) VALUES (
        ${sqlQuote(goal.id)},
        ${sqlQuote(goal.agentId)},
        ${sqlQuote(goal.domain)},
        ${sqlQuote(goal.subjectType)},
        ${sqlQuote(goal.subjectId)},
        ${sqlQuote(goal.visibilityScope)},
        ${sqlQuote(goal.contextPolicy)},
        ${sqlQuote(goal.title)},
        ${sqlQuote(goal.description)},
        ${goal.cadence ? sqlJson(goal.cadence) : "NULL"},
        ${sqlJson(goal.supportStrategy)},
        ${sqlJson(goal.successCriteria)},
        ${sqlQuote(goal.status)},
        ${sqlQuote(goal.reviewState)},
        ${sqlJson(goal.metadata)},
        ${sqlQuote(goal.createdAt)},
        ${sqlQuote(goal.updatedAt)}
      )`,
    );
  }

  async updateGoal(goal: LifeOpsGoalDefinition): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `UPDATE life_goal_definitions
          SET domain = ${sqlQuote(goal.domain)},
              subject_type = ${sqlQuote(goal.subjectType)},
              subject_id = ${sqlQuote(goal.subjectId)},
              visibility_scope = ${sqlQuote(goal.visibilityScope)},
              context_policy = ${sqlQuote(goal.contextPolicy)},
              title = ${sqlQuote(goal.title)},
              description = ${sqlQuote(goal.description)},
              cadence_json = ${goal.cadence ? sqlJson(goal.cadence) : "NULL"},
              support_strategy_json = ${sqlJson(goal.supportStrategy)},
              success_criteria_json = ${sqlJson(goal.successCriteria)},
              status = ${sqlQuote(goal.status)},
              review_state = ${sqlQuote(goal.reviewState)},
              metadata_json = ${sqlJson(goal.metadata)},
              updated_at = ${sqlQuote(goal.updatedAt)}
        WHERE id = ${sqlQuote(goal.id)}
          AND agent_id = ${sqlQuote(goal.agentId)}`,
    );
  }

  async getGoal(
    agentId: string,
    goalId: string,
  ): Promise<LifeOpsGoalDefinition | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_goal_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(goalId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseGoal(row) : null;
  }

  async listGoals(agentId: string): Promise<LifeOpsGoalDefinition[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_goal_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseGoal);
  }

  async deleteGoal(agentId: string, goalId: string): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_goal_links
        WHERE agent_id = ${sqlQuote(agentId)}
          AND goal_id = ${sqlQuote(goalId)}`,
    );
    await executeRawSql(
      this.runtime,
      `UPDATE life_task_definitions
         SET goal_id = NULL
       WHERE agent_id = ${sqlQuote(agentId)}
         AND goal_id = ${sqlQuote(goalId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_goal_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(goalId)}`,
    );
  }

  async upsertGoalLink(link: LifeOpsGoalLink): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_goal_links (
        id, agent_id, goal_id, linked_type, linked_id, created_at
      ) VALUES (
        ${sqlQuote(link.id)},
        ${sqlQuote(link.agentId)},
        ${sqlQuote(link.goalId)},
        ${sqlQuote(link.linkedType)},
        ${sqlQuote(link.linkedId)},
        ${sqlQuote(link.createdAt)}
      )
      ON CONFLICT(agent_id, goal_id, linked_type, linked_id) DO NOTHING`,
    );
  }

  async deleteGoalLinksForLinked(
    agentId: string,
    linkedType: LifeOpsGoalLink["linkedType"],
    linkedId: string,
  ): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_goal_links
        WHERE agent_id = ${sqlQuote(agentId)}
          AND linked_type = ${sqlQuote(linkedType)}
          AND linked_id = ${sqlQuote(linkedId)}`,
    );
  }

  async listGoalLinksForGoal(
    agentId: string,
    goalId: string,
  ): Promise<LifeOpsGoalLink[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_goal_links
        WHERE agent_id = ${sqlQuote(agentId)}
          AND goal_id = ${sqlQuote(goalId)}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseGoalLink);
  }

  async createReminderPlan(plan: LifeOpsReminderPlan): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_reminder_plans (
        id, agent_id, owner_type, owner_id, steps_json,
        mute_policy_json, quiet_hours_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(plan.id)},
        ${sqlQuote(plan.agentId)},
        ${sqlQuote(plan.ownerType)},
        ${sqlQuote(plan.ownerId)},
        ${sqlJson(plan.steps)},
        ${sqlJson(plan.mutePolicy)},
        ${sqlJson(plan.quietHours)},
        ${sqlQuote(plan.createdAt)},
        ${sqlQuote(plan.updatedAt)}
      )`,
    );
  }

  async updateReminderPlan(plan: LifeOpsReminderPlan): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `UPDATE life_reminder_plans
          SET steps_json = ${sqlJson(plan.steps)},
              mute_policy_json = ${sqlJson(plan.mutePolicy)},
              quiet_hours_json = ${sqlJson(plan.quietHours)},
              updated_at = ${sqlQuote(plan.updatedAt)}
        WHERE id = ${sqlQuote(plan.id)}
          AND agent_id = ${sqlQuote(plan.agentId)}`,
    );
  }

  async deleteReminderPlan(agentId: string, planId: string): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_reminder_plans
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(planId)}`,
    );
  }

  async getReminderPlan(
    agentId: string,
    planId: string,
  ): Promise<LifeOpsReminderPlan | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_reminder_plans
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(planId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseReminderPlan(row) : null;
  }

  async listReminderPlansForOwners(
    agentId: string,
    ownerType: string,
    ownerIds: string[],
  ): Promise<LifeOpsReminderPlan[]> {
    await this.ensureReady();
    if (ownerIds.length === 0) return [];
    const ownerList = ownerIds.map((ownerId) => sqlQuote(ownerId)).join(", ");
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_reminder_plans
        WHERE agent_id = ${sqlQuote(agentId)}
          AND owner_type = ${sqlQuote(ownerType)}
          AND owner_id IN (${ownerList})`,
    );
    return rows.map(parseReminderPlan);
  }

  async createAuditEvent(event: LifeOpsAuditEvent): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_audit_events (
        id, agent_id, event_type, owner_type, owner_id, reason,
        inputs_json, decision_json, actor, created_at
      ) VALUES (
        ${sqlQuote(event.id)},
        ${sqlQuote(event.agentId)},
        ${sqlQuote(event.eventType)},
        ${sqlQuote(event.ownerType)},
        ${sqlQuote(event.ownerId)},
        ${sqlQuote(event.reason)},
        ${sqlJson(event.inputs)},
        ${sqlJson(event.decision)},
        ${sqlQuote(event.actor)},
        ${sqlQuote(event.createdAt)}
      )`,
    );
  }

  async listAuditEvents(
    agentId: string,
    ownerType: string,
    ownerId: string,
  ): Promise<LifeOpsAuditEvent[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_audit_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND owner_type = ${sqlQuote(ownerType)}
          AND owner_id = ${sqlQuote(ownerId)}
        ORDER BY created_at DESC`,
    );
    return rows.map(parseAuditEvent);
  }

  async createActivitySignal(signal: LifeOpsActivitySignal): Promise<void> {
    await this.ensureReady();
    const metadata =
      signal.health !== null && signal.health !== undefined
        ? { ...signal.metadata, health: signal.health }
        : signal.metadata;
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_activity_signals (
        id, agent_id, source, platform, state, observed_at, idle_state,
        idle_time_seconds, on_battery, metadata_json, created_at
      ) VALUES (
        ${sqlQuote(signal.id)},
        ${sqlQuote(signal.agentId)},
        ${sqlQuote(signal.source)},
        ${sqlQuote(signal.platform)},
        ${sqlQuote(signal.state)},
        ${sqlQuote(signal.observedAt)},
        ${sqlText(signal.idleState)},
        ${sqlInteger(signal.idleTimeSeconds)},
        ${signal.onBattery === null ? "NULL" : sqlBoolean(signal.onBattery)},
        ${sqlJson(metadata)},
        ${sqlQuote(signal.createdAt)}
      )`,
    );
  }

  async listActivitySignals(
    agentId: string,
    args: {
      sinceAt?: string | null;
      limit?: number | null;
      states?: LifeOpsActivitySignal["state"][] | null;
    } = {},
  ): Promise<LifeOpsActivitySignal[]> {
    await this.ensureReady();
    const clauses = [`agent_id = ${sqlQuote(agentId)}`];
    if (args.sinceAt) {
      clauses.push(`observed_at >= ${sqlQuote(args.sinceAt)}`);
    }
    if (args.states && args.states.length > 0) {
      const stateList = args.states.map((state) => sqlQuote(state)).join(", ");
      clauses.push(`state IN (${stateList})`);
    }
    const limitClause =
      typeof args.limit === "number" && args.limit > 0
        ? `LIMIT ${Math.trunc(args.limit)}`
        : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_activity_signals
        WHERE ${clauses.join("\n          AND ")}
        ORDER BY observed_at DESC
        ${limitClause}`,
    );
    return rows.map(parseActivitySignal);
  }

  async upsertChannelPolicy(policy: LifeOpsChannelPolicy): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_channel_policies (
        id, agent_id, channel_type, channel_ref, privacy_class,
        allow_reminders, allow_escalation, allow_posts,
        require_confirmation_for_actions, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(policy.id)},
        ${sqlQuote(policy.agentId)},
        ${sqlQuote(policy.channelType)},
        ${sqlQuote(policy.channelRef)},
        ${sqlQuote(policy.privacyClass)},
        ${sqlBoolean(policy.allowReminders)},
        ${sqlBoolean(policy.allowEscalation)},
        ${sqlBoolean(policy.allowPosts)},
        ${sqlBoolean(policy.requireConfirmationForActions)},
        ${sqlJson(policy.metadata)},
        ${sqlQuote(policy.createdAt)},
        ${sqlQuote(policy.updatedAt)}
      )
      ON CONFLICT(agent_id, channel_type, channel_ref) DO UPDATE SET
        privacy_class = excluded.privacy_class,
        allow_reminders = excluded.allow_reminders,
        allow_escalation = excluded.allow_escalation,
        allow_posts = excluded.allow_posts,
        require_confirmation_for_actions = excluded.require_confirmation_for_actions,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listChannelPolicies(agentId: string): Promise<LifeOpsChannelPolicy[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_channel_policies
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseChannelPolicy);
  }

  async getChannelPolicy(
    agentId: string,
    channelType: LifeOpsChannelPolicy["channelType"],
    channelRef: string,
  ): Promise<LifeOpsChannelPolicy | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_channel_policies
        WHERE agent_id = ${sqlQuote(agentId)}
          AND channel_type = ${sqlQuote(channelType)}
          AND channel_ref = ${sqlQuote(channelRef)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseChannelPolicy(row) : null;
  }

  async upsertWebsiteAccessGrant(
    grant: LifeOpsWebsiteAccessGrant,
  ): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_website_access_grants (
        id, agent_id, group_key, definition_id, occurrence_id, websites_json,
        unlock_mode, unlock_duration_minutes, callback_key, unlocked_at,
        expires_at, revoked_at, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(grant.id)},
        ${sqlQuote(grant.agentId)},
        ${sqlQuote(grant.groupKey)},
        ${sqlQuote(grant.definitionId)},
        ${sqlText(grant.occurrenceId)},
        ${sqlJson(grant.websites)},
        ${sqlQuote(grant.unlockMode)},
        ${sqlInteger(grant.unlockDurationMinutes)},
        ${sqlText(grant.callbackKey)},
        ${sqlQuote(grant.unlockedAt)},
        ${sqlText(grant.expiresAt)},
        ${sqlText(grant.revokedAt)},
        ${sqlJson(grant.metadata)},
        ${sqlQuote(grant.createdAt)},
        ${sqlQuote(grant.updatedAt)}
      )`,
    );
  }

  async listWebsiteAccessGrants(
    agentId: string,
  ): Promise<LifeOpsWebsiteAccessGrant[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_website_access_grants
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY updated_at DESC, created_at DESC`,
    );
    return rows.map(parseWebsiteAccessGrant);
  }

  async revokeWebsiteAccessGrants(
    agentId: string,
    args: {
      groupKey?: string;
      callbackKey?: string;
      revokedAt: string;
    },
  ): Promise<void> {
    await this.ensureReady();
    const clauses = [`agent_id = ${sqlQuote(agentId)}`, "revoked_at IS NULL"];
    if (args.groupKey) {
      clauses.push(`group_key = ${sqlQuote(args.groupKey)}`);
    }
    if (args.callbackKey) {
      clauses.push(`callback_key = ${sqlQuote(args.callbackKey)}`);
    }
    await executeRawSql(
      this.runtime,
      `UPDATE life_website_access_grants
          SET revoked_at = ${sqlQuote(args.revokedAt)},
              updated_at = ${sqlQuote(args.revokedAt)}
        WHERE ${clauses.join("\n          AND ")}`,
    );
  }

  async upsertConnectorGrant(grant: LifeOpsConnectorGrant): Promise<void> {
    await this.ensureReady();
    const identityEmail = deriveConnectorIdentityEmail(grant.identity);
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_connector_grants (
        id, agent_id, provider, side, identity_json, identity_email,
        granted_scopes_json,
        capabilities_json, token_ref, mode, execution_target, source_of_truth,
        preferred_by_agent, cloud_connection_id, metadata_json,
        last_refresh_at, created_at, updated_at
      ) VALUES (
        ${sqlQuote(grant.id)},
        ${sqlQuote(grant.agentId)},
        ${sqlQuote(grant.provider)},
        ${sqlQuote(grant.side)},
        ${sqlJson(grant.identity)},
        ${sqlText(identityEmail)},
        ${sqlJson(grant.grantedScopes)},
        ${sqlJson(grant.capabilities)},
        ${sqlText(grant.tokenRef)},
        ${sqlQuote(grant.mode)},
        ${sqlQuote(grant.executionTarget)},
        ${sqlQuote(grant.sourceOfTruth)},
        ${sqlBoolean(grant.preferredByAgent)},
        ${sqlText(grant.cloudConnectionId)},
        ${sqlJson(grant.metadata)},
        ${sqlText(grant.lastRefreshAt)},
        ${sqlQuote(grant.createdAt)},
        ${sqlQuote(grant.updatedAt)}
      )
      ON CONFLICT(agent_id, provider, side, mode) DO UPDATE SET
        identity_json = excluded.identity_json,
        identity_email = excluded.identity_email,
        granted_scopes_json = excluded.granted_scopes_json,
        capabilities_json = excluded.capabilities_json,
        token_ref = excluded.token_ref,
        execution_target = excluded.execution_target,
        source_of_truth = excluded.source_of_truth,
        preferred_by_agent = excluded.preferred_by_agent,
        cloud_connection_id = excluded.cloud_connection_id,
        metadata_json = excluded.metadata_json,
        last_refresh_at = excluded.last_refresh_at,
        updated_at = excluded.updated_at`,
    );
  }

  async listConnectorGrants(agentId: string): Promise<LifeOpsConnectorGrant[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_connector_grants
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseConnectorGrant);
  }

  async getConnectorGrant(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    mode: LifeOpsConnectorGrant["mode"],
    side: LifeOpsConnectorSide = "owner",
  ): Promise<LifeOpsConnectorGrant | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
        FROM life_connector_grants
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND side = ${sqlQuote(side)}
          AND mode = ${sqlQuote(mode)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseConnectorGrant(row) : null;
  }

  async deleteConnectorGrant(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    mode?: LifeOpsConnectorGrant["mode"],
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    await this.ensureReady();
    const modeClause = mode ? `AND mode = ${sqlQuote(mode)}` : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_connector_grants
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${modeClause}
          ${sideClause}`,
    );
  }

  async upsertCalendarEvent(
    event: LifeOpsCalendarEvent,
    side: LifeOpsConnectorSide = event.side,
  ): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_calendar_events (
        id, agent_id, provider, side, calendar_id, external_event_id, title,
        description, location, status, start_at, end_at, is_all_day,
        timezone, html_link, conference_link, organizer_json,
        attendees_json, metadata_json, synced_at, updated_at
      ) VALUES (
        ${sqlQuote(event.id)},
        ${sqlQuote(event.agentId)},
        ${sqlQuote(event.provider)},
        ${sqlQuote(side)},
        ${sqlQuote(event.calendarId)},
        ${sqlQuote(event.externalId)},
        ${sqlQuote(event.title)},
        ${sqlQuote(event.description)},
        ${sqlQuote(event.location)},
        ${sqlQuote(event.status)},
        ${sqlQuote(event.startAt)},
        ${sqlQuote(event.endAt)},
        ${sqlBoolean(event.isAllDay)},
        ${sqlText(event.timezone)},
        ${sqlText(event.htmlLink)},
        ${sqlText(event.conferenceLink)},
        ${event.organizer ? sqlJson(event.organizer) : "NULL"},
        ${sqlJson(event.attendees)},
        ${sqlJson(event.metadata)},
        ${sqlQuote(event.syncedAt)},
        ${sqlQuote(event.updatedAt)}
      )
      ON CONFLICT(agent_id, provider, side, calendar_id, external_event_id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        location = excluded.location,
        status = excluded.status,
        start_at = excluded.start_at,
        end_at = excluded.end_at,
        is_all_day = excluded.is_all_day,
        timezone = excluded.timezone,
        html_link = excluded.html_link,
        conference_link = excluded.conference_link,
        organizer_json = excluded.organizer_json,
        attendees_json = excluded.attendees_json,
        metadata_json = excluded.metadata_json,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async deleteCalendarEventsForProvider(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId?: string,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    await this.ensureReady();
    const calendarClause = calendarId
      ? `AND calendar_id = ${sqlQuote(calendarId)}`
      : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${calendarClause}
          ${sideClause}`,
    );
  }

  async deleteCalendarEventByExternalId(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId: string,
    externalEventId: string,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    await this.ensureReady();
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND calendar_id = ${sqlQuote(calendarId)}
          AND external_event_id = ${sqlQuote(externalEventId)}
          ${sideClause}`,
    );
  }

  async pruneCalendarEventsInWindow(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId: string,
    timeMin: string,
    timeMax: string,
    keepExternalIds: readonly string[],
    side: LifeOpsConnectorSide = "owner",
  ): Promise<void> {
    await this.ensureReady();
    const keepClause =
      keepExternalIds.length > 0
        ? `AND external_event_id NOT IN (${keepExternalIds
            .map((externalId) => sqlQuote(externalId))
            .join(", ")})`
        : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND side = ${sqlQuote(side)}
          AND calendar_id = ${sqlQuote(calendarId)}
          AND end_at > ${sqlQuote(timeMin)}
          AND start_at < ${sqlQuote(timeMax)}
          ${keepClause}`,
    );
  }

  async listCalendarEvents(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    timeMin?: string,
    timeMax?: string,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsCalendarEvent[]> {
    await this.ensureReady();
    const timeMinClause = timeMin ? `AND end_at > ${sqlQuote(timeMin)}` : "";
    const timeMaxClause = timeMax ? `AND start_at < ${sqlQuote(timeMax)}` : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${timeMinClause}
          ${timeMaxClause}
        ORDER BY start_at ASC`,
    );
    return rows.map(parseCalendarEvent);
  }

  async upsertCalendarSyncState(
    state: LifeOpsCalendarSyncState,
  ): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_calendar_sync_states (
        id, agent_id, provider, side, calendar_id, window_start_at,
        window_end_at, synced_at, updated_at
      ) VALUES (
        ${sqlQuote(state.id)},
        ${sqlQuote(state.agentId)},
        ${sqlQuote(state.provider)},
        ${sqlQuote(state.side)},
        ${sqlQuote(state.calendarId)},
        ${sqlQuote(state.windowStartAt)},
        ${sqlQuote(state.windowEndAt)},
        ${sqlQuote(state.syncedAt)},
        ${sqlQuote(state.updatedAt)}
      )
      ON CONFLICT(agent_id, provider, side, calendar_id) DO UPDATE SET
        window_start_at = excluded.window_start_at,
        window_end_at = excluded.window_end_at,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async getCalendarSyncState(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId: string,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsCalendarSyncState | null> {
    await this.ensureReady();
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_calendar_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND calendar_id = ${sqlQuote(calendarId)}
          ${sideClause}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseCalendarSyncState(row) : null;
  }

  async deleteCalendarSyncState(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    calendarId?: string,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    await this.ensureReady();
    const calendarClause = calendarId
      ? `AND calendar_id = ${sqlQuote(calendarId)}`
      : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_calendar_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${calendarClause}
          ${sideClause}`,
    );
  }

  async upsertGmailMessage(
    message: LifeOpsGmailMessageSummary,
    side: LifeOpsConnectorSide = message.side,
  ): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_gmail_messages (
        id, agent_id, provider, side, external_message_id, thread_id, subject,
        from_display, from_email, reply_to, to_json, cc_json, snippet,
        received_at, is_unread, is_important, likely_reply_needed,
        triage_score, triage_reason, label_ids_json, html_link, metadata_json,
        synced_at, updated_at
      ) VALUES (
        ${sqlQuote(message.id)},
        ${sqlQuote(message.agentId)},
        ${sqlQuote(message.provider)},
        ${sqlQuote(side)},
        ${sqlQuote(message.externalId)},
        ${sqlQuote(message.threadId)},
        ${sqlQuote(message.subject)},
        ${sqlQuote(message.from)},
        ${sqlText(message.fromEmail)},
        ${sqlText(message.replyTo)},
        ${sqlJson(message.to)},
        ${sqlJson(message.cc)},
        ${sqlQuote(message.snippet)},
        ${sqlQuote(message.receivedAt)},
        ${sqlBoolean(message.isUnread)},
        ${sqlBoolean(message.isImportant)},
        ${sqlBoolean(message.likelyReplyNeeded)},
        ${sqlInteger(message.triageScore)},
        ${sqlQuote(message.triageReason)},
        ${sqlJson(message.labels)},
        ${sqlText(message.htmlLink)},
        ${sqlJson(message.metadata)},
        ${sqlQuote(message.syncedAt)},
        ${sqlQuote(message.updatedAt)}
      )
      ON CONFLICT(agent_id, provider, side, external_message_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        subject = excluded.subject,
        from_display = excluded.from_display,
        from_email = excluded.from_email,
        reply_to = excluded.reply_to,
        to_json = excluded.to_json,
        cc_json = excluded.cc_json,
        snippet = excluded.snippet,
        received_at = excluded.received_at,
        is_unread = excluded.is_unread,
        is_important = excluded.is_important,
        likely_reply_needed = excluded.likely_reply_needed,
        triage_score = excluded.triage_score,
        triage_reason = excluded.triage_reason,
        label_ids_json = excluded.label_ids_json,
        html_link = excluded.html_link,
        metadata_json = excluded.metadata_json,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async pruneGmailMessages(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    keepExternalIds: readonly string[],
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    await this.ensureReady();
    const keepClause =
      keepExternalIds.length > 0
        ? `AND external_message_id NOT IN (${keepExternalIds
            .map((externalId) => sqlQuote(externalId))
            .join(", ")})`
        : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_gmail_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${keepClause}`,
    );
  }

  async listGmailMessages(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    options?: {
      maxResults?: number;
      threadId?: string;
      since?: string;
    },
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGmailMessageSummary[]> {
    await this.ensureReady();
    const DEFAULT_GMAIL_LIST_LIMIT = 200;
    const limit =
      options?.maxResults !== undefined && Number.isFinite(options.maxResults)
        ? options.maxResults
        : DEFAULT_GMAIL_LIST_LIMIT;
    const maxResultsClause = `LIMIT ${sqlInteger(limit)}`;
    const threadClause = options?.threadId
      ? `AND thread_id = ${sqlQuote(options.threadId)}`
      : "";
    const sinceClause = options?.since
      ? `AND received_at >= ${sqlQuote(options.since)}`
      : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_gmail_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${threadClause}
          ${sinceClause}
        ORDER BY triage_score DESC, received_at DESC
        ${maxResultsClause}`,
    );
    return rows.map(parseGmailMessageSummary);
  }

  async getGmailMessage(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    messageId: string,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGmailMessageSummary | null> {
    await this.ensureReady();
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_gmail_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          AND id = ${sqlQuote(messageId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseGmailMessageSummary(row) : null;
  }

  async deleteGmailMessagesForProvider(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    await this.ensureReady();
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_gmail_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}`,
    );
  }

  async upsertGmailSyncState(state: LifeOpsGmailSyncState): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_gmail_sync_states (
        id, agent_id, provider, side, mailbox, max_results, synced_at, updated_at
      ) VALUES (
        ${sqlQuote(state.id)},
        ${sqlQuote(state.agentId)},
        ${sqlQuote(state.provider)},
        ${sqlQuote(state.side)},
        ${sqlQuote(state.mailbox)},
        ${sqlInteger(state.maxResults)},
        ${sqlQuote(state.syncedAt)},
        ${sqlQuote(state.updatedAt)}
      )
      ON CONFLICT(agent_id, provider, side, mailbox) DO UPDATE SET
        max_results = excluded.max_results,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async getGmailSyncState(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    mailbox: string,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGmailSyncState | null> {
    await this.ensureReady();
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_gmail_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          AND mailbox = ${sqlQuote(mailbox)}
          ${sideClause}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseGmailSyncState(row) : null;
  }

  async deleteGmailSyncState(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    mailbox?: string,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    await this.ensureReady();
    const mailboxClause = mailbox ? `AND mailbox = ${sqlQuote(mailbox)}` : "";
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_gmail_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${mailboxClause}
          ${sideClause}`,
    );
  }

  async createWorkflow(definition: LifeOpsWorkflowDefinition): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_workflow_definitions (
        id, agent_id, domain, subject_type, subject_id, visibility_scope,
        context_policy, title, trigger_type, schedule_json, action_plan_json,
        permission_policy_json, status, created_by, metadata_json,
        created_at, updated_at
      ) VALUES (
        ${sqlQuote(definition.id)},
        ${sqlQuote(definition.agentId)},
        ${sqlQuote(definition.domain)},
        ${sqlQuote(definition.subjectType)},
        ${sqlQuote(definition.subjectId)},
        ${sqlQuote(definition.visibilityScope)},
        ${sqlQuote(definition.contextPolicy)},
        ${sqlQuote(definition.title)},
        ${sqlQuote(definition.triggerType)},
        ${sqlJson(definition.schedule)},
        ${sqlJson(definition.actionPlan)},
        ${sqlJson(definition.permissionPolicy)},
        ${sqlQuote(definition.status)},
        ${sqlQuote(definition.createdBy)},
        ${sqlJson(definition.metadata)},
        ${sqlQuote(definition.createdAt)},
        ${sqlQuote(definition.updatedAt)}
      )`,
    );
  }

  async updateWorkflow(definition: LifeOpsWorkflowDefinition): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `UPDATE life_workflow_definitions
          SET domain = ${sqlQuote(definition.domain)},
              subject_type = ${sqlQuote(definition.subjectType)},
              subject_id = ${sqlQuote(definition.subjectId)},
              visibility_scope = ${sqlQuote(definition.visibilityScope)},
              context_policy = ${sqlQuote(definition.contextPolicy)},
              title = ${sqlQuote(definition.title)},
              trigger_type = ${sqlQuote(definition.triggerType)},
              schedule_json = ${sqlJson(definition.schedule)},
              action_plan_json = ${sqlJson(definition.actionPlan)},
              permission_policy_json = ${sqlJson(definition.permissionPolicy)},
              status = ${sqlQuote(definition.status)},
              metadata_json = ${sqlJson(definition.metadata)},
              updated_at = ${sqlQuote(definition.updatedAt)}
        WHERE id = ${sqlQuote(definition.id)}
          AND agent_id = ${sqlQuote(definition.agentId)}`,
    );
  }

  async listWorkflows(agentId: string): Promise<LifeOpsWorkflowDefinition[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_workflow_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY updated_at DESC, created_at DESC`,
    );
    return rows.map(parseWorkflowDefinition);
  }

  async deleteWorkflow(agentId: string, workflowId: string): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_workflow_runs
        WHERE agent_id = ${sqlQuote(agentId)}
          AND workflow_id = ${sqlQuote(workflowId)}`,
    );
    await executeRawSql(
      this.runtime,
      `UPDATE life_browser_sessions
         SET workflow_id = NULL
       WHERE agent_id = ${sqlQuote(agentId)}
         AND workflow_id = ${sqlQuote(workflowId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_workflow_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(workflowId)}`,
    );
  }

  async getWorkflow(
    agentId: string,
    workflowId: string,
  ): Promise<LifeOpsWorkflowDefinition | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_workflow_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(workflowId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseWorkflowDefinition(row) : null;
  }

  async createWorkflowRun(run: LifeOpsWorkflowRun): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_workflow_runs (
        id, agent_id, workflow_id, started_at, finished_at, status,
        result_json, audit_ref
      ) VALUES (
        ${sqlQuote(run.id)},
        ${sqlQuote(run.agentId)},
        ${sqlQuote(run.workflowId)},
        ${sqlQuote(run.startedAt)},
        ${sqlText(run.finishedAt)},
        ${sqlQuote(run.status)},
        ${sqlJson(run.result)},
        ${sqlText(run.auditRef)}
      )`,
    );
  }

  async listWorkflowRuns(
    agentId: string,
    workflowId: string,
  ): Promise<LifeOpsWorkflowRun[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_workflow_runs
        WHERE agent_id = ${sqlQuote(agentId)}
          AND workflow_id = ${sqlQuote(workflowId)}
        ORDER BY started_at DESC`,
    );
    return rows.map(parseWorkflowRun);
  }

  async createReminderAttempt(attempt: LifeOpsReminderAttempt): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_reminder_attempts (
        id, agent_id, plan_id, owner_type, owner_id, occurrence_id,
        channel, step_index, scheduled_for, attempted_at, outcome,
        connector_ref, delivery_metadata_json
      ) VALUES (
        ${sqlQuote(attempt.id)},
        ${sqlQuote(attempt.agentId)},
        ${sqlQuote(attempt.planId)},
        ${sqlQuote(attempt.ownerType)},
        ${sqlQuote(attempt.ownerId)},
        ${sqlText(attempt.occurrenceId)},
        ${sqlQuote(attempt.channel)},
        ${sqlInteger(attempt.stepIndex)},
        ${sqlQuote(attempt.scheduledFor)},
        ${sqlText(attempt.attemptedAt)},
        ${sqlQuote(attempt.outcome)},
        ${sqlText(attempt.connectorRef)},
        ${sqlJson(attempt.deliveryMetadata)}
      )`,
    );
  }

  async listReminderAttempts(
    agentId: string,
    options?: {
      ownerType?: LifeOpsReminderAttempt["ownerType"];
      ownerId?: string;
      planId?: string;
    },
  ): Promise<LifeOpsReminderAttempt[]> {
    await this.ensureReady();
    const ownerTypeClause = options?.ownerType
      ? `AND owner_type = ${sqlQuote(options.ownerType)}`
      : "";
    const ownerIdClause = options?.ownerId
      ? `AND owner_id = ${sqlQuote(options.ownerId)}`
      : "";
    const planIdClause = options?.planId
      ? `AND plan_id = ${sqlQuote(options.planId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_reminder_attempts
        WHERE agent_id = ${sqlQuote(agentId)}
          ${ownerTypeClause}
          ${ownerIdClause}
          ${planIdClause}
        ORDER BY scheduled_for ASC, step_index ASC, attempted_at ASC`,
    );
    return rows.map(parseReminderAttempt);
  }

  async updateReminderAttemptOutcome(
    id: string,
    outcome: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureReady();
    if (metadata && Object.keys(metadata).length > 0) {
      await executeRawSql(
        this.runtime,
        `UPDATE life_reminder_attempts
            SET outcome = ${sqlQuote(outcome)},
                delivery_metadata_json = delivery_metadata_json::jsonb || ${sqlJson(metadata)}::jsonb
          WHERE id = ${sqlQuote(id)}`,
      );
    } else {
      await executeRawSql(
        this.runtime,
        `UPDATE life_reminder_attempts
            SET outcome = ${sqlQuote(outcome)}
          WHERE id = ${sqlQuote(id)}`,
      );
    }
  }

  async createBrowserSession(session: LifeOpsBrowserSession): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_browser_sessions (
        id, agent_id, domain, subject_type, subject_id, visibility_scope,
        context_policy, workflow_id, browser, companion_id, profile_id,
        window_id, tab_id, title, status, actions_json,
        current_action_index, awaiting_confirmation_for_action_id,
        result_json, metadata_json, created_at, updated_at, finished_at
      ) VALUES (
        ${sqlQuote(session.id)},
        ${sqlQuote(session.agentId)},
        ${sqlQuote(session.domain)},
        ${sqlQuote(session.subjectType)},
        ${sqlQuote(session.subjectId)},
        ${sqlQuote(session.visibilityScope)},
        ${sqlQuote(session.contextPolicy)},
        ${sqlText(session.workflowId)},
        ${sqlText(session.browser)},
        ${sqlText(session.companionId)},
        ${sqlText(session.profileId)},
        ${sqlText(session.windowId)},
        ${sqlText(session.tabId)},
        ${sqlQuote(session.title)},
        ${sqlQuote(session.status)},
        ${sqlJson(session.actions)},
        ${sqlInteger(session.currentActionIndex)},
        ${sqlText(session.awaitingConfirmationForActionId)},
        ${sqlJson(session.result)},
        ${sqlJson(session.metadata)},
        ${sqlQuote(session.createdAt)},
        ${sqlQuote(session.updatedAt)},
        ${sqlText(session.finishedAt)}
      )`,
    );
  }

  async updateBrowserSession(session: LifeOpsBrowserSession): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `UPDATE life_browser_sessions
          SET domain = ${sqlQuote(session.domain)},
              subject_type = ${sqlQuote(session.subjectType)},
              subject_id = ${sqlQuote(session.subjectId)},
              visibility_scope = ${sqlQuote(session.visibilityScope)},
              context_policy = ${sqlQuote(session.contextPolicy)},
              workflow_id = ${sqlText(session.workflowId)},
              browser = ${sqlText(session.browser)},
              companion_id = ${sqlText(session.companionId)},
              profile_id = ${sqlText(session.profileId)},
              window_id = ${sqlText(session.windowId)},
              tab_id = ${sqlText(session.tabId)},
              title = ${sqlQuote(session.title)},
              status = ${sqlQuote(session.status)},
              actions_json = ${sqlJson(session.actions)},
              current_action_index = ${sqlInteger(session.currentActionIndex)},
              awaiting_confirmation_for_action_id = ${sqlText(session.awaitingConfirmationForActionId)},
              result_json = ${sqlJson(session.result)},
              metadata_json = ${sqlJson(session.metadata)},
              updated_at = ${sqlQuote(session.updatedAt)},
              finished_at = ${sqlText(session.finishedAt)}
        WHERE id = ${sqlQuote(session.id)}
          AND agent_id = ${sqlQuote(session.agentId)}`,
    );
  }

  async getBrowserSession(
    agentId: string,
    sessionId: string,
  ): Promise<LifeOpsBrowserSession | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_browser_sessions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(sessionId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseBrowserSession(row) : null;
  }

  async listBrowserSessions(agentId: string): Promise<LifeOpsBrowserSession[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_browser_sessions
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY updated_at DESC, created_at DESC`,
    );
    return rows.map(parseBrowserSession);
  }

  async getBrowserSettings(
    agentId: string,
  ): Promise<LifeOpsBrowserSettings | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_browser_settings
        WHERE agent_id = ${sqlQuote(agentId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseBrowserSettings(row) : null;
  }

  async upsertBrowserSettings(
    agentId: string,
    settings: LifeOpsBrowserSettings,
  ): Promise<void> {
    await this.ensureReady();
    const createdAt = settings.updatedAt ?? isoNow();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_browser_settings (
        agent_id, enabled, tracking_mode, allow_browser_control,
        require_confirmation_for_account_affecting, incognito_enabled,
        site_access_mode, granted_origins_json, blocked_origins_json,
        max_remembered_tabs, pause_until, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(agentId)},
        ${sqlBoolean(settings.enabled)},
        ${sqlQuote(settings.trackingMode)},
        ${sqlBoolean(settings.allowBrowserControl)},
        ${sqlBoolean(settings.requireConfirmationForAccountAffecting)},
        ${sqlBoolean(settings.incognitoEnabled)},
        ${sqlQuote(settings.siteAccessMode)},
        ${sqlJson(settings.grantedOrigins)},
        ${sqlJson(settings.blockedOrigins)},
        ${sqlInteger(settings.maxRememberedTabs)},
        ${sqlText(settings.pauseUntil)},
        ${sqlJson(settings.metadata)},
        ${sqlQuote(createdAt)},
        ${sqlQuote(settings.updatedAt ?? createdAt)}
      )
      ON CONFLICT(agent_id) DO UPDATE SET
        enabled = excluded.enabled,
        tracking_mode = excluded.tracking_mode,
        allow_browser_control = excluded.allow_browser_control,
        require_confirmation_for_account_affecting = excluded.require_confirmation_for_account_affecting,
        incognito_enabled = excluded.incognito_enabled,
        site_access_mode = excluded.site_access_mode,
        granted_origins_json = excluded.granted_origins_json,
        blocked_origins_json = excluded.blocked_origins_json,
        max_remembered_tabs = excluded.max_remembered_tabs,
        pause_until = excluded.pause_until,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async getBrowserCompanionByProfile(
    agentId: string,
    browser: LifeOpsBrowserCompanionStatus["browser"],
    profileId: string,
  ): Promise<LifeOpsBrowserCompanionStatus | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_browser_companions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND browser = ${sqlQuote(browser)}
          AND profile_id = ${sqlQuote(profileId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseBrowserCompanion(row) : null;
  }

  async getBrowserCompanionCredential(
    agentId: string,
    companionId: string,
  ): Promise<BrowserCompanionCredential | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_browser_companions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(companionId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseBrowserCompanionCredential(row) : null;
  }

  async upsertBrowserCompanion(
    companion: LifeOpsBrowserCompanionStatus,
  ): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_browser_companions (
        id, agent_id, browser, profile_id, profile_label, label,
        extension_version, connection_state, permissions_json, last_seen_at,
        paired_at, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(companion.id)},
        ${sqlQuote(companion.agentId)},
        ${sqlQuote(companion.browser)},
        ${sqlQuote(companion.profileId)},
        ${sqlQuote(companion.profileLabel)},
        ${sqlQuote(companion.label)},
        ${sqlText(companion.extensionVersion)},
        ${sqlQuote(companion.connectionState)},
        ${sqlJson(companion.permissions)},
        ${sqlText(companion.lastSeenAt)},
        ${sqlText(companion.pairedAt)},
        ${sqlJson(companion.metadata)},
        ${sqlQuote(companion.createdAt)},
        ${sqlQuote(companion.updatedAt)}
      )
      ON CONFLICT(agent_id, browser, profile_id) DO UPDATE SET
        profile_label = excluded.profile_label,
        label = excluded.label,
        extension_version = excluded.extension_version,
        connection_state = excluded.connection_state,
        permissions_json = excluded.permissions_json,
        last_seen_at = excluded.last_seen_at,
        paired_at = COALESCE(life_browser_companions.paired_at, excluded.paired_at),
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async updateBrowserCompanionPairingToken(
    agentId: string,
    companionId: string,
    pairingTokenHash: string,
    pairedAt: string,
    updatedAt: string,
  ): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `UPDATE life_browser_companions
          SET pairing_token_hash = ${sqlQuote(pairingTokenHash)},
              pending_pairing_token_hashes_json = '[]',
              paired_at = ${sqlQuote(pairedAt)},
              updated_at = ${sqlQuote(updatedAt)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(companionId)}`,
    );
  }

  async updateBrowserCompanionPendingPairingTokenHashes(
    agentId: string,
    companionId: string,
    pendingPairingTokenHashes: string[],
    updatedAt: string,
  ): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `UPDATE life_browser_companions
          SET pending_pairing_token_hashes_json = ${sqlJson(pendingPairingTokenHashes)},
              updated_at = ${sqlQuote(updatedAt)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(companionId)}`,
    );
  }

  async promoteBrowserCompanionPendingPairingToken(
    agentId: string,
    companionId: string,
    pairingTokenHash: string,
    pendingPairingTokenHashes: string[],
    pairedAt: string,
    updatedAt: string,
  ): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `UPDATE life_browser_companions
          SET pairing_token_hash = ${sqlQuote(pairingTokenHash)},
              pending_pairing_token_hashes_json = ${sqlJson(pendingPairingTokenHashes)},
              paired_at = ${sqlQuote(pairedAt)},
              updated_at = ${sqlQuote(updatedAt)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(companionId)}`,
    );
  }

  async listBrowserCompanions(
    agentId: string,
  ): Promise<LifeOpsBrowserCompanionStatus[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_browser_companions
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY browser ASC, profile_label ASC, label ASC`,
    );
    return rows.map(parseBrowserCompanion);
  }

  async upsertBrowserTab(tab: LifeOpsBrowserTabSummary): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_browser_tabs (
        id, agent_id, companion_id, browser, profile_id, window_id, tab_id,
        url, title, active_in_window, focused_window, focused_active,
        incognito, favicon_url, last_seen_at, last_focused_at, metadata_json,
        created_at, updated_at
      ) VALUES (
        ${sqlQuote(tab.id)},
        ${sqlQuote(tab.agentId)},
        ${sqlText(tab.companionId)},
        ${sqlQuote(tab.browser)},
        ${sqlQuote(tab.profileId)},
        ${sqlQuote(tab.windowId)},
        ${sqlQuote(tab.tabId)},
        ${sqlQuote(tab.url)},
        ${sqlQuote(tab.title)},
        ${sqlBoolean(tab.activeInWindow)},
        ${sqlBoolean(tab.focusedWindow)},
        ${sqlBoolean(tab.focusedActive)},
        ${sqlBoolean(tab.incognito)},
        ${sqlText(tab.faviconUrl)},
        ${sqlQuote(tab.lastSeenAt)},
        ${sqlText(tab.lastFocusedAt)},
        ${sqlJson(tab.metadata)},
        ${sqlQuote(tab.createdAt)},
        ${sqlQuote(tab.updatedAt)}
      )
      ON CONFLICT(agent_id, browser, profile_id, window_id, tab_id) DO UPDATE SET
        companion_id = excluded.companion_id,
        url = excluded.url,
        title = excluded.title,
        active_in_window = excluded.active_in_window,
        focused_window = excluded.focused_window,
        focused_active = excluded.focused_active,
        incognito = excluded.incognito,
        favicon_url = excluded.favicon_url,
        last_seen_at = excluded.last_seen_at,
        last_focused_at = excluded.last_focused_at,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listBrowserTabs(agentId: string): Promise<LifeOpsBrowserTabSummary[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_browser_tabs
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY focused_active DESC,
                 active_in_window DESC,
                 COALESCE(last_focused_at, last_seen_at) DESC,
                 updated_at DESC`,
    );
    return rows.map(parseBrowserTabSummary);
  }

  async deleteBrowserTabsByIds(agentId: string, ids: string[]): Promise<void> {
    await this.ensureReady();
    if (ids.length === 0) return;
    const values = ids.map((id) => sqlQuote(id)).join(", ");
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_browser_tabs
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id IN (${values})`,
    );
  }

  async deleteAllBrowserTabs(agentId: string): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_browser_tabs
        WHERE agent_id = ${sqlQuote(agentId)}`,
    );
  }

  async upsertBrowserPageContext(
    context: LifeOpsBrowserPageContext,
  ): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_browser_page_contexts (
        id, agent_id, browser, profile_id, window_id, tab_id, url, title,
        selection_text, main_text, headings_json, links_json, forms_json,
        captured_at, metadata_json
      ) VALUES (
        ${sqlQuote(context.id)},
        ${sqlQuote(context.agentId)},
        ${sqlQuote(context.browser)},
        ${sqlQuote(context.profileId)},
        ${sqlQuote(context.windowId)},
        ${sqlQuote(context.tabId)},
        ${sqlQuote(context.url)},
        ${sqlQuote(context.title)},
        ${sqlText(context.selectionText)},
        ${sqlText(context.mainText)},
        ${sqlJson(context.headings)},
        ${sqlJson(context.links)},
        ${sqlJson(context.forms)},
        ${sqlQuote(context.capturedAt)},
        ${sqlJson(context.metadata)}
      )
      ON CONFLICT(agent_id, browser, profile_id, window_id, tab_id) DO UPDATE SET
        url = excluded.url,
        title = excluded.title,
        selection_text = excluded.selection_text,
        main_text = excluded.main_text,
        headings_json = excluded.headings_json,
        links_json = excluded.links_json,
        forms_json = excluded.forms_json,
        captured_at = excluded.captured_at,
        metadata_json = excluded.metadata_json`,
    );
  }

  async listBrowserPageContexts(
    agentId: string,
  ): Promise<LifeOpsBrowserPageContext[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_browser_page_contexts
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY captured_at DESC`,
    );
    return rows.map(parseBrowserPageContext);
  }

  async deleteBrowserPageContextsByIds(
    agentId: string,
    ids: string[],
  ): Promise<void> {
    await this.ensureReady();
    if (ids.length === 0) return;
    const values = ids.map((id) => sqlQuote(id)).join(", ");
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_browser_page_contexts
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id IN (${values})`,
    );
  }

  async deleteAllBrowserPageContexts(agentId: string): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_browser_page_contexts
        WHERE agent_id = ${sqlQuote(agentId)}`,
    );
  }

  async deleteBrowserSession(
    agentId: string,
    sessionId: string,
  ): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_browser_sessions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(sessionId)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Escalation state persistence
  // ---------------------------------------------------------------------------

  async upsertEscalationState(state: {
    id: string;
    agentId: string;
    reason: string;
    text: string;
    currentStep: number;
    channelsSent: string[];
    startedAt: string;
    lastSentAt: string;
    resolved: boolean;
    resolvedAt?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.ensureReady();
    const now = isoNow();
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_escalation_states (
        id, agent_id, reason, text, current_step,
        channels_sent_json, started_at, last_sent_at,
        resolved, resolved_at, metadata_json,
        created_at, updated_at
      ) VALUES (
        ${sqlQuote(state.id)},
        ${sqlQuote(state.agentId)},
        ${sqlQuote(state.reason)},
        ${sqlQuote(state.text)},
        ${sqlInteger(state.currentStep)},
        ${sqlJson(state.channelsSent)},
        ${sqlQuote(state.startedAt)},
        ${sqlQuote(state.lastSentAt)},
        ${sqlBoolean(state.resolved)},
        ${sqlText(state.resolvedAt)},
        ${sqlJson(state.metadata ?? {})},
        ${sqlQuote(now)},
        ${sqlQuote(now)}
      )
      ON CONFLICT(id) DO UPDATE SET
        reason = excluded.reason,
        text = excluded.text,
        current_step = excluded.current_step,
        channels_sent_json = excluded.channels_sent_json,
        last_sent_at = excluded.last_sent_at,
        resolved = excluded.resolved,
        resolved_at = excluded.resolved_at,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async getActiveEscalationState(
    agentId: string,
  ): Promise<LifeOpsEscalationStateRow | null> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_escalation_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND resolved = FALSE
        ORDER BY started_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseEscalationStateRow(row) : null;
  }

  async resolveEscalationState(id: string, resolvedAt: string): Promise<void> {
    await this.ensureReady();
    const now = isoNow();
    await executeRawSql(
      this.runtime,
      `UPDATE life_escalation_states
         SET resolved = TRUE,
             resolved_at = ${sqlQuote(resolvedAt)},
             updated_at = ${sqlQuote(now)}
       WHERE id = ${sqlQuote(id)}`,
    );
  }

  async listRecentEscalationStates(
    agentId: string,
    limit = 10,
  ): Promise<LifeOpsEscalationStateRow[]> {
    await this.ensureReady();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_escalation_states
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY started_at DESC
        LIMIT ${sqlInteger(limit)}`,
    );
    return rows.map(parseEscalationStateRow);
  }

  async deleteAllEscalationStates(agentId: string): Promise<void> {
    await this.ensureReady();
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_escalation_states
        WHERE agent_id = ${sqlQuote(agentId)}`,
    );
  }
}

export function createLifeOpsTaskDefinition(
  params: Omit<LifeOpsTaskDefinition, "id" | "createdAt" | "updatedAt">,
): LifeOpsTaskDefinition {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsGoalDefinition(
  params: Omit<LifeOpsGoalDefinition, "id" | "createdAt" | "updatedAt">,
): LifeOpsGoalDefinition {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsReminderPlan(
  params: Omit<LifeOpsReminderPlan, "id" | "createdAt" | "updatedAt">,
): LifeOpsReminderPlan {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsChannelPolicy(
  params: Omit<LifeOpsChannelPolicy, "id" | "createdAt" | "updatedAt">,
): LifeOpsChannelPolicy {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsWebsiteAccessGrant(
  params: Omit<LifeOpsWebsiteAccessGrant, "id" | "createdAt" | "updatedAt">,
): LifeOpsWebsiteAccessGrant {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsAuditEvent(
  params: Omit<LifeOpsAuditEvent, "id" | "createdAt">,
): LifeOpsAuditEvent {
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: isoNow(),
  };
}

export function createLifeOpsActivitySignal(
  params: Omit<LifeOpsActivitySignal, "id" | "createdAt">,
): LifeOpsActivitySignal {
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: isoNow(),
  };
}

export function createLifeOpsConnectorGrant(
  params: Omit<
    LifeOpsConnectorGrant,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "side"
    | "executionTarget"
    | "sourceOfTruth"
    | "preferredByAgent"
    | "cloudConnectionId"
  > &
    Partial<
      Pick<
        LifeOpsConnectorGrant,
        | "side"
        | "executionTarget"
        | "sourceOfTruth"
        | "preferredByAgent"
        | "cloudConnectionId"
      >
    >,
): LifeOpsConnectorGrant {
  const timestamp = isoNow();
  return {
    ...params,
    side: params.side ?? "owner",
    executionTarget: params.executionTarget ?? "local",
    sourceOfTruth: params.sourceOfTruth ?? "local_storage",
    preferredByAgent: params.preferredByAgent ?? false,
    cloudConnectionId: params.cloudConnectionId ?? null,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsCalendarSyncState(
  params: Omit<LifeOpsCalendarSyncState, "id" | "updatedAt">,
): LifeOpsCalendarSyncState {
  return {
    ...params,
    id: crypto.randomUUID(),
    updatedAt: isoNow(),
  };
}

export function createLifeOpsGmailSyncState(
  params: Omit<LifeOpsGmailSyncState, "id" | "updatedAt">,
): LifeOpsGmailSyncState {
  return {
    ...params,
    id: crypto.randomUUID(),
    updatedAt: isoNow(),
  };
}

export function createLifeOpsWorkflowDefinition(
  params: Omit<LifeOpsWorkflowDefinition, "id" | "createdAt" | "updatedAt">,
): LifeOpsWorkflowDefinition {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsWorkflowRun(
  params: Omit<LifeOpsWorkflowRun, "id">,
): LifeOpsWorkflowRun {
  return {
    ...params,
    id: crypto.randomUUID(),
  };
}

export function createLifeOpsReminderAttempt(
  params: Omit<LifeOpsReminderAttempt, "id">,
): LifeOpsReminderAttempt {
  return {
    ...params,
    id: crypto.randomUUID(),
  };
}

export function createLifeOpsBrowserSession(
  params: Omit<LifeOpsBrowserSession, "id" | "createdAt" | "updatedAt">,
): LifeOpsBrowserSession {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsBrowserCompanionStatus(
  params: Omit<
    LifeOpsBrowserCompanionStatus,
    "id" | "createdAt" | "updatedAt" | "pairedAt"
  > & { pairedAt?: string | null },
): LifeOpsBrowserCompanionStatus {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    pairedAt: params.pairedAt ?? timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsBrowserTabSummary(
  params: Omit<LifeOpsBrowserTabSummary, "id" | "createdAt" | "updatedAt">,
): LifeOpsBrowserTabSummary {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsBrowserPageContext(
  params: Omit<LifeOpsBrowserPageContext, "id">,
): LifeOpsBrowserPageContext {
  return {
    ...params,
    id: crypto.randomUUID(),
  };
}
