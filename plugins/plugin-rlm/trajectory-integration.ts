/**
 * Integration with trajectory logging for RLM trace capture.
 *
 * Paper Section 4.1: "We select several examples of snippets from RLM trajectories
 * to understand how they solve long context problems"
 *
 * This module provides:
 * - RLMTrajectoryIntegration class that wraps an RLMClient
 * - Step-level logging with cost tracking
 * - Trajectory export with aggregate cost summaries
 * - Optional integration with an external trajectory logger service
 *
 * Matches Python `trajectory_integration.py`.
 */

import { randomUUID } from "node:crypto";

import type { RLMClient } from "./client";
import type { CostEstimate } from "./cost";
import { estimateCost, estimateTokenCount } from "./cost";
import type { RLMInferOptions, RLMResult } from "./types";

// ============================================================================
// Trajectory Logger Interface (compatible with plugin-trajectory-logger)
// ============================================================================

/** Interface for an external trajectory logger service. */
export interface TrajectoryLogger {
  startTrajectory(options: {
    agentId: string;
    scenarioId?: string;
    episodeId?: string;
    metadata?: Record<string, unknown>;
  }): string;

  endTrajectory(
    trajectoryId: string,
    status: "completed" | "error",
    finalMetrics?: Record<string, unknown>,
  ): void | Promise<void>;

  startStep(trajectoryId: string, envState?: EnvironmentState): string;

  completeStep(trajectoryId: string, stepId: string, action?: ActionAttempt, reward?: number): void;

  logLlmCall(stepId: string, call: LLMCall): void;

  logProviderAccess(stepId: string, access: ProviderAccess): void;

  getCurrentStepId(trajectoryId: string): string | undefined;
}

/** LLM call record for trajectory logging. */
export interface LLMCall {
  callId: string;
  timestamp: number;
  model: string;
  modelVersion: string;
  systemPrompt: string;
  userPrompt: string;
  response: string;
  reasoning?: string;
  temperature: number;
  maxTokens: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  purpose: string;
  actionType: string;
}

/** Provider access record for trajectory logging. */
export interface ProviderAccess {
  providerId: string;
  providerName: string;
  timestamp: number;
  query: Record<string, unknown>;
  data: Record<string, unknown>;
  purpose: string;
}

/** Environment state for trajectory steps. */
export interface EnvironmentState {
  timestamp: number;
  agentBalance: number;
  agentPoints: number;
  agentPnl: number;
  openPositions: number;
  custom: Record<string, unknown>;
}

/** Action attempt record for trajectory steps. */
export interface ActionAttempt {
  attemptId: string;
  timestamp: number;
  actionType: string;
  actionName: string;
  parameters: Record<string, unknown>;
  reasoning: string;
  llmCallId: string;
  success: boolean;
  result: Record<string, unknown>;
}

// ============================================================================
// Step & Trajectory Data Types
// ============================================================================

/** A tracked inference step within a trajectory. */
export interface InferenceStep {
  stepId: string;
  trajectoryId: string;
  startTime: number;
  endTime?: number;
  model?: string;
  modelVersion?: string;
  options?: Record<string, unknown>;
  costs: CostEstimate[];
  completed: boolean;
  result?: RLMResult;
}

/** Aggregate cost summary for a trajectory. */
export interface CostSummary {
  trajectoryId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  stepCount: number;
  costs: CostEstimate[];
}

/** Full trajectory export with cost data attached. */
export interface TrajectoryWithCosts {
  trajectoryId: string;
  agentId: string;
  scenarioId?: string;
  startTime: number;
  endTime: number;
  steps: InferenceStep[];
  costSummary: CostSummary;
  status: "completed" | "error" | "in_progress";
}

// ============================================================================
// RLMTrajectoryIntegration
// ============================================================================

/** Options for constructing RLMTrajectoryIntegration. */
export interface RLMTrajectoryIntegrationOptions {
  /** The RLM client to wrap. */
  client: RLMClient;
  /** Optional external trajectory logger (e.g. from plugin-trajectory-logger). */
  logger?: TrajectoryLogger;
  /** Agent ID for trajectory logging (default: "rlm-agent"). */
  agentId?: string;
  /** Optional scenario ID for grouping trajectories. */
  scenarioId?: string;
}

/**
 * Integration layer between RLM and trajectory logging.
 *
 * Wraps an RLMClient and automatically logs RLM trajectories
 * for observability and training data collection.
 *
 * Matches Python `RLMTrajectoryIntegration`.
 *
 * @example
 * ```ts
 * const integration = new RLMTrajectoryIntegration({ client });
 * const result = await integration.infer("Analyze this long document...");
 * const costs = integration.getCostSummary(trajectoryId);
 * ```
 */
export class RLMTrajectoryIntegration {
  private client: RLMClient;
  private logger: TrajectoryLogger | null;
  private agentId: string;
  private scenarioId?: string;

  // Internal tracking
  private steps: Map<string, InferenceStep> = new Map();
  private trajectories: Map<string, InferenceStep[]> = new Map();
  private trajectoryMeta: Map<string, { startTime: number; status: string }> = new Map();

  // Callback
  private onCompleteCallback?: (trajectory: TrajectoryWithCosts) => void;

  constructor(options: RLMTrajectoryIntegrationOptions) {
    this.client = options.client;
    this.logger = options.logger ?? null;
    this.agentId = options.agentId ?? "rlm-agent";
    this.scenarioId = options.scenarioId;
  }

  /** Get the underlying RLM client. */
  getClient(): RLMClient {
    return this.client;
  }

  /** Check if the RLM backend is available. */
  get isAvailable(): boolean {
    return this.client.available;
  }

  /**
   * Register a callback invoked when a trajectory completes.
   */
  onTrajectoryComplete(callback: (trajectory: TrajectoryWithCosts) => void): void {
    this.onCompleteCallback = callback;
  }

  // --------------------------------------------------------------------------
  // Step-level API
  // --------------------------------------------------------------------------

  /**
   * Start a new inference step within a trajectory.
   *
   * @param trajectoryId - The trajectory this step belongs to
   * @param options - Optional metadata for the step
   * @returns The generated step ID
   */
  startInferenceStep(
    trajectoryId: string,
    options?: {
      model?: string;
      modelVersion?: string;
      metadata?: Record<string, unknown>;
    },
  ): string {
    const stepId = randomUUID();
    const step: InferenceStep = {
      stepId,
      trajectoryId,
      startTime: Date.now(),
      model: options?.model,
      modelVersion: options?.modelVersion,
      options: options?.metadata,
      costs: [],
      completed: false,
    };

    this.steps.set(stepId, step);

    // Track step in trajectory
    if (!this.trajectories.has(trajectoryId)) {
      this.trajectories.set(trajectoryId, []);
      this.trajectoryMeta.set(trajectoryId, {
        startTime: Date.now(),
        status: "in_progress",
      });
    }
    this.trajectories.get(trajectoryId)?.push(step);

    // Log to external logger if available
    if (this.logger) {
      const envState: EnvironmentState = {
        timestamp: Date.now(),
        agentBalance: 0,
        agentPoints: 0,
        agentPnl: 0,
        openPositions: 0,
        custom: {
          rlm_model: options?.model,
          ...options?.metadata,
        },
      };
      this.logger.startStep(trajectoryId, envState);
    }

    return stepId;
  }

  /**
   * Complete an inference step with the RLM result.
   *
   * @param stepId - The step to complete
   * @param result - The RLM inference result
   */
  completeInferenceStep(stepId: string, result: RLMResult): void {
    const step = this.steps.get(stepId);
    if (!step) {
      throw new Error(`Unknown step: ${stepId}`);
    }

    step.completed = true;
    step.endTime = Date.now();
    step.result = result;

    // Auto-estimate cost from result
    if (!result.metadata.stub) {
      const outputTokens = estimateTokenCount(result.text);
      const costEstimate = estimateCost(step.model ?? "default", 0, outputTokens);
      step.costs.push(costEstimate);
    }

    // Log to external logger
    if (this.logger) {
      const action: ActionAttempt = {
        attemptId: stepId,
        timestamp: Date.now(),
        actionType: "rlm_step",
        actionName: "inference",
        parameters: { model: step.model },
        reasoning: "RLM inference step",
        llmCallId: stepId,
        success: !result.metadata.error,
        result: { text: result.text.substring(0, 500) },
      };
      this.logger.completeStep(step.trajectoryId, stepId, action, 0);
    }
  }

  /**
   * Log cost information for a step.
   *
   * @param stepId - The step to attach cost info to
   * @param costInfo - Cost estimation data
   */
  logCost(stepId: string, costInfo: CostEstimate): void {
    const step = this.steps.get(stepId);
    if (!step) {
      throw new Error(`Unknown step: ${stepId}`);
    }
    step.costs.push(costInfo);

    // Log as LLM call to external logger
    if (this.logger) {
      const llmCall: LLMCall = {
        callId: `${stepId}-cost`,
        timestamp: Date.now(),
        model: costInfo.model,
        modelVersion: "1.0",
        systemPrompt: "RLM recursive inference",
        userPrompt: "",
        response: "",
        temperature: 0,
        maxTokens: 0,
        promptTokens: costInfo.inputTokens,
        completionTokens: costInfo.outputTokens,
        latencyMs: 0,
        purpose: "reasoning",
        actionType: "rlm_cost",
      };
      this.logger.logLlmCall(stepId, llmCall);
    }
  }

  // --------------------------------------------------------------------------
  // Summary & Export
  // --------------------------------------------------------------------------

  /**
   * Get aggregate cost summary for a trajectory.
   *
   * @param trajectoryId - The trajectory to summarize
   * @returns CostSummary with aggregated token counts and costs
   */
  getCostSummary(trajectoryId: string): CostSummary {
    const steps = this.trajectories.get(trajectoryId) ?? [];
    const allCosts = steps.flatMap((s) => s.costs);

    return {
      trajectoryId,
      totalInputTokens: allCosts.reduce((sum, c) => sum + c.inputTokens, 0),
      totalOutputTokens: allCosts.reduce((sum, c) => sum + c.outputTokens, 0),
      totalCostUsd: allCosts.reduce((sum, c) => sum + c.totalCostUsd, 0),
      stepCount: steps.length,
      costs: allCosts,
    };
  }

  /**
   * Export full trajectory data with all cost information.
   *
   * @param trajectoryId - The trajectory to export
   * @returns TrajectoryWithCosts containing steps, costs, and status
   */
  exportTrajectoryWithCosts(trajectoryId: string): TrajectoryWithCosts {
    const steps = this.trajectories.get(trajectoryId) ?? [];
    const meta = this.trajectoryMeta.get(trajectoryId);
    const costSummary = this.getCostSummary(trajectoryId);

    const allCompleted = steps.length > 0 && steps.every((s) => s.completed);
    const hasErrors = steps.some((s) => s.result?.metadata.error);

    let status: "completed" | "error" | "in_progress";
    if (hasErrors) {
      status = "error";
    } else if (allCompleted) {
      status = "completed";
    } else {
      status = "in_progress";
    }

    return {
      trajectoryId,
      agentId: this.agentId,
      scenarioId: this.scenarioId,
      startTime: meta?.startTime ?? 0,
      endTime: Date.now(),
      steps,
      costSummary,
      status,
    };
  }

  // --------------------------------------------------------------------------
  // High-level inference with auto-logging
  // --------------------------------------------------------------------------

  /**
   * Perform RLM inference with automatic trajectory logging.
   *
   * Handles the full lifecycle:
   * 1. Start trajectory in external logger (if configured)
   * 2. Start inference step
   * 3. Run inference via RLMClient
   * 4. Estimate and log costs
   * 5. Complete step and end trajectory
   *
   * Matches Python `RLMTrajectoryIntegration.infer()`.
   *
   * @param messages - Input prompt
   * @param options - Inference and logging options
   * @returns RLMResult from the inference
   */
  async infer(
    messages: string,
    options?: {
      episodeId?: string;
      metadata?: Record<string, unknown>;
      inferOptions?: RLMInferOptions;
    },
  ): Promise<RLMResult> {
    // Start trajectory in external logger
    let externalTrajectoryId: string | undefined;
    if (this.logger) {
      externalTrajectoryId = this.logger.startTrajectory({
        agentId: this.agentId,
        scenarioId: this.scenarioId,
        episodeId: options?.episodeId,
        metadata: options?.metadata ?? {},
      });
    }
    const trajectoryId = externalTrajectoryId ?? randomUUID();

    // Initialize trajectory tracking
    if (!this.trajectories.has(trajectoryId)) {
      this.trajectories.set(trajectoryId, []);
      this.trajectoryMeta.set(trajectoryId, {
        startTime: Date.now(),
        status: "in_progress",
      });
    }

    // Start inference step
    const stepId = this.startInferenceStep(trajectoryId, {
      model: options?.inferOptions?.rootModel,
      metadata: options?.metadata,
    });

    try {
      // Run inference
      const result = await this.client.infer(messages, options?.inferOptions);

      // Log cost from token estimation
      const inputTokens = estimateTokenCount(messages);
      const outputTokens = estimateTokenCount(result.text);
      const costEstimate = estimateCost(
        options?.inferOptions?.rootModel ?? "default",
        inputTokens,
        outputTokens,
      );
      this.logCost(stepId, costEstimate);

      // Complete step
      this.completeInferenceStep(stepId, result);

      // End external trajectory
      if (this.logger && externalTrajectoryId) {
        await this.logger.endTrajectory(
          externalTrajectoryId,
          result.metadata.error ? "error" : "completed",
          {
            rlm_cost_usd: costEstimate.totalCostUsd,
            rlm_input_tokens: inputTokens,
            rlm_output_tokens: outputTokens,
          },
        );
      }

      // Update trajectory status
      const meta = this.trajectoryMeta.get(trajectoryId);
      if (meta) {
        meta.status = result.metadata.error ? "error" : "completed";
      }

      // Fire callback
      if (this.onCompleteCallback) {
        this.onCompleteCallback(this.exportTrajectoryWithCosts(trajectoryId));
      }

      return result;
    } catch (e) {
      // End trajectory with error
      if (this.logger && externalTrajectoryId) {
        await this.logger.endTrajectory(externalTrajectoryId, "error", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      const meta = this.trajectoryMeta.get(trajectoryId);
      if (meta) {
        meta.status = "error";
      }
      throw e;
    }
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------

  /** Get all tracked trajectory IDs. */
  getTrajectoryIds(): string[] {
    return Array.from(this.trajectories.keys());
  }

  /** Get a specific step by ID. */
  getStep(stepId: string): InferenceStep | undefined {
    return this.steps.get(stepId);
  }

  /** Clear all tracked data. */
  clear(): void {
    this.steps.clear();
    this.trajectories.clear();
    this.trajectoryMeta.clear();
  }
}

// ============================================================================
// Convenience function
// ============================================================================

/**
 * Convenience function for one-off RLM inference with trajectory logging.
 *
 * Matches Python `infer_with_logging()`.
 *
 * @param client - RLM client instance
 * @param prompt - The prompt to process
 * @param options - Optional logger and agent configuration
 * @returns RLMResult with trajectory attached
 */
export async function inferWithLogging(
  client: RLMClient,
  prompt: string,
  options?: {
    logger?: TrajectoryLogger;
    agentId?: string;
    inferOptions?: RLMInferOptions;
  },
): Promise<RLMResult> {
  const integration = new RLMTrajectoryIntegration({
    client,
    logger: options?.logger,
    agentId: options?.agentId,
  });
  return integration.infer(prompt, { inferOptions: options?.inferOptions });
}
