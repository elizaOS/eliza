import {
  type IAgentRuntime,
  type Plugin,
  type ProjectAgent,
  type TestSuite,
  logger,
} from '@elizaos/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface TestStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

interface TestOptions {
  filter?: string;
  skipPlugins?: boolean;
  skipProjectTests?: boolean;
  skipE2eTests?: boolean;
}

export class TestRunner {
  private runtime: IAgentRuntime;
  private projectAgent?: ProjectAgent;
  private stats: TestStats;
  private isDirectPluginTest: boolean;

  constructor(runtime: IAgentRuntime, projectAgent?: ProjectAgent) {
    this.runtime = runtime;
    this.projectAgent = projectAgent;
    this.stats = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    };

    // Check if this is a direct plugin test (the agent was created specifically for testing a plugin)
    // We can identify this in a few ways:
    // 1. If we have exactly one plugin and the character name refers to the plugin
    // 2. If we're in a directory containing a plugin and this agent is being used to test it
    // 3. If the agent has special naming indicating it's for testing a specific plugin
    if (
      (projectAgent?.plugins?.length === 1 &&
        (projectAgent.character.name.includes(`Test Agent for ${projectAgent.plugins[0].name}`) ||
          (projectAgent.character.name.toLowerCase().includes('test') &&
            projectAgent.character.name
              .toLowerCase()
              .includes(projectAgent.plugins[0].name.toLowerCase())))) ||
      // Alternatively, if we were launched from within a plugin directory, consider it a direct test
      process.env.ELIZA_TESTING_PLUGIN === 'true'
    ) {
      this.isDirectPluginTest = true;
      logger.debug('This is a direct plugin test - will only run tests for this plugin');
    } else {
      this.isDirectPluginTest = false;
    }
  }

  /**
   * Runs a test suite
   * @param suite The test suite to run
   */
  private async runTestSuite(suite: TestSuite) {
    logger.info(`\nRunning test suite: ${suite.name}`);

    for (const test of suite.tests) {
      this.stats.total++;

      try {
        logger.info(`  Running test: ${test.name}`);
        await test.fn(this.runtime);
        this.stats.passed++;
        logger.success(`  ✓ ${test.name}`);
      } catch (error) {
        this.stats.failed++;
        logger.error(`  ✗ ${test.name}`);
        logger.error(`    ${error.message}`);
      }
    }
  }

  /**
   * Runs project agent tests
   */
  private async runProjectTests(options: TestOptions) {
    if (!this.projectAgent?.tests || options.skipProjectTests || this.isDirectPluginTest) {
      if (this.isDirectPluginTest) {
        logger.info('Skipping project tests when directly testing a plugin');
      }
      return;
    }

    logger.info('\nRunning project tests...');

    const testSuites = Array.isArray(this.projectAgent.tests)
      ? this.projectAgent.tests
      : [this.projectAgent.tests];

    for (const suite of testSuites) {
      if (!suite) {
        continue;
      }

      // Apply filter if specified
      if (options.filter) {
        // Handle common filter formats
        let baseName = options.filter;
        if (baseName.endsWith('.test.ts') || baseName.endsWith('.test.js')) {
          baseName = baseName.slice(0, -8); // Remove '.test.ts' or '.test.js'
        } else if (baseName.endsWith('.test')) {
          baseName = baseName.slice(0, -5); // Remove '.test'
        }

        if (!suite.name.includes(baseName)) {
          logger.info(`Skipping test suite "${suite.name}" (doesn't match filter "${baseName}")`);
          this.stats.skipped++;
          continue;
        }
      }

      await this.runTestSuite(suite);
    }
  }

  /**
   * Runs plugin tests
   */
  private async runPluginTests(options: TestOptions) {
    if (options.skipPlugins && !this.isDirectPluginTest) {
      return;
    }

    // If this is a direct plugin test, we have a more friendly message
    if (this.isDirectPluginTest) {
      logger.info('\nRunning plugin tests...');

      // When directly testing a plugin, we test only that plugin
      const plugin = this.projectAgent?.plugins?.[0] as Plugin;
      if (!plugin || !plugin.tests) {
        logger.warn(`No tests found for this plugin (${plugin?.name || 'unknown plugin'})`);
        logger.info(
          "To add tests to your plugin, include a 'tests' property with an array of test suites."
        );
        logger.info('Example:');
        logger.info(`
export const myPlugin = {
  name: "my-plugin",
  description: "My awesome plugin",
  
  // ... other plugin properties ...
  
  tests: [
    {
      name: "Basic Tests",
      tests: [
        {
          name: "should do something",
          fn: async (runtime) => {
            // Test code here
          }
        }
      ]
    }
  ]
};
`);
        return;
      }

      logger.info(`Found test suites for plugin: ${plugin.name}`);

      // Handle both single suite and array of suites
      const testSuites = Array.isArray(plugin.tests) ? plugin.tests : [plugin.tests];

      for (const suite of testSuites) {
        if (!suite) {
          continue;
        }

        // Apply filter if specified
        if (options.filter) {
          // Handle common filter formats
          let baseName = options.filter;
          if (baseName.endsWith('.test.ts') || baseName.endsWith('.test.js')) {
            baseName = baseName.slice(0, -8); // Remove '.test.ts' or '.test.js'
          } else if (baseName.endsWith('.test')) {
            baseName = baseName.slice(0, -5); // Remove '.test'
          }

          if (!suite.name.includes(baseName)) {
            logger.info(
              `Skipping test suite "${suite.name}" because it doesn't match filter "${baseName}"`
            );
            this.stats.skipped++;
            continue;
          }
        }

        await this.runTestSuite(suite);
      }
    } else {
      // Standard plugin test running for a project - excluding other plugins loaded by the agent
      logger.info('\nRunning project plugin tests...');

      // Get the plugins directly from the projectAgent, not from runtime
      // This ensures we only run tests for plugins explicitly defined in the project
      const plugins = this.projectAgent?.plugins || [];

      if (plugins.length === 0) {
        logger.info('No plugins defined directly in project to test');
        return;
      }

      logger.info(`Found ${plugins.length} plugins defined in project`);

      for (const plugin of plugins) {
        try {
          if (!plugin) {
            continue;
          }

          logger.info(`Testing plugin: ${plugin.name || 'unnamed plugin'}`);

          const pluginTests = plugin.tests;
          if (!pluginTests) {
            logger.info(`No tests found for plugin: ${plugin.name || 'unnamed plugin'}`);
            continue;
          }

          // Handle both single suite and array of suites
          const testSuites = Array.isArray(pluginTests) ? pluginTests : [pluginTests];

          for (const suite of testSuites) {
            if (!suite) {
              continue;
            }

            // Apply filter if specified
            if (options.filter) {
              // Handle common filter formats
              let baseName = options.filter;
              if (baseName.endsWith('.test.ts') || baseName.endsWith('.test.js')) {
                baseName = baseName.slice(0, -8); // Remove '.test.ts' or '.test.js'
              } else if (baseName.endsWith('.test')) {
                baseName = baseName.slice(0, -5); // Remove '.test'
              }

              if (!suite.name.includes(baseName)) {
                logger.info(`Skipping test suite "${suite.name}" (doesn't match filter)`);
                this.stats.skipped++;
                continue;
              }
            }

            await this.runTestSuite(suite);
          }
        } catch (error) {
          logger.error(`Error running tests for plugin ${plugin.name}:`, error);
          this.stats.failed++;
        }
      }
    }
  }

  /**
   * Runs tests from the e2e directory
   */
  private async runE2eTests(options: TestOptions) {
    if (options.skipE2eTests) {
      logger.info('Skipping e2e tests (--skip-e2e-tests flag)');
      return;
    }

    try {
      // Check for e2e directory
      const e2eDir = path.join(process.cwd(), 'e2e');
      if (!fs.existsSync(e2eDir)) {
        logger.debug('No e2e directory found, skipping e2e tests');
        return;
      }

      logger.info('\nRunning e2e tests...');

      // Get all .ts files in the e2e directory
      const testFiles = fs
        .readdirSync(e2eDir)
        .filter((file) => file.endsWith('.test.ts'))
        .map((file) => path.join(e2eDir, file));

      if (testFiles.length === 0) {
        logger.info('No e2e test files found');
        return;
      }

      logger.info(`Found ${testFiles.length} e2e test files`);

      // Load and run each test file
      for (const testFile of testFiles) {
        try {
          // Get the file name for logging
          const fileName = path.basename(testFile);
          const fileNameWithoutExt = path.basename(testFile, '.test.ts');
          logger.info(`Loading test file: ${fileName}`);

          // Dynamic import the test file
          const testModule = await import(`file://${testFile}`);

          // Get the default export which should be a TestSuite
          const testSuite = testModule.default;

          if (!testSuite || !testSuite.tests) {
            logger.warn(`No valid test suite found in ${fileName}`);
            continue;
          }

          // Apply filter if specified - match against either file name or suite name
          if (options.filter) {
            // Handle common filter formats like component tests
            let baseName = options.filter;
            if (baseName.endsWith('.test.ts') || baseName.endsWith('.test.js')) {
              baseName = baseName.slice(0, -8); // Remove '.test.ts' or '.test.js'
            } else if (baseName.endsWith('.test')) {
              baseName = baseName.slice(0, -5); // Remove '.test'
            }

            // Now match against filename or suite name with the processed filter
            const matchesFileName = fileNameWithoutExt.includes(baseName);
            const matchesSuiteName = testSuite.name && testSuite.name.includes(baseName);

            if (!matchesFileName && !matchesSuiteName) {
              logger.info(
                `Skipping test suite "${testSuite.name}" in ${fileName} (doesn't match filter "${baseName}")`
              );
              this.stats.skipped++;
              continue;
            }
          }

          // Run the test suite
          await this.runTestSuite(testSuite);
        } catch (error) {
          logger.error(`Error running tests from ${testFile}:`, error);
          this.stats.failed++;
        }
      }
    } catch (error) {
      logger.error(`Error running e2e tests:`, error);
    }
  }

  /**
   * Runs all tests in the project
   * @param options Test options
   */
  async runTests(options: TestOptions = {}): Promise<TestStats> {
    // Run project tests first (unless this is a direct plugin test)
    await this.runProjectTests(options);

    // Then run plugin tests
    await this.runPluginTests(options);

    // Then run e2e tests
    await this.runE2eTests(options);

    // Log summary
    logger.info(
      `\nTest Summary: ${this.stats.passed} passed, ${this.stats.failed} failed, ${this.stats.skipped} skipped`
    );

    return this.stats;
  }
}
