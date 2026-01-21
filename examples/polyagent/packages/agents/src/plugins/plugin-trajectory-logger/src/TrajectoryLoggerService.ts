/**
 * Trajectory Logger Service
 *
 * Core service for collecting agent interaction trajectories for RL training
 */

import type { UUID } from "@elizaos/core";
import { db, llmCallLogs, trajectories } from "@polyagent/db";
import type { JsonValue } from "@polyagent/shared";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../../../shared/logger";
import { generateSnowflakeId } from "../../../shared/snowflake";
import type {
  ActionAttempt,
  EnvironmentState,
  LLMCall,
  ProviderAccess,
  RewardComponents,
  Trajectory,
  TrajectoryStep,
} from "./types";

export class TrajectoryLoggerService {
  private activeTrajectories: Map<string, Trajectory> = new Map();
  private activeStepIds: Map<string, string> = new Map(); // Maps trajectoryId -> current stepId

  /**
   * Start a new trajectory
   */
  startTrajectory(
    agentId: string,
    options: {
      scenarioId?: string;
      episodeId?: string;
      batchId?: string;
      groupIndex?: number;
      metadata?: Record<string, JsonValue>;
    } = {},
  ): string {
    const trajectoryId = uuidv4();
    const now = Date.now();

    const trajectory: Trajectory = {
      trajectoryId: trajectoryId as UUID,
      agentId: agentId as UUID,
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

  /**
   * Start a new step in the trajectory
   */
  startStep(trajectoryId: string, envState: EnvironmentState): string {
    const stepId = uuidv4();
    const trajectory = this.activeTrajectories.get(trajectoryId);

    if (!trajectory) {
      throw new Error(`Trajectory ${trajectoryId} not found`);
    }

    const step: TrajectoryStep = {
      stepId: stepId as UUID,
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

  /**
   * Log an LLM call
   */
  logLLMCall(
    stepId: string,
    llmCall: Omit<LLMCall, "callId" | "timestamp">,
  ): void {
    const trajectory = this.findTrajectoryByStepId(stepId);
    if (!trajectory) {
      logger.warn("Trajectory not found for LLM call", { stepId });
      return;
    }

    const step = trajectory.steps.find((s) => s.stepId === stepId);
    if (!step) {
      logger.warn("Step not found for LLM call", { stepId });
      return;
    }

    const fullLLMCall: LLMCall = {
      callId: uuidv4(),
      timestamp: Date.now(),
      ...llmCall,
    };

    step.llmCalls.push(fullLLMCall);

    // Also save to database for analysis
    this.saveLLMCallToDB(trajectory.trajectoryId, stepId, fullLLMCall).catch(
      (error) => {
        logger.error(
          "Failed to save LLM call to database",
          error,
          "TrajectoryLoggerService",
        );
      },
    );
  }

  /**
   * Save LLM call to database using Drizzle
   */
  private async saveLLMCallToDB(
    trajectoryId: string,
    stepId: string,
    llmCall: LLMCall,
  ): Promise<void> {
    await db.insert(llmCallLogs).values({
      id: await generateSnowflakeId(),
      trajectoryId,
      stepId,
      callId: llmCall.callId,
      timestamp: new Date(llmCall.timestamp),
      latencyMs: llmCall.latencyMs || undefined,
      model: llmCall.model,
      purpose: llmCall.purpose,
      actionType: llmCall.actionType || null,
      systemPrompt: llmCall.systemPrompt,
      userPrompt: llmCall.userPrompt,
      messagesJson: llmCall.messages ? JSON.stringify(llmCall.messages) : null,
      response: llmCall.response,
      reasoning: llmCall.reasoning || null,
      temperature: llmCall.temperature,
      maxTokens: llmCall.maxTokens,
      topP: llmCall.topP || null,
      promptTokens: llmCall.promptTokens || null,
      completionTokens: llmCall.completionTokens || null,
      totalTokens:
        llmCall.promptTokens && llmCall.completionTokens
          ? llmCall.promptTokens + llmCall.completionTokens
          : null,
      metadata: JSON.stringify({
        purpose: llmCall.purpose,
        actionType: llmCall.actionType,
        modelVersion: llmCall.modelVersion,
      }),
    });
  }

  /**
   * Log provider access
   */
  logProviderAccess(
    stepId: string,
    access: Omit<ProviderAccess, "providerId" | "timestamp">,
  ): void {
    const trajectory = this.findTrajectoryByStepId(stepId);
    if (!trajectory) {
      logger.warn("Trajectory not found for provider access", { stepId });
      return;
    }

    const step = trajectory.steps.find((s) => s.stepId === stepId);
    if (!step) {
      logger.warn("Step not found for provider access", { stepId });
      return;
    }

    const fullAccess: ProviderAccess = {
      providerId: uuidv4(),
      timestamp: Date.now(),
      ...access,
    };

    step.providerAccesses.push(fullAccess);
  }

  /**
   * Log LLM call using trajectory ID (convenience method)
   */
  logLLMCallByTrajectoryId(
    trajectoryId: string,
    llmCall: Omit<LLMCall, "callId" | "timestamp">,
  ): void {
    const stepId = this.activeStepIds.get(trajectoryId);
    if (!stepId) {
      logger.warn("No active step for trajectory", { trajectoryId });
      return;
    }
    this.logLLMCall(stepId, llmCall);
  }

  /**
   * Log provider access using trajectory ID (convenience method)
   */
  logProviderAccessByTrajectoryId(
    trajectoryId: string,
    access: Omit<ProviderAccess, "providerId" | "timestamp">,
  ): void {
    const stepId = this.activeStepIds.get(trajectoryId);
    if (!stepId) {
      logger.warn("No active step for trajectory", { trajectoryId });
      return;
    }
    this.logProviderAccess(stepId, access);
  }

  /**
   * Get current step ID for a trajectory
   */
  getCurrentStepId(trajectoryId: string): string | null {
    return this.activeStepIds.get(trajectoryId) || null;
  }

  /**
   * Complete a step with action and reward
   */
  completeStep(
    trajectoryId: string,
    stepId: string,
    action: Omit<ActionAttempt, "attemptId" | "timestamp">,
    rewardInfo?: { reward?: number; components?: Partial<RewardComponents> },
  ): void {
    const trajectory = this.activeTrajectories.get(trajectoryId);
    if (!trajectory) {
      logger.warn("Trajectory not found for completeStep", { trajectoryId });
      return;
    }

    const step = trajectory.steps.find((s) => s.stepId === stepId);
    if (!step) {
      logger.warn("Step not found for completeStep", { trajectoryId, stepId });
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

    // Clear current step ID
    this.activeStepIds.delete(trajectoryId);
  }

  /**
   * Complete step using current step ID (convenience method)
   */
  completeCurrentStep(
    trajectoryId: string,
    action: Omit<ActionAttempt, "attemptId" | "timestamp">,
    rewardInfo?: { reward?: number; components?: Partial<RewardComponents> },
  ): void {
    const stepId = this.activeStepIds.get(trajectoryId);
    if (!stepId) {
      logger.warn("No active step for trajectory", { trajectoryId });
      return;
    }
    this.completeStep(trajectoryId, stepId, action, rewardInfo);
  }

  /**
   * End trajectory and save to database using Drizzle
   */
  async endTrajectory(
    trajectoryId: string,
    status: "completed" | "terminated" | "error" | "timeout",
    finalMetrics?: Record<string, JsonValue>,
  ): Promise<void> {
    const trajectory = this.activeTrajectories.get(trajectoryId);
    if (!trajectory) {
      logger.warn("Trajectory not found for endTrajectory", { trajectoryId });
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

    // Save to database using Drizzle
    await db.insert(trajectories).values({
      id: await generateSnowflakeId(),
      trajectoryId,
      agentId: trajectory.agentId,
      startTime: new Date(trajectory.startTime),
      endTime: new Date(trajectory.endTime),
      durationMs: trajectory.durationMs,
      episodeId: trajectory.episodeId || null,
      scenarioId: trajectory.scenarioId || null,
      batchId: trajectory.batchId || null,
      stepsJson: JSON.stringify(trajectory.steps),
      rewardComponentsJson: JSON.stringify(trajectory.rewardComponents),
      metricsJson: JSON.stringify(trajectory.metrics),
      metadataJson: JSON.stringify(trajectory.metadata),
      totalReward: trajectory.totalReward,
      episodeLength: trajectory.metrics.episodeLength,
      finalStatus: trajectory.metrics.finalStatus,
      finalBalance:
        (trajectory.metrics.finalBalance as number | undefined) ?? null,
      finalPnL: (trajectory.metrics.finalPnL as number | undefined) ?? null,
      tradesExecuted:
        (trajectory.metrics.tradesExecuted as number | undefined) ?? null,
      postsCreated:
        (trajectory.metrics.postsCreated as number | undefined) ?? null,
      isTrainingData:
        (trajectory.metadata.isTrainingData as boolean | undefined) ?? true,
      isEvaluation:
        (trajectory.metadata.isEvaluation as boolean | undefined) ?? false,
      usedInTraining: false,
      updatedAt: new Date(),
    });

    logger.info(
      "Trajectory saved to database",
      {
        trajectoryId,
        agentId: trajectory.agentId,
        steps: trajectory.steps.length,
        totalReward: trajectory.totalReward,
      },
      "TrajectoryLoggerService",
    );

    // Keep in memory for retrieval
    this.activeTrajectories.set(trajectoryId, trajectory);
    this.activeStepIds.delete(trajectoryId);
  }

  /**
   * Get active trajectory
   */
  getActiveTrajectory(trajectoryId: string): Trajectory | null {
    return this.activeTrajectories.get(trajectoryId) || null;
  }

  /**
   * Helper to find trajectory by step ID
   */
  private findTrajectoryByStepId(stepId: string): Trajectory | null {
    for (const trajectory of this.activeTrajectories.values()) {
      if (trajectory.steps.some((s) => s.stepId === stepId)) {
        return trajectory;
      }
    }
    return null;
  }
}
