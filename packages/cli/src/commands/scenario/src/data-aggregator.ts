/**
 * Run Data Aggregator - Centralized Data Collection for Ticket #5786
 *
 * This utility class is responsible for collecting data from various sources
 * throughout a scenario run's lifecycle and assembling it into a single,
 * validated ScenarioRunResult object for serialization.
 */

import { type IAgentRuntime, type UUID } from '@elizaos/core';
import { TrajectoryReconstructor, type TrajectoryStep } from './TrajectoryReconstructor';
import { EvaluationEngine } from './EvaluationEngine';
import {
  type ScenarioRunResult,
  type ScenarioRunMetrics,
  type EnhancedEvaluationResult,
  ScenarioRunResultSchema,
} from './schema';
import { type ExecutionResult } from './providers';

/**
 * Utility class for aggregating all data from a single scenario run
 * and building the final ScenarioRunResult object.
 */
export class RunDataAggregator {
  // Dependencies
  public readonly runtime: IAgentRuntime;
  public readonly trajectoryReconstructor: TrajectoryReconstructor;
  public readonly evaluationEngine: EvaluationEngine;

  // Run identification
  public runId?: string;
  public combinationId?: string;
  public parameters?: Record<string, any>;
  public startTime?: Date;

  // Collected data
  public finalResponse?: string;
  public metrics: Partial<ScenarioRunMetrics> = {};
  public error?: string;

  constructor(
    runtime: IAgentRuntime,
    trajectoryReconstructor: TrajectoryReconstructor,
    evaluationEngine: EvaluationEngine
  ) {
    this.runtime = runtime;
    this.trajectoryReconstructor = trajectoryReconstructor;
    this.evaluationEngine = evaluationEngine;
  }

  /**
   * Initialize a new run with the specified identifiers and parameters.
   * This should be called at the start of each scenario execution.
   */
  public startRun(runId: string, combinationId: string, parameters: Record<string, any>): void {
    this.runId = runId;
    this.combinationId = combinationId;
    this.parameters = parameters;
    this.startTime = new Date();

    // Reset previous data
    this.finalResponse = undefined;
    this.metrics = {};
    this.error = undefined;

    this.runtime.logger.debug(
      `[RunDataAggregator] Started run ${runId} with combination ${combinationId}`
    );
  }

  /**
   * Record the final response from the agent.
   * This should be called after the agent has completed its interaction.
   */
  public recordFinalResponse(response: string): void {
    this.finalResponse = response;
    this.runtime.logger.debug(
      `[RunDataAggregator] Recorded final response (${response.length} chars)`
    );
  }

  /**
   * Record performance metrics for the run.
   * This can be called multiple times to accumulate different metrics.
   */
  public recordMetrics(newMetrics: Partial<ScenarioRunMetrics>): void {
    this.metrics = { ...this.metrics, ...newMetrics };
    this.runtime.logger.debug(`[RunDataAggregator] Recorded metrics:`, newMetrics);
  }

  /**
   * Record an error that occurred during the run.
   * This marks the run as failed.
   */
  public recordError(error: Error | string): void {
    this.error = error instanceof Error ? error.message : error;
    this.runtime.logger.error(`[RunDataAggregator] Recorded error: ${this.error}`);
  }

  /**
   * Build the final ScenarioRunResult object by collecting data from all sources.
   * This should be called at the end of the run, whether successful or failed.
   */
  public async buildResult(
    roomId: string,
    evaluations: EnhancedEvaluationResult[],
    _executionResult: ExecutionResult
  ): Promise<ScenarioRunResult> {
    if (!this.runId || !this.combinationId || !this.parameters || !this.startTime) {
      throw new Error('Run not started. Call startRun() first.');
    }

    this.runtime.logger.debug(`[RunDataAggregator] Building result for run ${this.runId}`);

    // Collect trajectory data (only if no error occurred)
    let trajectory: TrajectoryStep[] = [];
    if (!this.error) {
      try {
        trajectory = await this.trajectoryReconstructor.getLatestTrajectory(roomId as UUID);
        this.runtime.logger.debug(
          `[RunDataAggregator] Collected ${trajectory.length} trajectory steps`
        );
      } catch (trajectoryError) {
        this.runtime.logger.warn(
          `[RunDataAggregator] Failed to collect trajectory: ${trajectoryError}`
        );
        // Don't fail the entire result building process due to trajectory issues
      }
    }

    // Collect evaluation results (only if no error occurred)
    let evaluationResults: EnhancedEvaluationResult[] = [];
    if (!this.error && evaluations.length > 0) {
      // Evaluations are already in the enhanced format, just use them directly
      evaluationResults = evaluations;
      this.runtime.logger.debug(
        `[RunDataAggregator] Collected ${evaluationResults.length} evaluation results`
      );
    }

    // Ensure required metrics are present
    const completeMetrics: ScenarioRunMetrics = {
      execution_time_seconds: this.metrics.execution_time_seconds || 0,
      llm_calls: this.metrics.llm_calls || 0,
      total_tokens: this.metrics.total_tokens || 0,
      ...this.metrics,
    };

    // Build the result object
    const result: ScenarioRunResult = {
      run_id: this.runId,
      matrix_combination_id: this.combinationId,
      parameters: this.parameters,
      metrics: completeMetrics,
      final_agent_response: this.finalResponse,
      evaluations: evaluationResults,
      trajectory: trajectory,
      error: this.error || null,
    };

    // Validate the result against the schema
    try {
      ScenarioRunResultSchema.parse(result);
      this.runtime.logger.debug(`[RunDataAggregator] Result validation successful`);
    } catch (validationError) {
      this.runtime.logger.error(`[RunDataAggregator] Result validation failed:`, validationError);
      // Still return the result, but log the validation issue
    }

    return result;
  }

  /**
   * Reset all collected data. Useful for reusing the aggregator across multiple runs.
   */
  public reset(): void {
    this.runId = undefined;
    this.combinationId = undefined;
    this.parameters = undefined;
    this.startTime = undefined;
    this.finalResponse = undefined;
    this.metrics = {};
    this.error = undefined;

    this.runtime.logger.debug(`[RunDataAggregator] Reset aggregator state`);
  }

  /**
   * Get a summary of the current aggregator state for debugging.
   */
  public getState(): {
    runId?: string;
    combinationId?: string;
    hasParameters: boolean;
    hasStartTime: boolean;
    hasFinalResponse: boolean;
    metricsCount: number;
    hasError: boolean;
  } {
    return {
      runId: this.runId,
      combinationId: this.combinationId,
      hasParameters: !!this.parameters,
      hasStartTime: !!this.startTime,
      hasFinalResponse: !!this.finalResponse,
      metricsCount: Object.keys(this.metrics).length,
      hasError: !!this.error,
    };
  }
}

// Re-export types for convenience
export type { ScenarioRunResult, ScenarioRunMetrics, TrajectoryStep };
