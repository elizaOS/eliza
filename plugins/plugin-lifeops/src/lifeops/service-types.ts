import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsCircadianState,
  LifeOpsWorkflowRun,
} from "../contracts/index.js";

export type LifeOpsWorkflowSchedulerState = {
  managedBy: "task_worker";
  nextDueAt: string | null;
  lastDueAt: string | null;
  lastRunId: string | null;
  lastRunStatus: LifeOpsWorkflowRun["status"] | null;
  updatedAt: string;
  /**
   * Tuple cursor for event-triggered workflows. Processing is ordered by
   * (end_at ASC, id ASC); after each fire we advance to the (end_at, id) of
   * the last-fired event so we never re-fire for an event we already ran.
   * Null for non-event workflows.
   */
  lastFiredEventEndAt?: string | null;
  lastFiredEventId?: string | null;
};

export type ExecuteWorkflowResult = {
  run: LifeOpsWorkflowRun;
  error: unknown | null;
};

export type RuntimeMessageTarget = Parameters<
  IAgentRuntime["sendMessageToTarget"]
>[0];
export type ReminderAttemptLifecycle = "plan" | "escalation";

export type LifeOpsAttentionContext = {
  source?:
    | "proactive_activity_profile"
    | "schedule_state"
    | "mixed"
    | "unknown";
  capturedAt?: string | null;
  sourceFreshnessMs?: number | null;
  sourceConfidence?: number | null;
  privacyMode?: "normal" | "sensitive" | "unknown";
  socialContext?: "alone" | "with_others" | "unknown";
  locationSafety?: "safe" | "transit" | "driving" | "unknown";
  primaryPlatform: string | null;
  secondaryPlatform: string | null;
  lastSeenPlatform: string | null;
  isCurrentlyActive: boolean;
  /** Epoch ms when owner was last seen active across any platform. */
  lastSeenAt: number | null;
  /** Current circadian state — single source of truth for sleep gating. */
  circadianState: LifeOpsCircadianState;
  /** Confidence of the circadianState, in [0, 1]. */
  stateConfidence: number;
  lastSleepEndedAt: string | null;
  nextMealLabel: string | null;
  nextMealWindowStartAt: string | null;
  nextMealWindowEndAt: string | null;
  calendarBusy?: boolean;
  dndActive?: boolean;
  hasCalendarData?: boolean;
  avgWeekdayMeetings?: number | null;
  hasOpenActivityCycle?: boolean;
  currentActivityCycleStartedAt?: number | null;
  screenContextFocus?:
    | "work"
    | "leisure"
    | "transition"
    | "idle"
    | "unknown"
    | null;
  screenContextBusy?: boolean;
  screenContextAvailable?: boolean;
  screenContextStale?: boolean;
  screenContextConfidence?: number | null;
};

export type ReminderActivityProfileSnapshot = LifeOpsAttentionContext;

export type RuntimeOwnerContactResolution = {
  sourceOfTruth: "config" | "relationships" | "config+relationships";
  preferredCommunicationChannel: string | null;
  platformIdentities: Array<{
    platform: string;
    handle: string;
    status?: string;
  }>;
  lastResponseAt: string | null;
  lastResponseChannel: string | null;
};

export type LifeOpsServiceOptions = {
  ownerEntityId?: string | null;
};

export class LifeOpsServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "LifeOpsServiceError";
  }
}
