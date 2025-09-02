import { type IAgentRuntime } from '@elizaos/core';
import { TestSuite } from '../utils/test-suite';
import { RunDataAggregator } from '../../src/data-aggregator';
import { TrajectoryReconstructor } from '../../src/TrajectoryReconstructor';
import { EvaluationEngine } from '../../src/EvaluationEngine';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * E2E Test for Centralized Data Serialization (Ticket #5786)
 *
 * This test validates that the RunDataAggregator correctly collects data
 * from a live agent runtime and produces the expected JSON structure.
 */
export default class CentralizedDataTestSuite extends TestSuite {
  public name = 'Centralized Data Serialization E2E Test';

  public tests = {
    'Should aggregate data from live runtime and produce valid ScenarioRunResult': async (
      runtime: IAgentRuntime
    ) => {
      // Arrange: Set up the data aggregator with live components
      const trajectoryReconstructor = new TrajectoryReconstructor(runtime);
      const evaluationEngine = new EvaluationEngine();
      const aggregator = new RunDataAggregator(runtime, trajectoryReconstructor, evaluationEngine);

      // Create a test room for isolation
      const roomId = 'e2e-centralized-data-test';

      // Start a run with matrix parameters
      const runId = 'e2e-test-run-001';
      const combinationId = 'e2e-combo-001';
      const parameters = {
        'character.llm.model': 'gpt-4',
        'run[0].input': 'List the open issues for elizaOS/eliza repository',
      };

      aggregator.startRun(runId, combinationId, parameters);

      // Act: Simulate agent interaction
      const userMessage = {
        roomId,
        content: { text: 'List the open issues for elizaOS/eliza repository' },
        agentId: runtime.agentId,
        userId: 'test-user',
        createdAt: Date.now(),
      };

      // Process the message through the live runtime
      const startTime = Date.now();
      await runtime.handleMessage(userMessage);
      const endTime = Date.now();

      // Record metrics based on the actual execution
      aggregator.recordMetrics({
        execution_time_seconds: (endTime - startTime) / 1000,
        llm_calls: 1, // Mock value - in real scenario this would be tracked
        total_tokens: 500, // Mock value
      });

      // Get the agent's response from memory
      const memories = await runtime.getMemories({
        roomId,
        count: 10,
        unique: false,
      });

      const agentResponse = memories.find(
        (m) =>
          m.agentId === runtime.agentId &&
          m.content &&
          typeof m.content === 'object' &&
          (m.content as any).text
      );

      this.expect(agentResponse).toBeDefined();

      if (agentResponse) {
        aggregator.recordFinalResponse((agentResponse.content as any).text);
      }

      // Set up evaluations
      const evaluations = [
        {
          type: 'string_contains' as const,
          value: 'issues',
          case_sensitive: false,
        },
        {
          type: 'trajectory_contains_action' as const,
          action: 'LIST_GITHUB_ISSUES',
        },
      ];

      const mockExecutionResult = {
        exitCode: 0,
        stdout: agentResponse ? (agentResponse.content as any).text : '',
        stderr: '',
        durationMs: endTime - startTime,
      };

      // Act: Build the final result
      const result = await aggregator.buildResult(roomId, evaluations, mockExecutionResult);

      // Assert: Validate the ScenarioRunResult structure
      this.expect(result.run_id).toBe(runId);
      this.expect(result.matrix_combination_id).toBe(combinationId);
      this.expect(result.parameters).toEqual(parameters);

      // Validate metrics
      this.expect(result.metrics).toBeDefined();
      this.expect(typeof result.metrics.execution_time_seconds).toBe('number');
      this.expect(result.metrics.execution_time_seconds).toBeGreaterThan(0);

      // Validate evaluations
      this.expect(Array.isArray(result.evaluations)).toBe(true);
      this.expect(result.evaluations.length).toBeGreaterThan(0);

      // Each evaluation should have the required structure
      result.evaluations.forEach((evaluation) => {
        this.expect(typeof evaluation.evaluator_type).toBe('string');
        this.expect(typeof evaluation.success).toBe('boolean');
        this.expect(typeof evaluation.summary).toBe('string');
        this.expect(typeof evaluation.details).toBe('object');
      });

      // Validate trajectory
      this.expect(Array.isArray(result.trajectory)).toBe(true);

      // Each trajectory step should have the required structure
      result.trajectory.forEach((step) => {
        this.expect(['thought', 'action', 'observation']).toContain(step.type);
        this.expect(typeof step.timestamp).toBe('string');
        this.expect(step.content).toBeDefined();

        // Validate ISO timestamp format
        this.expect(() => new Date(step.timestamp).toISOString()).not.toThrow();
      });

      // Validate final response
      this.expect(typeof result.final_agent_response).toBe('string');
      this.expect(result.final_agent_response.length).toBeGreaterThan(0);

      // Error should be null for successful run
      this.expect(result.error).toBeNull();

      // Additional validation: Ensure JSON serialization works
      const jsonString = JSON.stringify(result, null, 2);
      this.expect(jsonString.length).toBeGreaterThan(100);

      // Ensure it can be parsed back
      const parsedResult = JSON.parse(jsonString);
      this.expect(parsedResult.run_id).toBe(runId);
    },

    'Should handle failed runs with error field populated': async (runtime: IAgentRuntime) => {
      // Arrange: Set up aggregator for a failed run
      const trajectoryReconstructor = new TrajectoryReconstructor(runtime);
      const evaluationEngine = new EvaluationEngine();
      const aggregator = new RunDataAggregator(runtime, trajectoryReconstructor, evaluationEngine);

      const runId = 'e2e-failed-run-001';
      const combinationId = 'e2e-failed-combo-001';
      const parameters = { 'invalid.parameter': 'should-cause-error' };

      aggregator.startRun(runId, combinationId, parameters);

      // Simulate an error during execution
      const testError = new Error('Simulated runtime error for testing');
      aggregator.recordError(testError);

      // Record minimal metrics
      aggregator.recordMetrics({
        execution_time_seconds: 1.0,
        llm_calls: 0,
        total_tokens: 0,
      });

      const roomId = 'e2e-failed-test-room';
      const evaluations: any[] = []; // No evaluations for failed run
      const executionResult = {
        exitCode: 1,
        stdout: '',
        stderr: 'Simulated error occurred',
        durationMs: 1000,
      };

      // Act: Build result for failed run
      const result = await aggregator.buildResult(roomId, evaluations, executionResult);

      // Assert: Validate error handling
      this.expect(result.run_id).toBe(runId);
      this.expect(result.error).toBe('Simulated runtime error for testing');
      this.expect(result.evaluations).toEqual([]);
      this.expect(result.metrics.execution_time_seconds).toBe(1.0);

      // Final response should be undefined for failed run
      this.expect(result.final_agent_response).toBeUndefined();
    },

    'Should serialize result to JSON file with correct naming pattern': async (
      runtime: IAgentRuntime
    ) => {
      // Arrange: Set up a complete run
      const trajectoryReconstructor = new TrajectoryReconstructor(runtime);
      const evaluationEngine = new EvaluationEngine();
      const aggregator = new RunDataAggregator(runtime, trajectoryReconstructor, evaluationEngine);

      const runId = 'e2e-file-test-001';
      const combinationId = 'e2e-file-combo-001';
      const parameters = { 'test.param': 'file-test-value' };

      aggregator.startRun(runId, combinationId, parameters);
      aggregator.recordFinalResponse('Test response for file serialization');
      aggregator.recordMetrics({
        execution_time_seconds: 2.5,
        llm_calls: 1,
        total_tokens: 250,
      });

      const roomId = 'e2e-file-test-room';
      const evaluations = [
        {
          type: 'string_contains' as const,
          value: 'test',
          case_sensitive: false,
        },
      ];
      const executionResult = {
        exitCode: 0,
        stdout: 'Test response for file serialization',
        stderr: '',
        durationMs: 2500,
      };

      const result = await aggregator.buildResult(roomId, evaluations, executionResult);

      // Act: Serialize to file
      const outputDir = '/tmp/e2e-test-output';
      await fs.mkdir(outputDir, { recursive: true });

      const filename = `run-${runId}.json`;
      const filepath = path.join(outputDir, filename);

      await fs.writeFile(filepath, JSON.stringify(result, null, 2));

      // Assert: Verify file was created with correct content
      const fileExists = await fs
        .access(filepath)
        .then(() => true)
        .catch(() => false);
      this.expect(fileExists).toBe(true);

      const fileContent = await fs.readFile(filepath, 'utf-8');
      const parsedContent = JSON.parse(fileContent);

      this.expect(parsedContent.run_id).toBe(runId);
      this.expect(parsedContent.matrix_combination_id).toBe(combinationId);
      this.expect(parsedContent.parameters).toEqual(parameters);

      // Verify pretty-printing (should have indentation)
      this.expect(fileContent).toContain('  "run_id":');
      this.expect(fileContent).toContain('  "matrix_combination_id":');

      // Cleanup
      await fs.unlink(filepath).catch(() => {}); // Ignore cleanup errors
    },
  };
}
