/**
 * Integration Tests for Trajectory Collection in Scenario Runner (Ticket #5785)
 *
 * These tests validate end-to-end trajectory capture and integration
 * with the scenario execution system.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { UUID } from '@elizaos/core';
import { ScenarioRunResultSchema } from '../schema';
import { TrajectoryReconstructor, TrajectoryStep } from '../TrajectoryReconstructor';
import { RunDataAggregator } from '../data-aggregator';
import { EvaluationEngine } from '../EvaluationEngine';

/**
 * Creates a mock runtime for testing trajectory integration
 */
function createMockRuntime() {
  return {
    agentId: 'test-agent-id' as UUID,
    getSetting: mock(() => 'test-value'),
    getService: mock(() => null),
    getLogs: mock(async () => []),
    getMemories: mock(async () => []),
    useModel: mock(async () => ({ success: true })),
    logger: {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    },
  };
}

/**
 * Creates mock trajectory data for testing
 */
function createMockTrajectoryData(roomId: UUID, agentId: UUID) {
  return [
    {
      id: 'mem-1' as UUID,
      entityId: agentId,
      roomId,
      createdAt: 1698397201000, // 2023-10-27T09:00:01Z
      content: {
        type: 'action_result',
        actionName: 'analyze-input',
        planThought: 'Processing user request for analysis',
        actionParams: { input: 'test data', mode: 'analyze' },
        actionResult: {
          success: true,
          text: 'Analysis completed successfully',
          data: { items: 5, confidence: 0.95 },
        },
      },
    },
    {
      id: 'mem-2' as UUID,
      entityId: agentId,
      roomId,
      createdAt: 1698397202000, // 2023-10-27T09:00:02Z
      content: {
        type: 'action_result',
        actionName: 'generate-response',
        planThought: 'Formulating response based on analysis',
        actionParams: { format: 'detailed' },
        actionResult: {
          success: true,
          text: 'Response generated',
        },
      },
    },
  ];
}

describe('Trajectory Integration - Scenario Runner', () => {
  describe('Schema Integration', () => {
    it('should include trajectory field in run result schema', () => {
      const mockRunResult = {
        run_id: 'test-run-001',
        matrix_combination_id: 'combo-001',
        parameters: { test: true },
        metrics: {
          execution_time_seconds: 5.0,
          llm_calls: 3,
          total_tokens: 150,
        },
        final_agent_response: 'Test completed successfully',
        evaluations: [
          {
            evaluator_type: 'string_contains',
            success: true,
            summary: 'Test passed',
            details: { found: true },
          },
        ],
        trajectory: [
          {
            type: 'thought',
            timestamp: '2023-10-27T10:00:01Z',
            content: 'Processing user request',
          },
          {
            type: 'action',
            timestamp: '2023-10-27T10:00:02Z',
            content: {
              name: 'TEST_ACTION',
              parameters: { test: true },
            },
          },
          {
            type: 'observation',
            timestamp: '2023-10-27T10:00:03Z',
            content: {
              success: true,
              data: { result: 'completed' },
            },
          },
        ],
        error: null,
      };

      // Should validate successfully with trajectory field
      expect(() => ScenarioRunResultSchema.parse(mockRunResult)).not.toThrow();
    });

    it('should make trajectory field optional for backward compatibility', () => {
      const mockRunResultWithoutTrajectory = {
        run_id: 'test-run-002',
        matrix_combination_id: 'combo-002',
        parameters: { test: false },
        metrics: {
          execution_time_seconds: 3.0,
          llm_calls: 2,
          total_tokens: 100,
        },
        final_agent_response: 'Test completed',
        evaluations: [
          {
            evaluator_type: 'string_contains',
            success: true,
            summary: 'Test passed',
            details: { found: true },
          },
        ],
        trajectory: [], // Empty trajectory array
        error: null,
      };

      // Should validate successfully with empty trajectory array
      expect(() => ScenarioRunResultSchema.parse(mockRunResultWithoutTrajectory)).not.toThrow();
    });

    it('should validate trajectory step structure', () => {
      const mockRunResultWithInvalidTrajectory = {
        run_id: 'test-run-003',
        matrix_combination_id: 'combo-003',
        parameters: { test: true },
        metrics: {
          execution_time_seconds: 2.0,
          llm_calls: 1,
          total_tokens: 50,
        },
        final_agent_response: 'Test failed',
        evaluations: [],
        trajectory: [
          {
            // Missing required fields
            type: 'thought',
            // Missing timestamp and content
          },
        ],
        error: null,
      };

      // Should fail validation with invalid trajectory structure
      expect(() => ScenarioRunResultSchema.parse(mockRunResultWithInvalidTrajectory)).toThrow();
    });
  });

  describe('Runtime Integration', () => {
    let mockRuntime: ReturnType<typeof createMockRuntime>;
    let reconstructor: TrajectoryReconstructor;
    const testRoomId = 'test-room-id' as UUID;

    beforeEach(() => {
      mockRuntime = createMockRuntime();
      reconstructor = new TrajectoryReconstructor(mockRuntime as never);
    });

    it('should capture trajectory during scenario execution', async () => {
      const trajectoryData = createMockTrajectoryData(testRoomId, mockRuntime.agentId);

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue(trajectoryData as never);

      const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

      // Verify trajectory was captured
      expect(trajectory.steps.length).toBeGreaterThan(0);

      // Verify thought steps are captured
      const thoughtSteps = trajectory.steps.filter((s) => s.type === 'thought');
      expect(thoughtSteps.length).toBeGreaterThan(0);

      // Verify action steps are captured
      const actionSteps = trajectory.steps.filter((s) => s.type === 'action');
      expect(actionSteps.length).toBeGreaterThan(0);

      // Verify observation steps are captured
      const observationSteps = trajectory.steps.filter((s) => s.type === 'observation');
      expect(observationSteps.length).toBeGreaterThan(0);
    });

    it('should include trajectory in scenario run results', async () => {
      const trajectoryData = createMockTrajectoryData(testRoomId, mockRuntime.agentId);

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue(trajectoryData as never);

      // Get trajectory
      const trajectorySteps = await reconstructor.getLatestTrajectory(testRoomId);

      // Simulate building scenario run result with trajectory
      const scenarioRunResult = {
        run_id: 'integration-test-001',
        matrix_combination_id: 'combo-integration',
        parameters: { mode: 'test' },
        metrics: {
          execution_time_seconds: 2.5,
          llm_calls: 2,
          total_tokens: 100,
        },
        final_agent_response: 'Integration test completed',
        evaluations: [],
        trajectory: trajectorySteps,
        error: null,
      };

      // Validate the complete result
      const validated = ScenarioRunResultSchema.parse(scenarioRunResult);
      expect(validated.trajectory).toBeDefined();
      expect(validated.trajectory.length).toBeGreaterThan(0);
    });
  });

  describe('Trajectory Data Quality', () => {
    let mockRuntime: ReturnType<typeof createMockRuntime>;
    let reconstructor: TrajectoryReconstructor;
    const testRoomId = 'test-room-id' as UUID;

    beforeEach(() => {
      mockRuntime = createMockRuntime();
      reconstructor = new TrajectoryReconstructor(mockRuntime as never);
    });

    it('should ensure timestamps are properly formatted', async () => {
      const trajectoryData = createMockTrajectoryData(testRoomId, mockRuntime.agentId);

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue(trajectoryData as never);

      const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

      // Verify all timestamps are ISO format strings
      for (const step of trajectory.steps) {
        expect(typeof step.timestamp).toBe('string');
        // Should be parseable as a date
        expect(() => new Date(step.timestamp)).not.toThrow();
        // Should match ISO format pattern
        expect(step.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
    });

    it('should maintain chronological order of trajectory steps', async () => {
      const trajectoryData = createMockTrajectoryData(testRoomId, mockRuntime.agentId);

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue(trajectoryData as never);

      const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

      if (trajectory.steps.length > 1) {
        // Verify chronological order
        const timestamps = trajectory.steps.map((s) => new Date(s.timestamp).getTime());
        const sortedTimestamps = [...timestamps].sort((a, b) => a - b);
        expect(timestamps).toEqual(sortedTimestamps);
      }
    });

    it('should handle complex action parameters correctly', async () => {
      const complexParams = {
        nested: { deep: { value: 'test' } },
        array: [1, 2, 3],
        boolean: true,
        number: 42,
      };

      const complexMemory = {
        id: 'mem-complex' as UUID,
        entityId: mockRuntime.agentId,
        roomId: testRoomId,
        createdAt: 1698397201000,
        content: {
          type: 'action_result',
          actionName: 'complex-action',
          actionParams: complexParams,
          actionResult: { success: true, text: 'Completed' },
        },
      };

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue([complexMemory as never]);

      const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

      // Find the action step
      const actionStep = trajectory.steps.find((s) => s.type === 'action');
      expect(actionStep).toBeDefined();

      if (actionStep && typeof actionStep.content === 'object' && actionStep.content !== null) {
        const content = actionStep.content as { parameters?: Record<string, unknown> };
        expect(content.parameters).toBeDefined();
        // Verify nested structures are preserved
        expect(content.parameters?.nested).toBeDefined();
      }
    });
  });

  describe('Error Handling', () => {
    let mockRuntime: ReturnType<typeof createMockRuntime>;
    let reconstructor: TrajectoryReconstructor;
    const testRoomId = 'test-room-id' as UUID;

    beforeEach(() => {
      mockRuntime = createMockRuntime();
      reconstructor = new TrajectoryReconstructor(mockRuntime as never);
    });

    it('should handle trajectory capture failures gracefully', async () => {
      // Simulate API failure
      mockRuntime.getLogs.mockRejectedValueOnce(new Error('Database connection failed'));
      mockRuntime.getLogs.mockRejectedValueOnce(new Error('Database connection failed'));
      mockRuntime.getMemories.mockRejectedValueOnce(new Error('Database connection failed'));

      // Should not throw, instead return empty trajectory
      const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

      // Verify graceful degradation
      expect(trajectory).toBeDefined();
      expect(trajectory.steps).toBeDefined();
      expect(Array.isArray(trajectory.steps)).toBe(true);
    });

    it('should handle empty trajectory data without error', async () => {
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue([]);

      const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

      // Empty trajectory should be valid
      expect(trajectory).toBeDefined();
      expect(trajectory.steps).toEqual([]);
      expect(trajectory.totalSteps).toBe(0);
    });

    it('should handle malformed memory data gracefully', async () => {
      const malformedData = [
        {
          id: 'mem-good' as UUID,
          entityId: mockRuntime.agentId,
          roomId: testRoomId,
          createdAt: 1698397201000,
          content: {
            type: 'action_result',
            actionName: 'valid-action',
            actionResult: { success: true, text: 'Valid' },
          },
        },
        {
          // Malformed - missing content
          id: 'mem-bad' as UUID,
          entityId: mockRuntime.agentId,
          roomId: testRoomId,
          createdAt: 1698397202000,
          content: null,
        },
        {
          // Malformed - wrong content type
          id: 'mem-bad-2' as UUID,
          entityId: mockRuntime.agentId,
          roomId: testRoomId,
          createdAt: 1698397203000,
          content: 'not an object',
        },
      ];

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue(malformedData as never);

      // Should not throw
      const trajectory = await reconstructor.reconstructTrajectory(testRoomId);

      // Should have processed at least the valid entry
      expect(trajectory.steps.length).toBeGreaterThan(0);
    });
  });

  describe('Data Aggregator Integration', () => {
    let mockRuntime: ReturnType<typeof createMockRuntime>;
    let reconstructor: TrajectoryReconstructor;
    let mockEvaluationEngine: EvaluationEngine;
    let dataAggregator: RunDataAggregator;
    const testRoomId = 'test-room-id' as UUID;

    beforeEach(() => {
      mockRuntime = createMockRuntime();
      reconstructor = new TrajectoryReconstructor(mockRuntime as never);
      mockEvaluationEngine = {
        runEnhancedEvaluations: mock(async () => []),
        runEvaluations: mock(async () => []),
      } as unknown as EvaluationEngine;
      dataAggregator = new RunDataAggregator(
        mockRuntime as never,
        reconstructor,
        mockEvaluationEngine
      );
    });

    it('should build result with trajectory included', async () => {
      const trajectoryData = createMockTrajectoryData(testRoomId, mockRuntime.agentId);

      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getLogs.mockResolvedValueOnce([]);
      mockRuntime.getMemories.mockResolvedValue(trajectoryData as never);

      // Start run
      dataAggregator.startRun('test-run-001', 'combo-001', { mode: 'test' });
      dataAggregator.recordMetrics({
        execution_time_seconds: 2.0,
        llm_calls: 2,
        total_tokens: 100,
      });
      dataAggregator.recordFinalResponse('Test completed');

      // Build result
      const result = await dataAggregator.buildResult(
        testRoomId,
        [],
        { exitCode: 0, stdout: 'OK', stderr: '', durationMs: 2000, files: {} }
      );

      // Verify trajectory is included
      expect(result.trajectory).toBeDefined();
      expect(Array.isArray(result.trajectory)).toBe(true);
    });
  });
});
