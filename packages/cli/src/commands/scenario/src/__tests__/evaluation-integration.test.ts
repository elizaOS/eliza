import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EvaluationEngine } from '../EvaluationEngine';
import { ExecutionResult } from '../providers';

/**
 * Integration tests for backward compatibility and feature flag behavior
 */
describe('Evaluation Engine Integration (Ticket #5783)', () => {
  let mockRuntime: any;
  let engine: EvaluationEngine;
  let sampleExecutionResult: ExecutionResult;

  beforeEach(() => {
    // Mock runtime with minimal required functionality
    mockRuntime = {
      agentId: 'test-agent',
      getMemories: async () => [],
      getModel: (type: any) => ({ generate: async () => ({}) }),
      useModel: async () => ({ overall_success: true, confidence: 0.9, qualitative_summary: 'Test passed', capability_checklist: [] }),
      models: new Map()
    };

    engine = new EvaluationEngine(mockRuntime);

    sampleExecutionResult = {
      exitCode: 0,
      stdout: 'Hello, I am here to help you with your task.',
      stderr: '',
      files: { 'output.txt': 'file content' },
      startedAtMs: 1000,
      endedAtMs: 1500,
      durationMs: 500
    };

    // Clean environment for each test
    delete process.env.ELIZA_ENHANCED_EVALUATIONS;
  });

  afterEach(() => {
    delete process.env.ELIZA_ENHANCED_EVALUATIONS;
  });

  describe('Backward Compatibility', () => {
    it('should maintain existing runEvaluations behavior unchanged', async () => {
      const evaluation = {
        type: 'string_contains' as const,
        value: 'help',
        description: 'Check if response contains help'
      };

      const results = await engine.runEvaluations([evaluation], sampleExecutionResult);
      
      // Should maintain exact legacy behavior
      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('success');
      expect(results[0]).toHaveProperty('message');
      expect(typeof results[0].success).toBe('boolean');
      expect(typeof results[0].message).toBe('string');
      expect(results[0].success).toBe(true);
      expect(results[0].message).toContain('help');
    });

    it('should provide enhanced structure when feature flag is disabled (default)', async () => {
      const evaluation = {
        type: 'string_contains' as const,
        value: 'help',
        description: 'Check if response contains help'
      };

      // Default behavior (feature flag off)
      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);
      
      expect(results).toHaveLength(1);
      const result = results[0];
      
      // Should have enhanced structure but use legacy engine
      expect(result.evaluator_type).toBe('string_contains');
      expect(result.success).toBe(true);
      expect(result.summary).toContain('help');
      expect(result.details.legacy_result).toBeDefined();
      expect(result.details.legacy_result.success).toBe(true);
    });
  });

  describe('Enhanced Mode', () => {
    beforeEach(() => {
      process.env.ELIZA_ENHANCED_EVALUATIONS = 'true';
    });

    it('should use enhanced evaluations when feature flag is enabled', async () => {
      const evaluation = {
        type: 'string_contains' as const,
        value: 'help',
        description: 'Check if response contains help'
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);
      
      expect(results).toHaveLength(1);
      const result = results[0];
      
      // Should have full enhanced structure
      expect(result.evaluator_type).toBe('string_contains');
      expect(result.success).toBe(true);
      expect(result.summary).toContain('PASSED'); // Enhanced engine uses "PASSED"
      expect(result.details.expected_value).toBe('help');
      expect(result.details.actual_output).toBe(sampleExecutionResult.stdout);
      expect(result.details.case_sensitive).toBe(false);
      
      // Should NOT have legacy_result when using enhanced mode
      expect(result.details.legacy_result).toBeUndefined();
    });

    it('should provide rich details for execution time evaluator', async () => {
      const evaluation = {
        type: 'execution_time' as const,
        max_duration_ms: 1000,
        min_duration_ms: 100,
        target_duration_ms: 500,
        description: 'Check execution timing'
      };

      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);
      
      const result = results[0];
      expect(result.evaluator_type).toBe('execution_time');
      expect(result.success).toBe(true);
      expect(result.details.actual_duration_ms).toBe(500);
      expect(result.details.performance_rating).toBe(0); // Perfect match with target
      expect(result.details.timing_breakdown).toBeDefined();
    });

    it('should handle multiple evaluations correctly', async () => {
      const evaluations = [
        {
          type: 'string_contains' as const,
          value: 'help',
          description: 'Check for help'
        },
        {
          type: 'execution_time' as const,
          max_duration_ms: 1000,
          description: 'Check timing'
        }
      ];

      const results = await engine.runEnhancedEvaluations(evaluations, sampleExecutionResult);
      
      expect(results).toHaveLength(2);
      expect(results[0].evaluator_type).toBe('string_contains');
      expect(results[1].evaluator_type).toBe('execution_time');
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });
  });

  describe('Feature Flag Behavior', () => {
    it('should switch between modes based on environment variable', async () => {
      const evaluation = {
        type: 'string_contains' as const,
        value: 'help',
        description: 'Check if response contains help'
      };

      // Test with feature flag off
      process.env.ELIZA_ENHANCED_EVALUATIONS = 'false';
      const legacyResults = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);
      expect(legacyResults[0].details.legacy_result).toBeDefined();

      // Test with feature flag on
      process.env.ELIZA_ENHANCED_EVALUATIONS = 'true';
      const enhancedResults = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);
      expect(enhancedResults[0].details.legacy_result).toBeUndefined();
      expect(enhancedResults[0].summary).toContain('PASSED');
    });

    it('should handle invalid feature flag values gracefully', async () => {
      const evaluation = {
        type: 'string_contains' as const,
        value: 'help',
        description: 'Check if response contains help'
      };

      // Test with invalid value (should default to false)
      process.env.ELIZA_ENHANCED_EVALUATIONS = 'invalid';
      const results = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);
      expect(results[0].details.legacy_result).toBeDefined(); // Should use legacy mode
    });
  });

  describe('Error Handling', () => {
    it('should handle unknown evaluator types gracefully in both modes', async () => {
      const evaluation = {
        type: 'unknown_evaluator' as any,
        description: 'Test unknown type'
      };

      // Test legacy mode
      const legacyResults = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);
      expect(legacyResults[0].success).toBe(false);
      expect(legacyResults[0].evaluator_type).toBe('unknown_evaluator');

      // Test enhanced mode
      process.env.ELIZA_ENHANCED_EVALUATIONS = 'true';
      const enhancedResults = await engine.runEnhancedEvaluations([evaluation], sampleExecutionResult);
      expect(enhancedResults[0].success).toBe(false);
      expect(enhancedResults[0].evaluator_type).toBe('unknown_evaluator');
      expect(enhancedResults[0].details.error).toBe('evaluator_not_found');
    });
  });
});
