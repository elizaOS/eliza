import type { IAgentRuntime } from "@elizaos/core"
import type { LifeOpsWorkflowRun } from "@elizaos/shared/contracts/lifeops"

export type LifeOpsWorkflowSchedulerState = {
  managedBy: "task_worker"
  nextDueAt: string | null
  lastDueAt: string | null
  lastRunId: string | null
  lastRunStatus: LifeOpsWorkflowRun["status"] | null
  updatedAt: string
  /**
   * Tuple cursor for event-triggered workflows. Processing is ordered by
   * (end_at ASC, id ASC); after each fire we advance to the (end_at, id) of
   * the last-fired event so we never re-fire for an event we already ran.
   * Null for non-event workflows.
   */
  lastFiredEventEndAt?: string | null
  lastFiredEventId?: string | null
}

export type ExecuteWorkflowResult = {
  run: LifeOpsWorkflowRun
  error: unknown | null
}

export type RuntimeMessageTarget = Parameters<IAgentRuntime["sendMessageToTarget"]>[0]
export type ReminderAttemptLifecycle = "plan" | "escalation"
export type ReminderActivityProfileSnapshot = {
  primaryPlatform: string | null
  secondaryPlatform: string | null
  lastSeenPlatform: string | null
  isCurrentlyActive: boolean
  /** Epoch ms when owner was last seen active across any platform. */
  lastSeenAt: number | null
  isProbablySleeping: boolean
  sleepConfidence: number
  schedulePhase: string | null
  lastSleepEndedAt: string | null
  nextMealLabel: string | null
  nextMealWindowStartAt: string | null
  nextMealWindowEndAt: string | null
}

export type RuntimeOwnerContactResolution = {
  sourceOfTruth: "config" | "relationships" | "config+relationships"
  preferredCommunicationChannel: string | null
  platformIdentities: Array<{
    platform: string
    handle: string
    status?: string
  }>
  lastResponseAt: string | null
  lastResponseChannel: string | null
}

export type LifeOpsServiceOptions = {
  ownerEntityId?: string | null
}

export class LifeOpsServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "LifeOpsServiceError"
  }
}
