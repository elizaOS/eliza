import { describe, it, expect } from 'bun:test';
import { validateMatrixConfig, type MatrixConfig, type MatrixAxis } from '../matrix-schema';

describe('Matrix Schema Validation', () => {
  describe('Valid Configuration Tests', () => {
    it('should validate a complete matrix configuration', () => {
      const validConfig = {
        name: 'GitHub Issue Action Chaining Analysis',
        description:
          'Tests the reliability of listing GitHub issues under various LLM and prompt configurations.',
        base_scenario:
          'packages/cli/src/commands/scenario/examples/test-github-issues.scenario.yaml',
        runs_per_combination: 3,
        matrix: [
          {
            parameter: 'character.llm.model',
            values: ['gpt-4-turbo', 'gpt-3.5-turbo'],
          },
          {
            parameter: 'run[0].input',
            values: [
              'List open issues for elizaOS/eliza',
              'Find current issues for the elizaos/eliza repo',
              "Show me what's open in the elizaOS/eliza GitHub.",
            ],
          },
        ],
      };

      const result = validateMatrixConfig(validConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('GitHub Issue Action Chaining Analysis');
        expect(result.data.matrix).toHaveLength(2);
        expect(result.data.runs_per_combination).toBe(3);
      }
    });

    it('should validate minimal required configuration', () => {
      const minimalConfig = {
        name: 'Simple Test',
        base_scenario: 'test.scenario.yaml',
        matrix: [
          {
            parameter: 'character.llm.model',
            values: ['gpt-4'],
          },
        ],
      };

      const result = validateMatrixConfig(minimalConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.runs_per_combination).toBe(1); // default value
        expect(result.data.description).toBeUndefined(); // optional field
      }
    });

    it('should validate complex parameter paths', () => {
      const configWithComplexPaths = {
        name: 'Complex Parameter Test',
        base_scenario: 'test.scenario.yaml',
        matrix: [
          {
            parameter: 'character.llm.model',
            values: ['gpt-4', 'claude-3'],
          },
          {
            parameter: 'run[0].input',
            values: ['prompt 1', 'prompt 2'],
          },
          {
            parameter: 'setup.mocks[0].response.success',
            values: [true, false],
          },
          {
            parameter: 'character.temperature',
            values: [0.1, 0.5, 0.9],
          },
        ],
      };

      const result = validateMatrixConfig(configWithComplexPaths);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.matrix).toHaveLength(4);
        expect(result.data.matrix[2].parameter).toBe('setup.mocks[0].response.success');
        expect(result.data.matrix[3].values).toEqual([0.1, 0.5, 0.9]);
      }
    });
  });

  describe('Validation Error Tests', () => {
    it('should reject configuration without required name field', () => {
      const invalidConfig = {
        base_scenario: 'test.scenario.yaml',
        matrix: [{ parameter: 'test', values: ['a'] }],
      };

      const result = validateMatrixConfig(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('name');
      }
    });

    it('should reject configuration without required base_scenario field', () => {
      const invalidConfig = {
        name: 'Test',
        matrix: [{ parameter: 'test', values: ['a'] }],
      };

      const result = validateMatrixConfig(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('base_scenario');
      }
    });

    it('should reject configuration without required matrix field', () => {
      const invalidConfig = {
        name: 'Test',
        base_scenario: 'test.scenario.yaml',
      };

      const result = validateMatrixConfig(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('matrix');
      }
    });

    it('should reject empty matrix array', () => {
      const invalidConfig = {
        name: 'Test',
        base_scenario: 'test.scenario.yaml',
        matrix: [],
      };

      const result = validateMatrixConfig(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least 1');
      }
    });

    it('should reject matrix axis without parameter field', () => {
      const invalidConfig = {
        name: 'Test',
        base_scenario: 'test.scenario.yaml',
        matrix: [
          {
            values: ['test'],
          },
        ],
      };

      const result = validateMatrixConfig(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('parameter');
      }
    });

    it('should reject matrix axis without values field', () => {
      const invalidConfig = {
        name: 'Test',
        base_scenario: 'test.scenario.yaml',
        matrix: [
          {
            parameter: 'test',
          },
        ],
      };

      const result = validateMatrixConfig(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('values');
      }
    });

    it('should reject matrix axis with empty values array', () => {
      const invalidConfig = {
        name: 'Test',
        base_scenario: 'test.scenario.yaml',
        matrix: [
          {
            parameter: 'test',
            values: [],
          },
        ],
      };

      const result = validateMatrixConfig(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least 1');
      }
    });

    it('should reject invalid runs_per_combination value', () => {
      const invalidConfig = {
        name: 'Test',
        base_scenario: 'test.scenario.yaml',
        runs_per_combination: 0,
        matrix: [{ parameter: 'test', values: ['a'] }],
      };

      const result = validateMatrixConfig(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('runs_per_combination');
      }
    });

    it('should reject negative runs_per_combination value', () => {
      const invalidConfig = {
        name: 'Test',
        base_scenario: 'test.scenario.yaml',
        runs_per_combination: -1,
        matrix: [{ parameter: 'test', values: ['a'] }],
      };

      const result = validateMatrixConfig(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('greater than or equal to 1');
      }
    });
  });

  describe('TypeScript Interface Tests', () => {
    it('should have correct TypeScript types for MatrixConfig', () => {
      const config: MatrixConfig = {
        name: 'Type Test',
        description: 'Optional description',
        base_scenario: 'test.scenario.yaml',
        runs_per_combination: 2,
        matrix: [
          {
            parameter: 'test.param',
            values: ['value1', 'value2', 123, true, { nested: 'object' }],
          },
        ],
      };

      // This test passes if the TypeScript compiler accepts the above without errors
      expect(config.name).toBe('Type Test');
      expect(config.matrix[0].values).toHaveLength(5);
    });

    it('should have correct TypeScript types for MatrixAxis', () => {
      const axis: MatrixAxis = {
        parameter: 'character.llm.model',
        values: ['gpt-4', 'claude-3', 42, true, null],
      };

      // This test passes if the TypeScript compiler accepts the above without errors
      expect(axis.parameter).toBe('character.llm.model');
      expect(axis.values).toHaveLength(5);
    });
  });

  describe('User-Friendly Error Messages', () => {
    it('should provide clear error messages for missing required fields', () => {
      const invalidConfig = {};

      const result = validateMatrixConfig(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessages = result.error.issues.map((issue: any) => issue.message);
        expect(errorMessages.some((msg: string) => msg.includes('Required'))).toBe(true);
      }
    });

    it('should provide clear error messages for invalid field types', () => {
      const invalidConfig = {
        name: 123, // should be string
        base_scenario: 'test.scenario.yaml',
        matrix: [{ parameter: 'test', values: ['a'] }],
      };

      const result = validateMatrixConfig(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        const nameError = result.error.issues.find((issue: any) => issue.path.includes('name'));
        expect(nameError?.message).toContain('string');
      }
    });

    it('should provide clear error messages for array constraint violations', () => {
      const invalidConfig = {
        name: 'Test',
        base_scenario: 'test.scenario.yaml',
        matrix: [
          {
            parameter: 'test',
            values: [], // empty array
          },
        ],
      };

      const result = validateMatrixConfig(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        const valuesError = result.error.issues.find((issue: any) => issue.path.includes('values'));
        expect(valuesError?.message).toContain('at least 1');
      }
    });
  });

  describe('Real-World Configuration Examples', () => {
    it('should validate the exact example from the ticket', () => {
      const ticketExample = {
        name: 'GitHub Issue Action Chaining Analysis',
        description:
          'Tests the reliability of listing GitHub issues under various LLM and prompt configurations.',
        base_scenario:
          'packages/cli/src/commands/scenario/examples/test-github-issues.scenario.yaml',
        runs_per_combination: 3,
        matrix: [
          {
            parameter: 'character.llm.model',
            values: ['gpt-4-turbo', 'gpt-3.5-turbo'],
          },
          {
            parameter: 'run[0].input',
            values: [
              'List open issues for elizaOS/eliza',
              'Find current issues for the elizaos/eliza repo',
              "Show me what's open in the elizaOS/eliza GitHub.",
            ],
          },
        ],
      };

      const result = validateMatrixConfig(ticketExample);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(ticketExample);
      }
    });

    it('should validate performance testing configuration', () => {
      const performanceConfig = {
        name: 'Performance Matrix Test',
        description: 'Test agent performance across different configurations',
        base_scenario: 'performance-test.scenario.yaml',
        runs_per_combination: 5,
        matrix: [
          {
            parameter: 'character.llm.model',
            values: ['gpt-4', 'gpt-3.5-turbo', 'claude-3'],
          },
          {
            parameter: 'character.temperature',
            values: [0.1, 0.5, 0.9],
          },
          {
            parameter: 'character.max_tokens',
            values: [1000, 2000, 4000],
          },
        ],
      };

      const result = validateMatrixConfig(performanceConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        // Should generate 3 * 3 * 3 = 27 combinations
        const combinations =
          result.data.matrix[0].values.length *
          result.data.matrix[1].values.length *
          result.data.matrix[2].values.length;
        expect(combinations).toBe(27);
      }
    });

    it('should validate plugin testing configuration', () => {
      const pluginConfig = {
        name: 'Plugin Compatibility Matrix',
        base_scenario: 'plugin-test.scenario.yaml',
        matrix: [
          {
            parameter: 'plugins[0].name',
            values: ['@elizaos/plugin-bootstrap', '@elizaos/plugin-sql'],
          },
          {
            parameter: 'plugins[0].enabled',
            values: [true, false],
          },
          {
            parameter: 'environment.type',
            values: ['local', 'e2b'],
          },
        ],
      };

      const result = validateMatrixConfig(pluginConfig);
      expect(result.success).toBe(true);
    });
  });
});
