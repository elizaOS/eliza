/**
 * Trajectory Logger Service
 *
 * In-memory collector for agent interaction trajectories.
 *
 * This implementation is intentionally storage-agnostic so it can be used in any elizaOS
 * environment (Node, Bun, tests). If you want persistence, export trajectories and store them
 * via your preferred database or file pipeline.
 */

import { asUUID, logger } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import type {
  ActionAttempt,
  EnvironmentState,
  JsonValue,
  LLMCall,
  ProviderAccess,
  RewardComponents,
  Trajectory,
  TrajectoryStep,
} from "./types";

export class TrajectoryLoggerService {
  private activeTrajectories: Map<string, Trajectory> = new Map();
  private activeStepIds: Map<string, string> = new Map();

  startTrajectory(
    agentId: string,
    options: {
      scenarioId?: string;
      episodeId?: string;
      batchId?: string;
      groupIndex?: number;
      metadata?: Record<string, JsonValue>;
    } = {}
  ): string {
    const trajectoryId = uuidv4();
    const now = Date.now();

    const trajectory: Trajectory = {
      trajectoryId: asUUID(trajectoryId),
      agentId: asUUID(agentId),
      startTime: now,
      endTime: now,
      durationMs: 0,
      episodeId: options.episodeId,
      scenarioId: options.scenarioId,
      batchId: options.batchId,
      groupIndex: options.groupIndex,
      steps: [],
      totalReward: 0,
      rewardComponents: {
        environmentReward: 0,
      },
      metrics: {
        episodeLength: 0,
        finalStatus: "completed",
      },
      metadata: (options.metadata || {}) as Record<string, JsonValue>,
    };

    this.activeTrajectories.set(trajectoryId, trajectory);
    return trajectoryId;
  }

  startStep(trajectoryId: string, envState: EnvironmentState): string {
    const stepId = uuidv4();
    const trajectory = this.activeTrajectories.get(trajectoryId);

    if (!trajectory) {
      throw new Error(`Trajectory ${trajectoryId} not found`);
    }

    const step: TrajectoryStep = {
      stepId: asUUID(stepId),
      stepNumber: trajectory.steps.length,
      timestamp: envState.timestamp || Date.now(),
      environmentState: envState,
      observation: {},
      llmCalls: [],
      providerAccesses: [],
      action: {
        attemptId: "",
        timestamp: 0,
        actionType: "pending",
        actionName: "pending",
        parameters: {},
        success: false,
      },
      reward: 0,
      done: false,
    };

    trajectory.steps.push(step);
    this.activeStepIds.set(trajectoryId, stepId);
    return stepId;
  }

  logLLMCall(stepId: string, llmCall: Omit<LLMCall, "callId" | "timestamp">): void {
    const trajectory = this.findTrajectoryByStepId(stepId);
    if (!trajectory) {
      logger.warn({ stepId }, "Trajectory not found for LLM call");
      return;
    }

    const step = trajectory.steps.find((s) => s.stepId === stepId);
    if (!step) {
      logger.warn({ stepId }, "Step not found for LLM call");
      return;
    }

    const fullLLMCall: LLMCall = {
      callId: uuidv4(),
      timestamp: Date.now(),
      ...llmCall,
    };

    step.llmCalls.push(fullLLMCall);
  }

  logProviderAccess(
    stepId: string,
    access: Omit<ProviderAccess, "providerId" | "timestamp">
  ): void {
    const trajectory = this.findTrajectoryByStepId(stepId);
    if (!trajectory) {
      logger.warn({ stepId }, "Trajectory not found for provider access");
      return;
    }

    const step = trajectory.steps.find((s) => s.stepId === stepId);
    if (!step) {
      logger.warn({ stepId }, "Step not found for provider access");
      return;
    }

    const fullAccess: ProviderAccess = {
      providerId: uuidv4(),
      timestamp: Date.now(),
      ...access,
    };

    step.providerAccesses.push(fullAccess);
  }

  logLLMCallByTrajectoryId(
    trajectoryId: string,
    llmCall: Omit<LLMCall, "callId" | "timestamp">
  ): void {
    const stepId = this.activeStepIds.get(trajectoryId);
    if (!stepId) {
      logger.warn({ trajectoryId }, "No active step for trajectory");
      return;
    }
    this.logLLMCall(stepId, llmCall);
  }

  logProviderAccessByTrajectoryId(
    trajectoryId: string,
    access: Omit<ProviderAccess, "providerId" | "timestamp">
  ): void {
    const stepId = this.activeStepIds.get(trajectoryId);
    if (!stepId) {
      logger.warn({ trajectoryId }, "No active step for trajectory");
      return;
    }
    this.logProviderAccess(stepId, access);
  }

  getCurrentStepId(trajectoryId: string): string | null {
    return this.activeStepIds.get(trajectoryId) || null;
  }

  completeStep(
    trajectoryId: string,
    stepId: string,
    action: Omit<ActionAttempt, "attemptId" | "timestamp">,
    rewardInfo?: { reward?: number; components?: Partial<RewardComponents> }
  ): void {
    const trajectory = this.activeTrajectories.get(trajectoryId);
    if (!trajectory) {
      logger.warn({ trajectoryId }, "Trajectory not found for completeStep");
      return;
    }

    const step = trajectory.steps.find((s) => s.stepId === stepId);
    if (!step) {
      logger.warn({ trajectoryId, stepId }, "Step not found for completeStep");
      return;
    }

    step.action = {
      attemptId: uuidv4(),
      timestamp: Date.now(),
      ...action,
    };

    if (rewardInfo?.reward !== undefined) {
      step.reward = rewardInfo.reward;
      trajectory.totalReward += rewardInfo.reward;
    }

    if (rewardInfo?.components) {
      trajectory.rewardComponents = {
        ...trajectory.rewardComponents,
        ...rewardInfo.components,
      };
    }

    this.activeStepIds.delete(trajectoryId);
  }

  completeCurrentStep(
    trajectoryId: string,
    action: Omit<ActionAttempt, "attemptId" | "timestamp">,
    rewardInfo?: { reward?: number; components?: Partial<RewardComponents> }
  ): void {
    const stepId = this.activeStepIds.get(trajectoryId);
    if (!stepId) {
      logger.warn({ trajectoryId }, "No active step for trajectory");
      return;
    }
    this.completeStep(trajectoryId, stepId, action, rewardInfo);
  }

  async endTrajectory(
    trajectoryId: string,
    status: "completed" | "terminated" | "error" | "timeout",
    finalMetrics?: Record<string, JsonValue>
  ): Promise<void> {
    const trajectory = this.activeTrajectories.get(trajectoryId);
    if (!trajectory) {
      logger.warn({ trajectoryId }, "Trajectory not found for endTrajectory");
      return;
    }

    trajectory.endTime = Date.now();
    trajectory.durationMs = trajectory.endTime - trajectory.startTime;
    trajectory.metrics.finalStatus = status;
    trajectory.metrics.episodeLength = trajectory.steps.length;

    if (finalMetrics) {
      trajectory.metrics = {
        ...trajectory.metrics,
        ...finalMetrics,
      };
    }

    this.activeStepIds.delete(trajectoryId);
  }

  getActiveTrajectory(trajectoryId: string): Trajectory | null {
    return this.activeTrajectories.get(trajectoryId) || null;
  }

  private findTrajectoryByStepId(stepId: string): Trajectory | null {
    for (const trajectory of this.activeTrajectories.values()) {
      if (trajectory.steps.some((s) => s.stepId === stepId)) {
        return trajectory;
      }
    }
    return null;
  }
}
