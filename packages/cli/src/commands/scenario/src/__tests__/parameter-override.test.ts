import { describe, it, expect, beforeEach } from 'bun:test';
import {
  applyParameterOverrides,
  applyParameterOverride,
  applyMatrixOverrides,
  parseParameterPath,
  validateParameterPath,
  ParameterOverride,
  ParameterPath,
  ValidationResult,
} from '../parameter-override';

describe('Parameter Override System', () => {
  let baseScenario: any;

  beforeEach(() => {
    // Create a comprehensive base scenario object for testing
    baseScenario = {
      name: 'Base Test Scenario',
      description: 'A test scenario for parameter override testing',
      plugins: [
        { name: '@elizaos/plugin-bootstrap', enabled: true },
        { name: '@elizaos/plugin-sql', enabled: false, config: { apiKey: 'default-key' } },
      ],
      environment: {
        type: 'local',
        settings: {
          timeout: 5000,
          retry: 3,
        },
      },
      setup: {
        mocks: [
          {
            service: 'TestService',
            method: 'testMethod',
            response: { success: true, data: 'original' },
            metadata: { delay: 100 },
          },
        ],
        virtual_fs: {
          '/test/file.txt': 'original content',
        },
      },
      run: [
        {
          name: 'First step',
          input: 'original input',
          lang: 'javascript',
          code: "console.log('original');",
          evaluations: [
            { type: 'string_contains', value: 'original' },
            { type: 'llm_judge', prompt: 'original prompt', expected: 'yes' },
          ],
        },
        {
          name: 'Second step',
          input: 'second input',
          evaluations: [{ type: 'regex_match', pattern: 'test.*' }],
        },
      ],
      judgment: {
        strategy: 'all_pass',
      },
      character: {
        name: 'TestAgent',
        llm: {
          model: 'gpt-4',
          temperature: 0.7,
          max_tokens: 2000,
        },
        system_prompt: 'You are a test agent',
      },
    };
  });

  describe('Parameter Path Parsing', () => {
    it('should parse simple dot-notation paths', () => {
      const path = parseParameterPath('character.name');
      expect(path.segments).toEqual(['character', 'name']);
      expect(path.hasArrayAccess).toBe(false);
    });

    it('should parse nested dot-notation paths', () => {
      const path = parseParameterPath('character.llm.model');
      expect(path.segments).toEqual(['character', 'llm', 'model']);
      expect(path.hasArrayAccess).toBe(false);
    });

    it('should parse array access with bracket notation', () => {
      const path = parseParameterPath('run[0].input');
      expect(path.segments).toEqual(['run', 0, 'input']);
      expect(path.hasArrayAccess).toBe(true);
    });

    it('should parse nested array access', () => {
      const path = parseParameterPath('setup.mocks[0].response.success');
      expect(path.segments).toEqual(['setup', 'mocks', 0, 'response', 'success']);
      expect(path.hasArrayAccess).toBe(true);
    });

    it('should parse multiple array indices', () => {
      const path = parseParameterPath('run[1].evaluations[0].type');
      expect(path.segments).toEqual(['run', 1, 'evaluations', 0, 'type']);
      expect(path.hasArrayAccess).toBe(true);
    });

    it('should handle mixed array and object access', () => {
      const path = parseParameterPath('plugins[1].config.apiKey');
      expect(path.segments).toEqual(['plugins', 1, 'config', 'apiKey']);
      expect(path.hasArrayAccess).toBe(true);
    });

    it('should throw error for invalid bracket notation', () => {
      expect(() => parseParameterPath('run[invalid].input')).toThrow();
      expect(() => parseParameterPath('run[].input')).toThrow();
      expect(() => parseParameterPath('run[1.5].input')).toThrow();
    });

    it('should throw error for malformed paths', () => {
      expect(() => parseParameterPath('')).toThrow();
      expect(() => parseParameterPath('.')).toThrow();
      expect(() => parseParameterPath('.character')).toThrow();
      expect(() => parseParameterPath('character.')).toThrow();
    });
  });

  describe('Parameter Path Validation', () => {
    it('should validate existing simple paths', () => {
      const result1 = validateParameterPath(baseScenario, 'name');
      expect(result1.isValid).toBe(true);
      expect(result1.pathExists).toBe(true);
      expect(result1.targetType).toBe('string');

      const result2 = validateParameterPath(baseScenario, 'character.name');
      expect(result2.isValid).toBe(true);
      expect(result2.pathExists).toBe(true);
    });

    it('should validate existing nested paths', () => {
      const result1 = validateParameterPath(baseScenario, 'character.llm.model');
      expect(result1.isValid).toBe(true);
      expect(result1.pathExists).toBe(true);
      expect(result1.targetType).toBe('string');

      const result2 = validateParameterPath(baseScenario, 'environment.type');
      expect(result2.isValid).toBe(true);
      expect(result2.pathExists).toBe(true);
    });

    it('should validate existing array paths', () => {
      const result1 = validateParameterPath(baseScenario, 'plugins[0].name');
      expect(result1.isValid).toBe(true);
      expect(result1.pathExists).toBe(true);
      expect(result1.targetType).toBe('string');

      const result2 = validateParameterPath(baseScenario, 'run[0].input');
      expect(result2.isValid).toBe(true);
      expect(result2.pathExists).toBe(true);
    });

    it('should reject non-existing paths with detailed feedback', () => {
      const result1 = validateParameterPath(baseScenario, 'nonexistent');
      expect(result1.isValid).toBe(false);
      expect(result1.pathExists).toBe(false);
      expect(result1.error).toContain('does not exist');
      expect(result1.suggestion).toContain('Available properties');

      const result2 = validateParameterPath(baseScenario, 'plugins[10].name');
      expect(result2.isValid).toBe(false);
      expect(result2.pathExists).toBe(false);
      expect(result2.error).toContain('out of bounds');
      expect(result2.suggestion).toContain('index 0-');
    });

    it('should handle edge cases gracefully', () => {
      const result1 = validateParameterPath(null, 'test');
      expect(result1.isValid).toBe(false);
      expect(result1.pathExists).toBe(false);
      expect(result1.error).toContain('null or not an object');

      const result2 = validateParameterPath({}, 'test');
      expect(result2.isValid).toBe(false);
      expect(result2.pathExists).toBe(false);
      expect(result2.error).toContain('does not exist');
    });
  });

  describe('New API Functions (Ticket #5780)', () => {
    it('should test applyParameterOverride single function', () => {
      const scenario = {
        character: { llm: { model: 'gpt-4' } },
        run: [{ input: 'original' }],
      };

      // Test single parameter override
      const result = applyParameterOverride(scenario, 'character.llm.model', 'gpt-3.5-turbo');

      expect(result.character.llm.model).toBe('gpt-3.5-turbo');
      expect(scenario.character.llm.model).toBe('gpt-4'); // Original unchanged
    });

    it('should test applyMatrixOverrides batch function', () => {
      const scenario = {
        character: { llm: { model: 'gpt-4' } },
        run: [{ input: 'original' }],
      };

      const overrides = {
        'character.llm.model': 'gpt-3.5-turbo',
        'run[0].input': 'modified',
      };

      const result = applyMatrixOverrides(scenario, overrides);

      expect(result.character.llm.model).toBe('gpt-3.5-turbo');
      expect(result.run[0].input).toBe('modified');
      expect(scenario.character.llm.model).toBe('gpt-4'); // Original unchanged
    });

    it('should provide detailed validation feedback', () => {
      const scenario = { character: { name: 'Test' } };

      // Test valid path
      const validResult = validateParameterPath(scenario, 'character.name');
      expect(validResult.isValid).toBe(true);
      expect(validResult.targetType).toBe('string');
      expect(validResult.pathExists).toBe(true);

      // Test invalid path with suggestions
      const invalidResult = validateParameterPath(scenario, 'character.age');
      expect(invalidResult.isValid).toBe(false);
      expect(invalidResult.error).toContain('does not exist');
      expect(invalidResult.suggestion).toContain('Available properties: name');
    });
  });

  describe('Single Parameter Override', () => {
    it('should override simple string properties', () => {
      const overrides: ParameterOverride[] = [{ path: 'name', value: 'Modified Test Scenario' }];

      const result = applyParameterOverrides(baseScenario, overrides);
      expect(result.name).toBe('Modified Test Scenario');
      expect(result.description).toBe(baseScenario.description); // unchanged
    });

    it('should override nested object properties', () => {
      const overrides: ParameterOverride[] = [
        { path: 'character.llm.model', value: 'gpt-3.5-turbo' },
      ];

      const result = applyParameterOverrides(baseScenario, overrides);
      expect(result.character.llm.model).toBe('gpt-3.5-turbo');
      expect(result.character.llm.temperature).toBe(0.7); // unchanged
    });

    it('should override array elements', () => {
      const overrides: ParameterOverride[] = [{ path: 'run[0].input', value: 'modified input' }];

      const result = applyParameterOverrides(baseScenario, overrides);
      expect(result.run[0].input).toBe('modified input');
      expect(result.run[0].name).toBe('First step'); // unchanged
      expect(result.run[1].input).toBe('second input'); // unchanged
    });

    it('should override deeply nested properties', () => {
      const overrides: ParameterOverride[] = [
        { path: 'setup.mocks[0].response.data', value: 'modified data' },
      ];

      const result = applyParameterOverrides(baseScenario, overrides);
      expect(result.setup.mocks[0].response.data).toBe('modified data');
      expect(result.setup.mocks[0].response.success).toBe(true); // unchanged
    });

    it('should override with different data types', () => {
      const overrides: ParameterOverride[] = [
        { path: 'character.llm.temperature', value: 0.9 },
        { path: 'plugins[1].enabled', value: true },
        { path: 'environment.settings.retry', value: 5 },
        { path: 'setup.mocks[0].metadata', value: { delay: 500, retries: 3 } },
      ];

      const result = applyParameterOverrides(baseScenario, overrides);
      expect(result.character.llm.temperature).toBe(0.9);
      expect(result.plugins[1].enabled).toBe(true);
      expect(result.environment.settings.retry).toBe(5);
      expect(result.setup.mocks[0].metadata).toEqual({ delay: 500, retries: 3 });
    });
  });

  describe('Multiple Parameter Overrides', () => {
    it('should apply multiple overrides correctly', () => {
      const overrides: ParameterOverride[] = [
        { path: 'name', value: 'Multi-Override Test' },
        { path: 'character.llm.model', value: 'claude-3' },
        { path: 'character.llm.temperature', value: 0.1 },
        { path: 'run[0].input', value: 'first modified input' },
        { path: 'run[1].input', value: 'second modified input' },
      ];

      const result = applyParameterOverrides(baseScenario, overrides);
      expect(result.name).toBe('Multi-Override Test');
      expect(result.character.llm.model).toBe('claude-3');
      expect(result.character.llm.temperature).toBe(0.1);
      expect(result.run[0].input).toBe('first modified input');
      expect(result.run[1].input).toBe('second modified input');
    });

    it('should handle overlapping path overrides', () => {
      const overrides: ParameterOverride[] = [
        { path: 'character.llm', value: { model: 'new-model', temperature: 0.5 } },
        { path: 'character.llm.temperature', value: 0.8 }, // This should win
      ];

      const result = applyParameterOverrides(baseScenario, overrides);
      expect(result.character.llm.model).toBe('new-model');
      expect(result.character.llm.temperature).toBe(0.8); // Later override wins
    });
  });

  describe('Error Handling', () => {
    it('should throw error for invalid parameter paths', () => {
      const overrides: ParameterOverride[] = [{ path: 'nonexistent.path', value: 'test' }];

      expect(() => applyParameterOverrides(baseScenario, overrides)).toThrow(
        'Invalid parameter path'
      );
    });

    it('should throw error for out-of-bounds array access', () => {
      const overrides: ParameterOverride[] = [{ path: 'run[10].input', value: 'test' }];

      expect(() => applyParameterOverrides(baseScenario, overrides)).toThrow(
        'Array index out of bounds'
      );
    });

    it('should throw error for invalid array index', () => {
      const overrides: ParameterOverride[] = [{ path: 'run[invalid].input', value: 'test' }];

      expect(() => parseParameterPath('run[invalid].input')).toThrow('Invalid array index');
    });

    it('should provide helpful error messages', () => {
      const overrides: ParameterOverride[] = [{ path: 'character.nonexistent', value: 'test' }];

      try {
        applyParameterOverrides(baseScenario, overrides);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toContain('character.nonexistent');
      }
    });
  });

  describe('Immutability', () => {
    it('should not modify the original scenario object', () => {
      const originalName = baseScenario.name;
      const originalModel = baseScenario.character.llm.model;

      const overrides: ParameterOverride[] = [
        { path: 'name', value: 'Modified Name' },
        { path: 'character.llm.model', value: 'new-model' },
      ];

      applyParameterOverrides(baseScenario, overrides);

      // Original should be unchanged
      expect(baseScenario.name).toBe(originalName);
      expect(baseScenario.character.llm.model).toBe(originalModel);
    });

    it('should create deep copies of nested objects', () => {
      const overrides: ParameterOverride[] = [
        { path: 'setup.mocks[0].response.data', value: 'modified' },
      ];

      const result = applyParameterOverrides(baseScenario, overrides);

      // Modify the result - should not affect original
      result.setup.mocks[0].response.success = false;
      expect(baseScenario.setup.mocks[0].response.success).toBe(true);
    });
  });

  describe('Real-World Scenario Examples', () => {
    it('should handle matrix parameter combinations', () => {
      const combination1: ParameterOverride[] = [
        { path: 'character.llm.model', value: 'gpt-4-turbo' },
        { path: 'run[0].input', value: 'List open issues for elizaOS/eliza' },
      ];

      const combination2: ParameterOverride[] = [
        { path: 'character.llm.model', value: 'gpt-3.5-turbo' },
        { path: 'run[0].input', value: 'Find current issues for the elizaos/eliza repo' },
      ];

      const result1 = applyParameterOverrides(baseScenario, combination1);
      const result2 = applyParameterOverrides(baseScenario, combination2);

      expect(result1.character.llm.model).toBe('gpt-4-turbo');
      expect(result1.run[0].input).toBe('List open issues for elizaOS/eliza');

      expect(result2.character.llm.model).toBe('gpt-3.5-turbo');
      expect(result2.run[0].input).toBe('Find current issues for the elizaos/eliza repo');

      // Results should be independent
      expect(result1.character.llm.model).not.toBe(result2.character.llm.model);
    });

    it('should handle plugin configuration overrides', () => {
      const overrides: ParameterOverride[] = [
        { path: 'plugins[0].enabled', value: false },
        { path: 'plugins[1].config.apiKey', value: 'new-api-key' },
        { path: 'environment.type', value: 'e2b' },
      ];

      const result = applyParameterOverrides(baseScenario, overrides);
      expect(result.plugins[0].enabled).toBe(false);
      expect(result.plugins[1].config.apiKey).toBe('new-api-key');
      expect(result.environment.type).toBe('e2b');
    });

    it('should handle evaluation overrides', () => {
      const overrides: ParameterOverride[] = [
        { path: 'run[0].evaluations[0].value', value: 'modified' },
        { path: 'run[0].evaluations[1].prompt', value: 'modified prompt' },
        { path: 'run[1].evaluations[0].pattern', value: 'new.*pattern' },
      ];

      const result = applyParameterOverrides(baseScenario, overrides);
      expect(result.run[0].evaluations[0].value).toBe('modified');
      expect(result.run[0].evaluations[1].prompt).toBe('modified prompt');
      expect(result.run[1].evaluations[0].pattern).toBe('new.*pattern');
    });
  });

  describe('Edge Cases and Complex Scenarios', () => {
    it('should handle null and undefined values', () => {
      const overrides: ParameterOverride[] = [
        { path: 'description', value: null },
        { path: 'character.system_prompt', value: undefined },
      ];

      const result = applyParameterOverrides(baseScenario, overrides);
      expect(result.description).toBe(null);
      expect(result.character.system_prompt).toBe(undefined);
    });

    it('should handle empty arrays and objects', () => {
      const overrides: ParameterOverride[] = [
        { path: 'plugins', value: [] },
        { path: 'setup.virtual_fs', value: {} },
      ];

      const result = applyParameterOverrides(baseScenario, overrides);
      expect(result.plugins).toEqual([]);
      expect(result.setup.virtual_fs).toEqual({});
    });

    it('should handle complex nested structures', () => {
      const complexValue = {
        nested: {
          array: [1, 2, { deep: true }],
          object: { key: 'value' },
        },
      };

      const overrides: ParameterOverride[] = [
        { path: 'setup.mocks[0].response', value: complexValue },
      ];

      const result = applyParameterOverrides(baseScenario, overrides);
      expect(result.setup.mocks[0].response).toEqual(complexValue);
    });
  });
});
