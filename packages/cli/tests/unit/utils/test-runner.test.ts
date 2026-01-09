import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { TestRunner } from '../../../src/utils/test-runner';
import type { IAgentRuntime, Plugin, ProjectAgent, Character } from '@elizaos/core';

// Store original env
const originalEnv = process.env.ELIZA_TESTING_PLUGIN;

// Create minimal mock runtime factory
const createMockRuntime = (): IAgentRuntime => {
  return {
    agentId: 'test-agent-id',
    character: { name: 'Test Agent', bio: 'Test bio' } as Character,
    plugins: [],
  } as Partial<IAgentRuntime> as IAgentRuntime;
};

describe('TestRunner Plugin Isolation', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    // Reset environment
    delete process.env.ELIZA_TESTING_PLUGIN;
    mockRuntime = createMockRuntime();
  });

  afterEach(() => {
    // Restore original environment
    if (originalEnv) {
      process.env.ELIZA_TESTING_PLUGIN = originalEnv;
    } else {
      delete process.env.ELIZA_TESTING_PLUGIN;
    }
  });

  describe('Plugin Identification', () => {
    it('should identify plugin under test when ELIZA_TESTING_PLUGIN is set', () => {
      process.env.ELIZA_TESTING_PLUGIN = 'true';

      const sqlPlugin: Plugin = {
        name: '@elizaos/plugin-sql',
        description: 'SQL Plugin',
      };

      const testPlugin: Plugin = {
        name: 'test-plugin',
        description: 'Test Plugin',
        tests: [
          {
            name: 'Test Suite',
            tests: [
              {
                name: 'test 1',
                fn: async () => {},
              },
            ],
          },
        ],
      };

      const projectAgent: ProjectAgent = {
        character: { name: 'Eliza', bio: 'Test bio' } as Character,
        plugins: [sqlPlugin, testPlugin],
      };

      const testRunner = new TestRunner(mockRuntime, projectAgent);

      expect((testRunner as Record<string, unknown>).isDirectPluginTest).toBe(true);
      expect((testRunner as Record<string, unknown>).pluginUnderTest).toBe(testPlugin);
      expect(
        ((testRunner as Record<string, unknown>).pluginUnderTest as Plugin | undefined)?.name
      ).toBe('test-plugin');
    });

    it('should not identify as plugin test when only core plugins are present', () => {
      process.env.ELIZA_TESTING_PLUGIN = 'true';

      const sqlPlugin: Plugin = {
        name: '@elizaos/plugin-sql',
        description: 'SQL Plugin',
      };

      const projectAgent: ProjectAgent = {
        character: { name: 'Eliza', bio: 'Test bio' } as Character,
        plugins: [sqlPlugin],
      };

      const testRunner = new TestRunner(mockRuntime, projectAgent);

      expect((testRunner as Record<string, unknown>).isDirectPluginTest).toBe(false);
      expect((testRunner as Record<string, unknown>).pluginUnderTest).toBeUndefined();
    });

    it('should handle multiple non-core plugins by selecting the first one', () => {
      process.env.ELIZA_TESTING_PLUGIN = 'true';

      const sqlPlugin: Plugin = {
        name: '@elizaos/plugin-sql',
        description: 'SQL Plugin',
      };

      const plugin1: Plugin = {
        name: 'plugin-1',
        description: 'Plugin 1',
        tests: [{ name: 'Suite 1', tests: [] }],
      };

      const plugin2: Plugin = {
        name: 'plugin-2',
        description: 'Plugin 2',
        tests: [{ name: 'Suite 2', tests: [] }],
      };

      const projectAgent: ProjectAgent = {
        character: { name: 'Eliza', bio: 'Test bio' } as Character,
        plugins: [sqlPlugin, plugin1, plugin2],
      };

      const testRunner = new TestRunner(mockRuntime, projectAgent);

      expect((testRunner as Record<string, unknown>).isDirectPluginTest).toBe(true);
      expect((testRunner as Record<string, unknown>).pluginUnderTest).toBe(plugin1);
    });

    it('should not identify as plugin test when ELIZA_TESTING_PLUGIN is not set', () => {
      // Environment variable not set
      delete process.env.ELIZA_TESTING_PLUGIN;

      const testPlugin: Plugin = {
        name: 'test-plugin',
        description: 'Test Plugin',
      };

      const projectAgent: ProjectAgent = {
        character: { name: 'Eliza', bio: 'Test bio' } as Character,
        plugins: [testPlugin],
      };

      const testRunner = new TestRunner(mockRuntime, projectAgent);

      expect((testRunner as Record<string, unknown>).isDirectPluginTest).toBe(false);
    });
  });

  describe('Test Execution', () => {
    it('should only run tests for the identified plugin', async () => {
      process.env.ELIZA_TESTING_PLUGIN = 'true';

      let sqlTestCalled = false;
      let targetTest1Called = false;
      let targetTest2Called = false;

      const sqlPlugin: Plugin = {
        name: '@elizaos/plugin-sql',
        description: 'SQL Plugin',
        tests: [
          {
            name: 'SQL Tests',
            tests: [
              {
                name: 'sql test',
                fn: async () => {
                  sqlTestCalled = true;
                },
              },
            ],
          },
        ],
      };

      const targetPlugin: Plugin = {
        name: 'target-plugin',
        description: 'Target Plugin',
        tests: [
          {
            name: 'Target Tests',
            tests: [
              {
                name: 'target test 1',
                fn: async () => {
                  targetTest1Called = true;
                },
              },
              {
                name: 'target test 2',
                fn: async () => {
                  targetTest2Called = true;
                },
              },
            ],
          },
        ],
      };

      const projectAgent: ProjectAgent = {
        character: { name: 'Eliza', bio: 'Test bio' } as Character,
        plugins: [sqlPlugin, targetPlugin],
      };

      const testRunner = new TestRunner(mockRuntime, projectAgent);
      const results = await testRunner.runTests();

      // Only target plugin tests should have been run
      expect(results.total).toBe(2);
      expect(results.passed).toBe(2);

      // SQL plugin tests should not have been called
      expect(sqlTestCalled).toBe(false);

      // Target plugin tests should have been called
      expect(targetTest1Called).toBe(true);
      expect(targetTest2Called).toBe(true);
    });

    it('should skip project tests when testing a plugin', async () => {
      process.env.ELIZA_TESTING_PLUGIN = 'true';

      let pluginTestCalled = false;
      let projectTestCalled = false;

      const targetPlugin: Plugin = {
        name: 'target-plugin',
        description: 'Target Plugin',
        tests: [
          {
            name: 'Plugin Tests',
            tests: [
              {
                name: 'plugin test',
                fn: async () => {
                  pluginTestCalled = true;
                },
              },
            ],
          },
        ],
      };

      const projectAgent: ProjectAgent = {
        character: { name: 'Eliza', bio: 'Test bio' } as Character,
        plugins: [targetPlugin],
        tests: [
          {
            name: 'Project Tests',
            tests: [
              {
                name: 'project test',
                fn: async () => {
                  projectTestCalled = true;
                },
              },
            ],
          },
        ],
      };

      const testRunner = new TestRunner(mockRuntime, projectAgent);
      const results = await testRunner.runTests();

      // Only plugin test should run
      expect(results.total).toBe(1);
      expect(pluginTestCalled).toBe(true);

      // Project test should not run
      expect(projectTestCalled).toBe(false);
    });

    it('should handle plugins without tests gracefully', async () => {
      process.env.ELIZA_TESTING_PLUGIN = 'true';

      const pluginWithoutTests: Plugin = {
        name: 'no-test-plugin',
        description: 'Plugin without tests',
      };

      const projectAgent: ProjectAgent = {
        character: { name: 'Eliza', bio: 'Test bio' } as Character,
        plugins: [pluginWithoutTests],
      };

      const testRunner = new TestRunner(mockRuntime, projectAgent);
      const results = await testRunner.runTests();

      expect(results.total).toBe(0);
      expect(results.hasTests).toBe(false);
    });

    it('should apply test filters correctly when testing plugins', async () => {
      process.env.ELIZA_TESTING_PLUGIN = 'true';

      let suiteATestCalled = false;
      let suiteBTestCalled = false;

      const targetPlugin: Plugin = {
        name: 'target-plugin',
        description: 'Target Plugin',
        tests: [
          {
            name: 'Suite A',
            tests: [
              {
                name: 'test a',
                fn: async () => {
                  suiteATestCalled = true;
                },
              },
            ],
          },
          {
            name: 'Suite B',
            tests: [
              {
                name: 'test b',
                fn: async () => {
                  suiteBTestCalled = true;
                },
              },
            ],
          },
        ],
      };

      const projectAgent: ProjectAgent = {
        character: { name: 'Eliza', bio: 'Test bio' } as Character,
        plugins: [targetPlugin],
      };

      const testRunner = new TestRunner(mockRuntime, projectAgent);
      const results = await testRunner.runTests({ filter: 'Suite A' });

      // Only Suite A test should run
      expect(results.total).toBe(1);
      expect(results.skipped).toBe(1);
      expect(suiteATestCalled).toBe(true);
      expect(suiteBTestCalled).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty plugin arrays', () => {
      process.env.ELIZA_TESTING_PLUGIN = 'true';

      const projectAgent: ProjectAgent = {
        character: { name: 'Eliza', bio: 'Test bio' } as Character,
        plugins: [],
      };

      const testRunner = new TestRunner(mockRuntime, projectAgent);

      expect((testRunner as Record<string, unknown>).isDirectPluginTest).toBe(false);
      expect((testRunner as Record<string, unknown>).pluginUnderTest).toBeUndefined();
    });

    it('should handle null/undefined project agent', () => {
      process.env.ELIZA_TESTING_PLUGIN = 'true';

      const testRunner = new TestRunner(mockRuntime, undefined);

      expect((testRunner as Record<string, unknown>).isDirectPluginTest).toBe(false);
      expect((testRunner as Record<string, unknown>).pluginUnderTest).toBeUndefined();
    });

    it('should handle character name based plugin detection', () => {
      // Test the fallback detection method
      delete process.env.ELIZA_TESTING_PLUGIN;

      const testPlugin: Plugin = {
        name: 'awesome-plugin',
        description: 'Awesome Plugin',
      };

      const projectAgent: ProjectAgent = {
        character: { name: 'Test Agent for awesome-plugin', bio: 'Test bio' } as Character,
        plugins: [testPlugin],
      };

      const testRunner = new TestRunner(mockRuntime, projectAgent);

      expect((testRunner as Record<string, unknown>).isDirectPluginTest).toBe(true);
      expect((testRunner as Record<string, unknown>).pluginUnderTest).toBe(testPlugin);
    });
  });
});
