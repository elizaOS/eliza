import type { IAgentRuntime } from "@elizaos/core"
import type { LifeOpsWorkflowRun } from "@elizaos/shared/contracts/lifeops"

export type LifeOpsWorkflowSchedulerState = {
  managedBy: "task_worker"
  nextDueAt: string | null
  lastDueAt: string | null
  lastRunId: string | null
  lastRunStatus: LifeOpsWorkflowRun["status"] | null
  updatedAt: string
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
