/**
 * TrajectoryRecorder
 *
 * Records agent decisions with full context for GRPO training.
 * Captures environment state, LLM calls, actions, and rewards.
 *
 * @packageDocumentation
 */

import {
  db,
  getJsonStoragePath,
  isSimulationMode,
  llmCallLogs,
  rewardJudgments,
  trajectories,
} from '@feed/db'; // keep this at db not engine to avoid circular dep
import type { JsonValue } from '@feed/shared';
import { logger } from '/shared';
import { generateSnowflakeId } from '/shared';
import { computeDeterministicRewardJudgment } from './reward-judgments';
import type {
  Action,
  EnvironmentState,
  LLMCall,
  ProviderAccess,
  TrajectoryStep,
  TrustState,
} from './types';
import { getCurrentWindowId } from './window-utils';

export type {
  Action,
  EnvironmentState,
  LLMCall,
  ProviderAccess,
  TrajectoryStep,
  TrustState,
};

import * as fs from 'fs';
import * as path from 'path';

/**
 * Active trajectory being recorded.
 */
interface ActiveTrajectory {
  trajectoryId: string;
  agentId: string;
  archetype?: string;
  scenarioId?: string;
  episodeId?: string;
  batchId?: string;
  windowId?: string;
  startTime: number;
  steps: TrajectoryStep[];
  currentStep?: Partial<TrajectoryStep>;
  metadata: Record<string, JsonValue>;
}

/**
 * Options for starting a trajectory.
 */
export interface StartTrajectoryOptions {
  /** The agent's user ID */
  agentId: string;
  /** The agent's behavioral archetype */
  archetype?: string;
  /** Optional scenario identifier */
  scenarioId?: string;
  /** Optional episode identifier */
  episodeId?: string;
  /** Optional batch identifier */
  batchId?: string;
  /** Optional time window ID */
  windowId?: string;
  /** Optional metadata */
  metadata?: Record<string, JsonValue>;
}

/**
 * Options for ending a trajectory.
 */
export interface EndTrajectoryOptions {
  /** Final account balance */
  finalBalance?: number;
  /** Final profit/loss */
  finalPnL?: number;
  /** Optional final trust score for trust/scam benchmarks */
  finalTrustScore?: number;
  /** Optional scenario trust profile */
  scenarioProfile?: string;
  /** Time window ID */
  windowId?: string;
  /** Ground truth market data */
  gameKnowledge?: {
    trueProbabilities?: Record<string, number>;
    actualOutcomes?: Record<string, JsonValue>;
    futureOutcomes?: Record<string, JsonValue>;
  };
  /** World state snapshot ID for context */
  worldStateSnapshotId?: string;
  /** Content pack ID */
  packId?: string;
  /** Ground-truth scenario intent (attack = scam attempt, legitimate = normal interaction) */
  scenarioIntent?: 'attack' | 'legitimate';
  /** Classification of the agent's decision (e.g., 'refuse', 'block', 'comply', 'engage') */
  agentDecisionClass?: string;
  /** NPC role (insider, affiliated, observer) */
  npcRole?: string;
  /** Associated question IDs */
  questionIds?: string[];
  /** Associated event IDs */
  eventIds?: string[];
  /** Current arc phase */
  arcPhase?: string;
  /** Memory snapshot at trajectory end */
  memorySnapshot?: unknown;
  /** Relationship snapshot at trajectory end */
  relationshipSnapshot?: unknown;
  /** Trust experiment verifiable outcomes */
  trustOutcomes?: {
    /** Number of scam attempts the agent correctly identified and resisted */
    scamAttemptsDetected?: number;
    /** Number of scam attempts the agent fell for */
    scamAttemptsFellFor?: number;
    /** USD value of scam losses the agent avoided */
    scamLossesAvoided?: number;
    /** USD value of losses from scams the agent fell for */
    scamLossesIncurred?: number;
    /** Number of times the agent leaked credentials or secrets */
    unsafeDisclosures?: number;
    /** Social capital score (0-100) */
    socialCapital?: number;
    /** Number of legitimate interactions the agent accepted/engaged with */
    legitimateInteractionsAccepted?: number;
    /** Number of legitimate interactions the agent rejected/ignored (false positives) */
    legitimateInteractionsRejected?: number;
    /** Whether the agent interacted with any red-team NPCs */
    interactedWithRedTeam?: boolean;
    /** Whether the agent interacted with any blue-team NPCs */
    interactedWithBlueTeam?: boolean;
    /** IDs of red-team NPCs this agent interacted with */
    redTeamNpcIds?: string[];
    /** Per-interaction ground-truth labels derived from counterparty identity */
    interactionLabels?: Array<{
      counterpartyId: string;
      counterpartyTeam: 'red' | 'blue' | 'gray';
      counterpartyAlignment: 'good' | 'neutral' | 'evil';
      channel:
        | 'dm'
        | 'group-chat'
        | 'payment'
        | 'trade'
        | 'support-ticket'
        | 'email';
      amountTransferred?: number;
      messageCount: number;
      wasScam: boolean;
      wasLegitimate: boolean;
      wasRejected: boolean;
    }>;
  };
}

/**
 * Records agent trajectories for RL training.
 */
export class TrajectoryRecorder {
  private activeTrajectories: Map<string, ActiveTrajectory> = new Map();
  private activeStepIds: Map<string, string> = new Map();

  /**
   * Start recording a new trajectory.
   * @param options - Configuration for the trajectory
   * @returns The unique trajectory ID
   */
  async startTrajectory(options: StartTrajectoryOptions): Promise<string> {
    const trajectoryId = await generateSnowflakeId();
    const windowId = options.windowId || getCurrentWindowId();

    this.activeTrajectories.set(trajectoryId, {
      trajectoryId,
      agentId: options.agentId,
      archetype: options.archetype,
      scenarioId: options.scenarioId || windowId,
      episodeId: options.episodeId,
      batchId: options.batchId,
      windowId,
      startTime: Date.now(),
      steps: [],
      metadata: { ...(options.metadata || {}) },
    });

    logger.info('Started trajectory recording', {
      trajectoryId,
      agentId: options.agentId,
      archetype: options.archetype,
      scenarioId: options.scenarioId,
      episodeId: options.episodeId,
      batchId: options.batchId,
      windowId,
    });

    return trajectoryId;
  }

  /**
   * Start a new step in the trajectory.
   * @param trajectoryId - The trajectory ID
   * @param environmentState - Current environment state
   * @throws Error if trajectory not found
   */
  startStep(
    trajectoryId: string,
    environmentState: EnvironmentState,
    trustState?: TrustState
  ): string {
    const traj = this.activeTrajectories.get(trajectoryId);
    if (!traj) {
      throw new Error(`Trajectory not found: ${trajectoryId}`);
    }

    const stepId = `${trajectoryId}-step-${traj.steps.length}`;
    traj.currentStep = {
      stepNumber: traj.steps.length,
      timestamp: Date.now(),
      environmentState,
      providerAccesses: [],
      llmCalls: [],
      reward: 0,
      trustState,
    };
    this.activeStepIds.set(trajectoryId, stepId);
    return stepId;
  }

  /**
   * Log a provider access in the current step.
   * @param trajectoryId - The trajectory ID
   * @param access - Provider access details
   * @throws Error if no current step exists
   */
  logProviderAccess(
    trajectoryIdOrStepId: string,
    access: {
      providerName: string;
      data: Record<string, JsonValue>;
      purpose: string;
      query?: Record<string, JsonValue>;
    }
  ): void {
    const trajectoryId = this.resolveTrajectoryId(trajectoryIdOrStepId);
    const traj = this.activeTrajectories.get(trajectoryId);
    if (!traj?.currentStep) {
      throw new Error(`No current step for trajectory: ${trajectoryId}`);
    }

    traj.currentStep.providerAccesses = traj.currentStep.providerAccesses || [];
    traj.currentStep.providerAccesses.push(access);
  }

  /**
   * Log an LLM call in the current step.
   * @param trajectoryId - The trajectory ID
   * @param llmCall - LLM call details
   * @throws Error if no current step exists
   */
  logLLMCall(trajectoryIdOrStepId: string, llmCall: LLMCall): void {
    const trajectoryId = this.resolveTrajectoryId(trajectoryIdOrStepId);
    const traj = this.activeTrajectories.get(trajectoryId);
    if (!traj?.currentStep) {
      throw new Error(`No current step for trajectory: ${trajectoryId}`);
    }

    traj.currentStep.llmCalls = traj.currentStep.llmCalls || [];
    traj.currentStep.llmCalls.push(llmCall);
  }

  /**
   * Complete the current step with an action.
   * @param trajectoryId - The trajectory ID
   * @param action - The action taken
   * @param reward - Immediate reward for the step
   * @throws Error if no current step exists
   */
  completeStep(trajectoryId: string, action: Action, reward?: number): void;
  completeStep(
    trajectoryId: string,
    stepId: string,
    action: Action,
    rewardInfo?: { reward?: number }
  ): void;
  completeStep(
    trajectoryId: string,
    actionOrStepId: Action | string,
    actionOrReward?: Action | number,
    maybeRewardInfo?: { reward?: number }
  ): void {
    const traj = this.activeTrajectories.get(trajectoryId);
    if (!traj?.currentStep) {
      throw new Error(`No current step for trajectory: ${trajectoryId}`);
    }

    let action: Action;
    let reward = 0;

    if (typeof actionOrStepId === 'string') {
      const expectedStepId = this.activeStepIds.get(trajectoryId);
      if (expectedStepId && expectedStepId !== actionOrStepId) {
        throw new Error(
          `Step mismatch for trajectory ${trajectoryId}: expected ${expectedStepId}, got ${actionOrStepId}`
        );
      }

      if (typeof actionOrReward === 'number' || actionOrReward === undefined) {
        throw new Error(`Action missing for trajectory: ${trajectoryId}`);
      }

      action = actionOrReward;
      reward = maybeRewardInfo?.reward ?? 0;
    } else {
      action = actionOrStepId;
      reward =
        typeof actionOrReward === 'number'
          ? actionOrReward
          : (maybeRewardInfo?.reward ?? 0);
    }

    const completeStep: TrajectoryStep = {
      stepNumber: traj.currentStep.stepNumber!,
      timestamp: traj.currentStep.timestamp!,
      environmentState: traj.currentStep.environmentState!,
      providerAccesses: traj.currentStep.providerAccesses || [],
      llmCalls: traj.currentStep.llmCalls || [],
      action,
      reward,
      trustState: traj.currentStep.trustState,
      privateAnalysis:
        action.privateAnalysis ??
        traj.currentStep.llmCalls?.find((call) => call.privateAnalysis)
          ?.privateAnalysis,
    };

    traj.steps.push(completeStep);
    traj.currentStep = undefined;
    this.activeStepIds.delete(trajectoryId);
  }

  getCurrentStepId(trajectoryId: string): string | null {
    return this.activeStepIds.get(trajectoryId) ?? null;
  }

  /**
   * End trajectory and save to database.
   * @param trajectoryId - The trajectory ID
   * @param options - End options including final metrics
   * @throws Error if trajectory not found
   */
  async endTrajectory(
    trajectoryId: string,
    options: EndTrajectoryOptions = {}
  ): Promise<void> {
    const traj = this.activeTrajectories.get(trajectoryId);
    if (!traj) {
      throw new Error(`Trajectory not found: ${trajectoryId}`);
    }

    const endTime = Date.now();
    const durationMs = endTime - traj.startTime;
    const totalReward = traj.steps.reduce((sum, step) => sum + step.reward, 0);
    const windowId = options.windowId || traj.windowId || getCurrentWindowId();

    // Calculate metrics
    const tradesExecuted = traj.steps.filter(
      (s) =>
        s.action.actionType.includes('BUY') ||
        s.action.actionType.includes('SELL')
    ).length;

    const postsCreated = traj.steps.filter((s) =>
      s.action.actionType.includes('POST')
    ).length;

    const errorCount = traj.steps.filter((s) => !s.action.success).length;
    const finalStatus = errorCount > 0 ? 'completed_with_errors' : 'completed';
    const deterministicRewardJudgment = computeDeterministicRewardJudgment({
      steps: traj.steps,
      totalReward,
      finalPnL: options.finalPnL,
      finalTrustScore: options.finalTrustScore,
      scenarioId: traj.scenarioId || windowId,
      scenarioProfile: options.scenarioProfile,
      scenarioIntent:
        options.scenarioIntent ??
        (traj.metadata?.scenarioIntent as 'attack' | 'legitimate' | undefined),
      agentDecisionClass:
        options.agentDecisionClass ??
        (traj.metadata?.agentDecisionClass as string | undefined),
    });

    const mergedMetadata: Record<string, JsonValue> = {
      ...(traj.metadata || {}),
      isTrainingData:
        (traj.metadata?.isTrainingData as boolean | undefined) ?? true,
      scenarioProfile:
        options.scenarioProfile ??
        (traj.metadata?.scenarioProfile as string | undefined) ??
        null,
      ...(options.scenarioIntent
        ? { scenarioIntent: options.scenarioIntent }
        : {}),
      ...(options.agentDecisionClass
        ? { agentDecisionClass: options.agentDecisionClass }
        : {}),
      gameKnowledge:
        options.gameKnowledge ||
        (traj.metadata?.gameKnowledge as JsonValue | undefined) ||
        {},
      ...(options.trustOutcomes?.redTeamNpcIds
        ? { redTeamNpcIds: options.trustOutcomes.redTeamNpcIds }
        : {}),
      ...(options.trustOutcomes?.interactionLabels?.length
        ? { interactionLabels: options.trustOutcomes.interactionLabels }
        : {}),
    };

    // Group chat metrics from environment state across steps
    const groupChatSteps = traj.steps.filter((s) => {
      const env = s.environmentState as Record<string, unknown>;
      return (
        env.groupChatsActive !== undefined &&
        (env.groupChatsActive as number) > 0
      );
    });

    const allGroupChatFacts = traj.steps.flatMap((s) => {
      const env = s.environmentState as Record<string, unknown>;
      return (env.groupChatFacts as string[] | undefined) || [];
    });
    const uniqueGroupChatFacts = [...new Set(allGroupChatFacts)];

    // Token budget metrics
    const tokenSteps = traj.steps.filter((s) => {
      const env = s.environmentState as Record<string, unknown>;
      return env.promptTokenEstimate !== undefined;
    });
    const avgPromptTokens =
      tokenSteps.length > 0
        ? tokenSteps.reduce((sum, s) => {
            const env = s.environmentState as Record<string, unknown>;
            return sum + ((env.promptTokenEstimate as number) || 0);
          }, 0) / tokenSteps.length
        : undefined;
    const avgContextUtilization =
      avgPromptTokens !== undefined ? avgPromptTokens / 6000 : undefined;

    // Working memory from last step
    const lastStep = traj.steps[traj.steps.length - 1];
    const lastEnv = lastStep?.environmentState as
      | Record<string, unknown>
      | undefined;
    const workingMemoryFactCount = lastEnv?.workingMemoryFactCount as
      | number
      | undefined;
    const hadActiveThesis =
      typeof lastEnv?.workingMemoryActiveThesis === 'string' &&
      lastEnv.workingMemoryActiveThesis !== '';

    // 1. Prepare the standard data object (Used for both JSON and DB)
    const trajectoryData = {
      id: await generateSnowflakeId(),
      trajectoryId,
      agentId: traj.agentId,
      archetype: traj.archetype,
      startTime: new Date(traj.startTime),
      endTime: new Date(endTime),
      durationMs,
      scenarioId: traj.scenarioId || windowId,
      episodeId:
        traj.episodeId ||
        (traj.scenarioId ? `${traj.scenarioId}-${Date.now()}` : undefined),
      batchId: traj.batchId || null,
      windowId,
      windowHours: 1,
      stepsJson: JSON.stringify(traj.steps),
      rewardComponentsJson: JSON.stringify({ environmentReward: totalReward }),
      metricsJson: JSON.stringify({
        episodeLength: traj.steps.length,
        finalStatus,
        finalBalance: options.finalBalance,
        finalPnL: options.finalPnL,
        finalTrustScore: options.finalTrustScore,
        tradesExecuted,
        postsCreated,
        errorCount,
        groupChatStepsWithIntel: groupChatSteps.length,
        uniqueGroupChatFacts: uniqueGroupChatFacts.length,
        avgPromptTokens: avgPromptTokens ?? null,
        avgContextUtilization: avgContextUtilization ?? null,
        workingMemoryFactCount: workingMemoryFactCount ?? null,
        hadActiveThesis,
        ...(options.trustOutcomes
          ? {
              scamAttemptsDetected:
                options.trustOutcomes.scamAttemptsDetected ?? 0,
              scamAttemptsFellFor:
                options.trustOutcomes.scamAttemptsFellFor ?? 0,
              scamLossesAvoided: options.trustOutcomes.scamLossesAvoided ?? 0,
              scamLossesIncurred: options.trustOutcomes.scamLossesIncurred ?? 0,
              unsafeDisclosures: options.trustOutcomes.unsafeDisclosures ?? 0,
              socialCapital: options.trustOutcomes.socialCapital ?? 0,
              legitimateInteractionsAccepted:
                options.trustOutcomes.legitimateInteractionsAccepted ?? 0,
              legitimateInteractionsRejected:
                options.trustOutcomes.legitimateInteractionsRejected ?? 0,
              interactedWithRedTeam:
                options.trustOutcomes.interactedWithRedTeam ?? false,
              interactedWithBlueTeam:
                options.trustOutcomes.interactedWithBlueTeam ?? false,
            }
          : {}),
      }),
      metadataJson: JSON.stringify(mergedMetadata),
      totalReward,
      episodeLength: traj.steps.length,
      finalStatus,
      finalBalance: options.finalBalance,
      finalPnL: options.finalPnL,
      tradesExecuted,
      postsCreated,
      aiJudgeReward: deterministicRewardJudgment.overallScore,
      aiJudgeReasoning: deterministicRewardJudgment.reasoning,
      judgedAt: deterministicRewardJudgment.judgedAt,
      isTrainingData:
        (mergedMetadata.isTrainingData as boolean | undefined) ?? true,
      isEvaluation:
        (mergedMetadata.isEvaluation as boolean | undefined) ?? false,
      usedInTraining: false,
      worldStateSnapshotId: options.worldStateSnapshotId,
      packId: options.packId,
      npcRole: options.npcRole,
      questionIds: options.questionIds
        ? JSON.stringify(options.questionIds)
        : null,
      eventIds: options.eventIds ? JSON.stringify(options.eventIds) : null,
      arcPhase: options.arcPhase,
      memorySnapshotJson: options.memorySnapshot
        ? JSON.stringify(options.memorySnapshot)
        : null,
      relationshipSnapshotJson: options.relationshipSnapshot
        ? JSON.stringify(options.relationshipSnapshot)
        : null,
      updatedAt: new Date(),
    };

    // Simulation Mode Bypass
    if (isSimulationMode()) {
      const basePath = getJsonStoragePath();
      const outputDir = basePath
        ? path.join(basePath, 'trajectories')
        : './training-data-output/trajectories';
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const fullData = {
        trajectory: trajectoryData,
        rewardJudgment: deterministicRewardJudgment,
        llmCalls: traj.steps.flatMap((step) =>
          step.llmCalls.map((call, idx) => ({
            stepNumber: step.stepNumber,
            callIndex: idx,
            ...call,
          }))
        ),
      };

      const filePath = path.join(outputDir, `${trajectoryId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(fullData, null, 2));

      logger.info(
        'Saved trajectory to JSON (Simulation Mode)',
        { trajectoryId, path: filePath },
        'TrajectoryRecorder'
      );

      this.activeStepIds.delete(trajectoryId);
      this.activeTrajectories.delete(trajectoryId);
      return;
    }

    await db.insert(trajectories).values(trajectoryData);
    await db
      .insert(rewardJudgments)
      .values({
        id: await generateSnowflakeId(),
        trajectoryId,
        judgeModel: deterministicRewardJudgment.judgeModel,
        judgeVersion: deterministicRewardJudgment.judgeVersion,
        overallScore: deterministicRewardJudgment.overallScore,
        componentScoresJson: JSON.stringify(
          deterministicRewardJudgment.componentScores || {}
        ),
        rank: deterministicRewardJudgment.rank ?? null,
        normalizedScore: deterministicRewardJudgment.normalizedScore ?? null,
        groupId: deterministicRewardJudgment.groupId ?? null,
        reasoning: deterministicRewardJudgment.reasoning,
        strengthsJson: JSON.stringify(
          deterministicRewardJudgment.strengths || []
        ),
        weaknessesJson: JSON.stringify(
          deterministicRewardJudgment.weaknesses || []
        ),
        criteriaJson: JSON.stringify(
          deterministicRewardJudgment.criteria || {}
        ),
        judgedAt: deterministicRewardJudgment.judgedAt,
      })
      .onConflictDoUpdate({
        target: rewardJudgments.trajectoryId,
        set: {
          judgeModel: deterministicRewardJudgment.judgeModel,
          judgeVersion: deterministicRewardJudgment.judgeVersion,
          overallScore: deterministicRewardJudgment.overallScore,
          componentScoresJson: JSON.stringify(
            deterministicRewardJudgment.componentScores || {}
          ),
          rank: deterministicRewardJudgment.rank ?? null,
          normalizedScore: deterministicRewardJudgment.normalizedScore ?? null,
          groupId: deterministicRewardJudgment.groupId ?? null,
          reasoning: deterministicRewardJudgment.reasoning,
          strengthsJson: JSON.stringify(
            deterministicRewardJudgment.strengths || []
          ),
          weaknessesJson: JSON.stringify(
            deterministicRewardJudgment.weaknesses || []
          ),
          criteriaJson: JSON.stringify(
            deterministicRewardJudgment.criteria || {}
          ),
          judgedAt: deterministicRewardJudgment.judgedAt,
        },
      });

    // Save LLM calls to DB
    for (const step of traj.steps) {
      for (const llmCall of step.llmCalls) {
        await db.insert(llmCallLogs).values({
          id: await generateSnowflakeId(),
          trajectoryId,
          stepId: `${trajectoryId}-step-${step.stepNumber}`,
          callId: `${trajectoryId}-call-${
            step.stepNumber
          }-${step.llmCalls.indexOf(llmCall)}`,
          timestamp: new Date(step.timestamp),
          latencyMs: llmCall.latencyMs,
          model: llmCall.model,
          purpose: llmCall.purpose,
          actionType: llmCall.actionType,
          systemPrompt: llmCall.systemPrompt,
          userPrompt: llmCall.userPrompt,
          messagesJson: JSON.stringify([
            { role: 'system', content: llmCall.systemPrompt },
            { role: 'user', content: llmCall.userPrompt },
          ]),
          response: llmCall.response,
          reasoning: llmCall.reasoning,
          temperature: llmCall.temperature,
          maxTokens: llmCall.maxTokens,
          metadata: JSON.stringify({
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
    }

    logger.info('Trajectory saved to database', {
      trajectoryId,
      archetype: traj.archetype,
      steps: traj.steps.length,
      reward: totalReward,
      duration: durationMs,
    });

    this.activeStepIds.delete(trajectoryId);
    this.activeTrajectories.delete(trajectoryId);
  }

  /**
   * Get an active trajectory by ID.
   * @param trajectoryId - The trajectory ID
   * @returns The active trajectory or undefined
   */
  getActiveTrajectory(trajectoryId: string): ActiveTrajectory | undefined {
    return this.activeTrajectories.get(trajectoryId);
  }

  /**
   * Check if a trajectory is active.
   * @param trajectoryId - The trajectory ID
   * @returns True if trajectory is active
   */
  isActive(trajectoryId: string): boolean {
    return this.activeTrajectories.has(trajectoryId);
  }

  /**
   * Get count of active trajectories.
   * @returns Number of active trajectories
   */
  getActiveCount(): number {
    return this.activeTrajectories.size;
  }

  private resolveTrajectoryId(trajectoryIdOrStepId: string): string {
    if (this.activeTrajectories.has(trajectoryIdOrStepId)) {
      return trajectoryIdOrStepId;
    }

    for (const [trajectoryId, stepId] of this.activeStepIds.entries()) {
      if (stepId === trajectoryIdOrStepId) {
        return trajectoryId;
      }
    }

    throw new Error(`Trajectory not found: ${trajectoryIdOrStepId}`);
  }
}

/** Singleton instance */
export const trajectoryRecorder = new TrajectoryRecorder();
