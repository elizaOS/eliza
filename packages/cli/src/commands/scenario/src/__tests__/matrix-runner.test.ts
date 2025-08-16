import { describe, it, expect, beforeEach } from 'bun:test';
import {
  generateMatrixCombinations,
  createRuntimeConfig,
  createExecutionContext,
  filterCombinations,
  calculateExecutionStats,
  formatDuration,
} from '../matrix-runner';
import { MatrixConfig } from '../matrix-schema';

describe('Matrix Runner', () => {
  let basicConfig: MatrixConfig;
  let complexConfig: MatrixConfig;

  beforeEach(() => {
    basicConfig = {
      name: 'Basic Test Matrix',
      description: 'A simple test matrix',
      base_scenario: 'test.scenario.yaml',
      runs_per_combination: 1,
      matrix: [
        {
          parameter: 'character.llm.model',
          values: ['gpt-4', 'gpt-3.5-turbo'],
        },
        {
          parameter: 'run[0].input',
          values: ['Hello', 'Hi'],
        },
      ],
    };

    complexConfig = {
      name: 'Complex Test Matrix',
      base_scenario: 'complex.scenario.yaml',
      runs_per_combination: 3,
      matrix: [
        {
          parameter: 'character.llm.model',
          values: ['gpt-4', 'gpt-3.5-turbo', 'claude-3'],
        },
        {
          parameter: 'run[0].input',
          values: ['Hello', 'Hi', 'Hey'],
        },
        {
          parameter: 'environment.type',
          values: ['local', 'e2b'],
        },
      ],
    };
  });

  describe('generateMatrixCombinations', () => {
    it('should generate correct number of combinations for basic matrix', () => {
      const combinations = generateMatrixCombinations(basicConfig);

      // 2 models × 2 inputs = 4 combinations
      expect(combinations).toHaveLength(4);
    });

    it('should generate correct number of combinations for complex matrix', () => {
      const combinations = generateMatrixCombinations(complexConfig);

      // 3 models × 3 inputs × 2 environments = 18 combinations
      expect(combinations).toHaveLength(18);
    });

    it('should generate combinations with proper structure', () => {
      const combinations = generateMatrixCombinations(basicConfig);

      combinations.forEach((combo, index) => {
        // Each combination should have required properties
        expect(combo).toHaveProperty('id');
        expect(combo).toHaveProperty('parameters');
        expect(combo).toHaveProperty('metadata');

        // ID should be unique and follow pattern
        expect(combo.id).toMatch(/^combo-\d{3}-[a-f0-9]+$/);

        // Parameters should contain all matrix dimensions
        expect(Object.keys(combo.parameters)).toContain('character.llm.model');
        expect(Object.keys(combo.parameters)).toContain('run[0].input');

        // Metadata should be correct
        expect(combo.metadata.combinationIndex).toBe(index);
        expect(combo.metadata.totalCombinations).toBe(4);
        expect(combo.metadata.runIndex).toBeUndefined(); // Not set during generation
      });
    });

    it('should generate all possible parameter combinations', () => {
      const combinations = generateMatrixCombinations(basicConfig);

      // Collect all parameter values to verify completeness
      const modelValues = new Set(combinations.map((c) => c.parameters['character.llm.model']));
      const inputValues = new Set(combinations.map((c) => c.parameters['run[0].input']));

      expect(modelValues).toEqual(new Set(['gpt-4', 'gpt-3.5-turbo']));
      expect(inputValues).toEqual(new Set(['Hello', 'Hi']));

      // Verify all combinations exist
      const expectedCombinations = [
        { 'character.llm.model': 'gpt-4', 'run[0].input': 'Hello' },
        { 'character.llm.model': 'gpt-4', 'run[0].input': 'Hi' },
        { 'character.llm.model': 'gpt-3.5-turbo', 'run[0].input': 'Hello' },
        { 'character.llm.model': 'gpt-3.5-turbo', 'run[0].input': 'Hi' },
      ];

      expectedCombinations.forEach((expected) => {
        const found = combinations.find(
          (c) => JSON.stringify(c.parameters) === JSON.stringify(expected)
        );
        expect(found).toBeDefined();
      });
    });

    it('should handle single axis matrix', () => {
      const singleAxisConfig: MatrixConfig = {
        name: 'Single Axis',
        base_scenario: 'test.scenario.yaml',
        runs_per_combination: 1,
        matrix: [
          {
            parameter: 'character.name',
            values: ['Alice', 'Bob', 'Charlie'],
          },
        ],
      };

      const combinations = generateMatrixCombinations(singleAxisConfig);
      expect(combinations).toHaveLength(3);

      combinations.forEach((combo, index) => {
        expect(Object.keys(combo.parameters)).toContain('character.name');
        expect(['Alice', 'Bob', 'Charlie']).toContain(combo.parameters['character.name']);
        expect(combo.metadata.combinationIndex).toBe(index);
        expect(combo.metadata.totalCombinations).toBe(3);
      });
    });

    it('should handle empty matrix gracefully', () => {
      const emptyConfig: MatrixConfig = {
        name: 'Empty Matrix',
        base_scenario: 'test.scenario.yaml',
        runs_per_combination: 1,
        matrix: [],
      };

      const combinations = generateMatrixCombinations(emptyConfig);
      expect(combinations).toHaveLength(0);
    });

    it('should generate unique IDs for all combinations', () => {
      const combinations = generateMatrixCombinations(complexConfig);
      const ids = combinations.map((c) => c.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(combinations.length);
    });
  });

  describe('createRuntimeConfig', () => {
    it('should create runtime config with computed values', () => {
      const runtimeConfig = createRuntimeConfig(basicConfig);

      expect(runtimeConfig.name).toBe(basicConfig.name);
      expect(runtimeConfig.base_scenario).toBe(basicConfig.base_scenario);
      expect(runtimeConfig.runs_per_combination).toBe(basicConfig.runs_per_combination);

      expect(runtimeConfig.computed.totalCombinations).toBe(4);
      expect(runtimeConfig.computed.totalRuns).toBe(4);
      expect(runtimeConfig.computed.createdAt).toBeInstanceOf(Date);
    });

    it('should add runtime metadata to matrix axes', () => {
      const runtimeConfig = createRuntimeConfig(basicConfig);

      runtimeConfig.matrix.forEach((axis, index) => {
        expect(axis.metadata.axisIndex).toBe(index);
        expect(axis.metadata.valueCount).toBe(axis.values.length);
      });
    });
  });

  describe('filterCombinations', () => {
    it('should filter combinations by parameter value', () => {
      const combinations = generateMatrixCombinations(basicConfig);
      const filtered = filterCombinations(combinations, 'gpt-4');

      expect(filtered.length).toBeLessThan(combinations.length);
      filtered.forEach((combo) => {
        expect(JSON.stringify(combo.parameters)).toContain('gpt-4');
      });
    });

    it('should filter combinations case-insensitively', () => {
      const combinations = generateMatrixCombinations(basicConfig);
      const filtered = filterCombinations(combinations, 'GPT-4');

      expect(filtered.length).toBeGreaterThan(0);
      filtered.forEach((combo) => {
        expect(JSON.stringify(combo.parameters).toLowerCase()).toContain('gpt-4');
      });
    });

    it('should return empty array when no matches', () => {
      const combinations = generateMatrixCombinations(basicConfig);
      const filtered = filterCombinations(combinations, 'nonexistent');

      expect(filtered).toHaveLength(0);
    });

    it('should return all combinations when filter matches all', () => {
      const combinations = generateMatrixCombinations(basicConfig);
      const filtered = filterCombinations(combinations, 'run[0]');

      expect(filtered).toHaveLength(combinations.length);
    });
  });

  describe('calculateExecutionStats', () => {
    it('should calculate correct statistics for basic matrix', () => {
      const combinations = generateMatrixCombinations(basicConfig);
      const stats = calculateExecutionStats(combinations, basicConfig.runs_per_combination);

      expect(stats.totalCombinations).toBe(4);
      expect(stats.totalRuns).toBe(4); // 4 combinations × 1 run each
      expect(stats.estimatedDuration.realistic).toBeGreaterThan(0);
      expect(stats.estimatedDuration.optimistic).toBeLessThan(stats.estimatedDuration.realistic);
      expect(stats.estimatedDuration.pessimistic).toBeGreaterThan(
        stats.estimatedDuration.realistic
      );
    });

    it('should calculate correct statistics for complex matrix', () => {
      const combinations = generateMatrixCombinations(complexConfig);
      const stats = calculateExecutionStats(combinations, complexConfig.runs_per_combination);

      expect(stats.totalCombinations).toBe(18);
      expect(stats.totalRuns).toBe(54); // 18 combinations × 3 runs each
      expect(stats.estimatedDuration.realistic).toBeGreaterThan(0);
    });

    it('should scale estimates with number of runs', () => {
      const combinations = generateMatrixCombinations(basicConfig);
      const stats1 = calculateExecutionStats(combinations, 1);
      const stats2 = calculateExecutionStats(combinations, 3);

      expect(stats2.estimatedDuration.realistic).toBeGreaterThan(
        stats1.estimatedDuration.realistic
      );
      expect(stats2.totalRuns).toBe(stats1.totalRuns * 3);
    });
  });

  describe('createExecutionContext', () => {
    it('should create execution context with correct structure', () => {
      const combinations = generateMatrixCombinations(basicConfig);
      const context = createExecutionContext(basicConfig, combinations, {
        parallelism: 2,
        dryRun: false,
        verbose: true,
      });

      expect(context.config.name).toBe(basicConfig.name);
      expect(context.combinations).toHaveLength(4);
      expect(context.settings.parallelism).toBe(2);
      expect(context.settings.dryRun).toBe(false);
      expect(context.settings.verbose).toBe(true);

      expect(context.state.phase).toBe('initializing');
      expect(context.state.completedCombinations).toBe(0);
      expect(context.state.failedCombinations).toBe(0);
    });

    it('should handle optional settings', () => {
      const combinations = generateMatrixCombinations(basicConfig);
      const context = createExecutionContext(basicConfig, combinations, {
        parallelism: 1,
        dryRun: true,
        filter: 'gpt-4',
        verbose: false,
      });

      expect(context.settings.filter).toBe('gpt-4');
    });
  });

  describe('formatDuration', () => {
    it('should format seconds correctly', () => {
      expect(formatDuration(30)).toBe('30s');
      expect(formatDuration(45)).toBe('45s');
    });

    it('should format minutes and seconds correctly', () => {
      expect(formatDuration(90)).toBe('1m 30s');
      expect(formatDuration(150)).toBe('2m 30s');
    });

    it('should format hours and minutes correctly', () => {
      expect(formatDuration(3661)).toBe('1h 1m');
      expect(formatDuration(7320)).toBe('2h 2m');
    });

    it('should handle edge cases', () => {
      expect(formatDuration(0)).toBe('0s');
      expect(formatDuration(60)).toBe('1m 0s');
      expect(formatDuration(3600)).toBe('1h 0m');
    });
  });

  describe('Integration Tests', () => {
    it('should work end-to-end with real-world matrix configuration', () => {
      const realWorldConfig: MatrixConfig = {
        name: 'GitHub Issues Analysis',
        description: 'Test different models and prompts for GitHub issue analysis',
        base_scenario:
          'packages/cli/src/commands/scenario/examples/test-github-issues.scenario.yaml',
        runs_per_combination: 2,
        matrix: [
          {
            parameter: 'run[0].input',
            values: [
              'List open issues for elizaOS/eliza',
              'Find current issues for the elizaos/eliza repo',
              "Show me what's open in the elizaOS/eliza GitHub.",
            ],
          },
          {
            parameter: 'run[0].evaluations[0].value',
            values: ['issues', 'GitHub'],
          },
        ],
      };

      const combinations = generateMatrixCombinations(realWorldConfig);
      expect(combinations).toHaveLength(6); // 3 inputs × 2 evaluation values

      const stats = calculateExecutionStats(combinations, realWorldConfig.runs_per_combination);
      expect(stats.totalRuns).toBe(12); // 6 combinations × 2 runs each

      const context = createExecutionContext(realWorldConfig, combinations, {
        parallelism: 2,
        dryRun: false,
        verbose: true,
      });

      expect(context.combinations).toHaveLength(6);
      expect(context.config.computed.totalCombinations).toBe(6);
      expect(context.config.computed.totalRuns).toBe(12);
    });
  });
});
