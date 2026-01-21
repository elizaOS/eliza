import { pgEnum } from "drizzle-orm/pg-core";

// Realtime Outbox Status
export const realtimeOutboxStatusEnum = pgEnum("RealtimeOutboxStatus", [
  "pending",
  "sent",
  "failed",
]);

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
