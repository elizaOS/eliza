import { describe, it, expect } from 'bun:test';
import { TestRunner } from '../../src/utils/test-runner';
import type { IAgentRuntime, Plugin, ProjectAgent, Character } from '@elizaos/core';

describe('SQL Plugin Test Exclusion', () => {
  it('should not run SQL plugin tests when testing another plugin', async () => {
    // Set the environment variable to simulate plugin testing
    process.env.ELIZA_TESTING_PLUGIN = 'true';

    try {
      // Create mock plugins
      const sqlPlugin: Plugin = {
        name: '@elizaos/plugin-sql',
        description: 'SQL Plugin',
        tests: [
          {
            name: 'sql_test_suite',
            tests: [
              {
                name: 'sql_test',
                fn: async () => {
                  throw new Error('SQL test should not run!');
                },
              },
            ],
          },
        ],
      };

      const myPlugin: Plugin = {
        name: 'my-plugin',
        description: 'My Plugin',
        tests: [
          {
            name: 'my_test_suite',
            tests: [
              {
                name: 'my_test',
                fn: async () => {
                  // Test passes
                },
              },
            ],
          },
        ],
      };

      // Create mock runtime with both plugins
      const mockRuntime: IAgentRuntime = {
        agentId: 'test-agent',
        character: { name: 'test-character', bio: 'test bio' } as Character,
        plugins: [sqlPlugin, myPlugin],
      } as unknown as IAgentRuntime;

      // Create project agent with only the plugin we're testing
      const projectAgent: ProjectAgent = {
        character: { name: 'test-character', bio: 'test bio' } as Character,
        plugins: [myPlugin],
      } as ProjectAgent;

      // Create TestRunner instance
      const testRunner = new TestRunner(mockRuntime, projectAgent);

      // Run tests
      const results = await testRunner.runTests({
        filter: undefined,
        skipPlugins: false,
        skipProjectTests: false,
        skipE2eTests: true,
      });

      // Verify results
      expect(results.total).toBe(1); // Only one test should run
      expect(results.passed).toBe(1); // The test should pass
      expect(results.failed).toBe(0); // No failures

      // The SQL plugin test should not have been executed
      // If it had run, it would have thrown an error
    } finally {
      // Clean up
      delete process.env.ELIZA_TESTING_PLUGIN;
    }
  });

  it('should not run plugin tests when not in direct plugin test mode', async () => {
    // Ensure environment variable is not set
    delete process.env.ELIZA_TESTING_PLUGIN;

    let projectTestRan = false;

    // Create mock plugins (these won't run unless in plugin test mode)
    const sqlPlugin: Plugin = {
      name: '@elizaos/plugin-sql',
      description: 'SQL Plugin',
      tests: [
        {
          name: 'sql_test_suite',
          tests: [
            {
              name: 'sql_test',
              fn: async () => {
                throw new Error('Plugin tests should not run!');
              },
            },
          ],
        },
      ],
    };

    const myPlugin: Plugin = {
      name: 'my-plugin',
      description: 'My Plugin',
      tests: [
        {
          name: 'my_test_suite',
          tests: [
            {
              name: 'my_test',
              fn: async () => {
                throw new Error('Plugin tests should not run!');
              },
            },
          ],
        },
      ],
    };

    // Create project agent with project tests
    const projectAgent: ProjectAgent = {
      character: { name: 'test-character', bio: 'test bio' } as Character,
      plugins: [sqlPlugin, myPlugin],
      tests: [
        {
          name: 'project_test_suite',
          tests: [
            {
              name: 'project_test',
              fn: async () => {
                projectTestRan = true;
              },
            },
          ],
        },
      ],
    } as ProjectAgent;

    // Create mock runtime
    const mockRuntime: IAgentRuntime = {
      agentId: 'test-agent',
      character: { name: 'test-character', bio: 'test bio' } as Character,
      plugins: [],
    } as unknown as IAgentRuntime;

    // TestRunner with project agent
    const testRunner = new TestRunner(mockRuntime, projectAgent);

    // Run tests
    const results = await testRunner.runTests({
      filter: undefined,
      skipPlugins: false,
      skipProjectTests: false,
      skipE2eTests: true,
    });

    // Verify results - only project tests should run
    expect(results.total).toBe(1); // Only project test should run
    expect(results.passed).toBe(1); // It should pass
    expect(results.failed).toBe(0); // No failures

    // Only project test should have run
    expect(projectTestRan).toBe(true);
  });
});
