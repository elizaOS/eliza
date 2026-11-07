/** LifeOps events contracts. Persisted and wire shapes are preserved. */
import type { LifeOpsCalendarEventEndedFilters } from "../calendar.js";
import type { LifeOpsGmailEventFilters } from "./gmail.js";
import type {
  LifeOpsBedtimeImminentFilters,
  LifeOpsNapDetectedFilters,
  LifeOpsRegularityChangedFilters,
  LifeOpsSleepDetectedFilters,
  LifeOpsSleepEndedFilters,
  LifeOpsSleepOnsetCandidateFilters,
  LifeOpsWakeConfirmedFilters,
  LifeOpsWakeObservedFilters,
} from "./health.js";
import type { LifeOpsActor, LifeOpsOwnerType } from "./policy.js";

/**
 * Registry of event kinds that can fire a LifeOps workflow.
 *
 * Each entry is a stable identifier ("namespace.subject.verb") emitted by a
 * detector inside the engine. Adding a new entry means adding a detector that
 * publishes matching occurrences to `runDueEventWorkflows`, and — optionally —
 * a filter shape under {@link LifeOpsEventFilters}.
 */
export const LIFEOPS_EVENT_KINDS = [
  "calendar.event.ended",
  "gmail.message.received",
  "gmail.thread.needs_response",
  "lifeops.sleep.onset_candidate",
  "lifeops.sleep.detected",
  "lifeops.sleep.ended",
  "lifeops.wake.observed",
  "lifeops.wake.confirmed",
  "lifeops.nap.detected",
  "lifeops.bedtime.imminent",
  "lifeops.regularity.changed",
] as const;

export type LifeOpsEventKind = (typeof LIFEOPS_EVENT_KINDS)[number];

export type LifeOpsEventFilters =
  | {
      kind: "calendar.event.ended";
      filters?: LifeOpsCalendarEventEndedFilters;
    }
  | {
      kind: "gmail.message.received";
      filters?: LifeOpsGmailEventFilters;
    }
  | {
      kind: "gmail.thread.needs_response";
      filters?: LifeOpsGmailEventFilters;
    }
  | {
      kind: "lifeops.sleep.onset_candidate";
      filters?: LifeOpsSleepOnsetCandidateFilters;
    }
  | {
      kind: "lifeops.sleep.detected";
      filters?: LifeOpsSleepDetectedFilters;
    }
  | {
      kind: "lifeops.sleep.ended";
      filters?: LifeOpsSleepEndedFilters;
    }
  | {
      kind: "lifeops.wake.observed";
      filters?: LifeOpsWakeObservedFilters;
    }
  | {
      kind: "lifeops.wake.confirmed";
      filters?: LifeOpsWakeConfirmedFilters;
    }
  | {
      kind: "lifeops.nap.detected";
      filters?: LifeOpsNapDetectedFilters;
    }
  | {
      kind: "lifeops.bedtime.imminent";
      filters?: LifeOpsBedtimeImminentFilters;
    }
  | {
      kind: "lifeops.regularity.changed";
      filters?: LifeOpsRegularityChangedFilters;
    };

export const LIFEOPS_AUDIT_EVENT_TYPES = [
  "definition_created",
  "definition_updated",
  "definition_deleted",
  "occurrence_generated",
  "occurrence_completed",
  "occurrence_progress_recorded",
  "occurrence_skipped",
  "occurrence_snoozed",
  "goal_created",
  "goal_updated",
  "goal_deleted",
  "goal_reviewed",
  "calendar_event_created",
  "calendar_event_updated",
  "calendar_event_deleted",
  "gmail_triage_synced",
  "gmail_reply_drafted",
  "gmail_reply_sent",
  "gmail_message_sent",
  "reminder_due",
  "reminder_delivered",
  "reminder_blocked",
  "reminder_escalation_started",
  "reminder_escalation_resolved",
  "workflow_created",
  "workflow_updated",
  "workflow_run",
  "connector_grant_updated",
  "channel_policy_updated",
  "browser_session_created",
  "browser_session_updated",
  "x_post_sent",
  "seeding_offered",
  "circadian_event_emitted",
  "manual_override_accepted",
  "household_role_bound",
  "household_grant_issued",
  "household_grant_revoked",
  "household_proposal_created",
  "household_proposal_revised",
  "household_proposal_approved",
  "household_proposal_invalidated",
  "household_agreement_activated",
  "household_export_read",
] as const;

export type LifeOpsAuditEventType = (typeof LIFEOPS_AUDIT_EVENT_TYPES)[number];

export interface LifeOpsAuditEvent {
  id: string;
  agentId: string;
  eventType: LifeOpsAuditEventType;
  ownerType: LifeOpsOwnerType;
  ownerId: string;
  reason: string;
  inputs: Record<string, unknown>;
  decision: Record<string, unknown>;
  actor: LifeOpsActor;
  createdAt: string;
}
