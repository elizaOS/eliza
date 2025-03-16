import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestCase } from '@elizaos/core';
import {
  AgentRuntime,
  type Character,
  type IAgentRuntime,
  type TestSuite,
  logger,
  stringToUuid,
} from '@elizaos/core';
import dotenv from 'dotenv';
import { afterAll, beforeAll, describe, it } from 'vitest';
import project from './index';
dotenv.config({ path: '../../.env' });

const TEST_TIMEOUT = 300000;

const defaultCharacter: Character = project.agents[0].character;

const elizaOpenAIFirst: Character = {
  ...project.agents[0].character,
  name: 'ElizaOpenAIFirst',
  plugins: [
    '@elizaos/plugin-sql',
    '@elizaos/plugin-openai', // OpenAI first, embedding size = 1536
    '@elizaos/plugin-elevenlabs',
    '@elizaos/plugin-pdf',
    '@elizaos/plugin-video-understanding',
    '@elizaos/plugin-storage-s3',
  ],
};

const agentRuntimes = new Map<string, IAgentRuntime>();

// Initialize runtime for a character
/**
 * Asynchronously initializes the runtime for a given character with the provided configuration.
 *
 * @param {Character} character - The character for which the runtime is being initialized.
 * @returns {Promise<IAgentRuntime>} A promise that resolves to the initialized agent runtime.
 */
async function initializeRuntime(character: Character): Promise<IAgentRuntime> {
  try {
    character.id = stringToUuid(character.name);

    const runtime = new AgentRuntime({
      character,
      fetch: async (url: string, options: any) => {
        logger.debug(`Test fetch: ${url}`);
        return fetch(url, options);
      },
    });

    const envPath = path.join(process.cwd(), '.env');

    // try to read a file in the current directory titled .env
    let postgresUrl = null;
    // Try to find .env file by recursively checking parent directories
    let currentPath = envPath;
    let depth = 0;
    const maxDepth = 10;

    while (depth < maxDepth && currentPath.includes(path.sep)) {
      if (fs.existsSync(currentPath)) {
        const env = fs.readFileSync(currentPath, 'utf8');
        const envVars = env.split('\n').filter((line) => line.trim() !== '');
        const postgresUrlLine = envVars.find((line) => line.startsWith('POSTGRES_URL='));
        if (postgresUrlLine) {
          postgresUrl = postgresUrlLine.split('=')[1].trim();
          break;
        }
      }

      // Move up one directory by getting the parent directory path
      // First get the directory containing the current .env file
      const currentDir = path.dirname(currentPath);
      // Then move up one directory from there
      const parentDir = path.dirname(currentDir);
      currentPath = path.join(parentDir, '.env');
      depth++;
    }

    // Implement the database directory setup logic
    let dataDir = './elizadb'; // Default fallback path
    try {
      // 1. Get the user's home directory
      const homeDir = os.homedir();
      const elizaDir = path.join(homeDir, '.eliza');
      const elizaDbDir = path.join(elizaDir, 'db');

      // Debug information
      console.log(`Setting up database directory at: ${elizaDbDir}`);

      // 2 & 3. Check if .eliza directory exists, create if not
      if (!fs.existsSync(elizaDir)) {
        console.log(`Creating .eliza directory at: ${elizaDir}`);
        fs.mkdirSync(elizaDir, { recursive: true });
      }

      // 4 & 5. Check if db directory exists in .eliza, create if not
      if (!fs.existsSync(elizaDbDir)) {
        console.log(`Creating db directory at: ${elizaDbDir}`);
        fs.mkdirSync(elizaDbDir, { recursive: true });
      }

      // 6, 7 & 8. Use the db directory
      dataDir = elizaDbDir;
      console.log(`Using database directory: ${dataDir}`);
    } catch (error) {
      console.warn(
        'Failed to create database directory in home directory, using fallback location:',
        error
      );
      // 9. On failure, use the fallback path
    }

    const options = {
      dataDir: dataDir,
      postgresUrl,
    };

    const drizzleAdapter = await import('@elizaos/plugin-sql');
    const adapter = drizzleAdapter.createDatabaseAdapter(options, runtime.agentId);
    if (!adapter) {
      throw new Error('No database adapter found in default drizzle plugin');
    }
    runtime.registerDatabaseAdapter(adapter);

    // Make sure character exists in database
    await runtime.ensureAgentExists(character);

    while (true) {
      try {
        await adapter.getAgent(runtime.agentId);
        break;
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        logger.error('Waiting for tables to be created...');
      }
    }

    await runtime.initialize();

    logger.info(`Test runtime initialized for ${character.name}`);

    // Log expected embedding dimension based on plugins
    const hasOpenAIFirst = character.plugins[0] === '@elizaos/plugin-openai';
    const expectedDimension = hasOpenAIFirst ? 1536 : 384;
    logger.info(`Expected embedding dimension for ${character.name}: ${expectedDimension}`);
    return runtime;
  } catch (error) {
    logger.error(`Failed to initialize test runtime for ${character.name}:`, error);
    throw error;
  }
}

// Initialize the runtimes
beforeAll(async () => {
  const characters = [defaultCharacter, elizaOpenAIFirst];

  for (const character of characters) {
    const config = await initializeRuntime(character);
    agentRuntimes.set(character.name, config);
  }
}, TEST_TIMEOUT);

// Cleanup after all tests
afterAll(async () => {
  for (const [characterName] of agentRuntimes.entries()) {
    try {
      logger.info(`Cleaned up ${characterName}`);
    } catch (error) {
      logger.error(`Error during cleanup for ${characterName}:`, error);
    }
  }
});

// Test suite for each character
describe('Multi-Character Plugin Tests', () => {
  it(
    'should run tests for Default Character',
    async () => {
      const runtime = agentRuntimes.get(defaultCharacter.name);
      if (!runtime) throw new Error('Runtime not found for Default Character');

      const testRunner = new TestRunner(runtime);
      await testRunner.runPluginTests();
    },
    TEST_TIMEOUT
  );

  it(
    'should run tests for ElizaOpenAIFirst (1536 dimension)',
    async () => {
      const runtime = agentRuntimes.get('ElizaOpenAIFirst');
      if (!runtime) throw new Error('Runtime not found for ElizaOpenAIFirst');

      const testRunner = new TestRunner(runtime);
      await testRunner.runPluginTests();
    },
    TEST_TIMEOUT
  );
});

/**
 * Interface representing test statistics.
 * @interface
 * @property {number} total - Total number of tests.
 * @property {number} passed - Number of tests that passed.
 * @property {number} failed - Number of tests that failed.
 * @property {number} skipped - Number of tests that were skipped.
 */
interface TestStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * Represents the result of a test.
 * @typedef {Object} TestResult
 * @property {string} file - The file where the test was executed.
 * @property {string} suite - The test suite name.
 * @property {string} name - The name of the test.
 * @property {"passed" | "failed"} status - The status of the test, can be either "passed" or "failed".
 * @property {Error} [error] - Optional error object if the test failed.
 */
interface TestResult {
  file: string;
  suite: string;
  name: string;
  status: 'passed' | 'failed';
  error?: Error;
}

/**
 * Enumeration representing the status of a test.
 * @enum {string}
 * @readonly
 * @property {string} Passed - Indicates that the test has passed.
 * @property {string} Failed - Indicates that the test has failed.
 */
enum TestStatus {
  Passed = 'passed',
  Failed = 'failed',
}

/**
 * TestRunner class for running plugin tests and handling test results.
 * * @class TestRunner
 */
class TestRunner {
  private runtime: IAgentRuntime;
  private stats: TestStats;
  private testResults: Map<string, TestResult[]> = new Map();

  /**
   * Constructor function for creating a new instance of the class.
   *
   * @param {IAgentRuntime} runtime - The runtime environment for the agent.
   */
  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.stats = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    };
  }

  /**
   * Asynchronously runs a test case and updates the test results accordingly.
   *
   * @param {TestCase} test - The test case to run.
   * @param {string} file - The file the test case belongs to.
   * @param {string} suite - The suite the test case belongs to.
   * @returns {Promise<void>} - A Promise that resolves once the test case has been run.
   */
  private async runTestCase(test: TestCase, file: string, suite: string): Promise<void> {
    const startTime = performance.now();
    try {
      await test.fn(this.runtime);
      this.stats.passed++;
      const duration = performance.now() - startTime;
      logger.info(`✓ ${test.name} (${Math.round(duration)}ms)`);
      this.addTestResult(file, suite, test.name, TestStatus.Passed);
    } catch (error) {
      this.stats.failed++;
      logger.error(`✗ ${test.name}`);
      logger.error(error);
      this.addTestResult(file, suite, test.name, TestStatus.Failed, error);
    }
  }

  /**
   * Add a test result to the testResults map.
   * @param {string} file - The file being tested.
   * @param {string} suite - The test suite name.
   * @param {string} name - The test name.
   * @param {TestStatus} status - The status of the test (passed, failed, skipped, etc.).
   * @param {Error} [error] - The error object if the test failed.
   */
  private addTestResult(
    file: string,
    suite: string,
    name: string,
    status: TestStatus,
    error?: Error
  ) {
    if (!this.testResults.has(file)) {
      this.testResults.set(file, []);
    }
    this.testResults.get(file)?.push({ file, suite, name, status, error });
  }

  /**
   * Runs a test suite, logging the name of the suite and running each test case.
   *
   * @param {TestSuite} suite - The test suite to run.
   * @param {string} file - The file containing the test suite.
   * @returns {Promise<void>}
   */
  private async runTestSuite(suite: TestSuite, file: string): Promise<void> {
    logger.info(`\nTest suite: ${suite.name}`);
    for (const test of suite.tests) {
      this.stats.total++;
      await this.runTestCase(test, file, suite.name);
    }
  }

  /**
   * Runs tests for all plugins in the runtime and returns the test statistics.
   * @returns {Promise<TestStats>} The test statistics object.
   */
  public async runPluginTests(): Promise<TestStats> {
    console.log('*** Running plugin tests...');
    const plugins = this.runtime.plugins;

    for (const plugin of plugins) {
      try {
        logger.info(`Running tests for plugin: ${plugin.name}`);
        const pluginTests = plugin.tests;
        // Handle both single suite and array of suites
        const testSuites = Array.isArray(pluginTests) ? pluginTests : [pluginTests];

        for (const suite of testSuites) {
          if (suite) {
            const fileName = `${plugin.name} test suite`;
            await this.runTestSuite(suite, fileName);
          }
        }
      } catch (error) {
        logger.error(`Error in plugin ${plugin.name}:`, error);
        throw error;
      }
    }

    this.logTestSummary();
    if (this.stats.failed > 0) {
      throw new Error('An error occurred during plugin tests.');
    }
    return this.stats;
  }

  /**
   * Logs the summary of test results in the console with colors for each section.
   */
  private logTestSummary(): void {
    const COLORS = {
      reset: '\x1b[0m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      magenta: '\x1b[35m',
      cyan: '\x1b[36m',
      gray: '\x1b[90m',
      bold: '\x1b[1m',
      underline: '\x1b[4m',
    };

    const colorize = (text: string, color: keyof typeof COLORS, bold = false): string => {
      return `${bold ? COLORS.bold : ''}${COLORS[color]}${text}${COLORS.reset}`;
    };

    const printSectionHeader = (title: string, color: keyof typeof COLORS) => {
      console.log(colorize(`\n${'⎯'.repeat(25)}  ${title} ${'⎯'.repeat(25)}\n`, color, true));
    };

    const printTestSuiteSummary = () => {
      printSectionHeader('Test Suites', 'cyan');

      let failedTestSuites = 0;
      this.testResults.forEach((tests, file) => {
        const failed = tests.filter((t) => t.status === 'failed').length;
        const total = tests.length;

        if (failed > 0) {
          failedTestSuites++;
          console.log(` ${colorize('❯', 'yellow')} ${file} (${total})`);
        } else {
          console.log(` ${colorize('✓', 'green')} ${file} (${total})`);
        }

        const groupedBySuite = new Map<string, TestResult[]>();
        tests.forEach((t) => {
          if (!groupedBySuite.has(t.suite)) {
            groupedBySuite.set(t.suite, []);
          }
          groupedBySuite.get(t.suite)?.push(t);
        });

        groupedBySuite.forEach((suiteTests, suite) => {
          const failed = suiteTests.filter((t) => t.status === 'failed').length;
          if (failed > 0) {
            console.log(`   ${colorize('❯', 'yellow')} ${suite} (${suiteTests.length})`);
            suiteTests.forEach((test) => {
              const symbol =
                test.status === 'passed' ? colorize('✓', 'green') : colorize('×', 'red');
              console.log(`     ${symbol} ${test.name}`);
            });
          } else {
            console.log(`   ${colorize('✓', 'green')} ${suite} (${suiteTests.length})`);
          }
        });
      });

      return failedTestSuites;
    };

    const printFailedTests = () => {
      printSectionHeader('Failed Tests', 'red');

      this.testResults.forEach((tests) => {
        tests.forEach((test) => {
          if (test.status === 'failed') {
            console.log(` ${colorize('FAIL', 'red')} ${test.file} > ${test.suite} > ${test.name}`);
            console.log(` ${colorize(`AssertionError: ${test.error?.message}`, 'red')}`);
            console.log(`\n${colorize('⎯'.repeat(66), 'red')}\n`);
          }
        });
      });
    };

    const printTestSummary = (failedTestSuites: number) => {
      printSectionHeader('Test Summary', 'cyan');

      console.log(
        ` ${colorize('Test Suites:', 'gray')} ${
          failedTestSuites > 0 ? colorize(`${failedTestSuites} failed | `, 'red') : ''
        }${colorize(
          `${this.testResults.size - failedTestSuites} passed`,
          'green'
        )} (${this.testResults.size})`
      );
      console.log(
        ` ${colorize('      Tests:', 'gray')} ${
          this.stats.failed > 0 ? colorize(`${this.stats.failed} failed | `, 'red') : ''
        }${colorize(`${this.stats.passed} passed`, 'green')} (${this.stats.total})`
      );
    };

    const failedTestSuites = printTestSuiteSummary();
    if (this.stats.failed > 0) {
      printFailedTests();
    }
    printTestSummary(failedTestSuites);
  }
}
