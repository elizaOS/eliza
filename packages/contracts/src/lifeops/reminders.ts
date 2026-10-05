/** LifeOps reminders contracts. Persisted and wire shapes are preserved. */

import type { LifeOpsAuditEvent } from "./events.js";
import type {
  LifeOpsChannelType,
  LifeOpsDomain,
  LifeOpsOwnerType,
  LifeOpsPrivacyClass,
  LifeOpsSubjectType,
} from "./policy.js";
import type { LifeOpsOccurrenceState } from "./scheduling.js";

export const LIFEOPS_REMINDER_CHANNELS = [
  "in_app",
  "sms",
  "voice",
  "telegram",
  "discord",
  "whatsapp",
  "imessage",
  "email",
  "push",
] as const;

export type LifeOpsReminderChannel = (typeof LIFEOPS_REMINDER_CHANNELS)[number];

export const LIFEOPS_REMINDER_URGENCY_LEVELS = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type LifeOpsReminderUrgency =
  (typeof LIFEOPS_REMINDER_URGENCY_LEVELS)[number];

export const LIFEOPS_REMINDER_INTENSITIES = [
  "minimal",
  "normal",
  "persistent",
  "high_priority_only",
] as const;

export type LifeOpsReminderIntensity =
  (typeof LIFEOPS_REMINDER_INTENSITIES)[number];

export const LIFEOPS_REMINDER_INTENSITY_COMPATIBILITY_VALUES = [
  "paused",
  "low",
  "high",
] as const;

export type LifeOpsReminderIntensityCompatibility =
  (typeof LIFEOPS_REMINDER_INTENSITY_COMPATIBILITY_VALUES)[number];

export type LifeOpsReminderIntensityInput =
  | LifeOpsReminderIntensity
  | LifeOpsReminderIntensityCompatibility;

export const LIFEOPS_REMINDER_PREFERENCE_SOURCES = [
  "default",
  "global_policy",
  "definition_metadata",
] as const;

export type LifeOpsReminderPreferenceSource =
  (typeof LIFEOPS_REMINDER_PREFERENCE_SOURCES)[number];

export interface LifeOpsReminderStep {
  channel: LifeOpsReminderChannel;
  offsetMinutes: number;
  label: string;
}

export interface LifeOpsQuietHoursPolicy {
  timezone: string;
  startMinute: number;
  endMinute: number;
  channels?: LifeOpsReminderChannel[];
}

export interface LifeOpsReminderPlan {
  id: string;
  agentId: string;
  ownerType: LifeOpsOwnerType;
  ownerId: string;
  steps: LifeOpsReminderStep[];
  mutePolicy: Record<string, unknown>;
  quietHours: LifeOpsQuietHoursPolicy | Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const LIFEOPS_REMINDER_ATTEMPT_OUTCOMES = [
  "delivered",
  "delivered_read",
  "delivered_unread",
  "blocked_policy",
  "blocked_quiet_hours",
  "blocked_urgency",
  "blocked_acknowledged",
  "blocked_connector",
  "skipped_duplicate",
] as const;

export type LifeOpsReminderAttemptOutcome =
  (typeof LIFEOPS_REMINDER_ATTEMPT_OUTCOMES)[number];

export type LifeOpsReminderReviewStatus =
  | "unrelated"
  | "needs_clarification"
  | "no_response"
  | "resolved"
  | "escalated"
  | "clarification_requested";

export interface LifeOpsReminderAttempt {
  id: string;
  agentId: string;
  planId: string;
  ownerType: LifeOpsOwnerType;
  ownerId: string;
  occurrenceId: string | null;
  channel: LifeOpsReminderChannel;
  stepIndex: number;
  scheduledFor: string;
  attemptedAt: string | null;
  outcome: LifeOpsReminderAttemptOutcome;
  connectorRef: string | null;
  deliveryMetadata: Record<string, unknown>;
  reviewAt?: string | null;
  reviewStatus?: LifeOpsReminderReviewStatus | null;
}

export interface LifeOpsChannelPolicy {
  id: string;
  agentId: string;
  channelType: LifeOpsChannelType;
  channelRef: string;
  privacyClass: LifeOpsPrivacyClass;
  allowReminders: boolean;
  allowEscalation: boolean;
  allowPosts: boolean;
  requireConfirmationForActions: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifeOpsReminderPreferenceSetting {
  intensity: LifeOpsReminderIntensity;
  source: LifeOpsReminderPreferenceSource;
  updatedAt: string | null;
  note: string | null;
}

export interface LifeOpsReminderPreference {
  definitionId: string | null;
  definitionTitle: string | null;
  global: LifeOpsReminderPreferenceSetting;
  definition: LifeOpsReminderPreferenceSetting | null;
  effective: LifeOpsReminderPreferenceSetting;
}

export interface LifeOpsActiveReminderView {
  domain: LifeOpsDomain;
  subjectType: LifeOpsSubjectType;
  subjectId: string;
  ownerType: "occurrence" | "calendar_event";
  ownerId: string;
  occurrenceId: string | null;
  definitionId: string | null;
  eventId: string | null;
  title: string;
  channel: LifeOpsReminderChannel;
  stepIndex: number;
  stepLabel: string;
  scheduledFor: string;
  dueAt: string | null;
  state: LifeOpsOccurrenceState | "upcoming";
  metadata?: Record<string, unknown>;
  htmlLink?: string | null;
  eventStartAt?: string | null;
}

export interface UpsertLifeOpsChannelPolicyRequest {
  channelType: LifeOpsChannelType;
  channelRef: string;
  privacyClass?: LifeOpsPrivacyClass;
  allowReminders?: boolean;
  allowEscalation?: boolean;
  allowPosts?: boolean;
  requireConfirmationForActions?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SetLifeOpsReminderPreferenceRequest {
  intensity: LifeOpsReminderIntensityInput;
  definitionId?: string | null;
  note?: string;
}

export interface CaptureLifeOpsPhoneConsentRequest {
  phoneNumber: string;
  consentGiven: boolean;
  allowSms: boolean;
  allowVoice: boolean;
  privacyClass?: LifeOpsPrivacyClass;
  metadata?: Record<string, unknown>;
}

export interface ProcessLifeOpsRemindersRequest {
  now?: string;
  limit?: number;
}

export interface LifeOpsReminderProcessingResult {
  /** Future absolute deadline from this exact processing snapshot. */
  nextWakeAt?: number;
  now: string;
  attempts: LifeOpsReminderAttempt[];
}

export interface LifeOpsReminderInspection {
  ownerType: "occurrence" | "calendar_event";
  ownerId: string;
  reminderPlan: LifeOpsReminderPlan | null;
  attempts: LifeOpsReminderAttempt[];
  audits: LifeOpsAuditEvent[];
}

export interface AcknowledgeLifeOpsReminderRequest {
  ownerType: "occurrence" | "calendar_event";
  ownerId: string;
  acknowledgedAt?: string;
  note?: string;
}
