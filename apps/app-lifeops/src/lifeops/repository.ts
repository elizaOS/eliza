import crypto from "node:crypto";
import { logger } from "@elizaos/core";
import type {
  LifeOpsActivitySignal,
  LifeOpsAuditEvent,
  LifeOpsAwakeProbability,
  LifeOpsAwakeProbabilityContributor,
  LifeOpsBrowserSession,
  LifeOpsCalendarEvent,
  LifeOpsChannelPolicy,
  LifeOpsCircadianRuleFiring,
  LifeOpsCircadianState,
  LifeOpsConnectorGrant,
  LifeOpsConnectorSide,
  LifeOpsCrossChannelDraft,
  LifeOpsDossier,
  LifeOpsFollowUp,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailSpamReviewItem,
  LifeOpsGmailSpamReviewStatus,
  LifeOpsGoalDefinition,
  LifeOpsGoalLink,
  LifeOpsHealthSignal,
  LifeOpsMessageChannel,
  LifeOpsNegotiationState,
  LifeOpsOccurrence,
  LifeOpsOccurrenceView,
  LifeOpsPersonalBaseline,
  LifeOpsProposalProposer,
  LifeOpsProposalStatus,
  LifeOpsRelationship,
  LifeOpsRelationshipInteraction,
  LifeOpsReminderAttempt,
  LifeOpsReminderPlan,
  LifeOpsScheduleInsight,
  LifeOpsScheduleMealInsight,
  LifeOpsScheduleRegularity,
  LifeOpsSchedulingNegotiation,
  LifeOpsSchedulingProposal,
  LifeOpsScreenTimeDaily,
  LifeOpsScreenTimeSession,
  LifeOpsSleepCycleEvidence,
  LifeOpsSleepCycleType,
  LifeOpsTaskDefinition,
  LifeOpsTelemetryEvent,
  LifeOpsTelemetryFamily,
  LifeOpsTelemetryPayload,
  LifeOpsUnclearReason,
  LifeOpsWorkflowDefinition,
  LifeOpsWorkflowRun,
} from "../contracts/index.js";
import type { IAgentRuntime } from "@elizaos/core";
import {
  browserBridgeSchema,
  type BrowserBridgeCompanionStatus,
  type BrowserBridgePageContext,
  type BrowserBridgePermissionState,
  type BrowserBridgeSettings,
  type BrowserBridgeTabSummary,
} from "@elizaos/plugin-browser-bridge";
import type {
  LifeOpsXDm,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
  LifeOpsXSyncState,
} from "@elizaos/shared/contracts/lifeops-extensions";
import type {
  EmailUnsubscribeMethod,
  EmailUnsubscribeRecord,
  EmailUnsubscribeStatus,
} from "./email-unsubscribe-types.js";
import type {
  LifeOpsPaymentDirection,
  LifeOpsPaymentSource,
  LifeOpsPaymentSourceKind,
  LifeOpsPaymentSourceStatus,
  LifeOpsPaymentTransaction,
} from "./payment-types.js";
import { refreshLifeOpsRelativeTime } from "./relative-time.js";
import type {
  LifeOpsScheduleMergedState,
  LifeOpsScheduleObservation,
} from "./schedule-sync-contracts.js";
import { lifeOpsSchema } from "./schema.js";
import {
  executeRawSql,
  parseJsonArray,
  parseJsonRecord,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
} from "./sql.js";
import type {
  LifeOpsSubscriptionAudit,
  LifeOpsSubscriptionCancellation,
  LifeOpsSubscriptionCandidate,
} from "./subscriptions-types.js";
import { buildTelemetryEventFromSignal } from "./telemetry-mapping.js";

type BrowserCompanionCredential = {
  companion: BrowserBridgeCompanionStatus;
  pairingTokenHash: string | null;
  pendingPairingTokenHashes: string[];
};

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

export interface LifeOpsScheduleInsightRecord extends LifeOpsScheduleInsight {
  id: string;
  agentId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsScheduleObservationRecord
  extends LifeOpsScheduleObservation {}

export interface LifeOpsScheduleMergedStateRecord
  extends LifeOpsScheduleMergedState {}

export type LifeOpsPersistedSleepEpisodeSource =
  | LifeOpsSleepCycleEvidence["source"]
  | "manual";

export interface LifeOpsSleepEpisodeRecord {
  id: string;
  agentId: string;
  startAt: string;
  endAt: string | null;
  source: LifeOpsPersistedSleepEpisodeSource;
  confidence: number;
  cycleType: LifeOpsSleepCycleType;
  sealed: boolean;
  evidence: LifeOpsSleepCycleEvidence[];
  createdAt: string;
  updatedAt: string;
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

function parseRelationship(row: Record<string, unknown>): LifeOpsRelationship {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    name: toText(row.name),
    primaryChannel: toText(row.primary_channel) as LifeOpsMessageChannel,
    primaryHandle: toText(row.primary_handle),
    email: row.email ? toText(row.email) : null,
    phone: row.phone ? toText(row.phone) : null,
    notes: toText(row.notes, ""),
    tags: parseJsonArray(row.tags_json) as string[],
    relationshipType: toText(row.relationship_type),
    lastContactedAt: row.last_contacted_at
      ? toText(row.last_contacted_at)
      : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseRelationshipInteraction(
  row: Record<string, unknown>,
): LifeOpsRelationshipInteraction {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    relationshipId: toText(row.relationship_id),
    channel: toText(row.channel) as LifeOpsMessageChannel,
    direction: toText(row.direction) as "inbound" | "outbound",
    summary: toText(row.summary),
    occurredAt: toText(row.occurred_at),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
  };
}

function parseFollowUp(row: Record<string, unknown>): LifeOpsFollowUp {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    relationshipId: toText(row.relationship_id),
    dueAt: toText(row.due_at),
    reason: toText(row.reason),
    status: toText(row.status) as LifeOpsFollowUp["status"],
    priority: toNumber(row.priority, 3),
    draft: row.draft_json
      ? (parseJsonRecord(row.draft_json) as unknown as LifeOpsCrossChannelDraft)
      : null,
    completedAt: row.completed_at ? toText(row.completed_at) : null,
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

function parseSubscriptionAudit(
  row: Record<string, unknown>,
): LifeOpsSubscriptionAudit {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    source: toText(row.source, "gmail") as LifeOpsSubscriptionAudit["source"],
    queryWindowDays: toNumber(row.query_window_days, 180),
    status: toText(
      row.status,
      "completed",
    ) as LifeOpsSubscriptionAudit["status"],
    totalCandidates: toNumber(row.total_candidates, 0),
    activeCandidates: toNumber(row.active_candidates, 0),
    canceledCandidates: toNumber(row.canceled_candidates, 0),
    uncertainCandidates: toNumber(row.uncertain_candidates, 0),
    summary: toText(row.summary),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseSubscriptionCandidate(
  row: Record<string, unknown>,
): LifeOpsSubscriptionCandidate {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    auditId: toText(row.audit_id),
    serviceSlug: toText(row.service_slug),
    serviceName: toText(row.service_name),
    provider: toText(row.provider),
    cadence: toText(
      row.cadence,
      "unknown",
    ) as LifeOpsSubscriptionCandidate["cadence"],
    state: toText(
      row.state,
      "uncertain",
    ) as LifeOpsSubscriptionCandidate["state"],
    confidence: toNumber(row.confidence, 0),
    annualCostEstimateUsd:
      row.annual_cost_estimate_usd === null ||
      row.annual_cost_estimate_usd === undefined
        ? null
        : toNumber(row.annual_cost_estimate_usd, 0),
    managementUrl: row.management_url ? toText(row.management_url) : null,
    latestEvidenceAt: row.latest_evidence_at
      ? toText(row.latest_evidence_at)
      : null,
    evidenceJson: parseJsonArray<Record<string, unknown>>(row.evidence_json),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseSubscriptionCancellation(
  row: Record<string, unknown>,
): LifeOpsSubscriptionCancellation {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    auditId: row.audit_id ? toText(row.audit_id) : null,
    candidateId: row.candidate_id ? toText(row.candidate_id) : null,
    serviceSlug: toText(row.service_slug),
    serviceName: toText(row.service_name),
    executor: toText(
      row.executor,
      "agent_browser",
    ) as LifeOpsSubscriptionCancellation["executor"],
    status: toText(
      row.status,
      "draft",
    ) as LifeOpsSubscriptionCancellation["status"],
    confirmed: toBoolean(row.confirmed),
    currentStep: row.current_step ? toText(row.current_step) : null,
    browserSessionId: row.browser_session_id
      ? toText(row.browser_session_id)
      : null,
    evidenceSummary: row.evidence_summary ? toText(row.evidence_summary) : null,
    artifactCount: toNumber(row.artifact_count, 0),
    managementUrl: row.management_url ? toText(row.management_url) : null,
    error: row.error ? toText(row.error) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    finishedAt: row.finished_at ? toText(row.finished_at) : null,
  };
}

function parsePaymentSource(
  row: Record<string, unknown>,
): LifeOpsPaymentSource {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    kind: toText(row.kind, "manual") as LifeOpsPaymentSourceKind,
    label: toText(row.label),
    institution: row.institution ? toText(row.institution) : null,
    accountMask: row.account_mask ? toText(row.account_mask) : null,
    status: toText(row.status, "active") as LifeOpsPaymentSourceStatus,
    lastSyncedAt: row.last_synced_at ? toText(row.last_synced_at) : null,
    transactionCount: toNumber(row.transaction_count, 0),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parsePaymentTransaction(
  row: Record<string, unknown>,
): LifeOpsPaymentTransaction {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    sourceId: toText(row.source_id),
    externalId: row.external_id ? toText(row.external_id) : null,
    postedAt: toText(row.posted_at),
    amountUsd: toNumber(row.amount_usd, 0),
    direction: toText(row.direction, "debit") as LifeOpsPaymentDirection,
    merchantRaw: toText(row.merchant_raw),
    merchantNormalized: toText(row.merchant_normalized),
    description: row.description ? toText(row.description) : null,
    category: row.category ? toText(row.category) : null,
    currency: toText(row.currency, "USD"),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
  };
}

function parseEmailUnsubscribe(
  row: Record<string, unknown>,
): EmailUnsubscribeRecord {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    senderEmail: toText(row.sender_email),
    senderDisplay: toText(row.sender_display),
    senderDomain: row.sender_domain ? toText(row.sender_domain) : null,
    listId: row.list_id ? toText(row.list_id) : null,
    method: toText(row.method, "manual_only") as EmailUnsubscribeMethod,
    status: toText(row.status, "failed") as EmailUnsubscribeStatus,
    httpStatusCode:
      row.http_status_code === null || row.http_status_code === undefined
        ? null
        : toNumber(row.http_status_code, 0),
    httpFinalUrl: row.http_final_url ? toText(row.http_final_url) : null,
    filterCreated: toBoolean(row.filter_created),
    filterId: row.filter_id ? toText(row.filter_id) : null,
    threadsTrashed: toNumber(row.threads_trashed, 0),
    errorMessage: row.error_message ? toText(row.error_message) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
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

function parseGmailSpamReviewItem(
  row: Record<string, unknown>,
): LifeOpsGmailSpamReviewItem {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    provider: "google",
    side: toText(row.side, "owner") as LifeOpsGmailSpamReviewItem["side"],
    grantId: toText(row.grant_id),
    accountEmail: row.account_email ? toText(row.account_email) : null,
    messageId: toText(row.message_id),
    externalMessageId: toText(row.external_message_id),
    threadId: toText(row.thread_id),
    subject: toText(row.subject),
    from: toText(row.from_display),
    fromEmail: row.from_email ? toText(row.from_email) : null,
    receivedAt: toText(row.received_at),
    snippet: toText(row.snippet),
    labels: parseJsonArray(row.label_ids_json),
    rationale: toText(row.rationale),
    confidence: toNumber(row.confidence),
    status: toText(row.status, "pending") as LifeOpsGmailSpamReviewStatus,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    reviewedAt: row.reviewed_at ? toText(row.reviewed_at) : null,
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
): BrowserBridgePermissionState {
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
): BrowserBridgeSettings {
  return {
    enabled: toBoolean(row.enabled, false),
    trackingMode: toText(
      row.tracking_mode,
      "current_tab",
    ) as BrowserBridgeSettings["trackingMode"],
    allowBrowserControl: toBoolean(row.allow_browser_control, false),
    requireConfirmationForAccountAffecting: toBoolean(
      row.require_confirmation_for_account_affecting,
      true,
    ),
    incognitoEnabled: toBoolean(row.incognito_enabled, false),
    siteAccessMode: toText(
      row.site_access_mode,
      "current_site_only",
    ) as BrowserBridgeSettings["siteAccessMode"],
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
): BrowserBridgeCompanionStatus {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    browser: toText(row.browser) as BrowserBridgeCompanionStatus["browser"],
    profileId: toText(row.profile_id),
    profileLabel: toText(row.profile_label),
    label: toText(row.label),
    extensionVersion: row.extension_version
      ? toText(row.extension_version)
      : null,
    connectionState: toText(
      row.connection_state,
    ) as BrowserBridgeCompanionStatus["connectionState"],
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
): BrowserBridgeTabSummary {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    companionId: row.companion_id ? toText(row.companion_id) : null,
    browser: toText(row.browser) as BrowserBridgeTabSummary["browser"],
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
): BrowserBridgePageContext {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    browser: toText(row.browser) as BrowserBridgePageContext["browser"],
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
      (candidate): candidate is BrowserBridgePageContext["links"][number] =>
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
      (candidate): candidate is BrowserBridgePageContext["forms"][number] =>
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

function parseXDm(row: Record<string, unknown>): LifeOpsXDm {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    externalDmId: toText(row.external_dm_id),
    conversationId: toText(row.conversation_id),
    senderHandle: toText(row.sender_handle),
    senderId: toText(row.sender_id),
    isInbound: toBoolean(row.is_inbound),
    text: toText(row.text),
    receivedAt: toText(row.received_at),
    readAt: row.read_at ? toText(row.read_at) : null,
    repliedAt: row.replied_at ? toText(row.replied_at) : null,
    metadata: parseJsonRecord(row.metadata_json),
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseXFeedItem(row: Record<string, unknown>): LifeOpsXFeedItem {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    externalTweetId: toText(row.external_tweet_id),
    authorHandle: toText(row.author_handle),
    authorId: toText(row.author_id),
    text: toText(row.text),
    createdAtSource: toText(row.created_at_source),
    feedType: toText(row.feed_type) as LifeOpsXFeedType,
    metadata: parseJsonRecord(row.metadata_json),
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseXSyncState(row: Record<string, unknown>): LifeOpsXSyncState {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    feedType: toText(row.feed_type) as LifeOpsXFeedType,
    lastCursor: row.last_cursor ? toText(row.last_cursor) : null,
    syncedAt: toText(row.synced_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseScreenTimeSession(
  row: Record<string, unknown>,
): LifeOpsScreenTimeSession {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    source: toText(row.source) as "app" | "website",
    identifier: toText(row.identifier),
    displayName: toText(row.display_name, toText(row.identifier)),
    startAt: toText(row.start_at),
    endAt: row.end_at ? toText(row.end_at) : null,
    durationSeconds: toNumber(row.duration_seconds, 0),
    isActive: toBoolean(row.is_active),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseScreenTimeDaily(
  row: Record<string, unknown>,
): LifeOpsScreenTimeDaily {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    source: toText(row.source) as "app" | "website",
    identifier: toText(row.identifier),
    date: toText(row.date),
    totalSeconds: toNumber(row.total_seconds, 0),
    sessionCount: toNumber(row.session_count, 0),
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function defaultAwakeProbability(computedAt: string): LifeOpsAwakeProbability {
  return {
    pAwake: 0,
    pAsleep: 0,
    pUnknown: 1,
    contributingSources: [],
    computedAt,
  };
}

function parseAwakeProbability(
  value: unknown,
  computedAt: string,
): LifeOpsAwakeProbability {
  if (value === null || value === undefined || value === "") {
    return defaultAwakeProbability(computedAt);
  }
  const record = parseJsonRecord(value);
  const contributors = Array.isArray(record.contributingSources)
    ? record.contributingSources
        .filter(
          (candidate): candidate is Record<string, unknown> =>
            Boolean(candidate) && typeof candidate === "object",
        )
        .map((candidate) => ({
          source: toText(
            candidate.source,
          ) as LifeOpsAwakeProbabilityContributor["source"],
          logLikelihoodRatio: toNumber(candidate.logLikelihoodRatio, 0),
        }))
    : [];
  return {
    pAwake: toNumber(record.pAwake, 0),
    pAsleep: toNumber(record.pAsleep, 0),
    pUnknown: toNumber(record.pUnknown, 1),
    contributingSources: contributors,
    computedAt: toText(record.computedAt, computedAt),
  };
}

function defaultScheduleRegularity(): LifeOpsScheduleRegularity {
  return {
    sri: 0,
    bedtimeStddevMin: 0,
    wakeStddevMin: 0,
    midSleepStddevMin: 0,
    regularityClass: "insufficient_data",
    sampleCount: 0,
    windowDays: 28,
  };
}

function parseScheduleRegularity(value: unknown): LifeOpsScheduleRegularity {
  if (value === null || value === undefined || value === "") {
    return defaultScheduleRegularity();
  }
  const record = parseJsonRecord(value);
  return {
    sri: toNumber(record.sri, 0),
    bedtimeStddevMin: toNumber(record.bedtimeStddevMin, 0),
    wakeStddevMin: toNumber(record.wakeStddevMin, 0),
    midSleepStddevMin: toNumber(record.midSleepStddevMin, 0),
    regularityClass: toText(
      record.regularityClass,
      "insufficient_data",
    ) as LifeOpsScheduleRegularity["regularityClass"],
    sampleCount: toNumber(record.sampleCount, 0),
    windowDays: toNumber(record.windowDays, 28),
  };
}

function parseTelemetryEventRow(
  row: Record<string, unknown>,
): LifeOpsTelemetryEvent {
  const payload = parseJsonRecord(
    row.payload_json,
  ) as unknown as LifeOpsTelemetryPayload;
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    family: toText(row.family) as LifeOpsTelemetryFamily,
    occurredAt: toText(row.occurred_at),
    ingestedAt: toText(row.ingested_at),
    dedupeKey: toText(row.dedupe_key),
    sourceReliability: toNumber(row.source_reliability, 0.5),
    payload,
  };
}

export interface LifeOpsCircadianStateRow {
  agentId: string;
  circadianState: LifeOpsCircadianState;
  stateConfidence: number;
  uncertaintyReason: LifeOpsUnclearReason | null;
  enteredAt: string;
  sinceSleepDetectedAt: string | null;
  sinceWakeObservedAt: string | null;
  sinceWakeConfirmedAt: string | null;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

function parseCircadianStateRow(
  row: Record<string, unknown>,
): LifeOpsCircadianStateRow {
  return {
    agentId: toText(row.agent_id),
    circadianState: toText(row.circadian_state) as LifeOpsCircadianState,
    stateConfidence: toNumber(row.state_confidence, 0),
    uncertaintyReason: row.uncertainty_reason
      ? (toText(row.uncertainty_reason) as LifeOpsUnclearReason)
      : null,
    enteredAt: toText(row.entered_at),
    sinceSleepDetectedAt: row.since_sleep_detected_at
      ? toText(row.since_sleep_detected_at)
      : null,
    sinceWakeObservedAt: row.since_wake_observed_at
      ? toText(row.since_wake_observed_at)
      : null,
    sinceWakeConfirmedAt: row.since_wake_confirmed_at
      ? toText(row.since_wake_confirmed_at)
      : null,
    evidenceRefs: parseJsonArray<string>(row.evidence_refs_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parsePersonalBaseline(value: unknown): LifeOpsPersonalBaseline | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const record = parseJsonRecord(value);
  if (Object.keys(record).length === 0) {
    return null;
  }
  return {
    medianWakeLocalHour: toNumber(record.medianWakeLocalHour, 0),
    medianBedtimeLocalHour: toNumber(record.medianBedtimeLocalHour, 0),
    medianSleepDurationMin: toNumber(record.medianSleepDurationMin, 0),
    bedtimeStddevMin: toNumber(record.bedtimeStddevMin, 0),
    wakeStddevMin: toNumber(record.wakeStddevMin, 0),
    sampleCount: toNumber(record.sampleCount, 0),
    windowDays: toNumber(record.windowDays, 28),
  };
}

function parseSleepEpisode(
  row: Record<string, unknown>,
): LifeOpsSleepEpisodeRecord {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    startAt: toText(row.start_at),
    endAt: row.end_at ? toText(row.end_at) : null,
    source: toText(row.source) as LifeOpsSleepEpisodeRecord["source"],
    confidence: toNumber(row.confidence, 0),
    cycleType: toText(
      row.cycle_type,
      "unknown",
    ) as LifeOpsSleepEpisodeRecord["cycleType"],
    sealed: toBoolean(row.sealed, false),
    evidence: parseJsonArray<LifeOpsSleepCycleEvidence>(row.evidence_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseScheduleObservation(
  row: Record<string, unknown>,
): LifeOpsScheduleObservationRecord {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    origin: toText(row.origin) as LifeOpsScheduleObservationRecord["origin"],
    deviceId: toText(row.device_id),
    deviceKind: toText(
      row.device_kind,
    ) as LifeOpsScheduleObservationRecord["deviceKind"],
    timezone: toText(row.timezone, "UTC"),
    observedAt: toText(row.observed_at),
    windowStartAt: toText(row.window_start_at),
    windowEndAt: row.window_end_at ? toText(row.window_end_at) : null,
    circadianState: toText(row.circadian_state) as LifeOpsCircadianState,
    stateConfidence: toNumber(row.state_confidence, 0),
    uncertaintyReason: row.uncertainty_reason
      ? (toText(row.uncertainty_reason) as LifeOpsUnclearReason)
      : null,
    mealLabel: row.meal_label
      ? (toText(
          row.meal_label,
        ) as LifeOpsScheduleObservationRecord["mealLabel"])
      : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseScheduleMergedState(
  row: Record<string, unknown>,
): LifeOpsScheduleMergedStateRecord {
  const inferredAt = toText(row.inferred_at);
  return refreshLifeOpsRelativeTime(
    {
      id: toText(row.id),
      agentId: toText(row.agent_id),
      scope: toText(row.scope) as LifeOpsScheduleMergedStateRecord["scope"],
      mergedAt: toText(row.merged_at),
      effectiveDayKey: toText(row.effective_day_key),
      localDate: toText(row.local_date),
      timezone: toText(row.timezone, "UTC"),
      inferredAt,
      circadianState: toText(
        row.circadian_state,
        "unclear",
      ) as LifeOpsCircadianState,
      stateConfidence: toNumber(row.state_confidence, 0),
      uncertaintyReason: row.uncertainty_reason
        ? (toText(row.uncertainty_reason) as LifeOpsUnclearReason)
        : null,
      awakeProbability: parseAwakeProbability(
        row.awake_probability_json,
        inferredAt,
      ),
      regularity: parseScheduleRegularity(row.regularity_json),
      baseline: parsePersonalBaseline(row.baseline_json),
      circadianRuleFirings: parseJsonArray<LifeOpsCircadianRuleFiring>(
        row.circadian_rule_firings_json,
      ),
      sleepStatus: toText(
        row.sleep_status,
      ) as LifeOpsScheduleMergedStateRecord["sleepStatus"],
      sleepConfidence: toNumber(row.sleep_confidence, 0),
      currentSleepStartedAt: row.current_sleep_started_at
        ? toText(row.current_sleep_started_at)
        : null,
      lastSleepStartedAt: row.last_sleep_started_at
        ? toText(row.last_sleep_started_at)
        : null,
      lastSleepEndedAt: row.last_sleep_ended_at
        ? toText(row.last_sleep_ended_at)
        : null,
      lastSleepDurationMinutes:
        row.last_sleep_duration_minutes !== null &&
        row.last_sleep_duration_minutes !== undefined &&
        row.last_sleep_duration_minutes !== ""
          ? toNumber(row.last_sleep_duration_minutes, 0)
          : null,
      wakeAt: row.wake_at ? toText(row.wake_at) : null,
      firstActiveAt: row.first_active_at ? toText(row.first_active_at) : null,
      lastActiveAt: row.last_active_at ? toText(row.last_active_at) : null,
      meals: parseJsonArray<LifeOpsScheduleMealInsight>(row.meals_json),
      lastMealAt: row.last_meal_at ? toText(row.last_meal_at) : null,
      nextMealLabel: row.next_meal_label
        ? (toText(
            row.next_meal_label,
          ) as LifeOpsScheduleMergedStateRecord["nextMealLabel"])
        : null,
      nextMealWindowStartAt: row.next_meal_window_start_at
        ? toText(row.next_meal_window_start_at)
        : null,
      nextMealWindowEndAt: row.next_meal_window_end_at
        ? toText(row.next_meal_window_end_at)
        : null,
      nextMealConfidence: toNumber(row.next_meal_confidence, 0),
      observationCount: toNumber(row.observation_count, 0),
      deviceCount: toNumber(row.device_count, 0),
      contributingDeviceKinds: parseJsonArray<
        LifeOpsScheduleMergedStateRecord["contributingDeviceKinds"][number]
      >(row.contributing_device_kinds_json),
      metadata: parseJsonRecord(row.metadata_json),
      createdAt: toText(row.created_at),
      updatedAt: toText(row.updated_at),
    },
    new Date(toText(row.inferred_at, toText(row.updated_at))),
  );
}

function parseSchedulingNegotiation(
  row: Record<string, unknown>,
): LifeOpsSchedulingNegotiation {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    subject: toText(row.subject),
    relationshipId: row.relationship_id ? toText(row.relationship_id) : null,
    durationMinutes: toNumber(row.duration_minutes, 0),
    timezone: toText(row.timezone, "UTC"),
    state: toText(row.state, "initiated") as LifeOpsNegotiationState,
    acceptedProposalId: row.accepted_proposal_id
      ? toText(row.accepted_proposal_id)
      : null,
    startedAt: toText(row.started_at),
    finalizedAt: row.finalized_at ? toText(row.finalized_at) : null,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseSchedulingProposal(
  row: Record<string, unknown>,
): LifeOpsSchedulingProposal {
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    negotiationId: toText(row.negotiation_id),
    startAt: toText(row.start_at),
    endAt: toText(row.end_at),
    proposedBy: toText(row.proposed_by, "agent") as LifeOpsProposalProposer,
    status: toText(row.status, "pending") as LifeOpsProposalStatus,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function parseDossier(row: Record<string, unknown>): LifeOpsDossier {
  const rawSources = parseJsonArray(row.sources_json) as unknown[];
  const sources = rawSources
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      kind: toText(s.kind),
      ref: toText(s.ref),
      ...(typeof s.snippet === "string" && s.snippet.length > 0
        ? { snippet: s.snippet }
        : {}),
    }));
  return {
    id: toText(row.id),
    agentId: toText(row.agent_id),
    calendarEventId: row.calendar_event_id
      ? toText(row.calendar_event_id)
      : null,
    subject: toText(row.subject),
    generatedForAt: toText(row.generated_for_at),
    contentMd: toText(row.content_md, ""),
    sources,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export class LifeOpsRepository {
  /**
   * Per-agent counter for telemetry-mirror failures inside
   * {@link createActivitySignal}. The live signal insert is the primary
   * source of truth; mirror failures must not block persistence, but we
   * still want visibility when the mirror is broken. First failure logs,
   * then we throttle to once every 100 failures so a broken backend
   * doesn't flood logs.
   */
  private static telemetryMirrorFailures = new Map<string, number>();

  constructor(private readonly runtime: IAgentRuntime) {}

  /**
   * Ensure the LifeOps plugin schema has been migrated for this runtime.
   * Legacy callers still use this entrypoint in tests and seed helpers, but
   * those callers do not always construct a runtime with the LifeOps plugin
   * registered. Run this plugin's schema directly so the contract is stable.
   */
  static async bootstrapSchema(runtime: IAgentRuntime): Promise<void> {
    const adapter = runtime.adapter;
    if (!adapter || typeof adapter.runPluginMigrations !== "function") {
      return;
    }
    if (typeof adapter.isReady === "function" && !(await adapter.isReady())) {
      return;
    }
    await adapter.runPluginMigrations(
      [
        {
          name: "@elizaos/plugin-browser-bridge",
          schema: browserBridgeSchema,
        },
        {
          name: "@elizaos/app-lifeops",
          schema: lifeOpsSchema,
        },
      ],
      {
        verbose: process.env.NODE_ENV !== "production",
        force: process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS === "true",
        dryRun: false,
      },
    );
  }

  async createDefinition(definition: LifeOpsTaskDefinition): Promise<void> {
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
      )
      ON CONFLICT(id) DO NOTHING`,
    );
  }

  /**
   * Returns `true` when the audit row for this id was newly inserted, `false`
   * when the id already existed. Used by circadian event emission to dedupe
   * across runtime restarts (same state transition -> same id).
   */
  async createAuditEventIfNew(event: LifeOpsAuditEvent): Promise<boolean> {
    const rows = await executeRawSql(
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
      )
      ON CONFLICT(id) DO NOTHING
      RETURNING id`,
    );
    return rows.length > 0;
  }

  async listAuditEvents(
    agentId: string,
    ownerType: string,
    ownerId: string,
  ): Promise<LifeOpsAuditEvent[]> {
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

  async createSubscriptionAudit(
    audit: LifeOpsSubscriptionAudit,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_subscription_audits (
        id, agent_id, source, query_window_days, status, total_candidates,
        active_candidates, canceled_candidates, uncertain_candidates, summary,
        metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(audit.id)},
        ${sqlQuote(audit.agentId)},
        ${sqlQuote(audit.source)},
        ${sqlInteger(audit.queryWindowDays)},
        ${sqlQuote(audit.status)},
        ${sqlInteger(audit.totalCandidates)},
        ${sqlInteger(audit.activeCandidates)},
        ${sqlInteger(audit.canceledCandidates)},
        ${sqlInteger(audit.uncertainCandidates)},
        ${sqlQuote(audit.summary)},
        ${sqlJson(audit.metadata)},
        ${sqlQuote(audit.createdAt)},
        ${sqlQuote(audit.updatedAt)}
      )`,
    );
  }

  async updateSubscriptionAudit(
    audit: LifeOpsSubscriptionAudit,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE life_subscription_audits
          SET source = ${sqlQuote(audit.source)},
              query_window_days = ${sqlInteger(audit.queryWindowDays)},
              status = ${sqlQuote(audit.status)},
              total_candidates = ${sqlInteger(audit.totalCandidates)},
              active_candidates = ${sqlInteger(audit.activeCandidates)},
              canceled_candidates = ${sqlInteger(audit.canceledCandidates)},
              uncertain_candidates = ${sqlInteger(audit.uncertainCandidates)},
              summary = ${sqlQuote(audit.summary)},
              metadata_json = ${sqlJson(audit.metadata)},
              updated_at = ${sqlQuote(audit.updatedAt)}
        WHERE id = ${sqlQuote(audit.id)}
          AND agent_id = ${sqlQuote(audit.agentId)}`,
    );
  }

  async getSubscriptionAudit(
    agentId: string,
    auditId: string,
  ): Promise<LifeOpsSubscriptionAudit | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_subscription_audits
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(auditId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseSubscriptionAudit(row) : null;
  }

  async getLatestSubscriptionAudit(
    agentId: string,
  ): Promise<LifeOpsSubscriptionAudit | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_subscription_audits
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseSubscriptionAudit(row) : null;
  }

  async createSubscriptionCandidate(
    candidate: LifeOpsSubscriptionCandidate,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_subscription_candidates (
        id, agent_id, audit_id, service_slug, service_name, provider, cadence,
        state, confidence, annual_cost_estimate_usd, management_url,
        latest_evidence_at, evidence_json, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(candidate.id)},
        ${sqlQuote(candidate.agentId)},
        ${sqlQuote(candidate.auditId)},
        ${sqlQuote(candidate.serviceSlug)},
        ${sqlQuote(candidate.serviceName)},
        ${sqlQuote(candidate.provider)},
        ${sqlQuote(candidate.cadence)},
        ${sqlQuote(candidate.state)},
        ${sqlNumber(candidate.confidence)},
        ${sqlNumber(candidate.annualCostEstimateUsd)},
        ${sqlText(candidate.managementUrl)},
        ${sqlText(candidate.latestEvidenceAt)},
        ${sqlJson(candidate.evidenceJson)},
        ${sqlJson(candidate.metadata)},
        ${sqlQuote(candidate.createdAt)},
        ${sqlQuote(candidate.updatedAt)}
      )
      ON CONFLICT(agent_id, audit_id, service_slug) DO UPDATE SET
        service_name = excluded.service_name,
        provider = excluded.provider,
        cadence = excluded.cadence,
        state = excluded.state,
        confidence = excluded.confidence,
        annual_cost_estimate_usd = excluded.annual_cost_estimate_usd,
        management_url = excluded.management_url,
        latest_evidence_at = excluded.latest_evidence_at,
        evidence_json = excluded.evidence_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listSubscriptionCandidatesForAudit(
    agentId: string,
    auditId: string,
  ): Promise<LifeOpsSubscriptionCandidate[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_subscription_candidates
        WHERE agent_id = ${sqlQuote(agentId)}
          AND audit_id = ${sqlQuote(auditId)}
        ORDER BY confidence DESC, service_name ASC`,
    );
    return rows.map(parseSubscriptionCandidate);
  }

  async getSubscriptionCandidate(
    agentId: string,
    candidateId: string,
  ): Promise<LifeOpsSubscriptionCandidate | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_subscription_candidates
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(candidateId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseSubscriptionCandidate(row) : null;
  }

  async createSubscriptionCancellation(
    cancellation: LifeOpsSubscriptionCancellation,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_subscription_cancellations (
        id, agent_id, audit_id, candidate_id, service_slug, service_name,
        executor, status, confirmed, current_step, browser_session_id,
        evidence_summary, artifact_count, management_url, error, metadata_json,
        created_at, updated_at, finished_at
      ) VALUES (
        ${sqlQuote(cancellation.id)},
        ${sqlQuote(cancellation.agentId)},
        ${sqlText(cancellation.auditId)},
        ${sqlText(cancellation.candidateId)},
        ${sqlQuote(cancellation.serviceSlug)},
        ${sqlQuote(cancellation.serviceName)},
        ${sqlQuote(cancellation.executor)},
        ${sqlQuote(cancellation.status)},
        ${sqlBoolean(cancellation.confirmed)},
        ${sqlText(cancellation.currentStep)},
        ${sqlText(cancellation.browserSessionId)},
        ${sqlText(cancellation.evidenceSummary)},
        ${sqlInteger(cancellation.artifactCount)},
        ${sqlText(cancellation.managementUrl)},
        ${sqlText(cancellation.error)},
        ${sqlJson(cancellation.metadata)},
        ${sqlQuote(cancellation.createdAt)},
        ${sqlQuote(cancellation.updatedAt)},
        ${sqlText(cancellation.finishedAt)}
      )`,
    );
  }

  async updateSubscriptionCancellation(
    cancellation: LifeOpsSubscriptionCancellation,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE life_subscription_cancellations
          SET audit_id = ${sqlText(cancellation.auditId)},
              candidate_id = ${sqlText(cancellation.candidateId)},
              service_slug = ${sqlQuote(cancellation.serviceSlug)},
              service_name = ${sqlQuote(cancellation.serviceName)},
              executor = ${sqlQuote(cancellation.executor)},
              status = ${sqlQuote(cancellation.status)},
              confirmed = ${sqlBoolean(cancellation.confirmed)},
              current_step = ${sqlText(cancellation.currentStep)},
              browser_session_id = ${sqlText(cancellation.browserSessionId)},
              evidence_summary = ${sqlText(cancellation.evidenceSummary)},
              artifact_count = ${sqlInteger(cancellation.artifactCount)},
              management_url = ${sqlText(cancellation.managementUrl)},
              error = ${sqlText(cancellation.error)},
              metadata_json = ${sqlJson(cancellation.metadata)},
              updated_at = ${sqlQuote(cancellation.updatedAt)},
              finished_at = ${sqlText(cancellation.finishedAt)}
        WHERE id = ${sqlQuote(cancellation.id)}
          AND agent_id = ${sqlQuote(cancellation.agentId)}`,
    );
  }

  async getSubscriptionCancellation(
    agentId: string,
    cancellationId: string,
  ): Promise<LifeOpsSubscriptionCancellation | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_subscription_cancellations
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(cancellationId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseSubscriptionCancellation(row) : null;
  }

  async getLatestSubscriptionCancellation(
    agentId: string,
    serviceSlug?: string,
  ): Promise<LifeOpsSubscriptionCancellation | null> {
    const serviceClause = serviceSlug
      ? `AND service_slug = ${sqlQuote(serviceSlug)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_subscription_cancellations
        WHERE agent_id = ${sqlQuote(agentId)}
          ${serviceClause}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseSubscriptionCancellation(row) : null;
  }

  async createEmailUnsubscribe(record: EmailUnsubscribeRecord): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_email_unsubscribes (
        id, agent_id, sender_email, sender_display, sender_domain, list_id,
        method, status, http_status_code, http_final_url, filter_created,
        filter_id, threads_trashed, error_message, metadata_json,
        created_at, updated_at
      ) VALUES (
        ${sqlQuote(record.id)},
        ${sqlQuote(record.agentId)},
        ${sqlQuote(record.senderEmail)},
        ${sqlQuote(record.senderDisplay)},
        ${sqlText(record.senderDomain)},
        ${sqlText(record.listId)},
        ${sqlQuote(record.method)},
        ${sqlQuote(record.status)},
        ${record.httpStatusCode === null ? "NULL" : sqlInteger(record.httpStatusCode)},
        ${sqlText(record.httpFinalUrl)},
        ${sqlBoolean(record.filterCreated)},
        ${sqlText(record.filterId)},
        ${sqlInteger(record.threadsTrashed)},
        ${sqlText(record.errorMessage)},
        ${sqlJson(record.metadata)},
        ${sqlQuote(record.createdAt)},
        ${sqlQuote(record.updatedAt)}
      )`,
    );
  }

  async listEmailUnsubscribes(
    agentId: string,
    args: { limit?: number } = {},
  ): Promise<EmailUnsubscribeRecord[]> {
    const limit = Math.max(1, Math.min(500, Math.trunc(args.limit ?? 100)));
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_email_unsubscribes
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY created_at DESC
        LIMIT ${limit}`,
    );
    return rows.map(parseEmailUnsubscribe);
  }

  async getEmailUnsubscribe(
    agentId: string,
    id: string,
  ): Promise<EmailUnsubscribeRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_email_unsubscribes
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseEmailUnsubscribe(row) : null;
  }

  async findEmailUnsubscribeBySender(
    agentId: string,
    senderEmail: string,
  ): Promise<EmailUnsubscribeRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_email_unsubscribes
        WHERE agent_id = ${sqlQuote(agentId)}
          AND sender_email = ${sqlQuote(senderEmail.trim().toLowerCase())}
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseEmailUnsubscribe(row) : null;
  }

  async upsertPaymentSource(source: LifeOpsPaymentSource): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_payment_sources (
        id, agent_id, kind, label, institution, account_mask, status,
        last_synced_at, transaction_count, metadata_json, created_at, updated_at
      ) VALUES (
        ${sqlQuote(source.id)},
        ${sqlQuote(source.agentId)},
        ${sqlQuote(source.kind)},
        ${sqlQuote(source.label)},
        ${sqlText(source.institution)},
        ${sqlText(source.accountMask)},
        ${sqlQuote(source.status)},
        ${sqlText(source.lastSyncedAt)},
        ${sqlInteger(source.transactionCount)},
        ${sqlJson(source.metadata)},
        ${sqlQuote(source.createdAt)},
        ${sqlQuote(source.updatedAt)}
      )
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        label = excluded.label,
        institution = excluded.institution,
        account_mask = excluded.account_mask,
        status = excluded.status,
        last_synced_at = excluded.last_synced_at,
        transaction_count = excluded.transaction_count,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    );
  }

  async listPaymentSources(agentId: string): Promise<LifeOpsPaymentSource[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_payment_sources
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY created_at DESC`,
    );
    return rows.map(parsePaymentSource);
  }

  async getPaymentSource(
    agentId: string,
    sourceId: string,
  ): Promise<LifeOpsPaymentSource | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_payment_sources
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(sourceId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parsePaymentSource(row) : null;
  }

  async deletePaymentSource(
    agentId: string,
    sourceId: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_payment_transactions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND source_id = ${sqlQuote(sourceId)}`,
    );
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_payment_sources
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(sourceId)}`,
    );
  }

  async deletePaymentTransactionById(
    agentId: string,
    transactionId: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_payment_transactions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(transactionId)}`,
    );
  }

  async insertPaymentTransaction(
    transaction: LifeOpsPaymentTransaction,
  ): Promise<boolean> {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO life_payment_transactions (
        id, agent_id, source_id, external_id, posted_at, amount_usd, direction,
        merchant_raw, merchant_normalized, description, category, currency,
        metadata_json, created_at
      ) VALUES (
        ${sqlQuote(transaction.id)},
        ${sqlQuote(transaction.agentId)},
        ${sqlQuote(transaction.sourceId)},
        ${sqlText(transaction.externalId)},
        ${sqlQuote(transaction.postedAt)},
        ${sqlNumber(transaction.amountUsd)},
        ${sqlQuote(transaction.direction)},
        ${sqlQuote(transaction.merchantRaw)},
        ${sqlQuote(transaction.merchantNormalized)},
        ${sqlText(transaction.description)},
        ${sqlText(transaction.category)},
        ${sqlQuote(transaction.currency)},
        ${sqlJson(transaction.metadata)},
        ${sqlQuote(transaction.createdAt)}
      )
      ON CONFLICT DO NOTHING
      RETURNING id`,
    );
    return rows.length > 0;
  }

  async listPaymentTransactions(
    agentId: string,
    args: {
      sourceId?: string | null;
      sinceAt?: string | null;
      untilAt?: string | null;
      limit?: number | null;
      merchantContains?: string | null;
      onlyDebits?: boolean | null;
    } = {},
  ): Promise<LifeOpsPaymentTransaction[]> {
    const limit = Math.max(1, Math.min(5000, Math.trunc(args.limit ?? 500)));
    const sourceClause = args.sourceId
      ? `AND source_id = ${sqlQuote(args.sourceId)}`
      : "";
    const sinceClause = args.sinceAt
      ? `AND posted_at >= ${sqlQuote(args.sinceAt)}`
      : "";
    const untilClause = args.untilAt
      ? `AND posted_at <= ${sqlQuote(args.untilAt)}`
      : "";
    const merchantClause = args.merchantContains
      ? `AND merchant_normalized LIKE ${sqlQuote(`%${args.merchantContains.trim().toLowerCase()}%`)}`
      : "";
    const directionClause = args.onlyDebits
      ? `AND direction = ${sqlQuote("debit")}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_payment_transactions
        WHERE agent_id = ${sqlQuote(agentId)}
          ${sourceClause}
          ${sinceClause}
          ${untilClause}
          ${merchantClause}
          ${directionClause}
        ORDER BY posted_at DESC
        LIMIT ${limit}`,
    );
    return rows.map(parsePaymentTransaction);
  }

  async countPaymentTransactionsForSource(
    agentId: string,
    sourceId: string,
  ): Promise<number> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT COUNT(*) AS count
         FROM life_payment_transactions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND source_id = ${sqlQuote(sourceId)}`,
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? toNumber(row.count ?? row.COUNT, 0) : 0;
  }

  async createActivitySignal(signal: LifeOpsActivitySignal): Promise<void> {
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

    // Mirror into the canonical telemetry store. Dedupes on
    // (agent_id, dedupe_key) so re-persists and migrator replays are safe.
    // Failures here must not block signal persistence — the legacy table is
    // still the primary source of truth for the scorer — but they are
    // counted and logged (first + every 100th) so broken mirrors surface
    // in observability instead of silently rotting.
    try {
      const telemetry = buildTelemetryEventFromSignal(
        signal,
        new Date().toISOString(),
      );
      if (telemetry) {
        await this.insertTelemetryEvent(telemetry);
      }
      LifeOpsRepository.telemetryMirrorFailures.delete(signal.agentId);
    } catch (error) {
      const nextCount =
        (LifeOpsRepository.telemetryMirrorFailures.get(signal.agentId) ?? 0) +
        1;
      LifeOpsRepository.telemetryMirrorFailures.set(signal.agentId, nextCount);
      if (nextCount === 1 || nextCount % 100 === 0) {
        logger.warn(
          {
            agentId: signal.agentId,
            source: signal.source,
            platform: signal.platform,
            consecutiveFailures: nextCount,
            error: error instanceof Error ? error.message : String(error),
          },
          "[lifeops] Telemetry mirror failed for activity signal.",
        );
      }
    }
  }

  async listActivitySignals(
    agentId: string,
    args: {
      sinceAt?: string | null;
      limit?: number | null;
      states?: LifeOpsActivitySignal["state"][] | null;
    } = {},
  ): Promise<LifeOpsActivitySignal[]> {
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
      ON CONFLICT(agent_id, provider, side, mode, identity_email) DO UPDATE SET
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

  /**
   * Returns events whose `end_at` falls in (cursorEndAt, upToIso] OR
   * (end_at == cursorEndAt AND id > cursorId). Ordered by (end_at, id) ascending
   * so callers can advance a tuple cursor and never re-fire for the same event.
   */
  async listCalendarEventsEndedAfterCursor(args: {
    agentId: string;
    provider: LifeOpsConnectorGrant["provider"];
    side?: LifeOpsConnectorSide;
    cursorEndAt: string | null;
    cursorEventId: string | null;
    upToIso: string;
    limit: number;
  }): Promise<LifeOpsCalendarEvent[]> {
    const sideClause = args.side ? `AND side = ${sqlQuote(args.side)}` : "";
    let cursorClause = "";
    if (args.cursorEndAt) {
      cursorClause = args.cursorEventId
        ? `AND (end_at > ${sqlQuote(args.cursorEndAt)}
              OR (end_at = ${sqlQuote(args.cursorEndAt)} AND id > ${sqlQuote(args.cursorEventId)}))`
        : `AND end_at > ${sqlQuote(args.cursorEndAt)}`;
    }
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_calendar_events
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND provider = ${sqlQuote(args.provider)}
          ${sideClause}
          AND end_at <= ${sqlQuote(args.upToIso)}
          ${cursorClause}
        ORDER BY end_at ASC, id ASC
        LIMIT ${Math.max(1, Math.floor(args.limit))}`,
    );
    return rows.map(parseCalendarEvent);
  }

  async upsertCalendarSyncState(
    state: LifeOpsCalendarSyncState,
  ): Promise<void> {
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

  async deleteGmailMessages(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    messageIds: readonly string[],
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_gmail_messages
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          AND id IN (${messageIds.map((messageId) => sqlQuote(messageId)).join(", ")})`,
    );
  }

  async deleteGmailMessagesForProvider(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
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

  async upsertGmailSpamReviewItem(
    item: LifeOpsGmailSpamReviewItem,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_gmail_spam_review_items (
        id, agent_id, provider, side, grant_id, account_email, message_id,
        external_message_id, thread_id, subject, from_display, from_email,
        received_at, snippet, label_ids_json, rationale, confidence, status,
        created_at, updated_at, reviewed_at
      ) VALUES (
        ${sqlQuote(item.id)},
        ${sqlQuote(item.agentId)},
        ${sqlQuote(item.provider)},
        ${sqlQuote(item.side)},
        ${sqlQuote(item.grantId)},
        ${sqlText(item.accountEmail)},
        ${sqlQuote(item.messageId)},
        ${sqlQuote(item.externalMessageId)},
        ${sqlQuote(item.threadId)},
        ${sqlQuote(item.subject)},
        ${sqlQuote(item.from)},
        ${sqlText(item.fromEmail)},
        ${sqlQuote(item.receivedAt)},
        ${sqlQuote(item.snippet)},
        ${sqlJson(item.labels)},
        ${sqlQuote(item.rationale)},
        ${sqlNumber(item.confidence)},
        ${sqlQuote(item.status)},
        ${sqlQuote(item.createdAt)},
        ${sqlQuote(item.updatedAt)},
        ${sqlText(item.reviewedAt)}
      )
      ON CONFLICT(agent_id, provider, side, grant_id, external_message_id) DO UPDATE SET
        account_email = excluded.account_email,
        message_id = excluded.message_id,
        thread_id = excluded.thread_id,
        subject = excluded.subject,
        from_display = excluded.from_display,
        from_email = excluded.from_email,
        received_at = excluded.received_at,
        snippet = excluded.snippet,
        label_ids_json = excluded.label_ids_json,
        rationale = excluded.rationale,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at`,
    );
  }

  async listGmailSpamReviewItems(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    options?: {
      maxResults?: number;
      status?: LifeOpsGmailSpamReviewStatus;
      grantId?: string;
    },
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGmailSpamReviewItem[]> {
    const limit =
      options?.maxResults !== undefined && Number.isFinite(options.maxResults)
        ? options.maxResults
        : 100;
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const statusClause = options?.status
      ? `AND status = ${sqlQuote(options.status)}`
      : "";
    const grantClause = options?.grantId
      ? `AND grant_id = ${sqlQuote(options.grantId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_gmail_spam_review_items
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          ${statusClause}
          ${grantClause}
        ORDER BY updated_at DESC, received_at DESC
        LIMIT ${sqlInteger(limit)}`,
    );
    return rows.map(parseGmailSpamReviewItem);
  }

  async getGmailSpamReviewItem(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    itemId: string,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGmailSpamReviewItem | null> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_gmail_spam_review_items
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          AND id = ${sqlQuote(itemId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseGmailSpamReviewItem(row) : null;
  }

  async updateGmailSpamReviewItemStatus(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    itemId: string,
    status: LifeOpsGmailSpamReviewStatus,
    reviewedAt: string | null,
    updatedAt: string,
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `UPDATE life_gmail_spam_review_items
          SET status = ${sqlQuote(status)},
              reviewed_at = ${sqlText(reviewedAt)},
              updated_at = ${sqlQuote(updatedAt)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}
          AND id = ${sqlQuote(itemId)}`,
    );
  }

  async deleteGmailSpamReviewItemsForProvider(
    agentId: string,
    provider: LifeOpsConnectorGrant["provider"],
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    const sideClause = side ? `AND side = ${sqlQuote(side)}` : "";
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_gmail_spam_review_items
        WHERE agent_id = ${sqlQuote(agentId)}
          AND provider = ${sqlQuote(provider)}
          ${sideClause}`,
    );
  }

  async createWorkflow(definition: LifeOpsWorkflowDefinition): Promise<void> {
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
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_workflow_runs
        WHERE agent_id = ${sqlQuote(agentId)}
          AND workflow_id = ${sqlQuote(workflowId)}`,
    );
    await executeRawSql(
      this.runtime,
      `UPDATE life_workflow_browser_sessions
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
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_workflow_browser_sessions (
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
    await executeRawSql(
      this.runtime,
      `UPDATE life_workflow_browser_sessions
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
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_workflow_browser_sessions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(sessionId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseBrowserSession(row) : null;
  }

  async listBrowserSessions(agentId: string): Promise<LifeOpsBrowserSession[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_workflow_browser_sessions
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY updated_at DESC, created_at DESC`,
    );
    return rows.map(parseBrowserSession);
  }

  async getBrowserSettings(
    agentId: string,
  ): Promise<BrowserBridgeSettings | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM browser_bridge_settings
        WHERE agent_id = ${sqlQuote(agentId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseBrowserSettings(row) : null;
  }

  async upsertBrowserSettings(
    agentId: string,
    settings: BrowserBridgeSettings,
  ): Promise<void> {
    const createdAt = settings.updatedAt ?? isoNow();
    await executeRawSql(
      this.runtime,
      `INSERT INTO browser_bridge_settings (
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
    browser: BrowserBridgeCompanionStatus["browser"],
    profileId: string,
  ): Promise<BrowserBridgeCompanionStatus | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM browser_bridge_companions
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
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM browser_bridge_companions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(companionId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseBrowserCompanionCredential(row) : null;
  }

  async upsertBrowserCompanion(
    companion: BrowserBridgeCompanionStatus,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO browser_bridge_companions (
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
        paired_at = COALESCE(browser_bridge_companions.paired_at, excluded.paired_at),
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
    await executeRawSql(
      this.runtime,
      `UPDATE browser_bridge_companions
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
    await executeRawSql(
      this.runtime,
      `UPDATE browser_bridge_companions
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
    await executeRawSql(
      this.runtime,
      `UPDATE browser_bridge_companions
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
  ): Promise<BrowserBridgeCompanionStatus[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM browser_bridge_companions
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY browser ASC, profile_label ASC, label ASC`,
    );
    return rows.map(parseBrowserCompanion);
  }

  async upsertBrowserTab(tab: BrowserBridgeTabSummary): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO browser_bridge_tabs (
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

  async listBrowserTabs(agentId: string): Promise<BrowserBridgeTabSummary[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM browser_bridge_tabs
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY focused_active DESC,
                 active_in_window DESC,
                 COALESCE(last_focused_at, last_seen_at) DESC,
                 updated_at DESC`,
    );
    return rows.map(parseBrowserTabSummary);
  }

  async deleteBrowserTabsByIds(agentId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const values = ids.map((id) => sqlQuote(id)).join(", ");
    await executeRawSql(
      this.runtime,
      `DELETE FROM browser_bridge_tabs
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id IN (${values})`,
    );
  }

  async deleteAllBrowserTabs(agentId: string): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM browser_bridge_tabs
        WHERE agent_id = ${sqlQuote(agentId)}`,
    );
  }

  async upsertBrowserPageContext(
    context: BrowserBridgePageContext,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO browser_bridge_page_contexts (
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
  ): Promise<BrowserBridgePageContext[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM browser_bridge_page_contexts
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY captured_at DESC`,
    );
    return rows.map(parseBrowserPageContext);
  }

  async deleteBrowserPageContextsByIds(
    agentId: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const values = ids.map((id) => sqlQuote(id)).join(", ");
    await executeRawSql(
      this.runtime,
      `DELETE FROM browser_bridge_page_contexts
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id IN (${values})`,
    );
  }

  async deleteAllBrowserPageContexts(agentId: string): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM browser_bridge_page_contexts
        WHERE agent_id = ${sqlQuote(agentId)}`,
    );
  }

  async deleteBrowserSession(
    agentId: string,
    sessionId: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_workflow_browser_sessions
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
    await executeRawSql(
      this.runtime,
      `DELETE FROM life_escalation_states
        WHERE agent_id = ${sqlQuote(agentId)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Relationships, interactions & follow-ups
  // -----------------------------------------------------------------------

  async upsertRelationship(rel: LifeOpsRelationship): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_relationships (
         id, agent_id, name, primary_channel, primary_handle, email, phone,
         notes, tags_json, relationship_type, last_contacted_at, metadata_json,
         created_at, updated_at
       ) VALUES (
         ${sqlQuote(rel.id)},
         ${sqlQuote(rel.agentId)},
         ${sqlQuote(rel.name)},
         ${sqlQuote(rel.primaryChannel)},
         ${sqlQuote(rel.primaryHandle)},
         ${sqlText(rel.email)},
         ${sqlText(rel.phone)},
         ${sqlQuote(rel.notes)},
         ${sqlJson(rel.tags)},
         ${sqlQuote(rel.relationshipType)},
         ${sqlText(rel.lastContactedAt)},
         ${sqlJson(rel.metadata)},
         ${sqlQuote(rel.createdAt)},
         ${sqlQuote(rel.updatedAt)}
       )
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         primary_channel = EXCLUDED.primary_channel,
         primary_handle = EXCLUDED.primary_handle,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         notes = EXCLUDED.notes,
         tags_json = EXCLUDED.tags_json,
         relationship_type = EXCLUDED.relationship_type,
         last_contacted_at = EXCLUDED.last_contacted_at,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async getRelationship(
    agentId: string,
    id: string,
  ): Promise<LifeOpsRelationship | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_relationships
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseRelationship(row) : null;
  }

  async listRelationships(
    agentId: string,
    opts?: { primaryChannel?: string; limit?: number },
  ): Promise<LifeOpsRelationship[]> {
    const clauses = [`agent_id = ${sqlQuote(agentId)}`];
    if (opts?.primaryChannel) {
      clauses.push(`primary_channel = ${sqlQuote(opts.primaryChannel)}`);
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_relationships
        WHERE ${clauses.join(" AND ")}
        ORDER BY name ASC
        ${limitClause}`,
    );
    return rows.map(parseRelationship);
  }

  async logRelationshipInteraction(
    interaction: LifeOpsRelationshipInteraction,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_relationship_interactions (
         id, agent_id, relationship_id, channel, direction, summary,
         occurred_at, metadata_json, created_at
       ) VALUES (
         ${sqlQuote(interaction.id)},
         ${sqlQuote(interaction.agentId)},
         ${sqlQuote(interaction.relationshipId)},
         ${sqlQuote(interaction.channel)},
         ${sqlQuote(interaction.direction)},
         ${sqlQuote(interaction.summary)},
         ${sqlQuote(interaction.occurredAt)},
         ${sqlJson(interaction.metadata)},
         ${sqlQuote(interaction.createdAt)}
       )`,
    );
  }

  async listInteractions(
    agentId: string,
    relationshipId: string,
    opts?: { limit?: number },
  ): Promise<LifeOpsRelationshipInteraction[]> {
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_relationship_interactions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND relationship_id = ${sqlQuote(relationshipId)}
        ORDER BY occurred_at DESC
        ${limitClause}`,
    );
    return rows.map(parseRelationshipInteraction);
  }

  async updateRelationshipLastContactedAt(
    agentId: string,
    relationshipId: string,
    timestamp: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE life_relationships
          SET last_contacted_at = ${sqlQuote(timestamp)},
              updated_at = ${sqlQuote(timestamp)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(relationshipId)}
          AND (last_contacted_at IS NULL OR last_contacted_at < ${sqlQuote(timestamp)})`,
    );
  }

  async upsertFollowUp(fu: LifeOpsFollowUp): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_follow_ups (
         id, agent_id, relationship_id, due_at, reason, status, priority,
         draft_json, completed_at, metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(fu.id)},
         ${sqlQuote(fu.agentId)},
         ${sqlQuote(fu.relationshipId)},
         ${sqlQuote(fu.dueAt)},
         ${sqlQuote(fu.reason)},
         ${sqlQuote(fu.status)},
         ${sqlInteger(fu.priority)},
         ${fu.draft ? sqlJson(fu.draft) : "NULL"},
         ${sqlText(fu.completedAt)},
         ${sqlJson(fu.metadata)},
         ${sqlQuote(fu.createdAt)},
         ${sqlQuote(fu.updatedAt)}
       )
       ON CONFLICT (id) DO UPDATE SET
         relationship_id = EXCLUDED.relationship_id,
         due_at = EXCLUDED.due_at,
         reason = EXCLUDED.reason,
         status = EXCLUDED.status,
         priority = EXCLUDED.priority,
         draft_json = EXCLUDED.draft_json,
         completed_at = EXCLUDED.completed_at,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async getFollowUp(
    agentId: string,
    id: string,
  ): Promise<LifeOpsFollowUp | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_follow_ups
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseFollowUp(row) : null;
  }

  async listFollowUps(
    agentId: string,
    opts?: { status?: string; dueOnOrBefore?: string; limit?: number },
  ): Promise<LifeOpsFollowUp[]> {
    const clauses = [`agent_id = ${sqlQuote(agentId)}`];
    if (opts?.status) {
      clauses.push(`status = ${sqlQuote(opts.status)}`);
    }
    if (opts?.dueOnOrBefore) {
      clauses.push(`due_at <= ${sqlQuote(opts.dueOnOrBefore)}`);
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_follow_ups
        WHERE ${clauses.join(" AND ")}
        ORDER BY due_at ASC
        ${limitClause}`,
    );
    return rows.map(parseFollowUp);
  }

  async updateFollowUpStatus(
    agentId: string,
    id: string,
    status: string,
    completedAt?: string,
  ): Promise<void> {
    const now = isoNow();
    const completedClause = completedAt
      ? `, completed_at = ${sqlQuote(completedAt)}`
      : "";
    await executeRawSql(
      this.runtime,
      `UPDATE life_follow_ups
          SET status = ${sqlQuote(status)},
              updated_at = ${sqlQuote(now)}
              ${completedClause}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}`,
    );
  }

  async updateFollowUpDueAt(
    agentId: string,
    id: string,
    dueAt: string,
  ): Promise<void> {
    const now = isoNow();
    await executeRawSql(
      this.runtime,
      `UPDATE life_follow_ups
          SET due_at = ${sqlQuote(dueAt)},
              updated_at = ${sqlQuote(now)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}`,
    );
  }

  // -----------------------------------------------------------------------
  // X (Twitter) DMs, feed items, and sync state
  // -----------------------------------------------------------------------

  async upsertXDm(dm: LifeOpsXDm): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_x_dms (
        id, agent_id, external_dm_id, conversation_id, sender_handle, sender_id,
        is_inbound, text, received_at, read_at, replied_at, metadata_json,
        synced_at, updated_at
      ) VALUES (
        ${sqlQuote(dm.id)},
        ${sqlQuote(dm.agentId)},
        ${sqlQuote(dm.externalDmId)},
        ${sqlQuote(dm.conversationId)},
        ${sqlQuote(dm.senderHandle)},
        ${sqlQuote(dm.senderId)},
        ${sqlBoolean(dm.isInbound)},
        ${sqlQuote(dm.text)},
        ${sqlQuote(dm.receivedAt)},
        ${sqlText(dm.readAt)},
        ${sqlText(dm.repliedAt)},
        ${sqlJson(dm.metadata)},
        ${sqlQuote(dm.syncedAt)},
        ${sqlQuote(dm.updatedAt)}
      )
      ON CONFLICT(agent_id, external_dm_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        sender_handle = excluded.sender_handle,
        sender_id = excluded.sender_id,
        is_inbound = excluded.is_inbound,
        text = excluded.text,
        received_at = excluded.received_at,
        read_at = excluded.read_at,
        replied_at = excluded.replied_at,
        metadata_json = excluded.metadata_json,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async listXDms(
    agentId: string,
    opts: { conversationId?: string; limit?: number } = {},
  ): Promise<LifeOpsXDm[]> {
    const DEFAULT_LIMIT = 100;
    const limit =
      opts.limit !== undefined && Number.isFinite(opts.limit)
        ? opts.limit
        : DEFAULT_LIMIT;
    const conversationClause = opts.conversationId
      ? `AND conversation_id = ${sqlQuote(opts.conversationId)}`
      : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_x_dms
        WHERE agent_id = ${sqlQuote(agentId)}
          ${conversationClause}
        ORDER BY received_at DESC
        LIMIT ${sqlInteger(limit)}`,
    );
    return rows.map(parseXDm);
  }

  async upsertXFeedItem(item: LifeOpsXFeedItem): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_x_feed_items (
        id, agent_id, external_tweet_id, author_handle, author_id, text,
        created_at_source, feed_type, metadata_json, synced_at, updated_at
      ) VALUES (
        ${sqlQuote(item.id)},
        ${sqlQuote(item.agentId)},
        ${sqlQuote(item.externalTweetId)},
        ${sqlQuote(item.authorHandle)},
        ${sqlQuote(item.authorId)},
        ${sqlQuote(item.text)},
        ${sqlQuote(item.createdAtSource)},
        ${sqlQuote(item.feedType)},
        ${sqlJson(item.metadata)},
        ${sqlQuote(item.syncedAt)},
        ${sqlQuote(item.updatedAt)}
      )
      ON CONFLICT(agent_id, external_tweet_id, feed_type) DO UPDATE SET
        author_handle = excluded.author_handle,
        author_id = excluded.author_id,
        text = excluded.text,
        created_at_source = excluded.created_at_source,
        metadata_json = excluded.metadata_json,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async listXFeedItems(
    agentId: string,
    feedType: LifeOpsXFeedType,
    opts: { limit?: number } = {},
  ): Promise<LifeOpsXFeedItem[]> {
    const DEFAULT_LIMIT = 100;
    const limit =
      opts.limit !== undefined && Number.isFinite(opts.limit)
        ? opts.limit
        : DEFAULT_LIMIT;
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_x_feed_items
        WHERE agent_id = ${sqlQuote(agentId)}
          AND feed_type = ${sqlQuote(feedType)}
        ORDER BY created_at_source DESC
        LIMIT ${sqlInteger(limit)}`,
    );
    return rows.map(parseXFeedItem);
  }

  async upsertXSyncState(state: LifeOpsXSyncState): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_x_sync_states (
        id, agent_id, feed_type, last_cursor, synced_at, updated_at
      ) VALUES (
        ${sqlQuote(state.id)},
        ${sqlQuote(state.agentId)},
        ${sqlQuote(state.feedType)},
        ${sqlText(state.lastCursor)},
        ${sqlQuote(state.syncedAt)},
        ${sqlQuote(state.updatedAt)}
      )
      ON CONFLICT(agent_id, feed_type) DO UPDATE SET
        last_cursor = excluded.last_cursor,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at`,
    );
  }

  async getXSyncState(
    agentId: string,
    feedType: LifeOpsXFeedType,
  ): Promise<LifeOpsXSyncState | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_x_sync_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND feed_type = ${sqlQuote(feedType)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseXSyncState(row) : null;
  }

  // -----------------------------------------------------------------------
  // Screen time — per-app and per-website dwell sessions + daily rollups
  // -----------------------------------------------------------------------

  async upsertScreenTimeSession(
    session: LifeOpsScreenTimeSession,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_screen_time_sessions (
         id, agent_id, source, identifier, display_name, start_at, end_at,
         duration_seconds, is_active, metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(session.id)},
         ${sqlQuote(session.agentId)},
         ${sqlQuote(session.source)},
         ${sqlQuote(session.identifier)},
         ${sqlQuote(session.displayName)},
         ${sqlQuote(session.startAt)},
         ${sqlText(session.endAt)},
         ${sqlInteger(session.durationSeconds)},
         ${sqlBoolean(session.isActive)},
         ${sqlJson(session.metadata)},
         ${sqlQuote(session.createdAt)},
         ${sqlQuote(session.updatedAt)}
       )
       ON CONFLICT (id) DO UPDATE SET
         source = EXCLUDED.source,
         identifier = EXCLUDED.identifier,
         display_name = EXCLUDED.display_name,
         start_at = EXCLUDED.start_at,
         end_at = EXCLUDED.end_at,
         duration_seconds = EXCLUDED.duration_seconds,
         is_active = EXCLUDED.is_active,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async getScreenTimeSession(
    agentId: string,
    id: string,
  ): Promise<LifeOpsScreenTimeSession | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_screen_time_sessions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseScreenTimeSession(row) : null;
  }

  async finishScreenTimeSession(
    agentId: string,
    id: string,
    endAt: string,
    durationSeconds: number,
  ): Promise<void> {
    const now = isoNow();
    await executeRawSql(
      this.runtime,
      `UPDATE life_screen_time_sessions
          SET end_at = ${sqlQuote(endAt)},
              duration_seconds = ${sqlInteger(durationSeconds)},
              is_active = ${sqlBoolean(false)},
              updated_at = ${sqlQuote(now)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}`,
    );
  }

  async listScreenTimeSessionsBetween(
    agentId: string,
    start: string,
    end: string,
    opts?: { source?: string; limit?: number },
  ): Promise<LifeOpsScreenTimeSession[]> {
    const clauses = [
      `agent_id = ${sqlQuote(agentId)}`,
      `start_at >= ${sqlQuote(start)}`,
      `start_at < ${sqlQuote(end)}`,
    ];
    if (opts?.source) {
      clauses.push(`source = ${sqlQuote(opts.source)}`);
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_screen_time_sessions
        WHERE ${clauses.join(" AND ")}
        ORDER BY start_at ASC
        ${limitClause}`,
    );
    return rows.map(parseScreenTimeSession);
  }

  async listScreenTimeSessionsOverlapping(
    agentId: string,
    start: string,
    end: string,
    opts?: { source?: string; limit?: number },
  ): Promise<LifeOpsScreenTimeSession[]> {
    const clauses = [
      `agent_id = ${sqlQuote(agentId)}`,
      `start_at < ${sqlQuote(end)}`,
      `(end_at IS NULL OR end_at > ${sqlQuote(start)})`,
    ];
    if (opts?.source) {
      clauses.push(`source = ${sqlQuote(opts.source)}`);
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_screen_time_sessions
        WHERE ${clauses.join(" AND ")}
        ORDER BY start_at ASC
        ${limitClause}`,
    );
    return rows.map(parseScreenTimeSession);
  }

  async upsertScreenTimeDaily(row: LifeOpsScreenTimeDaily): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_screen_time_daily (
         id, agent_id, source, identifier, date, total_seconds, session_count,
         metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(row.id)},
         ${sqlQuote(row.agentId)},
         ${sqlQuote(row.source)},
         ${sqlQuote(row.identifier)},
         ${sqlQuote(row.date)},
         ${sqlInteger(row.totalSeconds)},
         ${sqlInteger(row.sessionCount)},
         ${sqlJson(row.metadata)},
         ${sqlQuote(row.createdAt)},
         ${sqlQuote(row.updatedAt)}
       )
       ON CONFLICT (agent_id, source, identifier, date) DO UPDATE SET
         total_seconds = EXCLUDED.total_seconds,
         session_count = EXCLUDED.session_count,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async upsertScheduleInsight(
    insight: LifeOpsScheduleInsightRecord,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_schedule_insights (
         id, agent_id, effective_day_key, local_date, timezone, inferred_at,
         circadian_state, state_confidence, uncertainty_reason, sleep_status,
         sleep_confidence,
         current_sleep_started_at, last_sleep_started_at, last_sleep_ended_at,
         last_sleep_duration_minutes, wake_at, first_active_at, last_active_at,
         last_meal_at,
         next_meal_label, next_meal_window_start_at, next_meal_window_end_at,
         next_meal_confidence, meals_json, awake_probability_json,
         regularity_json, baseline_json, circadian_rule_firings_json,
         metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(insight.id)},
         ${sqlQuote(insight.agentId)},
         ${sqlQuote(insight.effectiveDayKey)},
         ${sqlQuote(insight.localDate)},
         ${sqlQuote(insight.timezone)},
         ${sqlQuote(insight.inferredAt)},
         ${sqlQuote(insight.circadianState)},
         ${sqlNumber(insight.stateConfidence)},
         ${sqlText(insight.uncertaintyReason)},
         ${sqlQuote(insight.sleepStatus)},
         ${sqlNumber(insight.sleepConfidence)},
         ${sqlText(insight.currentSleepStartedAt)},
         ${sqlText(insight.lastSleepStartedAt)},
         ${sqlText(insight.lastSleepEndedAt)},
         ${sqlInteger(insight.lastSleepDurationMinutes)},
         ${sqlText(insight.wakeAt)},
         ${sqlText(insight.firstActiveAt)},
         ${sqlText(insight.lastActiveAt)},
         ${sqlText(insight.lastMealAt)},
         ${sqlText(insight.nextMealLabel)},
         ${sqlText(insight.nextMealWindowStartAt)},
         ${sqlText(insight.nextMealWindowEndAt)},
         ${sqlNumber(insight.nextMealConfidence)},
         ${sqlJson(insight.meals)},
         ${sqlJson(insight.awakeProbability)},
         ${sqlJson(insight.regularity)},
         ${sqlJson(insight.baseline)},
         ${sqlJson(insight.circadianRuleFirings)},
         ${sqlJson(insight.metadata)},
         ${sqlQuote(insight.createdAt)},
         ${sqlQuote(insight.updatedAt)}
       )
       ON CONFLICT(agent_id, effective_day_key) DO UPDATE SET
         local_date = EXCLUDED.local_date,
         timezone = EXCLUDED.timezone,
         inferred_at = EXCLUDED.inferred_at,
         circadian_state = EXCLUDED.circadian_state,
         state_confidence = EXCLUDED.state_confidence,
         uncertainty_reason = EXCLUDED.uncertainty_reason,
         sleep_status = EXCLUDED.sleep_status,
         sleep_confidence = EXCLUDED.sleep_confidence,
         current_sleep_started_at = EXCLUDED.current_sleep_started_at,
         last_sleep_started_at = EXCLUDED.last_sleep_started_at,
         last_sleep_ended_at = EXCLUDED.last_sleep_ended_at,
         last_sleep_duration_minutes = EXCLUDED.last_sleep_duration_minutes,
         wake_at = EXCLUDED.wake_at,
         first_active_at = EXCLUDED.first_active_at,
         last_active_at = EXCLUDED.last_active_at,
         last_meal_at = EXCLUDED.last_meal_at,
         next_meal_label = EXCLUDED.next_meal_label,
         next_meal_window_start_at = EXCLUDED.next_meal_window_start_at,
         next_meal_window_end_at = EXCLUDED.next_meal_window_end_at,
         next_meal_confidence = EXCLUDED.next_meal_confidence,
         meals_json = EXCLUDED.meals_json,
         awake_probability_json = EXCLUDED.awake_probability_json,
         regularity_json = EXCLUDED.regularity_json,
         baseline_json = EXCLUDED.baseline_json,
         circadian_rule_firings_json = EXCLUDED.circadian_rule_firings_json,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  /**
   * Insert a telemetry event with content-hash dedupe. Returns `true` when a
   * new row was written, `false` when the `(agent_id, dedupe_key)` pair
   * already existed. See `telemetry-event-families.md` §5 for the derivation
   * of `dedupeKey`.
   */
  async insertTelemetryEvent(event: LifeOpsTelemetryEvent): Promise<boolean> {
    const rows = await executeRawSql(
      this.runtime,
      `INSERT INTO life_telemetry_events (
         id, agent_id, family, occurred_at, ingested_at, dedupe_key,
         source_reliability, payload_json
       ) VALUES (
         ${sqlQuote(event.id)},
         ${sqlQuote(event.agentId)},
         ${sqlQuote(event.family)},
         ${sqlQuote(event.occurredAt)},
         ${sqlQuote(event.ingestedAt)},
         ${sqlQuote(event.dedupeKey)},
         ${sqlNumber(event.sourceReliability)},
         ${sqlJson(event.payload)}
       )
       ON CONFLICT(agent_id, dedupe_key) DO NOTHING
       RETURNING id`,
    );
    return rows.length > 0;
  }

  async listTelemetryEvents(args: {
    agentId: string;
    familyIn?: LifeOpsTelemetryFamily[];
    sinceIso?: string;
    untilIso?: string;
    limit?: number;
  }): Promise<LifeOpsTelemetryEvent[]> {
    const clauses = [`agent_id = ${sqlQuote(args.agentId)}`];
    if (args.familyIn && args.familyIn.length > 0) {
      const inList = args.familyIn.map((family) => sqlQuote(family)).join(", ");
      clauses.push(`family IN (${inList})`);
    }
    if (args.sinceIso) {
      clauses.push(`occurred_at >= ${sqlQuote(args.sinceIso)}`);
    }
    if (args.untilIso) {
      clauses.push(`occurred_at <= ${sqlQuote(args.untilIso)}`);
    }
    const limitClause =
      typeof args.limit === "number" ? `LIMIT ${sqlInteger(args.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_telemetry_events
        WHERE ${clauses.join(" AND ")}
        ORDER BY occurred_at ASC
        ${limitClause}`,
    );
    return rows.map(parseTelemetryEventRow);
  }

  /**
   * Delete telemetry rows older than the retention window. Callers should
   * prune daily via the scheduler. Daily rollups in
   * `life_telemetry_rollup_daily` are retained indefinitely.
   */
  async pruneTelemetryEvents(args: {
    agentId: string;
    retentionDays: number;
  }): Promise<{ deletedCount: number }> {
    const cutoff = new Date(
      Date.now() - args.retentionDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const rows = await executeRawSql(
      this.runtime,
      `DELETE FROM life_telemetry_events
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND occurred_at < ${sqlQuote(cutoff)}
        RETURNING id`,
    );
    return { deletedCount: rows.length };
  }

  /**
   * Roll up raw telemetry events within `[sinceIso, untilIso)` into daily
   * per-family aggregates. Upserts per (agent, family, local_date). Callers
   * should run this before `pruneTelemetryEvents` so the 60-day retention
   * cutoff doesn't drop un-aggregated history.
   *
   * The bucket key (`local_date`) is the UTC date of `occurred_at` — local
   * timezone bucketing would require per-agent TZ, which higher-level callers
   * can project off the merged schedule state when they need it.
   */
  async upsertTelemetryDailyRollup(args: {
    agentId: string;
    sinceIso: string;
    untilIso: string;
  }): Promise<{ bucketsWritten: number }> {
    const nowIso = new Date().toISOString();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT family,
              SUBSTR(occurred_at, 1, 10) AS local_date,
              COUNT(*) AS event_count,
              MAX(occurred_at) AS last_observed_at
         FROM life_telemetry_events
        WHERE agent_id = ${sqlQuote(args.agentId)}
          AND occurred_at >= ${sqlQuote(args.sinceIso)}
          AND occurred_at < ${sqlQuote(args.untilIso)}
        GROUP BY family, SUBSTR(occurred_at, 1, 10)`,
    );
    let bucketsWritten = 0;
    for (const row of rows) {
      const family = toText(row.family);
      const localDate = toText(row.local_date);
      const eventCount = Number(row.event_count ?? 0);
      const lastObservedAt = toText(row.last_observed_at);
      if (!family || !localDate || !lastObservedAt) continue;
      await executeRawSql(
        this.runtime,
        `INSERT INTO life_telemetry_rollup_daily (
           agent_id, family, local_date, event_count,
           last_observed_at, created_at, updated_at
         ) VALUES (
           ${sqlQuote(args.agentId)},
           ${sqlQuote(family)},
           ${sqlQuote(localDate)},
           ${sqlInteger(eventCount)},
           ${sqlQuote(lastObservedAt)},
           ${sqlQuote(nowIso)},
           ${sqlQuote(nowIso)}
         )
         ON CONFLICT(agent_id, family, local_date) DO UPDATE SET
           event_count = EXCLUDED.event_count,
           last_observed_at = EXCLUDED.last_observed_at,
           updated_at = EXCLUDED.updated_at`,
      );
      bucketsWritten += 1;
    }
    return { bucketsWritten };
  }

  async readCircadianState(
    agentId: string,
  ): Promise<LifeOpsCircadianStateRow | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_circadian_states
        WHERE agent_id = ${sqlQuote(agentId)}
        LIMIT 1`,
    );
    return rows[0] ? parseCircadianStateRow(rows[0]) : null;
  }

  async upsertCircadianState(state: LifeOpsCircadianStateRow): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_circadian_states (
         agent_id, circadian_state, state_confidence, uncertainty_reason,
         entered_at, since_sleep_detected_at, since_wake_observed_at,
         since_wake_confirmed_at, evidence_refs_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(state.agentId)},
         ${sqlQuote(state.circadianState)},
         ${sqlNumber(state.stateConfidence)},
         ${sqlText(state.uncertaintyReason)},
         ${sqlQuote(state.enteredAt)},
         ${sqlText(state.sinceSleepDetectedAt)},
         ${sqlText(state.sinceWakeObservedAt)},
         ${sqlText(state.sinceWakeConfirmedAt)},
         ${sqlJson(state.evidenceRefs)},
         ${sqlQuote(state.createdAt)},
         ${sqlQuote(state.updatedAt)}
       )
       ON CONFLICT(agent_id) DO UPDATE SET
         circadian_state = EXCLUDED.circadian_state,
         state_confidence = EXCLUDED.state_confidence,
         uncertainty_reason = EXCLUDED.uncertainty_reason,
         entered_at = EXCLUDED.entered_at,
         since_sleep_detected_at = EXCLUDED.since_sleep_detected_at,
         since_wake_observed_at = EXCLUDED.since_wake_observed_at,
         since_wake_confirmed_at = EXCLUDED.since_wake_confirmed_at,
         evidence_refs_json = EXCLUDED.evidence_refs_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async upsertSleepEpisode(episode: LifeOpsSleepEpisodeRecord): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_sleep_episodes (
         id, agent_id, start_at, end_at, source, confidence, cycle_type,
         sealed, evidence_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(episode.id)},
         ${sqlQuote(episode.agentId)},
         ${sqlQuote(episode.startAt)},
         ${sqlText(episode.endAt)},
         ${sqlQuote(episode.source)},
         ${sqlNumber(episode.confidence)},
         ${sqlQuote(episode.cycleType)},
         ${sqlBoolean(episode.sealed)},
         ${sqlJson(episode.evidence)},
         ${sqlQuote(episode.createdAt)},
         ${sqlQuote(episode.updatedAt)}
       )
       ON CONFLICT(agent_id, start_at) DO UPDATE SET
         end_at = EXCLUDED.end_at,
         source = EXCLUDED.source,
         confidence = EXCLUDED.confidence,
         cycle_type = EXCLUDED.cycle_type,
         sealed = EXCLUDED.sealed,
         evidence_json = EXCLUDED.evidence_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async listSleepEpisodesBetween(
    agentId: string,
    startAt: string,
    endAt: string,
    opts?: { includeOpen?: boolean; limit?: number },
  ): Promise<LifeOpsSleepEpisodeRecord[]> {
    const clauses = [
      `agent_id = ${sqlQuote(agentId)}`,
      `(end_at IS NULL OR end_at >= ${sqlQuote(startAt)})`,
      `start_at <= ${sqlQuote(endAt)}`,
    ];
    if (opts?.includeOpen !== true) {
      clauses.push("sealed = TRUE");
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_sleep_episodes
        WHERE ${clauses.join(" AND ")}
        ORDER BY start_at ASC
        ${limitClause}`,
    );
    return rows.map(parseSleepEpisode);
  }

  async upsertScheduleObservation(
    observation: LifeOpsScheduleObservationRecord,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_schedule_observations (
         id, agent_id, origin, device_id, device_kind, timezone, observed_at,
         window_start_at, window_end_at, circadian_state, state_confidence,
         uncertainty_reason, meal_label, metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(observation.id)},
         ${sqlQuote(observation.agentId)},
         ${sqlQuote(observation.origin)},
         ${sqlQuote(observation.deviceId)},
         ${sqlQuote(observation.deviceKind)},
         ${sqlQuote(observation.timezone)},
         ${sqlQuote(observation.observedAt)},
         ${sqlQuote(observation.windowStartAt)},
         ${sqlText(observation.windowEndAt)},
         ${sqlQuote(observation.circadianState)},
         ${sqlNumber(observation.stateConfidence)},
         ${sqlText(observation.uncertaintyReason)},
         ${sqlText(observation.mealLabel)},
         ${sqlJson(observation.metadata)},
         ${sqlQuote(observation.createdAt)},
         ${sqlQuote(observation.updatedAt)}
       )
       ON CONFLICT(id) DO UPDATE SET
         observed_at = EXCLUDED.observed_at,
         window_end_at = EXCLUDED.window_end_at,
         circadian_state = EXCLUDED.circadian_state,
         state_confidence = EXCLUDED.state_confidence,
         uncertainty_reason = EXCLUDED.uncertainty_reason,
         meal_label = EXCLUDED.meal_label,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async listScheduleObservations(
    agentId: string,
    sinceAt: string,
    opts?: {
      origin?: LifeOpsScheduleObservationRecord["origin"];
      deviceId?: string;
      limit?: number;
    },
  ): Promise<LifeOpsScheduleObservationRecord[]> {
    const clauses = [
      `agent_id = ${sqlQuote(agentId)}`,
      `observed_at >= ${sqlQuote(sinceAt)}`,
    ];
    if (opts?.origin) {
      clauses.push(`origin = ${sqlQuote(opts.origin)}`);
    }
    if (opts?.deviceId) {
      clauses.push(`device_id = ${sqlQuote(opts.deviceId)}`);
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_schedule_observations
        WHERE ${clauses.join(" AND ")}
        ORDER BY observed_at DESC
        ${limitClause}`,
    );
    return rows.map(parseScheduleObservation);
  }

  async upsertScheduleMergedState(
    state: LifeOpsScheduleMergedStateRecord,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_schedule_merged_states (
         id, agent_id, scope, effective_day_key, local_date, timezone,
         merged_at, inferred_at, circadian_state, state_confidence,
         uncertainty_reason, sleep_status, sleep_confidence,
         current_sleep_started_at, last_sleep_started_at,
         last_sleep_ended_at, last_sleep_duration_minutes,
         wake_at, first_active_at, last_active_at,
         last_meal_at, next_meal_label, next_meal_window_start_at,
         next_meal_window_end_at, next_meal_confidence, meals_json,
         awake_probability_json, regularity_json, baseline_json,
         circadian_rule_firings_json,
         observation_count, device_count, contributing_device_kinds_json,
         metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(state.id)},
         ${sqlQuote(state.agentId)},
         ${sqlQuote(state.scope)},
         ${sqlQuote(state.effectiveDayKey)},
         ${sqlQuote(state.localDate)},
         ${sqlQuote(state.timezone)},
         ${sqlQuote(state.mergedAt)},
         ${sqlQuote(state.inferredAt)},
         ${sqlQuote(state.circadianState)},
         ${sqlNumber(state.stateConfidence)},
         ${sqlText(state.uncertaintyReason)},
         ${sqlQuote(state.sleepStatus)},
         ${sqlNumber(state.sleepConfidence)},
         ${sqlText(state.currentSleepStartedAt)},
         ${sqlText(state.lastSleepStartedAt)},
         ${sqlText(state.lastSleepEndedAt)},
         ${sqlInteger(state.lastSleepDurationMinutes)},
         ${sqlText(state.wakeAt)},
         ${sqlText(state.firstActiveAt)},
         ${sqlText(state.lastActiveAt)},
         ${sqlText(state.lastMealAt)},
         ${sqlText(state.nextMealLabel)},
         ${sqlText(state.nextMealWindowStartAt)},
         ${sqlText(state.nextMealWindowEndAt)},
         ${sqlNumber(state.nextMealConfidence)},
         ${sqlJson(state.meals)},
         ${sqlJson(state.awakeProbability)},
         ${sqlJson(state.regularity)},
         ${state.baseline === null ? "NULL" : sqlJson(state.baseline)},
         ${sqlJson(state.circadianRuleFirings)},
         ${sqlInteger(state.observationCount)},
         ${sqlInteger(state.deviceCount)},
         ${sqlJson(state.contributingDeviceKinds)},
         ${sqlJson(state.metadata)},
         ${sqlQuote(state.createdAt)},
         ${sqlQuote(state.updatedAt)}
       )
       ON CONFLICT(agent_id, scope, timezone) DO UPDATE SET
         effective_day_key = EXCLUDED.effective_day_key,
         local_date = EXCLUDED.local_date,
         merged_at = EXCLUDED.merged_at,
         inferred_at = EXCLUDED.inferred_at,
         circadian_state = EXCLUDED.circadian_state,
         state_confidence = EXCLUDED.state_confidence,
         uncertainty_reason = EXCLUDED.uncertainty_reason,
         sleep_status = EXCLUDED.sleep_status,
         sleep_confidence = EXCLUDED.sleep_confidence,
         current_sleep_started_at = EXCLUDED.current_sleep_started_at,
         last_sleep_started_at = EXCLUDED.last_sleep_started_at,
         last_sleep_ended_at = EXCLUDED.last_sleep_ended_at,
         last_sleep_duration_minutes = EXCLUDED.last_sleep_duration_minutes,
         wake_at = EXCLUDED.wake_at,
         first_active_at = EXCLUDED.first_active_at,
         last_active_at = EXCLUDED.last_active_at,
         last_meal_at = EXCLUDED.last_meal_at,
         next_meal_label = EXCLUDED.next_meal_label,
         next_meal_window_start_at = EXCLUDED.next_meal_window_start_at,
         next_meal_window_end_at = EXCLUDED.next_meal_window_end_at,
         next_meal_confidence = EXCLUDED.next_meal_confidence,
         meals_json = EXCLUDED.meals_json,
         awake_probability_json = EXCLUDED.awake_probability_json,
         regularity_json = EXCLUDED.regularity_json,
         baseline_json = EXCLUDED.baseline_json,
         circadian_rule_firings_json = EXCLUDED.circadian_rule_firings_json,
         observation_count = EXCLUDED.observation_count,
         device_count = EXCLUDED.device_count,
         contributing_device_kinds_json = EXCLUDED.contributing_device_kinds_json,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async getScheduleMergedState(
    agentId: string,
    scope: LifeOpsScheduleMergedStateRecord["scope"],
    timezone: string,
  ): Promise<LifeOpsScheduleMergedStateRecord | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_schedule_merged_states
        WHERE agent_id = ${sqlQuote(agentId)}
          AND scope = ${sqlQuote(scope)}
          AND timezone = ${sqlQuote(timezone)}
        LIMIT 1`,
    );
    return rows[0] ? parseScheduleMergedState(rows[0]) : null;
  }

  async listScreenTimeDaily(
    agentId: string,
    date: string,
    opts?: { source?: string; limit?: number },
  ): Promise<LifeOpsScreenTimeDaily[]> {
    const clauses = [
      `agent_id = ${sqlQuote(agentId)}`,
      `date = ${sqlQuote(date)}`,
    ];
    if (opts?.source) {
      clauses.push(`source = ${sqlQuote(opts.source)}`);
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_screen_time_daily
        WHERE ${clauses.join(" AND ")}
        ORDER BY total_seconds DESC
        ${limitClause}`,
    );
    return rows.map(parseScreenTimeDaily);
  }

  async aggregateScreenTimeDailyForDate(
    agentId: string,
    date: string,
  ): Promise<{ updated: number }> {
    // Sessions counted when their start_at falls within the UTC day window.
    const dayStart = `${date}T00:00:00.000Z`;
    const dayEnd = `${date}T23:59:59.999Z`;
    const rows = await executeRawSql(
      this.runtime,
      `SELECT source,
              identifier,
              MAX(display_name) AS display_name,
              SUM(duration_seconds) AS total_seconds,
              COUNT(*) AS session_count
         FROM life_screen_time_sessions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND start_at >= ${sqlQuote(dayStart)}
          AND start_at <= ${sqlQuote(dayEnd)}
        GROUP BY source, identifier`,
    );
    const now = isoNow();
    let updated = 0;
    for (const row of rows) {
      const rollup: LifeOpsScreenTimeDaily = {
        id: crypto.randomUUID(),
        agentId,
        source: toText(row.source) as "app" | "website",
        identifier: toText(row.identifier),
        date,
        totalSeconds: toNumber(row.total_seconds, 0),
        sessionCount: toNumber(row.session_count, 0),
        metadata: {
          displayName: toText(row.display_name, toText(row.identifier)),
        },
        createdAt: now,
        updatedAt: now,
      };
      await this.upsertScreenTimeDaily(rollup);
      updated += 1;
    }
    return { updated };
  }

  // -----------------------------------------------------------------------
  // Scheduling negotiations + proposals
  // -----------------------------------------------------------------------

  async upsertSchedulingNegotiation(
    neg: LifeOpsSchedulingNegotiation,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_scheduling_negotiations (
         id, agent_id, subject, relationship_id, duration_minutes, timezone,
         state, accepted_proposal_id, started_at, finalized_at, metadata_json,
         created_at, updated_at
       ) VALUES (
         ${sqlQuote(neg.id)},
         ${sqlQuote(neg.agentId)},
         ${sqlQuote(neg.subject)},
         ${sqlText(neg.relationshipId)},
         ${sqlInteger(neg.durationMinutes)},
         ${sqlQuote(neg.timezone)},
         ${sqlQuote(neg.state)},
         ${sqlText(neg.acceptedProposalId)},
         ${sqlQuote(neg.startedAt)},
         ${sqlText(neg.finalizedAt)},
         ${sqlJson(neg.metadata)},
         ${sqlQuote(neg.createdAt)},
         ${sqlQuote(neg.updatedAt)}
       )
       ON CONFLICT (id) DO UPDATE SET
         subject = EXCLUDED.subject,
         relationship_id = EXCLUDED.relationship_id,
         duration_minutes = EXCLUDED.duration_minutes,
         timezone = EXCLUDED.timezone,
         state = EXCLUDED.state,
         accepted_proposal_id = EXCLUDED.accepted_proposal_id,
         finalized_at = EXCLUDED.finalized_at,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async getSchedulingNegotiation(
    agentId: string,
    id: string,
  ): Promise<LifeOpsSchedulingNegotiation | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_scheduling_negotiations
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseSchedulingNegotiation(row) : null;
  }

  async listSchedulingNegotiations(
    agentId: string,
    opts?: { state?: string; limit?: number },
  ): Promise<LifeOpsSchedulingNegotiation[]> {
    const clauses = [`agent_id = ${sqlQuote(agentId)}`];
    if (opts?.state) {
      clauses.push(`state = ${sqlQuote(opts.state)}`);
    }
    const limitClause =
      typeof opts?.limit === "number" ? `LIMIT ${sqlInteger(opts.limit)}` : "";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_scheduling_negotiations
        WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC
        ${limitClause}`,
    );
    return rows.map(parseSchedulingNegotiation);
  }

  async updateSchedulingNegotiationState(
    agentId: string,
    id: string,
    state: string,
    finalizedAt?: string | null,
  ): Promise<void> {
    const now = isoNow();
    const finalizedClause =
      finalizedAt === undefined
        ? ""
        : `, finalized_at = ${sqlText(finalizedAt)}`;
    await executeRawSql(
      this.runtime,
      `UPDATE life_scheduling_negotiations
          SET state = ${sqlQuote(state)},
              updated_at = ${sqlQuote(now)}${finalizedClause}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}`,
    );
  }

  async upsertSchedulingProposal(p: LifeOpsSchedulingProposal): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_scheduling_proposals (
         id, agent_id, negotiation_id, start_at, end_at, proposed_by, status,
         metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(p.id)},
         ${sqlQuote(p.agentId)},
         ${sqlQuote(p.negotiationId)},
         ${sqlQuote(p.startAt)},
         ${sqlQuote(p.endAt)},
         ${sqlQuote(p.proposedBy)},
         ${sqlQuote(p.status)},
         ${sqlJson(p.metadata)},
         ${sqlQuote(p.createdAt)},
         ${sqlQuote(p.updatedAt)}
       )
       ON CONFLICT (id) DO UPDATE SET
         start_at = EXCLUDED.start_at,
         end_at = EXCLUDED.end_at,
         proposed_by = EXCLUDED.proposed_by,
         status = EXCLUDED.status,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async getSchedulingProposal(
    agentId: string,
    id: string,
  ): Promise<LifeOpsSchedulingProposal | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_scheduling_proposals
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseSchedulingProposal(row) : null;
  }

  async listSchedulingProposals(
    agentId: string,
    negotiationId: string,
  ): Promise<LifeOpsSchedulingProposal[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_scheduling_proposals
        WHERE agent_id = ${sqlQuote(agentId)}
          AND negotiation_id = ${sqlQuote(negotiationId)}
        ORDER BY created_at ASC`,
    );
    return rows.map(parseSchedulingProposal);
  }

  async updateSchedulingProposalStatus(
    agentId: string,
    id: string,
    status: string,
  ): Promise<void> {
    const now = isoNow();
    await executeRawSql(
      this.runtime,
      `UPDATE life_scheduling_proposals
          SET status = ${sqlQuote(status)},
              updated_at = ${sqlQuote(now)}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Dossiers
  // -----------------------------------------------------------------------

  async upsertDossier(d: LifeOpsDossier): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO life_dossiers (
         id, agent_id, calendar_event_id, subject, generated_for_at,
         content_md, sources_json, metadata_json, created_at, updated_at
       ) VALUES (
         ${sqlQuote(d.id)},
         ${sqlQuote(d.agentId)},
         ${sqlText(d.calendarEventId)},
         ${sqlQuote(d.subject)},
         ${sqlQuote(d.generatedForAt)},
         ${sqlQuote(d.contentMd)},
         ${sqlJson(d.sources)},
         ${sqlJson(d.metadata)},
         ${sqlQuote(d.createdAt)},
         ${sqlQuote(d.updatedAt)}
       )
       ON CONFLICT (id) DO UPDATE SET
         calendar_event_id = EXCLUDED.calendar_event_id,
         subject = EXCLUDED.subject,
         generated_for_at = EXCLUDED.generated_for_at,
         content_md = EXCLUDED.content_md,
         sources_json = EXCLUDED.sources_json,
         metadata_json = EXCLUDED.metadata_json,
         updated_at = EXCLUDED.updated_at`,
    );
  }

  async getDossier(
    agentId: string,
    id: string,
  ): Promise<LifeOpsDossier | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_dossiers
        WHERE agent_id = ${sqlQuote(agentId)}
          AND id = ${sqlQuote(id)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseDossier(row) : null;
  }

  async getDossierByCalendarEvent(
    agentId: string,
    calendarEventId: string,
  ): Promise<LifeOpsDossier | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_dossiers
        WHERE agent_id = ${sqlQuote(agentId)}
          AND calendar_event_id = ${sqlQuote(calendarEventId)}
        ORDER BY generated_for_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? parseDossier(row) : null;
  }

  async listDossiers(
    agentId: string,
    opts?: { limit?: number },
  ): Promise<LifeOpsDossier[]> {
    const limitClause =
      typeof opts?.limit === "number"
        ? `LIMIT ${sqlInteger(opts.limit)}`
        : "LIMIT 50";
    const rows = await executeRawSql(
      this.runtime,
      `SELECT *
         FROM life_dossiers
        WHERE agent_id = ${sqlQuote(agentId)}
        ORDER BY generated_for_at DESC
        ${limitClause}`,
    );
    return rows.map(parseDossier);
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

export function createLifeOpsSubscriptionAudit(
  params: Omit<LifeOpsSubscriptionAudit, "id" | "createdAt" | "updatedAt">,
): LifeOpsSubscriptionAudit {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsSubscriptionCandidate(
  params: Omit<LifeOpsSubscriptionCandidate, "id" | "createdAt" | "updatedAt">,
): LifeOpsSubscriptionCandidate {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createLifeOpsSubscriptionCancellation(
  params: Omit<
    LifeOpsSubscriptionCancellation,
    "id" | "createdAt" | "updatedAt"
  >,
): LifeOpsSubscriptionCancellation {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
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

export function createLifeOpsSleepEpisode(
  params: Omit<LifeOpsSleepEpisodeRecord, "id" | "createdAt" | "updatedAt">,
): LifeOpsSleepEpisodeRecord {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
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

export function createBrowserBridgeCompanionStatus(
  params: Omit<
    BrowserBridgeCompanionStatus,
    "id" | "createdAt" | "updatedAt" | "pairedAt"
  > & { pairedAt?: string | null },
): BrowserBridgeCompanionStatus {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    pairedAt: params.pairedAt ?? timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createBrowserBridgeTabSummary(
  params: Omit<BrowserBridgeTabSummary, "id" | "createdAt" | "updatedAt">,
): BrowserBridgeTabSummary {
  const timestamp = isoNow();
  return {
    ...params,
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createBrowserBridgePageContext(
  params: Omit<BrowserBridgePageContext, "id">,
): BrowserBridgePageContext {
  return {
    ...params,
    id: crypto.randomUUID(),
  };
}
