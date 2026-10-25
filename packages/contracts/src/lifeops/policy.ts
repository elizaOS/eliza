/** LifeOps policy contracts. Persisted and wire shapes are preserved. */

import type { LifeOpsCapabilityStatus } from "./connectors.js";
import type { LifeOpsRelativeTime } from "./health.js";
import type { LifeOpsTelemetryFamily } from "./telemetry.js";

export const LIFEOPS_CHANNEL_TYPES = [
  "in_app",
  "sms",
  "voice",
  "telegram",
  "discord",
  "whatsapp",
  "imessage",
  "x",
  "browser",
  "email",
  "push",
  // Note: "cloud" in LIFEOPS_REMINDER_CHANNELS is a deployment target, not a user-facing delivery channel
] as const;

export type LifeOpsChannelType = (typeof LIFEOPS_CHANNEL_TYPES)[number];

export const LIFEOPS_PRIVACY_CLASSES = ["private", "shared", "public"] as const;

export type LifeOpsPrivacyClass = (typeof LIFEOPS_PRIVACY_CLASSES)[number];

export const LIFEOPS_DOMAINS = ["user_lifeops", "agent_ops"] as const;

export type LifeOpsDomain = (typeof LIFEOPS_DOMAINS)[number];

export const LIFEOPS_SUBJECT_TYPES = ["owner", "agent"] as const;

export type LifeOpsSubjectType = (typeof LIFEOPS_SUBJECT_TYPES)[number];

export const LIFEOPS_VISIBILITY_SCOPES = [
  "owner_only",
  "agent_and_admin",
  "owner_agent_admin",
] as const;

export type LifeOpsVisibilityScope = (typeof LIFEOPS_VISIBILITY_SCOPES)[number];

export const LIFEOPS_CONTEXT_POLICIES = [
  "never",
  "explicit_only",
  "sidebar_only",
  "allowed_in_private_chat",
] as const;

export type LifeOpsContextPolicy = (typeof LIFEOPS_CONTEXT_POLICIES)[number];

export const LIFEOPS_OWNER_TYPES = [
  "definition",
  "occurrence",
  "goal",
  "workflow",
  "calendar_event",
  "gmail_message",
  "connector",
  "channel_policy",
  "browser_session",
  "circadian_state",
  "household_role",
  "household_grant",
  "household_proposal",
  "household_agreement",
  "household_export",
] as const;

export type LifeOpsOwnerType = (typeof LIFEOPS_OWNER_TYPES)[number];

export const LIFEOPS_ACTORS = [
  "agent",
  "user",
  "workflow",
  "connector",
] as const;

export type LifeOpsActor = (typeof LIFEOPS_ACTORS)[number];

export interface LifeOpsOwnership {
  domain: LifeOpsDomain;
  subjectType: LifeOpsSubjectType;
  subjectId: string;
  visibilityScope: LifeOpsVisibilityScope;
  contextPolicy: LifeOpsContextPolicy;
}

export interface LifeOpsOwnershipInput {
  domain?: LifeOpsDomain;
  subjectType?: LifeOpsSubjectType;
  subjectId?: string;
  visibilityScope?: LifeOpsVisibilityScope;
  contextPolicy?: LifeOpsContextPolicy;
}

export type LifeOpsMessageDirection = "inbound" | "outbound_by_owner";

/**
 * Open-string bus-family identifier (W2-D).
 *
 * The closed `LifeOpsTelemetryFamily` union above retains the schema
 * discriminant for the 11 built-in telemetry payloads. The bus layer surfaces
 * additional namespaced families contributed by other plugins (e.g.
 * `health.sleep.detected` from `@elizaos/plugin-health`,
 * `calendar.meeting.ended` from app-lifeops calendar). Those families are
 * validated at runtime via the FamilyRegistry rather than statically through
 * a closed union — the union would otherwise need to grow every time a
 * plugin contributes a new event family.
 *
 * Convention:
 *   - built-ins: lower-snake-case (`device_presence_event`).
 *   - namespaced contributions: dotted, lower-case (`health.sleep.detected`).
 */
export type LifeOpsBusFamily = LifeOpsTelemetryFamily | string;

export interface LifeOpsCapabilitiesSummary {
  totalCount: number;
  workingCount: number;
  degradedCount: number;
  blockedCount: number;
  notConfiguredCount: number;
}

export interface LifeOpsCapabilitiesStatus {
  generatedAt: string;
  appEnabled: boolean;
  relativeTime: LifeOpsRelativeTime | null;
  capabilities: LifeOpsCapabilityStatus[];
  summary: LifeOpsCapabilitiesSummary;
}
