/**
 * Analysis Engine Tests - Test-Driven Development
 *
 * Comprehensive unit tests for the AnalysisEngine that processes ScenarioRunResult
 * arrays and generates structured ReportData objects.
 *
 * Required by ticket #5787 - Testing Requirements section.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { AnalysisEngine } from '../analysis-engine';
import { ReportData, ReportSummaryStats } from '../report-schema';
import {
  ScenarioRunResult,
  ScenarioRunMetrics,
  TrajectoryStep,
  EnhancedEvaluationResult,
} from '../../../scenario/src/schema';
import { MatrixConfig } from '../../../scenario/src/matrix-schema';

describe('AnalysisEngine', () => {
  let analysisEngine: AnalysisEngine;
  let mockMatrixConfig: MatrixConfig;

  beforeEach(() => {
    analysisEngine = new AnalysisEngine();
    mockMatrixConfig = {
      name: 'Test Matrix',
      description: 'Test matrix for analysis engine',
      base_scenario: 'test.scenario.yaml',
      runs_per_combination: 2,
      matrix: [
        {
          parameter: 'character.llm.model',
          values: ['gpt-4', 'gpt-3.5-turbo'],
        },
        {
          parameter: 'character.temperature',
          values: [0.7, 0.9],
        },
      ],
    };
  });

  describe('Constructor and Basic Setup', () => {
    test('should initialize with empty state', () => {
      const engine = new AnalysisEngine();
      expect(engine).toBeInstanceOf(AnalysisEngine);
    });
  });

  describe('processRunResults - Core Analysis Logic', () => {
    test('should calculate correct summary statistics for successful runs', () => {
      const mockRuns: ScenarioRunResult[] = [
        createMockRunResult({
          run_id: 'run-1',
          parameters: { 'character.llm.model': 'gpt-4' },
          metrics: {
            execution_time_seconds: 10.5,
            llm_calls: 3,
            total_tokens: 1500,
          },
          error: null,
          evaluations: [
            {
              evaluator_type: 'llm_judge',
              success: true,
              summary: 'Format response capability passed',
              details: { capability: 'Format Response', score: 1.0 },
            },
            {
              evaluator_type: 'llm_judge',
              success: true,
              summary: 'Answer quality capability passed',
              details: { capability: 'Answer Quality', score: 0.9 },
            },
          ],
        }),
        createMockRunResult({
          run_id: 'run-2',
          parameters: { 'character.llm.model': 'gpt-3.5-turbo' },
          metrics: {
            execution_time_seconds: 8.2,
            llm_calls: 2,
            total_tokens: 1200,
          },
          error: null,
          evaluations: [
            {
              evaluator_type: 'llm_judge',
              success: true,
              summary: 'Format response capability passed',
              details: { capability: 'Format Response', score: 0.95 },
            },
            {
              evaluator_type: 'llm_judge',
              success: false,
              summary: 'Answer quality capability failed',
              details: { capability: 'Answer Quality', score: 0.4 },
            },
          ],
        }),
        createMockRunResult({
          run_id: 'run-3',
          parameters: { 'character.llm.model': 'gpt-4' },
          metrics: {
            execution_time_seconds: 12.1,
            llm_calls: 4,
            total_tokens: 1800,
          },
          error: null,
          evaluations: [
            {
              evaluator_type: 'llm_judge',
              success: true,
              summary: 'Format response capability passed',
              details: { capability: 'Format Response', score: 0.88 },
            },
            {
              evaluator_type: 'llm_judge',
              success: true,
              summary: 'Answer quality capability passed',
              details: { capability: 'Answer Quality', score: 0.92 },
            },
          ],
        }),
      ];

      const result = analysisEngine.processRunResults(mockRuns, mockMatrixConfig, '/test/input', {
        processed: 3,
        skipped: 0,
      });

      expect(result.summary_stats.total_runs).toBe(3);
      expect(result.summary_stats.total_failed_runs).toBe(0);
      expect(result.summary_stats.average_execution_time).toBeCloseTo(10.27, 2); // (10.5 + 8.2 + 12.1) / 3
      expect(result.summary_stats.average_llm_calls).toBeCloseTo(3); // (3 + 2 + 4) / 3
      expect(result.summary_stats.average_total_tokens).toBeCloseTo(1500); // (1500 + 1200 + 1800) / 3
      expect(result.summary_stats.overall_success_rate).toBe(1.0); // All runs succeeded

      // Capability success rates
      expect(result.summary_stats.capability_success_rates['Format Response']).toBe(1.0); // 3/3
      expect(result.summary_stats.capability_success_rates['Answer Quality']).toBeCloseTo(0.67, 2); // 2/3
    });

    test('should handle failed runs correctly', () => {
      const mockRuns: ScenarioRunResult[] = [
        createMockRunResult({
          run_id: 'run-1',
          parameters: { 'character.llm.model': 'gpt-4' },
          error: null,
          evaluations: [
            {
              evaluator_type: 'test_evaluator',
              success: true,
              summary: 'Test capability passed',
              details: { capability: 'Test', score: 1.0 },
            },
          ],
        }),
        createMockRunResult({
          run_id: 'run-2',
          parameters: { 'character.llm.model': 'gpt-4' },
          error: 'Execution timeout',
          evaluations: [],
        }),
      ];

      const result = analysisEngine.processRunResults(mockRuns, mockMatrixConfig, '/test/input', {
        processed: 2,
        skipped: 0,
      });

      expect(result.summary_stats.total_runs).toBe(2);
      expect(result.summary_stats.total_failed_runs).toBe(1);
      expect(result.summary_stats.overall_success_rate).toBe(0.5); // 1/2 successful
    });

    test('should calculate median execution time correctly', () => {
      const mockRuns: ScenarioRunResult[] = [
        createMockRunResult({ metrics: { execution_time_seconds: 5 } }),
        createMockRunResult({ metrics: { execution_time_seconds: 10 } }),
        createMockRunResult({ metrics: { execution_time_seconds: 15 } }),
        createMockRunResult({ metrics: { execution_time_seconds: 20 } }),
        createMockRunResult({ metrics: { execution_time_seconds: 25 } }),
      ];

      const result = analysisEngine.processRunResults(mockRuns, mockMatrixConfig, '/test/input', {
        processed: 5,
        skipped: 0,
      });

      expect(result.summary_stats.median_execution_time).toBe(15); // Middle value of sorted array
    });

    test('should group results by matrix parameters correctly', () => {
      const mockRuns: ScenarioRunResult[] = [
        createMockRunResult({
          run_id: 'run-1',
          parameters: { 'character.llm.model': 'gpt-4', 'character.temperature': 0.7 },
          metrics: { execution_time_seconds: 10 },
          evaluations: [
            {
              evaluator_type: 'test_evaluator',
              success: true,
              summary: 'Test capability passed',
              details: { capability: 'Test', score: 0.9 },
            },
          ],
        }),
        createMockRunResult({
          run_id: 'run-2',
          parameters: { 'character.llm.model': 'gpt-4', 'character.temperature': 0.9 },
          metrics: { execution_time_seconds: 12 },
          evaluations: [
            {
              evaluator_type: 'test_evaluator',
              success: false,
              summary: 'Test capability failed',
              details: { capability: 'Test', score: 0.3 },
            },
          ],
        }),
        createMockRunResult({
          run_id: 'run-3',
          parameters: { 'character.llm.model': 'gpt-3.5-turbo', 'character.temperature': 0.7 },
          metrics: { execution_time_seconds: 8 },
          evaluations: [
            {
              evaluator_type: 'test_evaluator',
              success: true,
              summary: 'Test capability passed',
              details: { capability: 'Test', score: 0.8 },
            },
          ],
        }),
      ];

      const result = analysisEngine.processRunResults(mockRuns, mockMatrixConfig, '/test/input', {
        processed: 3,
        skipped: 0,
      });

      // Check grouping by model
      expect(result.results_by_parameter['character.llm.model']).toBeDefined();
      expect(result.results_by_parameter['character.llm.model']['gpt-4']).toBeDefined();
      expect(result.results_by_parameter['character.llm.model']['gpt-3.5-turbo']).toBeDefined();

      const gpt4Stats = result.results_by_parameter['character.llm.model']['gpt-4'];
      const gpt35Stats = result.results_by_parameter['character.llm.model']['gpt-3.5-turbo'];

      expect(gpt4Stats.total_runs).toBe(2);
      expect(gpt4Stats.average_execution_time).toBe(11); // (10 + 12) / 2
      expect(gpt4Stats.capability_success_rates['Test']).toBe(0.5); // 1/2

      expect(gpt35Stats.total_runs).toBe(1);
      expect(gpt35Stats.average_execution_time).toBe(8);
      expect(gpt35Stats.capability_success_rates['Test']).toBe(1.0); // 1/1

      // Check grouping by temperature
      expect(result.results_by_parameter['character.temperature']).toBeDefined();
      expect(result.results_by_parameter['character.temperature']['0.7']).toBeDefined();
      expect(result.results_by_parameter['character.temperature']['0.9']).toBeDefined();
    });

    test('should analyze trajectory patterns correctly', () => {
      const mockRuns: ScenarioRunResult[] = [
        createMockRunResult({
          run_id: 'run-1',
          trajectory: [
            { type: 'thought', timestamp: '2023-01-01T00:00:00Z', content: 'thinking' },
            { type: 'action', timestamp: '2023-01-01T00:00:01Z', content: 'list_issues' },
            { type: 'observation', timestamp: '2023-01-01T00:00:02Z', content: 'got results' },
          ],
          metrics: { execution_time_seconds: 10 },
        }),
        createMockRunResult({
          run_id: 'run-2',
          trajectory: [
            { type: 'thought', timestamp: '2023-01-01T00:00:00Z', content: 'thinking' },
            { type: 'action', timestamp: '2023-01-01T00:00:01Z', content: 'list_issues' },
            { type: 'observation', timestamp: '2023-01-01T00:00:02Z', content: 'got results' },
          ],
          metrics: { execution_time_seconds: 12 },
        }),
        createMockRunResult({
          run_id: 'run-3',
          trajectory: [
            { type: 'thought', timestamp: '2023-01-01T00:00:00Z', content: 'direct response' },
            { type: 'action', timestamp: '2023-01-01T00:00:01Z', content: 'reply_directly' },
            // Different pattern: only thought -> action, no observation
          ],
          metrics: { execution_time_seconds: 8 },
        }),
      ];

      const result = analysisEngine.processRunResults(mockRuns, mockMatrixConfig, '/test/input', {
        processed: 3,
        skipped: 0,
      });

      expect(result.common_trajectories).toHaveLength(2);

      // Find the most common trajectory (thought,action,observation)
      const commonTrajectory = result.common_trajectories.find(
        (t) => t.sequence.join(',') === 'thought,action,observation'
      );
      expect(commonTrajectory).toBeDefined();
      expect(commonTrajectory!.count).toBe(2); // Runs 1 and 2 follow this pattern
      expect(commonTrajectory!.percentage).toBeCloseTo(0.67, 2); // 2/3
      expect(commonTrajectory!.average_duration).toBe(11); // (10 + 12) / 2

      // Find the less common trajectory (thought,action)
      const shortTrajectory = result.common_trajectories.find(
        (t) => t.sequence.join(',') === 'thought,action'
      );
      expect(shortTrajectory).toBeDefined();
      expect(shortTrajectory!.count).toBe(1); // Run 3 follows this pattern
      expect(shortTrajectory!.percentage).toBeCloseTo(0.33, 2); // 1/3
      expect(shortTrajectory!.average_duration).toBe(8); // Run 3 duration
    });

    test('should include complete metadata in the result', () => {
      const mockRuns: ScenarioRunResult[] = [createMockRunResult()];
      const inputDir = '/test/matrix/output';
      const fileStats = { processed: 5, skipped: 2 };

      const result = analysisEngine.processRunResults(
        mockRuns,
        mockMatrixConfig,
        inputDir,
        fileStats
      );

      expect(result.metadata.matrix_config).toEqual(mockMatrixConfig);
      expect(result.metadata.input_directory).toBe(inputDir);
      expect(result.metadata.processed_files).toBe(5);
      expect(result.metadata.skipped_files).toBe(2);
      expect(result.metadata.report_generated_at).toBeDefined();
      expect(new Date(result.metadata.report_generated_at)).toBeInstanceOf(Date);
    });

    test('should preserve raw results in output', () => {
      const mockRuns: ScenarioRunResult[] = [
        createMockRunResult({ run_id: 'run-1' }),
        createMockRunResult({ run_id: 'run-2' }),
      ];

      const result = analysisEngine.processRunResults(mockRuns, mockMatrixConfig, '/test/input', {
        processed: 2,
        skipped: 0,
      });

      expect(result.raw_results).toEqual(mockRuns);
      expect(result.raw_results).toHaveLength(2);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty input gracefully', () => {
      const result = analysisEngine.processRunResults([], mockMatrixConfig, '/test/input', {
        processed: 0,
        skipped: 0,
      });

      expect(result.summary_stats.total_runs).toBe(0);
      expect(result.summary_stats.total_failed_runs).toBe(0);
      expect(result.summary_stats.average_execution_time).toBe(0);
      expect(result.summary_stats.overall_success_rate).toBe(0);
      expect(result.results_by_parameter).toEqual({});
      expect(result.common_trajectories).toEqual([]);
      expect(result.raw_results).toEqual([]);
    });

    test('should handle single run input', () => {
      const singleRun = createMockRunResult({
        run_id: 'only-run',
        metrics: { execution_time_seconds: 15.5, llm_calls: 5, total_tokens: 2000 },
        evaluations: [{ capability: 'Test', passed: true }],
      });

      const result = analysisEngine.processRunResults(
        [singleRun],
        mockMatrixConfig,
        '/test/input',
        { processed: 1, skipped: 0 }
      );

      expect(result.summary_stats.total_runs).toBe(1);
      expect(result.summary_stats.average_execution_time).toBe(15.5);
      expect(result.summary_stats.median_execution_time).toBe(15.5);
      expect(result.summary_stats.overall_success_rate).toBe(1.0);
      expect(result.common_trajectories).toHaveLength(1);
    });

    test('should handle runs with missing evaluation data', () => {
      const mockRuns: ScenarioRunResult[] = [
        createMockRunResult({
          run_id: 'run-1',
          evaluations: [], // No evaluations
        }),
        createMockRunResult({
          run_id: 'run-2',
          evaluations: [
            {
              evaluator_type: 'test_evaluator',
              success: true,
              summary: 'Test capability passed',
              details: { capability: 'Test', score: 1.0 },
            },
          ],
        }),
      ];

      const result = analysisEngine.processRunResults(mockRuns, mockMatrixConfig, '/test/input', {
        processed: 2,
        skipped: 0,
      });

      expect(result.summary_stats.total_runs).toBe(2);
      expect(result.summary_stats.capability_success_rates['Test']).toBe(1.0); // Only count runs that have this capability
    });

    test('should handle runs with empty trajectories', () => {
      const mockRuns: ScenarioRunResult[] = [
        createMockRunResult({
          run_id: 'run-1',
          trajectory: [], // Empty trajectory
        }),
        createMockRunResult({
          run_id: 'run-2',
          trajectory: [{ type: 'thought', timestamp: '2023-01-01T00:00:00Z', content: 'thinking' }],
        }),
      ];

      const result = analysisEngine.processRunResults(mockRuns, mockMatrixConfig, '/test/input', {
        processed: 2,
        skipped: 0,
      });

      expect(result.common_trajectories).toHaveLength(1); // Only the non-empty trajectory
      expect(result.common_trajectories[0].sequence).toEqual(['thought']);
      expect(result.common_trajectories[0].count).toBe(1);
    });

    test('should handle parameters with complex values', () => {
      const mockRuns: ScenarioRunResult[] = [
        createMockRunResult({
          parameters: {
            'character.llm.model': 'gpt-4',
            'character.settings': { temperature: 0.7, maxTokens: 1000 }, // Complex object
          },
        }),
      ];

      const result = analysisEngine.processRunResults(mockRuns, mockMatrixConfig, '/test/input', {
        processed: 1,
        skipped: 0,
      });

      // Should convert complex values to strings for grouping
      expect(result.results_by_parameter['character.settings']).toBeDefined();
      const settingsKey = JSON.stringify({ temperature: 0.7, maxTokens: 1000 });
      expect(result.results_by_parameter['character.settings'][settingsKey]).toBeDefined();
    });
  });
});

/**
 * Helper function to create mock ScenarioRunResult objects for testing
 */
function createMockRunResult(overrides: Partial<ScenarioRunResult> = {}): ScenarioRunResult {
  const defaultTrajectory: TrajectoryStep[] = [
    { type: 'thought', timestamp: '2023-01-01T00:00:00Z', content: 'default thought' },
  ];

  const defaultMetrics: ScenarioRunMetrics = {
    execution_time_seconds: 10,
    llm_calls: 2,
    total_tokens: 1000,
  };

  const defaultEvaluations: EnhancedEvaluationResult[] = [
    {
      evaluator_type: 'test_evaluator',
      success: true,
      summary: 'Default test passed',
      details: { capability: 'Default Test', score: 1.0 },
    },
  ];

  return {
    run_id: `run-${Math.random().toString(36).substr(2, 9)}`,
    matrix_combination_id: `combination-${Math.random().toString(36).substr(2, 9)}`,
    parameters: { 'character.llm.model': 'gpt-4' },
    metrics: defaultMetrics,
    final_agent_response: 'Mock response',
    evaluations: defaultEvaluations,
    trajectory: defaultTrajectory,
    error: null,
    ...overrides,
    // Ensure nested objects are properly merged
    metrics: { ...defaultMetrics, ...overrides.metrics },
    trajectory: overrides.trajectory || defaultTrajectory,
    evaluations: overrides.evaluations || defaultEvaluations,
  };
}
