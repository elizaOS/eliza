import { type IAgentRuntime, type TestSuite, type ProjectAgent, logger } from "@elizaos/core";

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
}

export class TestRunner {
  private runtime: IAgentRuntime;
  private projectAgent?: ProjectAgent;
  private stats: TestStats;

  constructor(runtime: IAgentRuntime, projectAgent?: ProjectAgent) {
    this.runtime = runtime;
    this.projectAgent = projectAgent;
    this.stats = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0
    };
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
    if (!this.projectAgent?.tests || options.skipProjectTests) {
      return;
    }

    logger.info("\nRunning project tests...");

    const testSuites = Array.isArray(this.projectAgent.tests) 
      ? this.projectAgent.tests 
      : [this.projectAgent.tests];

    for (const suite of testSuites) {
      if (!suite) {
        continue;
      }

      // Apply filter if specified
      if (options.filter && !suite.name.includes(options.filter)) {
        this.stats.skipped++;
        continue;
      }

      await this.runTestSuite(suite);
    }
  }

  /**
   * Runs plugin tests
   */
  private async runPluginTests(options: TestOptions) {
    if (options.skipPlugins) {
      return;
    }

    logger.info("\nRunning plugin tests...");
    const plugins = this.runtime.plugins || [];
    
    for (const plugin of plugins) {
      try {
        const pluginTests = plugin.tests;
        if (!pluginTests) {
          continue;
        }

        // Handle both single suite and array of suites
        const testSuites = Array.isArray(pluginTests) ? pluginTests : [pluginTests];

        for (const suite of testSuites) {
          if (!suite) {
            continue;
          }

          // Apply filter if specified
          if (options.filter && !suite.name.includes(options.filter)) {
            this.stats.skipped++;
            continue;
          }

          await this.runTestSuite(suite);
        }
      } catch (error) {
        logger.error(`Error running tests for plugin ${plugin.name}:`, error);
        this.stats.failed++;
      }
    }
  }

  /**
   * Runs all tests in the project
   * @param options Test options
   */
  async runTests(options: TestOptions = {}): Promise<TestStats> {
    // Run project tests first
    await this.runProjectTests(options);
    
    // Then run plugin tests
    await this.runPluginTests(options);

    return this.stats;
  }
} 