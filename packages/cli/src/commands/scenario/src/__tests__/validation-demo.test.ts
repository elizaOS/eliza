import { describe, it, expect } from 'bun:test';
import {
  validateMatrixConfig,
  calculateTotalCombinations,
  calculateTotalRuns,
  generateParameterCombinations,
  isValidParameterPath,
} from '../matrix-schema';

describe('Matrix Schema Demo and Integration', () => {
  it('should demonstrate the complete workflow from the ticket example', () => {
    // This is the exact example from ticket #5778
    const ticketExample = {
      name: 'GitHub Issue Action Chaining Analysis',
      description:
        'Tests the reliability of listing GitHub issues under various LLM and prompt configurations.',
      base_scenario: 'packages/cli/src/commands/scenario/examples/test-github-issues.scenario.yaml',
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

    // Step 1: Validate the configuration
    const validationResult = validateMatrixConfig(ticketExample);
    expect(validationResult.success).toBe(true);

    if (!validationResult.success) {
      throw new Error('Validation failed');
    }

    const config = validationResult.data;

    // Step 2: Calculate totals
    const totalCombinations = calculateTotalCombinations(config);
    const totalRuns = calculateTotalRuns(config);

    expect(totalCombinations).toBe(6); // 2 models × 3 prompts = 6 combinations
    expect(totalRuns).toBe(18); // 6 combinations × 3 runs each = 18 total runs

    // Step 3: Generate parameter combinations
    const combinations = generateParameterCombinations(config);
    expect(combinations).toHaveLength(6);

    // Verify the combinations are correct
    const expectedCombinations = [
      {
        'character.llm.model': 'gpt-4-turbo',
        'run[0].input': 'List open issues for elizaOS/eliza',
      },
      {
        'character.llm.model': 'gpt-4-turbo',
        'run[0].input': 'Find current issues for the elizaos/eliza repo',
      },
      {
        'character.llm.model': 'gpt-4-turbo',
        'run[0].input': "Show me what's open in the elizaOS/eliza GitHub.",
      },
      {
        'character.llm.model': 'gpt-3.5-turbo',
        'run[0].input': 'List open issues for elizaOS/eliza',
      },
      {
        'character.llm.model': 'gpt-3.5-turbo',
        'run[0].input': 'Find current issues for the elizaos/eliza repo',
      },
      {
        'character.llm.model': 'gpt-3.5-turbo',
        'run[0].input': "Show me what's open in the elizaOS/eliza GitHub.",
      },
    ];

    expect(combinations).toEqual(expectedCombinations);

    // Step 4: Validate parameter paths
    config.matrix.forEach((axis) => {
      expect(isValidParameterPath(axis.parameter)).toBe(true);
    });
  });

  it('should demonstrate error handling with user-friendly messages', () => {
    const invalidConfig = {
      name: '', // Empty name
      base_scenario: 'test.yaml',
      runs_per_combination: -1, // Invalid value
      matrix: [], // Empty matrix
    };

    const result = validateMatrixConfig(invalidConfig);
    expect(result.success).toBe(false);

    if (!result.success) {
      const errors = result.error.format();

      // Should have errors for all the issues
      expect(errors.name?._errors).toBeDefined();
      expect(errors.runs_per_combination?._errors).toBeDefined();
      expect(errors.matrix?._errors).toBeDefined();
    }
  });

  it('should demonstrate parameter path validation', () => {
    const validPaths = [
      'character.llm.model',
      'run[0].input',
      'setup.mocks[0].response.success',
      'plugins[0].name',
      'environment.type',
    ];

    const invalidPaths = [
      '',
      'invalid..path',
      '.leading.dot',
      'trailing.dot.',
      '123invalid',
      'invalid[abc]',
    ];

    validPaths.forEach((path) => {
      expect(isValidParameterPath(path)).toBe(true);
    });

    invalidPaths.forEach((path) => {
      expect(isValidParameterPath(path)).toBe(false);
    });
  });

  it('should demonstrate large matrix calculations', () => {
    const largeMatrixConfig = {
      name: 'Large Test Matrix',
      base_scenario: 'test.yaml',
      runs_per_combination: 5,
      matrix: [
        {
          parameter: 'character.llm.model',
          values: ['gpt-4', 'gpt-3.5-turbo', 'claude-3', 'llama-2'], // 4 values
        },
        {
          parameter: 'character.temperature',
          values: [0.1, 0.3, 0.5, 0.7, 0.9], // 5 values
        },
        {
          parameter: 'character.max_tokens',
          values: [1000, 2000, 4000], // 3 values
        },
      ],
    };

    const result = validateMatrixConfig(largeMatrixConfig);
    expect(result.success).toBe(true);

    if (result.success) {
      const combinations = calculateTotalCombinations(result.data);
      const totalRuns = calculateTotalRuns(result.data);

      expect(combinations).toBe(60); // 4 × 5 × 3 = 60 combinations
      expect(totalRuns).toBe(300); // 60 combinations × 5 runs = 300 total runs

      // This would be a warning case - 300 total runs is quite large!
    }
  });
});
