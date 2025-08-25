import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { type IAgentRuntime } from '@elizaos/core';
import { RunDataAggregator, type ScenarioRunResult } from '../data-aggregator';
import { TrajectoryReconstructor } from '../TrajectoryReconstructor';
import { EvaluationEngine } from '../EvaluationEngine';

describe('RunDataAggregator', () => {
  let mockRuntime: IAgentRuntime;
  let aggregator: RunDataAggregator;
  let mockTrajectoryReconstructor: TrajectoryReconstructor;
  let mockEvaluationEngine: EvaluationEngine;

  beforeEach(() => {
    // Create mock runtime
    mockRuntime = {
      agentId: 'test-agent-123',
      getSetting: mock(() => 'test-value'),
      getService: mock(() => null),
      logger: {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
      },
    } as any;

    // Create mock trajectory reconstructor
    mockTrajectoryReconstructor = {
      getLatestTrajectory: mock(async () => [
        {
          type: 'thought',
          timestamp: '2023-10-27T10:00:01Z',
          content: 'I need to test something',
        },
        {
          type: 'action',
          timestamp: '2023-10-27T10:00:02Z',
          content: {
            name: 'TEST_ACTION',
            parameters: { value: 123 },
          },
        },
        {
          type: 'observation',
          timestamp: '2023-10-27T10:00:03Z',
          content: 'Test completed successfully',
        },
      ]),
    } as any;

    // Create mock evaluation engine
    mockEvaluationEngine = {
      runEnhancedEvaluations: mock(async () => [
        {
          evaluator_type: 'string_contains',
          success: true,
          summary: 'String found successfully',
          details: { found_at: 0, case_sensitive: false },
        },
      ]),
    } as any;

    aggregator = new RunDataAggregator(
      mockRuntime,
      mockTrajectoryReconstructor,
      mockEvaluationEngine
    );
  });

  describe('constructor', () => {
    it('should initialize with required dependencies', () => {
      expect(aggregator).toBeDefined();
      expect(aggregator.runtime).toBe(mockRuntime);
      expect(aggregator.trajectoryReconstructor).toBe(mockTrajectoryReconstructor);
      expect(aggregator.evaluationEngine).toBe(mockEvaluationEngine);
    });
  });

  describe('startRun', () => {
    it('should initialize a new run with unique ID', () => {
      const runId = 'test-run-123';
      const combinationId = 'combo-001';
      const parameters = { 'character.llm.model': 'gpt-4' };

      aggregator.startRun(runId, combinationId, parameters);

      expect(aggregator.runId).toBe(runId);
      expect(aggregator.combinationId).toBe(combinationId);
      expect(aggregator.parameters).toEqual(parameters);
      expect(aggregator.startTime).toBeInstanceOf(Date);
    });

    it('should reset previous run data', () => {
      // Start first run
      aggregator.startRun('run-1', 'combo-1', { param1: 'value1' });
      const firstStartTime = aggregator.startTime;

      // Start second run
      aggregator.startRun('run-2', 'combo-2', { param2: 'value2' });

      expect(aggregator.runId).toBe('run-2');
      expect(aggregator.combinationId).toBe('combo-2');
      expect(aggregator.parameters).toEqual({ param2: 'value2' });
      expect(aggregator.startTime).not.toBe(firstStartTime);
    });
  });

  describe('recordFinalResponse', () => {
    it('should store the final agent response', () => {
      const response = 'This is the final response from the agent.';

      aggregator.recordFinalResponse(response);

      expect(aggregator.finalResponse).toBe(response);
    });
  });

  describe('recordMetrics', () => {
    it('should store execution metrics', () => {
      const metrics = {
        execution_time_seconds: 15.7,
        llm_calls: 3,
        total_tokens: 1500,
      };

      aggregator.recordMetrics(metrics);

      expect(aggregator.metrics).toEqual(metrics);
    });

    it('should merge with existing metrics', () => {
      aggregator.recordMetrics({ execution_time_seconds: 10.0 });
      aggregator.recordMetrics({ llm_calls: 2, total_tokens: 800 });

      expect(aggregator.metrics).toEqual({
        execution_time_seconds: 10.0,
        llm_calls: 2,
        total_tokens: 800,
      });
    });
  });

  describe('recordError', () => {
    it('should store error information', () => {
      const error = new Error('Test error occurred');

      aggregator.recordError(error);

      expect(aggregator.error).toBe('Test error occurred');
    });

    it('should handle string errors', () => {
      const error = 'String error message';

      aggregator.recordError(error);

      expect(aggregator.error).toBe(error);
    });
  });

  describe('buildResult', () => {
    it('should build a complete ScenarioRunResult for successful run', async () => {
      // Arrange: Set up a complete run
      aggregator.startRun('test-run-456', 'combo-002', { model: 'gpt-4' });
      aggregator.recordFinalResponse('Agent completed the task successfully.');
      aggregator.recordMetrics({
        execution_time_seconds: 12.3,
        llm_calls: 2,
        total_tokens: 1200,
      });

      const roomId = 'test-room-789';
      const evaluations = [
        {
          type: 'string_contains',
          value: 'success',
          case_sensitive: false,
        },
      ];
      const executionResult = {
        exitCode: 0,
        stdout: 'Task completed',
        stderr: '',
        durationMs: 12300,
      };

      // Act: Build the result
      const result = await aggregator.buildResult(roomId, evaluations, executionResult);

      // Assert: Verify the complete structure
      expect(result).toEqual({
        run_id: 'test-run-456',
        matrix_combination_id: 'combo-002',
        parameters: { model: 'gpt-4' },
        metrics: {
          execution_time_seconds: 12.3,
          llm_calls: 2,
          total_tokens: 1200,
        },
        final_agent_response: 'Agent completed the task successfully.',
        evaluations: [
          {
            evaluator_type: 'string_contains',
            success: true,
            summary: 'String found successfully',
            details: { found_at: 0, case_sensitive: false },
          },
        ],
        trajectory: [
          {
            type: 'thought',
            timestamp: '2023-10-27T10:00:01Z',
            content: 'I need to test something',
          },
          {
            type: 'action',
            timestamp: '2023-10-27T10:00:02Z',
            content: {
              name: 'TEST_ACTION',
              parameters: { value: 123 },
            },
          },
          {
            type: 'observation',
            timestamp: '2023-10-27T10:00:03Z',
            content: 'Test completed successfully',
          },
        ],
        error: null,
      });

      // Verify dependencies were called
      expect(mockTrajectoryReconstructor.getLatestTrajectory).toHaveBeenCalledWith(roomId);
      expect(mockEvaluationEngine.runEnhancedEvaluations).toHaveBeenCalledWith(
        evaluations,
        executionResult
      );
    });

    it('should build a ScenarioRunResult with error for failed run', async () => {
      // Arrange: Set up a failed run
      aggregator.startRun('failed-run-789', 'combo-003', { model: 'claude-3' });
      aggregator.recordError(new Error('Runtime error occurred'));
      aggregator.recordMetrics({ execution_time_seconds: 5.0 });

      const roomId = 'test-room-failed';
      const evaluations = [];
      const executionResult = {
        exitCode: 1,
        stdout: '',
        stderr: 'Error occurred',
        durationMs: 5000,
      };

      // Act: Build the result
      const result = await aggregator.buildResult(roomId, evaluations, executionResult);

      // Assert: Verify error is captured
      expect(result.run_id).toBe('failed-run-789');
      expect(result.error).toBe('Runtime error occurred');
      expect(result.final_agent_response).toBeUndefined();
      expect(result.metrics.execution_time_seconds).toBe(5.0);
    });

    it('should throw error if run not started', async () => {
      // Act & Assert: Attempt to build result without starting run
      await expect(aggregator.buildResult('room-id', [], {})).rejects.toThrow(
        'Run not started. Call startRun() first.'
      );
    });
  });

  describe('reset', () => {
    it('should clear all run data', () => {
      // Arrange: Set up a run with data
      aggregator.startRun('test-run', 'combo-test', { param: 'value' });
      aggregator.recordFinalResponse('Response');
      aggregator.recordMetrics({ execution_time_seconds: 10 });
      aggregator.recordError('Error');

      // Act: Reset the aggregator
      aggregator.reset();

      // Assert: All data should be cleared
      expect(aggregator.runId).toBeUndefined();
      expect(aggregator.combinationId).toBeUndefined();
      expect(aggregator.parameters).toBeUndefined();
      expect(aggregator.startTime).toBeUndefined();
      expect(aggregator.finalResponse).toBeUndefined();
      expect(aggregator.metrics).toEqual({});
      expect(aggregator.error).toBeUndefined();
    });
  });
});

describe('ScenarioRunResult schema validation', () => {
  it('should validate a complete valid result', () => {
    const validResult: ScenarioRunResult = {
      run_id: 'run-20231027-015',
      matrix_combination_id: 'combo-003',
      parameters: {
        'character.llm.model': 'gpt-4-turbo',
        'run[0].input': 'Test input',
      },
      metrics: {
        execution_time_seconds: 14.7,
        llm_calls: 2,
        total_tokens: 2100,
      },
      final_agent_response: 'Task completed successfully.',
      evaluations: [
        {
          evaluator_type: 'llm_judge',
          success: false,
          summary: 'Agent response needs improvement',
          details: {
            qualitative_summary: 'Response was accurate but lacked detail',
            capability_checklist: [
              {
                capability: 'Formats Final Response',
                achieved: false,
                reasoning: 'Response format was not optimal',
              },
            ],
          },
        },
      ],
      trajectory: [
        {
          type: 'thought',
          timestamp: '2023-10-27T10:00:01Z',
          content: 'I need to process this request',
        },
        {
          type: 'action',
          timestamp: '2023-10-27T10:00:02Z',
          content: {
            name: 'LIST_GITHUB_ISSUES',
            parameters: {
              owner: 'elizaOS',
              repo: 'eliza',
            },
          },
        },
        {
          type: 'observation',
          timestamp: '2023-10-27T10:00:04Z',
          content: [
            { id: 123, title: 'Fix the login button', state: 'open' },
            { id: 124, title: 'Improve documentation for scenarios', state: 'open' },
          ],
        },
      ],
      error: null,
    };

    // This should not throw any TypeScript errors
    expect(validResult.run_id).toBe('run-20231027-015');
    expect(validResult.trajectory.length).toBe(3);
    expect(validResult.evaluations[0].success).toBe(false);
  });
});
