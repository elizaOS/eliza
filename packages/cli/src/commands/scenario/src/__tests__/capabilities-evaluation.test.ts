import { describe, it, expect, beforeEach } from 'bun:test';
import { EnhancedEvaluationEngine } from '../EnhancedEvaluationEngine';
import { ExecutionResult } from '../providers';

/**
 * Tests for ticket #5784: Implement Scenario Capability Definitions
 * Tests dynamic capabilities injection into LLM Judge evaluator
 */
describe('LLM Judge Capabilities Feature (Ticket #5784)', () => {
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
        qualitative_summary:
          'Agent successfully completed the task with custom capabilities assessment',
        capability_checklist: [
          {
            capability: 'Custom Capability 1',
            achieved: true,
            reasoning: 'Successfully demonstrated this custom capability',
          },
          {
            capability: 'Custom Capability 2',
            achieved: false,
            reasoning: 'Did not fully achieve this custom capability',
          },
        ],
      }),
      models: new Map(),
    };

    engine = new EnhancedEvaluationEngine(mockRuntime);

    sampleExecutionResult = {
      exitCode: 0,
      stdout:
        'Task completed with GitHub issues: Issue #1: Bug fix needed, Issue #2: Feature request',
      stderr: '',
      files: {},
      startedAtMs: 1000,
      endedAtMs: 1500,
      durationMs: 500,
    };
  });

  describe('Schema Extension for Capabilities', () => {
    it('should accept capabilities array in llm_judge evaluation', async () => {
      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Evaluate the agent response',
        expected: 'yes',
        capabilities: [
          'Understands the multi-step nature of the request (list AND summarize)',
          'Successfully retrieves the list of GitHub issues',
          'Provides an accurate and concise summary of the issues',
          'Formats the final response in a clean, readable manner',
        ],
      };

      // Should not throw validation error
      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      expect(results).toHaveLength(1);
      expect(results[0].evaluator_type).toBe('llm_judge');
      expect(results[0].success).toBe(true);
    });

    it('should work without capabilities array (backward compatibility)', async () => {
      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Evaluate the agent response',
        expected: 'yes',
        // No capabilities array - should use defaults
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      expect(results).toHaveLength(1);
      expect(results[0].evaluator_type).toBe('llm_judge');
      expect(results[0].success).toBe(true);
    });

    it('should validate capabilities array is non-empty if provided', async () => {
      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Evaluate the agent response',
        expected: 'yes',
        capabilities: [], // Empty array should be invalid
      };

      // Should return failed result for empty capabilities
      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].summary).toContain('Invalid capabilities');
      expect(results[0].summary).toContain('must not be empty');
    });

    it('should validate capabilities array contains only strings', async () => {
      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Evaluate the agent response',
        expected: 'yes',
        capabilities: [
          'Valid capability',
          42, // Invalid: number instead of string
          'Another valid capability',
        ] as any, // Cast to any to bypass TypeScript but still test runtime validation
      };

      // Should return failed result for non-string capability
      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].summary).toContain('Invalid capabilities');
      expect(results[0].summary).toContain('string');
    });
  });

  describe('Dynamic Prompt Injection', () => {
    it('should include custom capabilities in the LLM prompt', async () => {
      const customCapabilities = [
        'Understands the multi-step nature of the request',
        'Successfully retrieves GitHub issues',
        'Provides accurate summary',
        'Formats response cleanly',
      ];

      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Evaluate the agent response',
        expected: 'yes',
        capabilities: customCapabilities,
      };

      // Mock the LLM call to capture the prompt
      let capturedPrompt = '';
      mockRuntime.useModel = async (modelType: any, params: any) => {
        capturedPrompt = params.prompt;
        return {
          overall_success: true,
          confidence: 0.9,
          qualitative_summary: 'Test response',
          capability_checklist: customCapabilities.map((cap) => ({
            capability: cap,
            achieved: true,
            reasoning: 'Test reasoning',
          })),
        };
      };

      await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      // Verify custom capabilities are injected into prompt
      expect(capturedPrompt).toContain('Understands the multi-step nature of the request');
      expect(capturedPrompt).toContain('Successfully retrieves GitHub issues');
      expect(capturedPrompt).toContain('Provides accurate summary');
      expect(capturedPrompt).toContain('Formats response cleanly');

      // Should contain numbered list format
      expect(capturedPrompt).toContain('1.');
      expect(capturedPrompt).toContain('2.');
      expect(capturedPrompt).toContain('3.');
      expect(capturedPrompt).toContain('4.');
    });

    it('should use default capabilities when none provided', async () => {
      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Evaluate the agent response',
        expected: 'yes',
        // No capabilities - should use defaults
      };

      let capturedPrompt = '';
      mockRuntime.useModel = async (modelType: any, params: any) => {
        capturedPrompt = params.prompt;
        return {
          overall_success: true,
          confidence: 0.9,
          qualitative_summary: 'Test response',
          capability_checklist: [
            {
              capability: 'Default Task Completion',
              achieved: true,
              reasoning: 'Default assessment',
            },
          ],
        };
      };

      await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      // Should contain default capabilities in prompt
      expect(capturedPrompt).toContain('Task Completion');
      expect(capturedPrompt).toContain('Response Quality');
      expect(capturedPrompt).toContain('User Intent Understanding');
    });
  });

  describe('Enhanced Result Format', () => {
    it('should return structured result with custom capabilities assessment', async () => {
      const customCapabilities = [
        'Multi-step task understanding',
        'Data retrieval accuracy',
        'Summary quality',
      ];

      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Evaluate the agent response',
        expected: 'yes',
        capabilities: customCapabilities,
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);
      const result = results[0];

      // Verify structured result format
      expect(result.evaluator_type).toBe('llm_judge');
      expect(result.success).toBe(true);
      expect(result.summary).toContain('Agent successfully completed');

      // Verify details contain LLM judge specific information
      expect(result.details.llm_judge_result).toBeDefined();
      expect(result.details.llm_judge_result.qualitative_summary).toBeDefined();
      expect(result.details.llm_judge_result.capability_checklist).toBeDefined();
      expect(Array.isArray(result.details.llm_judge_result.capability_checklist)).toBe(true);
    });

    it('should include custom capabilities in capability checklist result', async () => {
      const customCapabilities = ['Custom Capability A', 'Custom Capability B'];

      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Test prompt',
        expected: 'yes',
        capabilities: customCapabilities,
      };

      mockRuntime.useModel = async () => ({
        overall_success: true,
        confidence: 0.9,
        qualitative_summary: 'Custom assessment completed',
        capability_checklist: [
          {
            capability: 'Custom Capability A',
            achieved: true,
            reasoning: 'Successfully demonstrated capability A',
          },
          {
            capability: 'Custom Capability B',
            achieved: false,
            reasoning: 'Partially demonstrated capability B',
          },
        ],
      });

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);
      const checklist = results[0].details.llm_judge_result.capability_checklist;

      expect(checklist).toHaveLength(2);
      expect(checklist[0].capability).toBe('Custom Capability A');
      expect(checklist[0].achieved).toBe(true);
      expect(checklist[1].capability).toBe('Custom Capability B');
      expect(checklist[1].achieved).toBe(false);
    });
  });

  describe('Integration with Evaluation Engine', () => {
    it('should pass capabilities from scenario to LLM Judge evaluator', async () => {
      const evaluations = [
        {
          type: 'llm_judge' as const,
          prompt: 'Evaluate response quality',
          expected: 'yes',
          capabilities: ['Request understanding', 'Data accuracy', 'Response formatting'],
        },
      ];

      const results = await engine.runEnhancedEvaluations(evaluations, sampleExecutionResult);

      expect(results).toHaveLength(1);
      expect(results[0].evaluator_type).toBe('llm_judge');
      expect(results[0].success).toBe(true);

      // Verify the evaluation was processed with custom capabilities
      const details = results[0].details;
      expect(details.custom_capabilities_provided).toBe(true);
      expect(details.capabilities_count).toBe(3);
    });
  });

  describe('Error Handling', () => {
    it('should handle LLM errors gracefully with custom capabilities', async () => {
      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Test prompt',
        expected: 'yes',
        capabilities: ['Test capability'],
      };

      mockRuntime.useModel = async () => {
        throw new Error('LLM service unavailable');
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      expect(results[0].success).toBe(false);
      expect(results[0].summary).toContain('LLM service unavailable');
      expect(results[0].details.error_type).toBe('llm_error');
    });

    it('should handle malformed LLM response with custom capabilities', async () => {
      const evaluation = {
        type: 'llm_judge' as const,
        prompt: 'Test prompt',
        expected: 'yes',
        capabilities: ['Test capability'],
      };

      mockRuntime.useModel = async () => ({
        // Missing required fields
        incomplete: 'response',
      });

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);

      expect(results[0].success).toBe(false);
      expect(results[0].summary).toContain('Invalid LLM response');
      expect(results[0].details.error_type).toBe('llm_parse_error');
    });
  });
});
