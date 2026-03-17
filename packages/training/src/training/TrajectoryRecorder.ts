/**
 * TrajectoryRecorder
 *
 * Records agent decisions with full context for GRPO training.
 * Captures environment state, LLM calls, actions, and rewards.
 *
 * @packageDocumentation
 */

import type { JsonValue, TrajectoryRecord } from "../adapter";
import { getLlmLogAdapter, getTrainingDataAdapter } from "../adapter";
import { logger } from "../utils/logger";
import { generateSnowflakeId } from "../utils/snowflake";
import type {
  Action,
  EnvironmentState,
  LLMCall,
  ProviderAccess,
  TrajectoryStep,
} from "./types";
import { getCurrentWindowId } from "./window-utils";

export type {
  Action,
  EnvironmentState,
  LLMCall,
  ProviderAccess,
  TrajectoryStep,
};

import * as fs from "node:fs";
import * as path from "node:path";

// ─── Simulation mode flag ────────────────────────────────────────────
// Replaces the `isSimulationMode` import from `@elizaos/db`.
// Set via `setSimulationMode(true)` before recording trajectories in
// simulation/benchmark contexts.
let _simulationMode = false;

/** Enable or disable simulation mode for trajectory recording. */
export function setSimulationMode(enabled: boolean): void {
  _simulationMode = enabled;
}

/** Check whether simulation mode is active. */
export function isSimulationMode(): boolean {
  return _simulationMode;
}

/**
 * Active trajectory being recorded.
 */
interface ActiveTrajectory {
  trajectoryId: string;
  agentId: string;
  archetype?: string;
  scenarioId?: string;
  startTime: number;
  steps: TrajectoryStep[];
  currentStep?: Partial<TrajectoryStep>;
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
  /** Optional time window ID */
  windowId?: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for ending a trajectory.
 */
export interface EndTrajectoryOptions {
  /** Final account balance */
  finalBalance?: number;
  /** Final profit/loss */
  finalPnL?: number;
  /** Time window ID */
  windowId?: string;
  /** Ground truth market data */
  gameKnowledge?: {
    trueProbabilities?: Record<string, number>;
    actualOutcomes?: Record<string, JsonValue>;
    futureOutcomes?: Record<string, JsonValue>;
  };
}

/**
 * Records agent trajectories for RL training.
 */
export class TrajectoryRecorder {
  private activeTrajectories: Map<string, ActiveTrajectory> = new Map();

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
      startTime: Date.now(),
      steps: [],
    });

    logger.info("Started trajectory recording", {
      trajectoryId,
      agentId: options.agentId,
      archetype: options.archetype,
      scenarioId: options.scenarioId,
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
  startStep(trajectoryId: string, environmentState: EnvironmentState): void {
    const traj = this.activeTrajectories.get(trajectoryId);
    if (!traj) {
      throw new Error(`Trajectory not found: ${trajectoryId}`);
    }

    traj.currentStep = {
      stepNumber: traj.steps.length,
      timestamp: Date.now(),
      environmentState,
      providerAccesses: [],
      llmCalls: [],
      reward: 0,
    };
  }

  /**
   * Log a provider access in the current step.
   * @param trajectoryId - The trajectory ID
   * @param access - Provider access details
   * @throws Error if no current step exists
   */
  logProviderAccess(
    trajectoryId: string,
    access: {
      providerName: string;
      data: Record<string, JsonValue>;
      purpose: string;
    },
  ): void {
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
  logLLMCall(trajectoryId: string, llmCall: LLMCall): void {
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
  completeStep(trajectoryId: string, action: Action, reward: number = 0): void {
    const traj = this.activeTrajectories.get(trajectoryId);
    if (!traj?.currentStep) {
      throw new Error(`No current step for trajectory: ${trajectoryId}`);
    }

    const stepNumber = traj.currentStep.stepNumber;
    const timestamp = traj.currentStep.timestamp;
    const environmentState = traj.currentStep.environmentState;
    if (
      stepNumber === undefined ||
      timestamp === undefined ||
      environmentState === undefined
    ) {
      throw new Error(
        `Current step incomplete for trajectory: ${trajectoryId}`,
      );
    }
    const completeStep: TrajectoryStep = {
      stepNumber,
      timestamp,
      environmentState,
      providerAccesses: traj.currentStep.providerAccesses || [],
      llmCalls: traj.currentStep.llmCalls || [],
      action,
      reward,
    };

    traj.steps.push(completeStep);
    traj.currentStep = undefined;
  }

  /**
   * End trajectory and save to database.
   * @param trajectoryId - The trajectory ID
   * @param options - End options including final metrics
   * @throws Error if trajectory not found
   */
  async endTrajectory(
    trajectoryId: string,
    options: EndTrajectoryOptions = {},
  ): Promise<void> {
    const traj = this.activeTrajectories.get(trajectoryId);
    if (!traj) {
      throw new Error(`Trajectory not found: ${trajectoryId}`);
    }

    const endTime = Date.now();
    const durationMs = endTime - traj.startTime;
    const totalReward = traj.steps.reduce((sum, step) => sum + step.reward, 0);
    const windowId = options.windowId || getCurrentWindowId();

    // Calculate metrics
    const tradesExecuted = traj.steps.filter(
      (s) =>
        s.action.actionType.includes("BUY") ||
        s.action.actionType.includes("SELL"),
    ).length;

    const postsCreated = traj.steps.filter((s) =>
      s.action.actionType.includes("POST"),
    ).length;

    const errorCount = traj.steps.filter((s) => !s.action.success).length;
    const finalStatus = errorCount > 0 ? "completed_with_errors" : "completed";

    // 1. Prepare the standard data object (Used for both JSON and DB)
    const trajectoryData: Omit<TrajectoryRecord, "createdAt" | "updatedAt"> = {
      id: await generateSnowflakeId(),
      trajectoryId,
      agentId: traj.agentId,
      archetype: traj.archetype ?? null,
      startTime: new Date(traj.startTime),
      endTime: new Date(endTime),
      durationMs,
      scenarioId: traj.scenarioId || windowId,
      episodeId: traj.scenarioId ? `${traj.scenarioId}-${Date.now()}` : null,
      windowId,
      windowHours: 1,
      batchId: null,
      stepsJson: JSON.stringify(traj.steps),
      rewardComponentsJson: JSON.stringify({ environmentReward: totalReward }),
      metricsJson: JSON.stringify({
        episodeLength: traj.steps.length,
        finalStatus,
        finalBalance: options.finalBalance,
        finalPnL: options.finalPnL,
        tradesExecuted,
        postsCreated,
        errorCount,
      }),
      metadataJson: JSON.stringify({
        isTrainingData: true,
        gameKnowledge: options.gameKnowledge || {},
      }),
      totalReward,
      episodeLength: traj.steps.length,
      finalStatus,
      finalBalance: options.finalBalance ?? null,
      finalPnL: options.finalPnL ?? null,
      tradesExecuted: tradesExecuted ?? null,
      postsCreated: postsCreated ?? null,
      aiJudgeReward: null,
      aiJudgeReasoning: null,
      judgedAt: null,
      isTrainingData: true,
      isEvaluation: false,
      usedInTraining: false,
      trainedInBatch: null,
    };

    // Simulation Mode Bypass
    if (isSimulationMode()) {
      const outputDir = "./training-data-output/trajectories";
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const fullData = {
        trajectory: trajectoryData,
        llmCalls: traj.steps.flatMap((step) =>
          step.llmCalls.map((call, idx) => ({
            stepNumber: step.stepNumber,
            callIndex: idx,
            ...call,
          })),
        ),
      };

      const filePath = path.join(outputDir, `${trajectoryId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(fullData, null, 2));

      logger.info(
        "Saved trajectory to JSON (Simulation Mode)",
        { trajectoryId, path: filePath },
        "TrajectoryRecorder",
      );

      this.activeTrajectories.delete(trajectoryId);
      return;
    }

    const adapter = getTrainingDataAdapter();
    await adapter.insertTrajectory(trajectoryData);

    // Save LLM calls via adapter (if LLM log adapter is registered)
    const llmLogAdapter = getLlmLogAdapter();
    if (llmLogAdapter) {
      for (const step of traj.steps) {
        for (const llmCall of step.llmCalls) {
          await llmLogAdapter.insertLLMCallLog({
            id: await generateSnowflakeId(),
            trajectoryId,
            stepId: `${trajectoryId}-step-${step.stepNumber}`,
            callId: `${trajectoryId}-call-${
              step.stepNumber
            }-${step.llmCalls.indexOf(llmCall)}`,
            timestamp: new Date(step.timestamp),
            latencyMs: llmCall.latencyMs ?? null,
            model: llmCall.model,
            purpose: llmCall.purpose,
            actionType: llmCall.actionType ?? null,
            systemPrompt: llmCall.systemPrompt,
            userPrompt: llmCall.userPrompt,
            response: llmCall.response,
          });
        }
      }
    }

    logger.info("Trajectory saved to database", {
      trajectoryId,
      archetype: traj.archetype,
      steps: traj.steps.length,
      reward: totalReward,
      duration: durationMs,
    });

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
}

/** Singleton instance */
export const trajectoryRecorder = new TrajectoryRecorder();
