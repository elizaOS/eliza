import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

/**
 * Safe Integration Tests for Ticket #5783
 * Tests the fallback mechanism in runEvaluationsWithFallback
 */
describe('Safe Integration with Fallback (Ticket #5783)', () => {
  let mockEvaluationEngine: any;
  let originalEnv: string | undefined;

  beforeEach(() => {
    // Store original environment
    originalEnv = process.env.ELIZA_ENHANCED_EVALUATIONS;

    // Mock evaluation engine
    mockEvaluationEngine = {
      runEvaluations: async (evaluations: any[], result: any) => {
        return [
          {
            success: true,
            message: 'Legacy evaluation passed',
          },
        ];
      },
      runEnhancedEvaluations: async (evaluations: any[], result: any) => {
        return [
          {
            evaluator_type: 'string_contains',
            success: true,
            summary: 'Enhanced evaluation passed',
            details: { expected: 'test', actual: 'test data' },
          },
        ];
      },
    };
  });

  afterEach(() => {
    // Restore original environment
    if (originalEnv !== undefined) {
      process.env.ELIZA_ENHANCED_EVALUATIONS = originalEnv;
    } else {
      delete process.env.ELIZA_ENHANCED_EVALUATIONS;
    }
  });

  /**
   * Mock version of runEvaluationsWithFallback for testing
   * (In real implementation, this is in packages/cli/src/commands/scenario/index.ts)
   */
  async function runEvaluationsWithFallback(
    evaluationEngine: any,
    evaluations: any[],
    result: any
  ) {
    const useEnhanced = process.env.ELIZA_ENHANCED_EVALUATIONS === 'true';

    if (!useEnhanced) {
      // Feature flag disabled - use original evaluations directly
      return await evaluationEngine.runEvaluations(evaluations, result);
    }

    try {
      // Attempt enhanced evaluations
      const enhancedResults = await evaluationEngine.runEnhancedEvaluations(evaluations, result);

      // Validate that we got proper structured results
      if (Array.isArray(enhancedResults) && enhancedResults.length > 0) {
        const firstResult = enhancedResults[0];
        if (
          firstResult &&
          typeof firstResult.evaluator_type === 'string' &&
          typeof firstResult.success === 'boolean' &&
          typeof firstResult.summary === 'string' &&
          typeof firstResult.details === 'object'
        ) {
          // Convert enhanced results back to legacy format for compatibility
          return enhancedResults.map((enhanced) => ({
            success: enhanced.success,
            message: enhanced.summary,
            // Store enhanced data for future use
            _enhanced: enhanced,
          }));
        }
      }

      // Enhanced results invalid - fall through to legacy
    } catch (error) {
      // Enhanced evaluations failed - fall back to legacy
    }

    // Fallback to original evaluation system
    return await evaluationEngine.runEvaluations(evaluations, result);
  }

  describe('Feature Flag Disabled', () => {
    beforeEach(() => {
      process.env.ELIZA_ENHANCED_EVALUATIONS = 'false';
    });

    it('should use legacy evaluations when feature flag is disabled', async () => {
      const evaluations = [{ type: 'string_contains', value: 'test' }];
      const result = { stdout: 'test data' };

      const output = await runEvaluationsWithFallback(mockEvaluationEngine, evaluations, result);

      expect(output).toHaveLength(1);
      expect(output[0].success).toBe(true);
      expect(output[0].message).toBe('Legacy evaluation passed');
      expect(output[0]._enhanced).toBeUndefined();
    });

    it('should use legacy evaluations when feature flag is unset', async () => {
      delete process.env.ELIZA_ENHANCED_EVALUATIONS;

      const evaluations = [{ type: 'string_contains', value: 'test' }];
      const result = { stdout: 'test data' };

      const output = await runEvaluationsWithFallback(mockEvaluationEngine, evaluations, result);

      expect(output).toHaveLength(1);
      expect(output[0].success).toBe(true);
      expect(output[0].message).toBe('Legacy evaluation passed');
      expect(output[0]._enhanced).toBeUndefined();
    });
  });

  describe('Feature Flag Enabled - Success Path', () => {
    beforeEach(() => {
      process.env.ELIZA_ENHANCED_EVALUATIONS = 'true';
    });

    it('should use enhanced evaluations when feature flag is enabled', async () => {
      const evaluations = [{ type: 'string_contains', value: 'test' }];
      const result = { stdout: 'test data' };

      const output = await runEvaluationsWithFallback(mockEvaluationEngine, evaluations, result);

      expect(output).toHaveLength(1);
      expect(output[0].success).toBe(true);
      expect(output[0].message).toBe('Enhanced evaluation passed');
      expect(output[0]._enhanced).toBeDefined();
      expect(output[0]._enhanced.evaluator_type).toBe('string_contains');
      expect(output[0]._enhanced.details.expected).toBe('test');
    });

    it('should convert enhanced results to legacy-compatible format', async () => {
      const evaluations = [{ type: 'string_contains', value: 'test' }];
      const result = { stdout: 'test data' };

      const output = await runEvaluationsWithFallback(mockEvaluationEngine, evaluations, result);

      expect(output).toHaveLength(1);
      // Legacy format requirements
      expect(output[0]).toHaveProperty('success');
      expect(output[0]).toHaveProperty('message');
      expect(typeof output[0].success).toBe('boolean');
      expect(typeof output[0].message).toBe('string');

      // Enhanced data preserved
      expect(output[0]._enhanced).toBeDefined();
      expect(output[0]._enhanced.evaluator_type).toBe('string_contains');
      expect(output[0]._enhanced.success).toBe(true);
      expect(output[0]._enhanced.summary).toBe('Enhanced evaluation passed');
    });
  });

  describe('Feature Flag Enabled - Fallback Scenarios', () => {
    beforeEach(() => {
      process.env.ELIZA_ENHANCED_EVALUATIONS = 'true';
    });

    it('should fallback to legacy when enhanced evaluations throw error', async () => {
      // Mock enhanced evaluations to throw error
      mockEvaluationEngine.runEnhancedEvaluations = async () => {
        throw new Error('Enhanced evaluation failed');
      };

      const evaluations = [{ type: 'string_contains', value: 'test' }];
      const result = { stdout: 'test data' };

      const output = await runEvaluationsWithFallback(mockEvaluationEngine, evaluations, result);

      expect(output).toHaveLength(1);
      expect(output[0].success).toBe(true);
      expect(output[0].message).toBe('Legacy evaluation passed');
      expect(output[0]._enhanced).toBeUndefined();
    });

    it('should fallback to legacy when enhanced results are invalid format', async () => {
      // Mock enhanced evaluations to return invalid format
      mockEvaluationEngine.runEnhancedEvaluations = async () => {
        return [{ invalid: 'format' }];
      };

      const evaluations = [{ type: 'string_contains', value: 'test' }];
      const result = { stdout: 'test data' };

      const output = await runEvaluationsWithFallback(mockEvaluationEngine, evaluations, result);

      expect(output).toHaveLength(1);
      expect(output[0].success).toBe(true);
      expect(output[0].message).toBe('Legacy evaluation passed');
      expect(output[0]._enhanced).toBeUndefined();
    });

    it('should fallback to legacy when enhanced results are empty', async () => {
      // Mock enhanced evaluations to return empty array
      mockEvaluationEngine.runEnhancedEvaluations = async () => {
        return [];
      };

      const evaluations = [{ type: 'string_contains', value: 'test' }];
      const result = { stdout: 'test data' };

      const output = await runEvaluationsWithFallback(mockEvaluationEngine, evaluations, result);

      expect(output).toHaveLength(1);
      expect(output[0].success).toBe(true);
      expect(output[0].message).toBe('Legacy evaluation passed');
      expect(output[0]._enhanced).toBeUndefined();
    });

    it('should fallback to legacy when enhanced results are not array', async () => {
      // Mock enhanced evaluations to return non-array
      mockEvaluationEngine.runEnhancedEvaluations = async () => {
        return { not: 'an array' };
      };

      const evaluations = [{ type: 'string_contains', value: 'test' }];
      const result = { stdout: 'test data' };

      const output = await runEvaluationsWithFallback(mockEvaluationEngine, evaluations, result);

      expect(output).toHaveLength(1);
      expect(output[0].success).toBe(true);
      expect(output[0].message).toBe('Legacy evaluation passed');
      expect(output[0]._enhanced).toBeUndefined();
    });

    it('should fallback to legacy when enhanced results have missing required fields', async () => {
      // Mock enhanced evaluations with missing fields
      mockEvaluationEngine.runEnhancedEvaluations = async () => {
        return [
          {
            evaluator_type: 'string_contains',
            success: true,
            // missing 'summary' and 'details'
          },
        ];
      };

      const evaluations = [{ type: 'string_contains', value: 'test' }];
      const result = { stdout: 'test data' };

      const output = await runEvaluationsWithFallback(mockEvaluationEngine, evaluations, result);

      expect(output).toHaveLength(1);
      expect(output[0].success).toBe(true);
      expect(output[0].message).toBe('Legacy evaluation passed');
      expect(output[0]._enhanced).toBeUndefined();
    });
  });

  describe('Multiple Evaluations', () => {
    beforeEach(() => {
      process.env.ELIZA_ENHANCED_EVALUATIONS = 'true';
    });

    it('should handle multiple enhanced evaluations correctly', async () => {
      // Mock multiple enhanced evaluations
      mockEvaluationEngine.runEnhancedEvaluations = async () => {
        return [
          {
            evaluator_type: 'string_contains',
            success: true,
            summary: 'String check passed',
            details: { expected: 'test', actual: 'test data' },
          },
          {
            evaluator_type: 'execution_time',
            success: false,
            summary: 'Execution too slow',
            details: { duration_ms: 1500, max_duration_ms: 1000 },
          },
        ];
      };

      const evaluations = [
        { type: 'string_contains', value: 'test' },
        { type: 'execution_time', max_duration_ms: 1000 },
      ];
      const result = { stdout: 'test data', durationMs: 1500 };

      const output = await runEvaluationsWithFallback(mockEvaluationEngine, evaluations, result);

      expect(output).toHaveLength(2);

      // First evaluation (success)
      expect(output[0].success).toBe(true);
      expect(output[0].message).toBe('String check passed');
      expect(output[0]._enhanced.evaluator_type).toBe('string_contains');

      // Second evaluation (failure)
      expect(output[1].success).toBe(false);
      expect(output[1].message).toBe('Execution too slow');
      expect(output[1]._enhanced.evaluator_type).toBe('execution_time');
    });
  });

  describe('Edge Cases', () => {
    it('should handle null/undefined evaluations gracefully', async () => {
      process.env.ELIZA_ENHANCED_EVALUATIONS = 'true';

      const evaluations: any[] = [];
      const result = { stdout: 'test data' };

      // Mock to return empty array for empty input
      mockEvaluationEngine.runEnhancedEvaluations = async () => [];
      mockEvaluationEngine.runEvaluations = async () => [];

      const output = await runEvaluationsWithFallback(mockEvaluationEngine, evaluations, result);

      expect(Array.isArray(output)).toBe(true);
      expect(output).toHaveLength(0);
    });

    it('should preserve original legacy behavior when fallback is used', async () => {
      process.env.ELIZA_ENHANCED_EVALUATIONS = 'true';

      // Mock enhanced to fail
      mockEvaluationEngine.runEnhancedEvaluations = async () => {
        throw new Error('Enhanced failed');
      };

      // Mock legacy to return complex result
      mockEvaluationEngine.runEvaluations = async () => {
        return [
          { success: true, message: 'First passed' },
          { success: false, message: 'Second failed' },
        ];
      };

      const evaluations = [
        { type: 'string_contains', value: 'test1' },
        { type: 'string_contains', value: 'test2' },
      ];
      const result = { stdout: 'test1 data' };

      const output = await runEvaluationsWithFallback(mockEvaluationEngine, evaluations, result);

      expect(output).toHaveLength(2);
      expect(output[0].success).toBe(true);
      expect(output[0].message).toBe('First passed');
      expect(output[1].success).toBe(false);
      expect(output[1].message).toBe('Second failed');

      // No enhanced data should be present
      expect(output[0]._enhanced).toBeUndefined();
      expect(output[1]._enhanced).toBeUndefined();
    });
  });
});
