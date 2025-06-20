import {
  type IAgentRuntime,
  type Plugin,
  type ProjectAgent,
  type TestSuite,
  logger,
} from '@elizaos/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// Ensure logger has all required methods with fallbacks
const safeLogger = {
  debug: logger?.debug || console.log,
  info: logger?.info || console.log,
  warn: logger?.warn || console.warn,
  error: logger?.error || console.error,
  success: logger?.success || console.log,
};

interface TestStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  hasTests: boolean;
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
  private pluginUnderTest?: Plugin;

  constructor(runtime: IAgentRuntime, projectAgent?: ProjectAgent) {
    this.runtime = runtime;
    this.projectAgent = projectAgent;
    this.stats = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      hasTests: false,
    };

    // Check if this is a direct plugin test (the agent was created specifically for testing a plugin)
    // We can identify this in a few ways:
    // 1. If we have exactly one plugin and the character name refers to the plugin
    // 2. If we're in a directory containing a plugin and this agent is being used to test it
    // 3. If the agent has special naming indicating it's for testing a specific plugin
    // 4. If ELIZA_TESTING_PLUGIN environment variable is set

    // When testing a plugin directly, the plugin being tested is passed in projectAgent.plugins
    // but it might not be the first one due to dependency loading (e.g., sql plugin is always first)
    const testingPlugin = process.env.ELIZA_TESTING_PLUGIN === 'true';

    if (testingPlugin && projectAgent?.plugins) {
      // Find the plugin that's not a core plugin (like sql)
      const corePlugins = ['@elizaos/plugin-sql'];
      const nonCorePlugins = projectAgent.plugins.filter(
        (plugin) => !corePlugins.includes(plugin.name)
      );

      if (nonCorePlugins.length > 0) {
        // Store the actual plugin being tested
        this.pluginUnderTest = nonCorePlugins[0];
        this.isDirectPluginTest = true;
        safeLogger.debug(
          `Direct plugin test detected - will only run tests for plugin: ${this.pluginUnderTest.name}`
        );
      } else {
        this.isDirectPluginTest = false;
      }
    } else if (
      projectAgent?.plugins?.length === 1 &&
      (projectAgent.character.name.includes(`Test Agent for ${projectAgent.plugins[0].name}`) ||
        (projectAgent.character.name.toLowerCase().includes('test') &&
          projectAgent.character.name
            .toLowerCase()
            .includes(projectAgent.plugins[0].name.toLowerCase())))
    ) {
      this.pluginUnderTest = projectAgent.plugins[0];
      this.isDirectPluginTest = true;
      safeLogger.debug(
        `Direct plugin test detected - will only run tests for plugin: ${this.pluginUnderTest.name}`
      );
    } else {
      this.isDirectPluginTest = false;
    }
  }

  /**
   * Helper method to check if a test suite name matches the filter
   * @param name The name of the test suite
   * @param filter Optional filter string
   * @returns True if the name matches the filter or if no filter is specified
   */
  private matchesFilter(name: string, filter?: string): boolean {
    if (!filter) return true;

    // Process filter name consistently
    let processedFilter = filter;
    if (processedFilter.endsWith('.test.ts') || processedFilter.endsWith('.test.js')) {
      processedFilter = processedFilter.slice(0, -8); // Remove '.test.ts' or '.test.js'
    } else if (processedFilter.endsWith('.test')) {
      processedFilter = processedFilter.slice(0, -5); // Remove '.test'
    }

    // Match against test suite name (case insensitive for better UX)
    return name.toLowerCase().includes(processedFilter.toLowerCase());
  }

  /**
   * Runs a test suite
   * @param suite The test suite to run
   */
  private async runTestSuite(suite: TestSuite) {
    safeLogger.info(`\nRunning test suite: ${suite.name}`);

    if (suite.tests.length > 0) {
      this.stats.hasTests = true; // Mark that we found tests
    }

    for (const test of suite.tests) {
      this.stats.total++;

      try {
        safeLogger.info(`  Running test: ${test.name}`);
        await test.fn(this.runtime);
        this.stats.passed++;
        safeLogger.success(`  [✓] ${test.name}`);
      } catch (error) {
        this.stats.failed++;
        safeLogger.error(`  [X] ${test.name}`);
        safeLogger.error(`    ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Runs project agent tests
   */
  private async runProjectTests(options: TestOptions) {
    if (!this.projectAgent?.tests || options.skipProjectTests || this.isDirectPluginTest) {
      if (this.isDirectPluginTest) {
        safeLogger.info('Skipping project tests when directly testing a plugin');
      }
      return;
    }

    safeLogger.info('\nRunning project tests...');

    const testSuites = Array.isArray(this.projectAgent.tests)
      ? this.projectAgent.tests
      : [this.projectAgent.tests];

    for (const suite of testSuites) {
      if (!suite) {
        continue;
      }

      // Apply filter if specified
      if (!this.matchesFilter(suite.name, options.filter)) {
        safeLogger.info(
          `Skipping test suite "${suite.name}" (doesn't match filter "${options.filter}")`
        );
        this.stats.skipped++;
        continue;
      }

      await this.runTestSuite(suite);
    }
  }

  /**
   * Runs plugin tests (only when in a plugin directory)
   */
  private async runPluginTests(options: TestOptions) {
    // Skip plugin tests if we're not in a plugin directory
    if (options.skipPlugins) {
      return;
    }

    // Only run plugin tests when we're actually in a plugin directory
    if (this.isDirectPluginTest) {
      safeLogger.info('\nRunning plugin tests...');

      // When directly testing a plugin, we test only that plugin
      const plugin = this.pluginUnderTest;
      if (!plugin || !plugin.tests) {
        safeLogger.info(`No tests found for this plugin (${plugin?.name || 'unknown plugin'})`);
        safeLogger.info(
          "To add tests to your plugin, include a 'tests' property with an array of test suites."
        );
        safeLogger.info('Example:');
        safeLogger.info(`
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

      safeLogger.info(`Found test suites for plugin: ${plugin.name}`);

      // Handle both single suite and array of suites
      const testSuites = Array.isArray(plugin.tests) ? plugin.tests : [plugin.tests];

      for (const suite of testSuites) {
        if (!suite) {
          continue;
        }

        // Apply filter if specified
        if (!this.matchesFilter(suite.name, options.filter)) {
          safeLogger.info(
            `Skipping test suite "${suite.name}" because it doesn't match filter "${options.filter}"`
          );
          this.stats.skipped++;
          continue;
        }

        await this.runTestSuite(suite);
      }
    } else {
      // This should not happen in the new logic since we properly scope tests by directory type
      safeLogger.info('Plugin tests were requested but this is not a direct plugin test');
    }
  }

  /**
   * Runs tests from the e2e directory
   */
  private async runE2eTests(options: TestOptions) {
    if (options.skipE2eTests) {
      safeLogger.info('Skipping e2e tests (--skip-e2e-tests flag)');
      return;
    }

    try {
      // Check for e2e directory
      const e2eDir = path.join(process.cwd(), 'e2e');
      if (!fs.existsSync(e2eDir)) {
        safeLogger.debug('No e2e directory found, skipping e2e tests');
        return;
      }

      safeLogger.info('\nRunning e2e tests...');

      // Get all .ts files in the e2e directory
      const walk = (dir: string): string[] =>
        fs
          .readdirSync(dir, { withFileTypes: true })
          .flatMap((entry) =>
            entry.isDirectory()
              ? walk(path.join(dir, entry.name))
              : entry.name.match(/\.test\.(t|j)sx?$/)
                ? [path.join(dir, entry.name)]
                : []
          );
      const testFiles = walk(e2eDir);

      if (testFiles.length === 0) {
        safeLogger.info('No e2e test files found');
        return;
      }

      safeLogger.info(`Found ${testFiles.length} e2e test files`);

      // Check if we have compiled dist versions
      const distE2eDir = path.join(process.cwd(), 'dist', 'e2e');
      const hasDistE2e = fs.existsSync(distE2eDir);

      // Load and run each test file
      for (const testFile of testFiles) {
        try {
          // Get the file name for logging
          const fileName = path.basename(testFile);
          const fileNameWithoutExt = path.basename(testFile, '.test.ts');
          safeLogger.info(`Loading test file: ${fileName}`);

          // Check if we should try to load from the dist directory instead
          let moduleImportPath = testFile;
          if (hasDistE2e) {
            // Try to find a .js version in dist/e2e
            const distFile = path.join(distE2eDir, `${fileNameWithoutExt}.test.js`);
            if (fs.existsSync(distFile)) {
              moduleImportPath = distFile;
              safeLogger.debug(`Using compiled version from ${distFile}`);
            } else {
              // Fall back to TS file, which might fail
              safeLogger.warn(
                `No compiled version found for ${fileName}, attempting to import TypeScript directly (may fail)`
              );
            }
          } else {
            safeLogger.warn(
              `No dist/e2e directory found. E2E tests should be compiled first. Import may fail.`
            );
          }

          // Dynamic import the test file
          let testModule;
          try {
            testModule = await import(pathToFileURL(moduleImportPath).href);
          } catch (importError) {
            safeLogger.error(`Failed to import test file ${fileName}:`, importError);
            safeLogger.info(
              `Make sure your e2e tests are properly compiled with 'npm run build' or 'bun run build'`
            );
            this.stats.failed++;
            continue;
          }

          // Get the default export which should be a TestSuite
          const testSuite = testModule.default;

          if (!testSuite || !testSuite.tests) {
            safeLogger.warn(`No valid test suite found in ${fileName}`);
            continue;
          }

          // Apply filter if specified - match against either file name or suite name
          if (options.filter) {
            // Process filter name - this should be pre-processed by the command
            const processedFilter = options.filter;

            // First try direct comparison with the filename (without extension)
            const matchesFileName =
              fileNameWithoutExt.toLowerCase() === processedFilter.toLowerCase() ||
              fileNameWithoutExt.toLowerCase().includes(processedFilter.toLowerCase());

            // Try substring match on suite name (case insensitive for better usability)
            const matchesSuiteName = testSuite.name
              ? testSuite.name.toLowerCase().includes(processedFilter.toLowerCase())
              : false;

            if (!matchesFileName && !matchesSuiteName) {
              safeLogger.info(
                `Skipping test suite "${testSuite.name || 'unnamed'}" in ${fileName} (doesn't match filter "${options.filter}")`
              );
              this.stats.skipped++;
              continue;
            }
          }

          // Run the test suite
          await this.runTestSuite(testSuite);
        } catch (error) {
          safeLogger.error(`Error running tests from ${testFile}:`, error);
          this.stats.failed++;
        }
      }
    } catch (error) {
      safeLogger.error(`Error running e2e tests:`, error);
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
    if (!this.stats.hasTests) {
      safeLogger.info('\nNo test files found, exiting with code 0');
    } else {
      safeLogger.info(
        `\nTest Summary: ${this.stats.passed} passed, ${this.stats.failed} failed, ${this.stats.skipped} skipped`
      );
    }

    return this.stats;
  }
}
