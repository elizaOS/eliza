/**
 * Analysis Engine - Core Data Aggregation Logic
 *
 * This module contains the AnalysisEngine class that processes arrays of
 * ScenarioRunResult objects and transforms them into structured ReportData
 * with comprehensive statistics, groupings, and trajectory analysis.
 *
 * Required by ticket #5787 - Data Aggregation Logic section.
 */

import { ScenarioRunResult } from '../../scenario/src/schema';
import { MatrixConfig } from '../../scenario/src/matrix-schema';
import { ReportData, ReportSummaryStats, CommonTrajectory } from './report-schema';

export interface FileProcessingStats {
  processed: number;
  skipped: number;
}

/**
 * Core analysis engine that processes raw scenario run data into structured reports
 */
export class AnalysisEngine {
  constructor() {
    // Initialize any necessary state or configuration
  }

  /**
   * Main processing method that transforms raw run results into structured report data
   *
   * @param runs Array of ScenarioRunResult objects to analyze
   * @param matrixConfig The original matrix configuration
   * @param inputDirectory Path to the input directory that was processed
   * @param fileStats Statistics about file processing (processed vs skipped)
   * @returns Complete ReportData object ready for serialization
   */
  processRunResults(
    runs: ScenarioRunResult[],
    matrixConfig: MatrixConfig,
    inputDirectory: string,
    fileStats: FileProcessingStats
  ): ReportData {
    // Calculate summary statistics across all runs
    const summaryStats = this.calculateSummaryStats(runs);

    // Group results by each matrix parameter
    const resultsByParameter = this.groupResultsByParameters(runs, matrixConfig);

    // Analyze trajectory patterns
    const commonTrajectories = this.analyzeTrajectoryPatterns(runs);

    // Build complete report data structure
    const reportData: ReportData = {
      metadata: {
        report_generated_at: new Date().toISOString(),
        matrix_config: matrixConfig,
        input_directory: inputDirectory,
        processed_files: fileStats.processed,
        skipped_files: fileStats.skipped,
      },
      summary_stats: summaryStats,
      results_by_parameter: resultsByParameter,
      common_trajectories: commonTrajectories,
      raw_results: runs,
    };

    return reportData;
  }

  /**
   * Calculate high-level summary statistics across all runs
   */
  private calculateSummaryStats(runs: ScenarioRunResult[]): ReportSummaryStats {
    if (runs.length === 0) {
      return {
        total_runs: 0,
        total_failed_runs: 0,
        average_execution_time: 0,
        median_execution_time: 0,
        average_llm_calls: 0,
        average_total_tokens: 0,
        capability_success_rates: {},
        overall_success_rate: 0,
      };
    }

    const totalRuns = runs.length;
    const failedRuns = runs.filter((run) => run.error !== null).length;
    const successfulRuns = runs.filter((run) => run.error === null);

    // Calculate execution time statistics
    const executionTimes = runs.map((run) => run.metrics.execution_time_seconds);
    const averageExecutionTime = executionTimes.reduce((sum, time) => sum + time, 0) / totalRuns;
    const sortedExecutionTimes = [...executionTimes].sort((a, b) => a - b);
    const medianExecutionTime = this.calculateMedian(sortedExecutionTimes);

    // Calculate LLM usage statistics
    const averageLlmCalls = runs.reduce((sum, run) => sum + run.metrics.llm_calls, 0) / totalRuns;
    const averageTotalTokens =
      runs.reduce((sum, run) => sum + run.metrics.total_tokens, 0) / totalRuns;

    // Calculate capability success rates
    const capabilitySuccessRates = this.calculateCapabilitySuccessRates(runs);

    // Overall success rate
    const overallSuccessRate = successfulRuns.length / totalRuns;

    return {
      total_runs: totalRuns,
      total_failed_runs: failedRuns,
      average_execution_time: averageExecutionTime,
      median_execution_time: medianExecutionTime,
      average_llm_calls: averageLlmCalls,
      average_total_tokens: averageTotalTokens,
      capability_success_rates: capabilitySuccessRates,
      overall_success_rate: overallSuccessRate,
    };
  }

  /**
   * Calculate success rates for each evaluation capability
   */
  private calculateCapabilitySuccessRates(runs: ScenarioRunResult[]): Record<string, number> {
    const capabilityStats: Record<string, { total: number; passed: number }> = {};

    // Collect all capability results
    runs.forEach((run) => {
      run.evaluations.forEach((evaluation) => {
        // Extract capability from evaluation details or use evaluator_type as fallback
        const capability = evaluation.details?.capability || evaluation.evaluator_type;
        if (capability) {
          if (!capabilityStats[capability]) {
            capabilityStats[capability] = { total: 0, passed: 0 };
          }
          capabilityStats[capability].total++;
          if (evaluation.success) {
            capabilityStats[capability].passed++;
          }
        }
      });
    });

    // Calculate success rates
    const successRates: Record<string, number> = {};
    Object.entries(capabilityStats).forEach(([capability, stats]) => {
      successRates[capability] = stats.total > 0 ? stats.passed / stats.total : 0;
    });

    return successRates;
  }

  /**
   * Group results by each matrix parameter and calculate statistics for each group
   */
  private groupResultsByParameters(
    runs: ScenarioRunResult[],
    matrixConfig: MatrixConfig
  ): Record<string, Record<string, ReportSummaryStats>> {
    const groupedResults: Record<string, Record<string, ReportSummaryStats>> = {};

    if (runs.length === 0) {
      return groupedResults;
    }

    // Extract parameter names from matrix config AND infer additional ones from runs
    const matrixParameters = new Set(matrixConfig.matrix.map((axis) => axis.parameter));

    // Always collect all parameters from run data to ensure we don't miss any
    const allParameters = new Set<string>();
    runs.forEach((run) => {
      this.collectAllParameterPaths(run.parameters, '', allParameters);
    });

    // Combine matrix parameters with inferred parameters
    const combinedParameters = new Set([...matrixParameters, ...allParameters]);
    const parameterNames = Array.from(combinedParameters);

    // Group runs by each parameter
    parameterNames.forEach((parameterName) => {
      groupedResults[parameterName] = {};

      // Group runs by parameter value
      const runGroups: Record<string, ScenarioRunResult[]> = {};
      runs.forEach((run) => {
        const parameterValue = this.getParameterValue(run.parameters, parameterName);
        const parameterValueKey = this.serializeParameterValue(parameterValue);

        if (!runGroups[parameterValueKey]) {
          runGroups[parameterValueKey] = [];
        }
        runGroups[parameterValueKey].push(run);
      });

      // Calculate statistics for each group
      Object.entries(runGroups).forEach(([valueKey, groupRuns]) => {
        groupedResults[parameterName][valueKey] = this.calculateSummaryStats(groupRuns);
      });
    });

    return groupedResults;
  }

  /**
   * Recursively collect all parameter paths from a parameters object
   */
  private collectAllParameterPaths(
    obj: any,
    currentPath: string,
    paths: Set<string>,
    maxDepth = 3,
    currentDepth = 0
  ): void {
    if (currentDepth >= maxDepth || obj === null || typeof obj !== 'object') {
      return;
    }

    Object.entries(obj).forEach(([key, value]) => {
      const paramPath = currentPath ? `${currentPath}.${key}` : key;

      // Always add the current path as a potential parameter
      paths.add(paramPath);

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Also recurse into nested objects to find deeper paths
        this.collectAllParameterPaths(value, paramPath, paths, maxDepth, currentDepth + 1);
      }
    });
  }

  /**
   * Extract parameter value from nested or flat parameters object
   */
  private getParameterValue(parameters: Record<string, any>, parameterPath: string): any {
    // First try the flat key (exact match)
    if (parameterPath in parameters) {
      return parameters[parameterPath];
    }

    // If not found, try navigating nested object structure
    const pathParts = parameterPath.split('.');
    let value = parameters;

    for (const part of pathParts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * Convert parameter values to strings for consistent grouping
   */
  private serializeParameterValue(value: any): string {
    if (value === null || value === undefined) {
      return 'undefined';
    }
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    return String(value);
  }

  /**
   * Analyze trajectory patterns to find most common sequences
   */
  private analyzeTrajectoryPatterns(runs: ScenarioRunResult[]): CommonTrajectory[] {
    const trajectoryPatterns: Map<
      string,
      {
        count: number;
        totalDuration: number;
        sequence: string[];
      }
    > = new Map();

    // Extract trajectory sequences and durations
    runs.forEach((run) => {
      if (run.trajectory && run.trajectory.length > 0) {
        const sequence = run.trajectory.map((step) => step.type);
        const sequenceKey = sequence.join(',');
        const duration = run.metrics.execution_time_seconds;

        if (trajectoryPatterns.has(sequenceKey)) {
          const pattern = trajectoryPatterns.get(sequenceKey)!;
          pattern.count++;
          pattern.totalDuration += duration;
        } else {
          trajectoryPatterns.set(sequenceKey, {
            count: 1,
            totalDuration: duration,
            sequence: [...sequence], // Create a copy of the sequence array
          });
        }
      }
    });

    // Convert to CommonTrajectory objects and sort by frequency
    const totalRunsWithTrajectories = runs.filter(
      (run) => run.trajectory && run.trajectory.length > 0
    ).length;

    const commonTrajectories: CommonTrajectory[] = Array.from(trajectoryPatterns.entries())
      .map(([_, pattern]) => ({
        sequence: pattern.sequence,
        count: pattern.count,
        average_duration: pattern.totalDuration / pattern.count,
        percentage: totalRunsWithTrajectories > 0 ? pattern.count / totalRunsWithTrajectories : 0,
      }))
      .sort((a, b) => b.count - a.count); // Sort by frequency (most common first)

    return commonTrajectories;
  }

  /**
   * Calculate median value from sorted array of numbers
   */
  private calculateMedian(sortedNumbers: number[]): number {
    if (sortedNumbers.length === 0) return 0;

    const middle = Math.floor(sortedNumbers.length / 2);

    if (sortedNumbers.length % 2 === 0) {
      // Even number of elements - average of two middle values
      return (sortedNumbers[middle - 1] + sortedNumbers[middle]) / 2;
    } else {
      // Odd number of elements - middle value
      return sortedNumbers[middle];
    }
  }
}
