import { pgEnum } from "drizzle-orm/pg-core";

// Realtime Outbox Status
export const realtimeOutboxStatusEnum = pgEnum("RealtimeOutboxStatus", [
  "pending",
  "sent",
  "failed",
]);

// Sentry Webhook Inbox Status
export const sentryWebhookInboxStatusEnum = pgEnum("SentryWebhookInboxStatus", [
  "pending",
  "processing",
  "processed",
  "failed",
  "dead",
]);

export const sentryIncidentRunStatusEnum = pgEnum("SentryIncidentRunStatus", [
  "running",
  "completed",
  "failed",
  "suppressed",
]);

export const sentryIncidentRunDecisionEnum = pgEnum(
  "SentryIncidentRunDecision",
  ["pending", "skip_linear", "reuse_linear", "create_linear", "process_issue"],
);

export const sentryIncidentAlertOutboxStatusEnum = pgEnum(
  "SentryIncidentAlertOutboxStatus",
  ["pending", "processing", "sent", "failed", "dead"],
);

// Onboarding Status
export const onboardingStatusEnum = pgEnum("OnboardingStatus", [
  "PENDING_PROFILE",
  "PENDING_ONCHAIN",
  "ONCHAIN_IN_PROGRESS",
  "ONCHAIN_FAILED",
  "COMPLETED",
]);

// Agent Type
export const agentTypeEnum = pgEnum("AgentType", [
  "USER_CONTROLLED",
  "NPC",
  "EXTERNAL",
]);

// Agent Status
export const agentStatusEnum = pgEnum("AgentStatus", [
  "REGISTERED",
  "INITIALIZED",
  "ACTIVE",
  "PAUSED",
  "TERMINATED",
]);
