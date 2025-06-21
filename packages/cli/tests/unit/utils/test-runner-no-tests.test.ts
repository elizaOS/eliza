import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestRunner } from '../../../src/utils/test-runner';
import type { IAgentRuntime, Plugin, ProjectAgent, Character } from '@elizaos/core';

// Mock logger
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  };
});

describe('TestRunner - Plugin Without Tests', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ELIZA_TESTING_PLUGIN = 'true';

    mockRuntime = {
      character: { name: 'Test Agent' } as Character,
      plugins: [],
    } as unknown as IAgentRuntime;
  });

  it('should fail when testing a plugin that has no tests', async () => {
    const pluginWithoutTests: Plugin = {
      name: 'plugin-without-tests',
      description: 'A plugin with no tests',
    };

    const projectAgent: ProjectAgent = {
      character: { name: 'Test Agent' } as Character,
      plugins: [pluginWithoutTests],
    };

    const testRunner = new TestRunner(mockRuntime, projectAgent);
    const results = await testRunner.runTests();

    // Should have marked it as having tests but failed
    expect(results.hasTests).toBe(true);
    expect(results.failed).toBe(1);
    expect(results.total).toBe(0);
    expect(results.passed).toBe(0);
  });

  it('should pass when testing a plugin that has tests', async () => {
    const pluginWithTests: Plugin = {
      name: 'plugin-with-tests',
      description: 'A plugin with tests',
      tests: [
        {
          name: 'Test Suite',
          tests: [
            {
              name: 'test 1',
              fn: vi.fn().mockResolvedValue(undefined),
            },
          ],
        },
      ],
    };

    const projectAgent: ProjectAgent = {
      character: { name: 'Test Agent' } as Character,
      plugins: [pluginWithTests],
    };

    const testRunner = new TestRunner(mockRuntime, projectAgent);
    const results = await testRunner.runTests();

    // Should have run the test and passed
    expect(results.hasTests).toBe(true);
    expect(results.failed).toBe(0);
    expect(results.total).toBe(1);
    expect(results.passed).toBe(1);
  });

  it('should handle plugins with empty test arrays', async () => {
    const pluginWithEmptyTests: Plugin = {
      name: 'plugin-empty-tests',
      description: 'A plugin with empty test array',
      tests: [],
    };

    const projectAgent: ProjectAgent = {
      character: { name: 'Test Agent' } as Character,
      plugins: [pluginWithEmptyTests],
    };

    const testRunner = new TestRunner(mockRuntime, projectAgent);
    const results = await testRunner.runTests();

    // Should still fail because no actual tests were found
    expect(results.hasTests).toBe(true);
    expect(results.failed).toBe(1);
    expect(results.total).toBe(0);
    expect(results.passed).toBe(0);
  });
});
