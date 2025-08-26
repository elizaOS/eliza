import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EnhancedEvaluationEngine } from '../EnhancedEvaluationEngine';
import { EnhancedEvaluationResult, LLMJudgeResult } from '../schema';
import { ExecutionResult } from '../providers';

/**
 * Comprehensive tests for Enhanced Evaluation Engine (Ticket #5783)
 *
 * These tests ensure the new structured JSON output works correctly
 * while maintaining backward compatibility.
 */
describe('Enhanced Evaluation Engine (Ticket #5783)', () => {
  let mockRuntime: any;
  let engine: EnhancedEvaluationEngine;
  let sampleExecutionResult: ExecutionResult;

  beforeEach(() => {
    // Mock runtime with minimal required functionality
    mockRuntime = {
      agentId: 'test-agent',
      getMemories: async () => [],
      getModel: (type: any) => ({ generate: async () => ({}) }),
      useModel: async () => ({
        overall_success: true,
        confidence: 0.9,
        qualitative_summary: 'Test passed',
        capability_checklist: [],
      }),
      models: new Map(),
    };

    engine = new EnhancedEvaluationEngine(mockRuntime);

    sampleExecutionResult = {
      exitCode: 0,
      stdout: 'Hello, I am here to help you with your task.',
      stderr: '',
      files: { 'output.txt': 'file content' },
      startedAtMs: 1000,
      endedAtMs: 1500,
      durationMs: 500,
    };
  });

  describe('Enhanced String Contains Evaluator', () => {
    it('should return structured success result for matching substring', async () => {
      const evaluation = {
        type: 'string_contains' as const,
        value: 'help',
        description: 'Check if response contains help',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      expect(results).toHaveLength(1);
      const result = results[0];

      expect(result.evaluator_type).toBe('string_contains');
      expect(result.success).toBe(true);
      expect(result.summary).toContain('PASSED');
      expect(result.summary).toContain('help');
      expect(result.details.expected_value).toBe('help');
      expect(result.details.actual_output).toBe(sampleExecutionResult.stdout);
      expect(result.details.case_sensitive).toBe(false);
    });

    it('should return structured failure result for non-matching substring', async () => {
      const evaluation = {
        type: 'string_contains' as const,
        value: 'nonexistent',
        description: 'Check for missing substring',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.success).toBe(false);
      expect(result.summary).toContain('FAILED');
      expect(result.summary).toContain('nonexistent');
      expect(result.details.expected_value).toBe('nonexistent');
    });

    it('should handle case sensitive search correctly', async () => {
      const evaluation = {
        type: 'string_contains' as const,
        value: 'HELP',
        case_sensitive: true,
        description: 'Case sensitive search',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.success).toBe(false); // 'HELP' not in 'help'
      expect(result.details.case_sensitive).toBe(true);
    });
  });

  describe('Enhanced Regex Match Evaluator', () => {
    it('should return structured result with match details', async () => {
      const evaluation = {
        type: 'regex_match' as const,
        pattern: 'h[ae]lp',
        description: 'Check regex pattern',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.evaluator_type).toBe('regex_match');
      expect(result.success).toBe(true);
      expect(result.details.pattern).toBe('h[ae]lp');
      expect(result.details.regex_flags).toBe('i');
      expect(result.details.matched_text).toBe('help');
      expect(typeof result.details.match_index).toBe('number');
    });

    it('should return structured failure for non-matching regex', async () => {
      const evaluation = {
        type: 'regex_match' as const,
        pattern: 'xyz123',
        description: 'Non-matching pattern',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.success).toBe(false);
      expect(result.details.match_found).toBe(null);
    });
  });

  describe('Enhanced File Exists Evaluator', () => {
    it('should return structured success for existing file', async () => {
      const evaluation = {
        type: 'file_exists' as const,
        path: 'output.txt',
        description: 'Check file creation',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.evaluator_type).toBe('file_exists');
      expect(result.success).toBe(true);
      expect(result.details.expected_path).toBe('output.txt');
      expect(result.details.created_files).toContain('output.txt');
      expect(result.details.matching_path).toBe('output.txt');
      expect(result.details.total_files_created).toBe(1);
    });

    it('should handle relative path variations', async () => {
      const executionWithRelativePath = {
        ...sampleExecutionResult,
        files: { './output.txt': 'content' },
      };

      const evaluation = {
        type: 'file_exists' as const,
        path: 'output.txt',
        description: 'Check relative path',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], executionWithRelativePath);

      const result = results[0];
      expect(result.success).toBe(true);
      expect(result.details.matching_path).toBe('./output.txt');
    });
  });

  describe('Enhanced Execution Time Evaluator', () => {
    it('should return structured success for timing within bounds', async () => {
      const evaluation = {
        type: 'execution_time' as const,
        max_duration_ms: 1000,
        min_duration_ms: 100,
        target_duration_ms: 500,
        description: 'Check execution timing',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.evaluator_type).toBe('execution_time');
      expect(result.success).toBe(true);
      expect(result.details.actual_duration_ms).toBe(500);
      expect(result.details.max_duration_ms).toBe(1000);
      expect(result.details.min_duration_ms).toBe(100);
      expect(result.details.target_duration_ms).toBe(500);
      expect(result.details.performance_rating).toBe(0); // Perfect match
    });

    it('should return structured failure for timing violations', async () => {
      const evaluation = {
        type: 'execution_time' as const,
        max_duration_ms: 300, // 500ms actual > 300ms max
        description: 'Too slow test',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.success).toBe(false);
      expect(result.summary).toContain('exceeded maximum');
      expect(result.details.actual_duration_ms).toBe(500);
    });

    it('should handle missing timing information gracefully', async () => {
      const executionWithoutTiming = {
        ...sampleExecutionResult,
        durationMs: undefined,
        startedAtMs: undefined,
        endedAtMs: undefined,
      };

      const evaluation = {
        type: 'execution_time' as const,
        max_duration_ms: 1000,
        description: 'Timing with missing data',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], executionWithoutTiming);

      const result = results[0];
      expect(result.success).toBe(false);
      expect(result.details.error).toBe('no_timing_data');
    });
  });

  describe('Enhanced Trajectory Contains Action Evaluator', () => {
    it('should return structured success when action is found', async () => {
      // Mock runtime with action memory
      mockRuntime.getMemories = async () => [
        {
          id: 'memory-1',
          type: 'messages',
          content: {
            type: 'action_result',
            actionName: 'TEST_ACTION',
            actionStatus: 'completed',
            result: 'Action succeeded',
          },
        },
      ];

      const evaluation = {
        type: 'trajectory_contains_action' as const,
        action: 'test_action', // Should match TEST_ACTION (normalized)
        description: 'Check action execution',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.evaluator_type).toBe('trajectory_contains_action');
      expect(result.success).toBe(true);
      expect(result.details.expected_action).toBe('test_action');
      expect(result.details.found_action).toBe('TEST_ACTION');
      expect(result.details.action_status).toBe('completed');
      expect(result.details.action_succeeded).toBe(true);
    });

    it('should return structured failure when action is not found', async () => {
      mockRuntime.getMemories = async () => []; // No actions

      const evaluation = {
        type: 'trajectory_contains_action' as const,
        action: 'missing_action',
        description: 'Check missing action',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.success).toBe(false);
      expect(result.summary).toContain('not found');
      expect(result.details.expected_action).toBe('missing_action');
      expect(result.details.actions_found).toEqual([]);
    });
  });

  describe('Enhanced LLM Judge Evaluator', () => {
    beforeEach(() => {
      // Mock successful LLM response
      mockRuntime.useModel = async () => ({
        qualitative_summary:
          'The agent successfully completed the task with excellent reasoning and clear output formatting.',
        capability_checklist: [
          {
            capability: 'Task Understanding',
            achieved: true,
            reasoning: 'Agent correctly interpreted the user request',
          },
          {
            capability: 'Output Quality',
            achieved: true,
            reasoning: 'Response was well-formatted and informative',
          },
        ],
        confidence: 0.85,
        overall_success: true,
      });
    });

    it('should return structured LLM judgment with qualitative analysis', async () => {
      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Does the agent provide helpful assistance?',
        expected: 'yes',
        description: 'LLM quality assessment',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.evaluator_type).toBe('llm_judge');
      expect(result.success).toBe(true);
      expect(result.summary).toContain('PASSED');

      // Check LLMJudgeResult details structure
      const details = result.details as any;
      expect(details.llm_judge_result.qualitative_summary).toContain('successfully completed');
      expect(details.llm_judge_result.capability_checklist).toHaveLength(2);
      expect(details.llm_judge_result.capability_checklist[0].capability).toBe(
        'Task Understanding'
      );
      expect(details.llm_judge_result.capability_checklist[0].achieved).toBe(true);
      expect(details.llm_judge_result.capability_checklist[0].reasoning).toContain(
        'correctly interpreted'
      );
    });

    it('should handle LLM errors gracefully', async () => {
      mockRuntime.useModel = async () => {
        throw new Error('Model unavailable');
      };

      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Test question',
        expected: 'yes',
        description: 'Error handling test',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.success).toBe(false);
      expect(result.summary).toContain('FAILED');
      expect(result.details.error).toBe('llm_error');
      expect(result.details.error_message).toContain('Model unavailable');
    });

    it('should handle LLM timeout gracefully', async () => {
      // Mock timeout by making useModel hang
      mockRuntime.useModel = async () => {
        await new Promise((resolve) => setTimeout(resolve, 20000)); // Long delay
        return {};
      };

      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Test timeout',
        expected: 'yes',
        description: 'Timeout test',
      };

      // Override timeout for test
      process.env.LLM_JUDGE_TIMEOUT_MS = '100';

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.success).toBe(false);
      expect(result.summary).toContain('Timed out');
      expect(result.details.error).toBe('llm_timeout');

      // Restore timeout
      delete process.env.LLM_JUDGE_TIMEOUT_MS;
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle unknown evaluator types gracefully', async () => {
      const evaluation = {
        type: 'unknown_evaluator' as any,
        description: 'Test unknown type',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.evaluator_type).toBe('unknown_evaluator');
      expect(result.success).toBe(false);
      expect(result.summary).toContain('Unknown evaluator type');
      expect(result.details.error).toBe('evaluator_not_found');
      expect(result.details.available_types).toContain('string_contains');
    });

    it('should handle evaluator execution failures', async () => {
      // Force an error by passing invalid parameters
      const evaluation = {
        type: 'string_contains' as const,
        // Missing required 'value' field to trigger error
        description: 'Error test',
      } as any;

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      const result = results[0];
      expect(result.success).toBe(false);
      expect(result.summary).toContain('failed with error');
      expect(result.details.error).toBe('evaluator_execution_failed');
    });

    it('should process multiple evaluations correctly', async () => {
      const evaluations = [
        {
          type: 'string_contains' as const,
          value: 'help',
          description: 'First evaluation',
        },
        {
          type: 'file_exists' as const,
          path: 'output.txt',
          description: 'Second evaluation',
        },
      ];

      const results = await engine.runEnhancedEvaluations(evaluations, sampleExecutionResult);

      expect(results).toHaveLength(2);
      expect(results[0].evaluator_type).toBe('string_contains');
      expect(results[1].evaluator_type).toBe('file_exists');
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });
  });

  describe('Interface Compliance', () => {
    it('should return EnhancedEvaluationResult interface compliant results', async () => {
      const evaluation = {
        type: 'string_contains' as const,
        value: 'test',
        description: 'Interface test',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);
      const result = results[0];

      // Verify all required fields are present
      expect(typeof result.evaluator_type).toBe('string');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.summary).toBe('string');
      expect(typeof result.details).toBe('object');
      expect(result.details).not.toBe(null);

      // Verify the result satisfies the EnhancedEvaluationResult interface
      const validResult: EnhancedEvaluationResult = result;
      expect(validResult).toBeDefined();
    });

    it('should provide comprehensive details for debugging', async () => {
      const evaluation = {
        type: 'execution_time' as const,
        max_duration_ms: 1000,
        min_duration_ms: 100,
        target_duration_ms: 500,
        description: 'Detailed test',
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);
      const result = results[0];

      // Verify rich details are provided
      expect(result.details.actual_duration_ms).toBeDefined();
      expect(result.details.timing_breakdown).toBeDefined();
      expect(result.details.performance_rating).toBeDefined();
      expect(Object.keys(result.details).length).toBeGreaterThan(5);
    });
  });
});
