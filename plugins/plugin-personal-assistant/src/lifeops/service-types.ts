/**
 * Shared types for the LifeOpsService: service options, workflow scheduler
 * state, and related structural types, plus a re-export of the shared
 * LifeOpsServiceError.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { LifeOpsServiceError } from "@elizaos/shared";
import type {
  LifeOpsCircadianState,
  LifeOpsWorkflowRun,
} from "../contracts/index.js";

// LifeOpsServiceError is a runtime-level primitive in `@elizaos/shared`,
// re-exported here for `./service-types.js` callers.
export { LifeOpsServiceError };

export class LifeOpsWorkflowRunFailedUncompensatedError extends LifeOpsServiceError {
  readonly cause: unknown;

  constructor(
    readonly run: LifeOpsWorkflowRun,
    readonly failedCompensationKinds: readonly string[],
    cause: unknown,
    status = 500,
  ) {
    super(
      status,
      `workflow run ${run.id} failed with uncompensated side effects`,
      "WORKFLOW_RUN_FAILED_UNCOMPENSATED",
    );
    this.name = "LifeOpsWorkflowRunFailedUncompensatedError";
    this.cause = cause;
  }
}

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
  disposition: "executed" | "replayed" | "in_progress";
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
