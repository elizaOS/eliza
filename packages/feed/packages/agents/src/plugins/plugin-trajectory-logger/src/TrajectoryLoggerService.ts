/**
 * Trajectory Logger Service
 *
 * Core service for collecting agent interaction trajectories for RL training
 */

import { db, llmCallLogs, trajectories } from '@feed/db';
import type { JsonValue } from '@feed/shared';
import type { TrajectoryStep as TrainingTrajectoryStep } from '../../../training';
import { type IAgentRuntime, Service, type UUID } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../../shared/logger';
import { generateSnowflakeId } from '../../../shared/snowflake';
import type {
  ActionAttempt,
  CounterpartyContext,
  EnvironmentState,
  LLMCall,
  ProviderAccess,
  RewardComponents,
  Trajectory,
  TrajectoryStep,
} from './types';

type RuntimeEnvironmentStateInput = {
  timestamp?: number;
  agentBalance: number;
  agentPoints?: number;
  agentPnL: number;
  openPositions: number;
  activeMarkets?: number;
  portfolioValue?: number;
  unreadMessages?: number;
  recentEngagement?: number;
  groupChatsActive?: number;
  groupChatFacts?: string[];
  groupChatIntelTokenEstimate?: number;
  promptTokenEstimate?: number;
  contextBreakdown?: {
    system?: number;
    markets?: number;
    positions?: number;
    groupChat?: number;
    pending?: number;
    actionSchemas?: number;
    feed?: number;
  };
  custom?: Record<string, JsonValue>;
};

type InsertableDatabase = {
  insert: (table: unknown) => {
    values: (row: Record<string, unknown>) => Promise<unknown>;
  };
};

function normalizeEnvironmentState<T extends RuntimeEnvironmentStateInput>(
  envState: T
): EnvironmentState {
  const {
    timestamp,
    agentBalance,
    agentPoints,
    agentPnL,
    openPositions,
    activeMarkets,
    portfolioValue,
    unreadMessages,
    recentEngagement,
    groupChatsActive,
    groupChatFacts,
    groupChatIntelTokenEstimate,
    promptTokenEstimate,
    contextBreakdown,
    custom,
    ...extraFields
  } = envState;

  const mergedCustom: Record<string, JsonValue> = {
    ...(custom || {}),
  };

  for (const [key, value] of Object.entries(extraFields)) {
    if (value !== undefined) {
      mergedCustom[key] = value as JsonValue;
    }
  }

  return {
    timestamp: timestamp ?? Date.now(),
    agentBalance,
    agentPoints: agentPoints ?? 0,
    agentPnL,
    openPositions,
    activeMarkets,
    portfolioValue,
    unreadMessages,
    recentEngagement,
    groupChatsActive,
    groupChatFacts,
    groupChatIntelTokenEstimate,
    promptTokenEstimate,
    contextBreakdown,
    custom: Object.keys(mergedCustom).length > 0 ? mergedCustom : undefined,
  };
}

function getInsertableDb(): InsertableDatabase | null {
  const database = db as Partial<InsertableDatabase>;
  return typeof database.insert === 'function'
    ? (database as InsertableDatabase)
    : null;
}

export class TrajectoryLoggerService extends Service {
  static serviceType = 'trajectory_logger' as const;

  capabilityDescription =
    'Captures agent trajectories for RL training, debugging, and evaluation.';

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  static override async start(
    runtime: IAgentRuntime
  ): Promise<TrajectoryLoggerService> {
    return new TrajectoryLoggerService(runtime);
  }

  async stop(): Promise<void> {
    this.activeTrajectories.clear();
    this.activeStepIds.clear();
  }

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
    } = {}
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
        finalStatus: 'completed',
      },
      metadata: (options.metadata || {}) as Record<string, JsonValue>,
    };

    this.activeTrajectories.set(trajectoryId, trajectory);
    return trajectoryId;
  }

  /**
   * Start a new step in the trajectory
   */
  startStep<T extends RuntimeEnvironmentStateInput>(
    trajectoryId: string,
    envState: T
  ): string {
    const stepId = uuidv4();
    const trajectory = this.activeTrajectories.get(trajectoryId);

    if (!trajectory) {
      throw new Error(`Trajectory ${trajectoryId} not found`);
    }

    const environmentState = normalizeEnvironmentState(envState);

    const step: TrajectoryStep = {
      stepId: stepId as UUID,
      stepNumber: trajectory.steps.length,
      timestamp: environmentState.timestamp,
      environmentState,
      observation: {},
      llmCalls: [],
      providerAccesses: [],
      action: {
        attemptId: '',
        timestamp: 0,
        actionType: 'pending',
        actionName: 'pending',
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
    llmCall: Omit<LLMCall, 'callId' | 'timestamp'>
  ): void {
    const trajectory = this.findTrajectoryByStepId(stepId);
    if (!trajectory) {
      logger.warn('Trajectory not found for LLM call', { stepId });
      return;
    }

    const step = trajectory.steps.find((s) => s.stepId === stepId);
    if (!step) {
      logger.warn('Step not found for LLM call', { stepId });
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
          'Failed to save LLM call to database',
          error,
          'TrajectoryLoggerService'
        );
      }
    );
  }

  /**
   * Save LLM call to database using Drizzle
   */
  private async saveLLMCallToDB(
    trajectoryId: string,
    stepId: string,
    llmCall: LLMCall
  ): Promise<void> {
    const database = getInsertableDb();
    if (!database) {
      return;
    }

    await database.insert(llmCallLogs).values({
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
        reasoningAvailable: llmCall.reasoningAvailable ?? false,
        reasoningSource: llmCall.reasoningSource ?? null,
        traceVisibility: llmCall.traceVisibility ?? null,
        rawReasoningTrace: llmCall.rawReasoningTrace ?? null,
        privateAnalysis: llmCall.privateAnalysis ?? null,
        ...(llmCall.metadata ?? {}),
      }),
    });
  }

  /**
   * Log provider access
   */
  logProviderAccess(
    stepId: string,
    access: Omit<ProviderAccess, 'providerId' | 'timestamp'>
  ): void {
    const trajectory = this.findTrajectoryByStepId(stepId);
    if (!trajectory) {
      logger.warn('Trajectory not found for provider access', { stepId });
      return;
    }

    const step = trajectory.steps.find((s) => s.stepId === stepId);
    if (!step) {
      logger.warn('Step not found for provider access', { stepId });
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
    llmCall: Omit<LLMCall, 'callId' | 'timestamp'>
  ): void {
    const stepId = this.activeStepIds.get(trajectoryId);
    if (!stepId) {
      logger.warn('No active step for trajectory', { trajectoryId });
      return;
    }
    this.logLLMCall(stepId, llmCall);
  }

  /**
   * Log provider access using trajectory ID (convenience method)
   */
  logProviderAccessByTrajectoryId(
    trajectoryId: string,
    access: Omit<ProviderAccess, 'providerId' | 'timestamp'>
  ): void {
    const stepId = this.activeStepIds.get(trajectoryId);
    if (!stepId) {
      logger.warn('No active step for trajectory', { trajectoryId });
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
   * Set counterparty context on the current step.
   *
   * Call this BEFORE completeStep() to attach ground-truth metadata about
   * who the agent is interacting with. This enables intent-aware reward
   * computation during training.
   */
  setCounterpartyContext(
    trajectoryId: string,
    stepId: string,
    counterparty: CounterpartyContext
  ): void {
    const trajectory = this.activeTrajectories.get(trajectoryId);
    if (!trajectory) return;
    const step = trajectory.steps.find((s) => s.stepId === stepId);
    if (!step) return;
    step.counterpartyContext = counterparty;
  }

  /**
   * Set counterparty context on current step by trajectory ID.
   */
  setCurrentStepCounterpartyContext(
    trajectoryId: string,
    counterparty: CounterpartyContext
  ): void {
    const stepId = this.activeStepIds.get(trajectoryId);
    if (!stepId) return;
    this.setCounterpartyContext(trajectoryId, stepId, counterparty);
  }

  /**
   * Set the scenario intent on the trajectory metadata.
   *
   * Call this when ground-truth intent is known (e.g., from scenario matchmaker
   * or counterparty team assignment). Enables the over-refusal penalty in
   * deterministic reward judging.
   */
  setScenarioIntent(
    trajectoryId: string,
    intent: 'attack' | 'legitimate'
  ): void {
    const trajectory = this.activeTrajectories.get(trajectoryId);
    if (!trajectory) return;
    trajectory.metadata.scenarioIntent = intent;
  }

  /**
   * Set the agent's decision classification on the trajectory metadata.
   *
   * Should be called when the agent's overall behavior can be classified
   * (e.g., 'refuse', 'block', 'comply', 'engage', 'ignore').
   * Used by the over-refusal penalty to detect false positives.
   */
  setAgentDecisionClass(trajectoryId: string, decisionClass: string): void {
    const trajectory = this.activeTrajectories.get(trajectoryId);
    if (!trajectory) return;
    trajectory.metadata.agentDecisionClass = decisionClass;
  }

  /**
   * Complete a step with action and reward
   */
  completeStep(
    trajectoryId: string,
    stepId: string,
    action: Omit<ActionAttempt, 'attemptId' | 'timestamp'>,
    rewardInfo?: { reward?: number; components?: Partial<RewardComponents> }
  ): void {
    const trajectory = this.activeTrajectories.get(trajectoryId);
    if (!trajectory) {
      logger.warn('Trajectory not found for completeStep', { trajectoryId });
      return;
    }

    const step = trajectory.steps.find((s) => s.stepId === stepId);
    if (!step) {
      logger.warn('Step not found for completeStep', { trajectoryId, stepId });
      return;
    }

    step.action = {
      attemptId: uuidv4(),
      timestamp: Date.now(),
      ...action,
    };
    step.privateAnalysis =
      action.privateAnalysis ??
      step.llmCalls.find((call) => call.privateAnalysis)?.privateAnalysis;

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
    action: Omit<ActionAttempt, 'attemptId' | 'timestamp'>,
    rewardInfo?: { reward?: number; components?: Partial<RewardComponents> }
  ): void {
    const stepId = this.activeStepIds.get(trajectoryId);
    if (!stepId) {
      logger.warn('No active step for trajectory', { trajectoryId });
      return;
    }
    this.completeStep(trajectoryId, stepId, action, rewardInfo);
  }

  /**
   * End trajectory and save to database using Drizzle
   */
  async endTrajectory(
    trajectoryId: string,
    status: 'completed' | 'terminated' | 'error' | 'timeout',
    finalMetrics?: Record<string, JsonValue>
  ): Promise<void> {
    const trajectory = this.activeTrajectories.get(trajectoryId);
    if (!trajectory) {
      logger.warn('Trajectory not found for endTrajectory', { trajectoryId });
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

    // Step-level reward attribution: distribute totalReward across individual steps
    // so GRPO can identify which decisions mattered most in multi-turn episodes.
    // Must run BEFORE database save so attributed rewards are persisted.
    try {
      const totalReward = trajectory.totalReward;
      const steps = trajectory.steps;
      if (steps.length > 0 && totalReward !== 0) {
        let totalWeight = 0;
        for (const step of steps) {
          // A "real" action is one that was completed (not still 'pending' from init)
          const hasRealAction =
            step.action?.actionType !== undefined &&
            step.action.actionType !== 'pending' &&
            step.action.success === true;
          const hasLLMCall = (step.llmCalls?.length ?? 0) > 0;
          // Successful action steps get 2x weight, LLM-only steps get 1x, empty/pending steps get 0.5x
          step.stepWeight = hasRealAction ? 2.0 : hasLLMCall ? 1.0 : 0.5;
          totalWeight += step.stepWeight;
        }
        for (const step of steps) {
          step.attributedReward =
            totalReward * ((step.stepWeight ?? 1) / totalWeight);
        }
      }
    } catch {
      // Non-fatal — step attribution is best-effort
    }

    // Save to database using Drizzle
    const database = getInsertableDb();
    if (!database) {
      this.activeTrajectories.set(trajectoryId, trajectory);
      this.activeStepIds.delete(trajectoryId);
      return;
    }

    await database.insert(trajectories).values({
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
      archetype: (trajectory.metadata.archetype as string | undefined) ?? null,
      packId: (trajectory.metadata.packId as string | undefined) ?? null,
      worldStateSnapshotId:
        (trajectory.metadata.worldStateSnapshotId as string | undefined) ??
        null,
      memorySnapshotJson:
        trajectory.metadata.memorySnapshot != null
          ? JSON.stringify(trajectory.metadata.memorySnapshot)
          : null,
      relationshipSnapshotJson:
        trajectory.metadata.relationshipSnapshot != null
          ? JSON.stringify(trajectory.metadata.relationshipSnapshot)
          : null,
      updatedAt: new Date(),
    });

    logger.info(
      'Trajectory saved to database',
      {
        trajectoryId,
        agentId: trajectory.agentId,
        steps: trajectory.steps.length,
        totalReward: trajectory.totalReward,
      },
      'TrajectoryLoggerService'
    );

    // Compute and persist deterministic reward judgment for RL training.
    // This runs inline so every trajectory gets scored immediately after save,
    // closing the gap between data collection and reward computation.
    try {
      const { computeDeterministicRewardJudgment, upsertRewardJudgment } =
        await import('../../../training');
      // The plugin's TrajectoryStep type and the training package's TrajectoryStep
      // are structurally compatible but declared separately. Use unknown bridge.
      const trainingSteps =
        trajectory.steps as unknown as TrainingTrajectoryStep[];
      const judgment = computeDeterministicRewardJudgment({
        steps: trainingSteps,
        totalReward: trajectory.totalReward,
        finalPnL: trajectory.metrics.finalPnL as number | undefined,
        finalTrustScore: trajectory.metrics.finalTrustScore as
          | number
          | undefined,
        scenarioId: trajectory.scenarioId ?? undefined,
        scenarioProfile: trajectory.metadata.scenarioProfile as
          | string
          | undefined,
        scenarioIntent: trajectory.metadata.scenarioIntent as
          | 'attack'
          | 'legitimate'
          | undefined,
        agentDecisionClass: trajectory.metadata.agentDecisionClass as
          | string
          | undefined,
      });

      await upsertRewardJudgment({
        trajectoryId,
        ...judgment,
        syncTrajectory: true,
      });

      logger.info(
        'Deterministic reward judgment computed',
        {
          trajectoryId,
          overallScore: judgment.overallScore,
          components: Object.keys(judgment.componentScores ?? {}),
        },
        'TrajectoryLoggerService'
      );
    } catch (err) {
      // Non-fatal — trajectory is saved regardless of scoring
      logger.warn(
        'Failed to compute deterministic reward judgment (non-fatal)',
        {
          trajectoryId,
          error: err instanceof Error ? err.message : String(err),
        },
        'TrajectoryLoggerService'
      );
    }

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

declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    TRAJECTORY_LOGGER: 'trajectory_logger';
  }
}
