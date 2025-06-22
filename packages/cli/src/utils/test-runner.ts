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

// Create a simple console-based logger for tests to avoid pino issues
const createTestLogger = () => {
  const log = (level: string, message: string, ...args: any[]) => {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] ${level}:`;
    console.log(prefix, message, ...args);
  };

  return {
    info: (message: string, ...args: any[]) => log('INFO', message, ...args),
    warn: (message: string, ...args: any[]) => log('WARN', message, ...args),
    error: (message: string, ...args: any[]) => log('ERROR', message, ...args),
    debug: (message: string, ...args: any[]) => log('DEBUG', message, ...args),
    success: (message: string, ...args: any[]) => log('SUCCESS', message, ...args),
    log: (message: string, ...args: any[]) => log('LOG', message, ...args),
  };
};

export class TestRunner {
  private runtime: IAgentRuntime;
  private projectAgent?: ProjectAgent;
  private stats: TestStats;
  private isDirectPluginTest: boolean;
  private pluginUnderTest?: Plugin;
  private logger: ReturnType<typeof createTestLogger>;

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
    
    // Use a simple console logger for tests to avoid pino initialization issues
    this.logger = createTestLogger();

    const isTestingPlugin = process.env.ELIZA_TESTING_PLUGIN === 'true';

    if (isTestingPlugin && projectAgent?.plugins) {
      let foundPlugin: Plugin | undefined;
      try {
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
          const currentPackageName = pkg.name;
          // Find the loaded plugin that matches the package name
          foundPlugin = projectAgent.plugins.find((p) => p.name === currentPackageName);
        }
      } catch (error) {
        this.logger.warn(`Could not read package.json to determine plugin under test: ${error}`);
      }

      // Fallback for safety, but the above should be primary
      if (!foundPlugin) {
        const corePlugins = ['@elizaos/plugin-sql', 'bootstrap', 'openai'];
        const nonCorePlugins = projectAgent.plugins.filter(
          (plugin) => !corePlugins.includes(plugin.name)
        );
        if (nonCorePlugins.length > 0) {
          foundPlugin = nonCorePlugins[0];
        }
      }

      if (foundPlugin) {
        this.pluginUnderTest = foundPlugin;
        this.isDirectPluginTest = true;
        this.logger.debug(
          `Direct plugin test detected - running tests for: ${this.pluginUnderTest.name}`
        );
      } else {
        this.isDirectPluginTest = false;
      }
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
    this.logger.info(`\nRunning test suite: ${suite.name}`);

    if (suite.tests.length > 0) {
      this.stats.hasTests = true; // Mark that we found tests
    }

    for (const test of suite.tests) {
      this.stats.total++;

      try {
        this.logger.info(`  Running test: ${test.name}`);
        await test.fn(this.runtime);
        this.stats.passed++;
        this.logger.success(`  [✓] ${test.name}`);
      } catch (error) {
        this.stats.failed++;
        this.logger.error(`  [X] ${test.name}`);
        this.logger.error(`    ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Runs project agent tests
   */
  private async runProjectTests(options: TestOptions) {
    if (!this.projectAgent?.tests || options.skipProjectTests || this.isDirectPluginTest) {
      if (this.isDirectPluginTest) {
        this.logger.info('Skipping project tests when directly testing a plugin');
      }
      return;
    }

    this.logger.info('\nRunning project tests...');

    const testSuites = Array.isArray(this.projectAgent.tests)
      ? this.projectAgent.tests
      : [this.projectAgent.tests];

    for (const suite of testSuites) {
      if (!suite) {
        continue;
      }

      // Apply filter if specified
      if (!this.matchesFilter(suite.name, options.filter)) {
        this.logger.info(
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
      this.logger.info('\nRunning plugin tests...');

      // When directly testing a plugin, we test only that plugin
      const plugin = this.pluginUnderTest;
      if (!plugin || !plugin.tests || (Array.isArray(plugin.tests) && plugin.tests.length === 0)) {
        this.logger.error(`No tests found for plugin: ${plugin?.name || 'unknown plugin'}`);
        this.logger.info(
          "To add tests to your plugin, include a 'tests' property with an array of test suites."
        );
        this.logger.info('Example:');
        this.logger.info(`
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
        // Mark as having tests but failed so we exit with error
        this.stats.hasTests = true;
        this.stats.failed = 1;
        return;
      }

      this.logger.info(`Found test suites for plugin: ${plugin.name}`);

      // Handle both single suite and array of suites
      const testSuites = Array.isArray(plugin.tests) ? plugin.tests : [plugin.tests];

      for (const suite of testSuites) {
        if (!suite) {
          continue;
        }

        // Apply filter if specified
        if (!this.matchesFilter(suite.name, options.filter)) {
          this.logger.info(
            `Skipping test suite "${suite.name}" because it doesn't match filter "${options.filter}"`
          );
          this.stats.skipped++;
          continue;
        }

        await this.runTestSuite(suite);
      }
    } else {
      // This should not happen in the new logic since we properly scope tests by directory type
      this.logger.info('Plugin tests were requested but this is not a direct plugin test');
    }
  }

  /**
   * Runs tests from the e2e directory
   */
  private async runE2eTests(options: TestOptions) {
    if (options.skipE2eTests) {
      this.logger.info('Skipping e2e tests (--skip-e2e-tests flag)');
      return;
    }

    try {
      // Check for e2e directory
      const e2eDir = path.join(process.cwd(), 'e2e');
      if (!fs.existsSync(e2eDir)) {
        this.logger.debug('No e2e directory found, skipping e2e tests');
        return;
      }

      this.logger.info('\nRunning e2e tests...');

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
        this.logger.info('No e2e test files found');
        return;
      }

      this.logger.info(`Found ${testFiles.length} e2e test files`);

      // Check if we have compiled dist versions
      const distE2eDir = path.join(process.cwd(), 'dist', 'e2e');
      const hasDistE2e = fs.existsSync(distE2eDir);

      // Load and run each test file
      for (const testFile of testFiles) {
        try {
          // Get the file name for logging
          const fileName = path.basename(testFile);
          const fileNameWithoutExt = path.basename(testFile, '.test.ts');
          this.logger.info(`Loading test file: ${fileName}`);

          // Check if we should try to load from the dist directory instead
          let moduleImportPath = testFile;
          if (hasDistE2e) {
            // Try to find a .js version in dist/e2e
            const distFile = path.join(distE2eDir, `${fileNameWithoutExt}.test.js`);
            if (fs.existsSync(distFile)) {
              moduleImportPath = distFile;
              this.logger.debug(`Using compiled version from ${distFile}`);
            } else {
              // Fall back to TS file, which might fail
              this.logger.warn(
                `No compiled version found for ${fileName}, attempting to import TypeScript directly (may fail)`
              );
            }
          } else {
            this.logger.warn(
              `No dist/e2e directory found. E2E tests should be compiled first. Import may fail.`
            );
          }

          // Dynamic import the test file
          let testModule;
          try {
            testModule = await import(pathToFileURL(moduleImportPath).href);
          } catch (importError) {
            this.logger.error(`Failed to import test file ${fileName}:`, importError);
            this.logger.info(
              `Make sure your e2e tests are properly compiled with 'npm run build' or 'bun run build'`
            );
            this.stats.failed++;
            continue;
          }

          // Get the default export which should be a TestSuite
          const testSuite = testModule.default;

          if (!testSuite || !testSuite.tests) {
            this.logger.warn(`No valid test suite found in ${fileName}`);
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
              this.logger.info(
                `Skipping test suite "${testSuite.name || 'unnamed'}" in ${fileName} (doesn't match filter "${options.filter}")`
              );
              this.stats.skipped++;
              continue;
            }
          }

          // Run the test suite
          await this.runTestSuite(testSuite);
        } catch (error) {
          this.logger.error(`Error running tests from ${testFile}:`, error);
          this.stats.failed++;
        }
      }
    } catch (error) {
      this.logger.error(`Error running e2e tests:`, error);
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
      this.logger.info('\nNo test files found, exiting with code 0');
    } else if (this.isDirectPluginTest && this.stats.failed === 1 && this.stats.total === 0) {
      // Special case: plugin has no tests defined
      this.logger.error('\nTest Summary: Plugin has no tests defined. Please add tests to your plugin.');
    } else {
      this.logger.info(
        `\nTest Summary: ${this.stats.passed} passed, ${this.stats.failed} failed, ${this.stats.skipped} skipped`
      );
    }

    return this.stats;
  }
}
