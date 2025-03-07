import type { TestCase } from "@elizaos/core";
import {
	AgentRuntime,
	logger,
	stringToUuid,
	type Character,
	type IAgentRuntime,
	type TestSuite,
} from "@elizaos/core";
import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, it } from "vitest";
import project from "./index";
dotenv.config({ path: "../../.env" });

const TEST_TIMEOUT = 300000;

const defaultCharacter: Character = project.agents[0].character;

const elizaOpenAIFirst: Character = {
  ...project.agents[0].character,
  name: "ElizaOpenAIFirst",
  plugins: [
    "@elizaos/plugin-openai", // OpenAI first, embedding size = 1536
    "@elizaos/plugin-elevenlabs",
    "@elizaos/plugin-node",
  ],
};

const agentRuntimes = new Map<string, IAgentRuntime>();

// Initialize runtime for a character
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

    const envPath = path.join(process.cwd(), ".env");

    // try to read a file in the current directory titled .env
    let postgresUrl = null;
    // Try to find .env file by recursively checking parent directories
    let currentPath = envPath;
    let depth = 0;
    const maxDepth = 10;

    while (depth < maxDepth && currentPath.includes(path.sep)) {
      if (fs.existsSync(currentPath)) {
        const env = fs.readFileSync(currentPath, "utf8");
        const envVars = env.split("\n").filter((line) => line.trim() !== "");
        const postgresUrlLine = envVars.find((line) =>
          line.startsWith("POSTGRES_URL=")
        );
        if (postgresUrlLine) {
          postgresUrl = postgresUrlLine.split("=")[1].trim();
          break;
        }
      }

      // Move up one directory by getting the parent directory path
      // First get the directory containing the current .env file
      const currentDir = path.dirname(currentPath);
      // Then move up one directory from there
      const parentDir = path.dirname(currentDir);
      currentPath = path.join(parentDir, ".env");
      depth++;
    }

    // Implement the database directory setup logic
    let dataDir = "./elizadb"; // Default fallback path
    try {
      // 1. Get the user's home directory
      const homeDir = os.homedir();
      const elizaDir = path.join(homeDir, ".eliza");
      const elizaDbDir = path.join(elizaDir, "db");

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
        "Failed to create database directory in home directory, using fallback location:",
        error
      );
      // 9. On failure, use the fallback path
    }

    const options = {
      dataDir: dataDir,
      postgresUrl,
    };

    const drizzleAdapter = await import("@elizaos/plugin-sql");
    const adapter = drizzleAdapter.createDatabaseAdapter(
      options,
      runtime.agentId
    );
    if (!adapter) {
      throw new Error("No database adapter found in default drizzle plugin");
    }
    runtime.registerDatabaseAdapter(adapter);

    // Make sure character exists in database
    await runtime.getDatabaseAdapter().ensureAgentExists(character);

    while (true) {
      try {
        await adapter.getAgent(runtime.agentId);
        break;
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        logger.error("Waiting for tables to be created...");
      }
    }

    await runtime.initialize();

    logger.info(`Test runtime initialized for ${character.name}`);

    // Log expected embedding dimension based on plugins
    const hasOpenAIFirst = character.plugins[0] === "@elizaos/plugin-openai";
    const expectedDimension = hasOpenAIFirst ? 1536 : 384;
    logger.info(
      `Expected embedding dimension for ${character.name}: ${expectedDimension}`
    );
    return runtime;
  } catch (error) {
    logger.error(
      `Failed to initialize test runtime for ${character.name}:`,
      error
    );
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
describe("Multi-Character Plugin Tests", () => {
  it(
    "should run tests for Default Character",
    async () => {
      const runtime = agentRuntimes.get(defaultCharacter.name);
      if (!runtime) throw new Error("Runtime not found for Default Character");

      const testRunner = new TestRunner(runtime);
      await testRunner.runPluginTests();
    },
    TEST_TIMEOUT
  );

  it(
    "should run tests for ElizaOpenAIFirst (1536 dimension)",
    async () => {
      const runtime = agentRuntimes.get("ElizaOpenAIFirst");
      if (!runtime) throw new Error("Runtime not found for ElizaOpenAIFirst");

      const testRunner = new TestRunner(runtime);
      await testRunner.runPluginTests();
    },
    TEST_TIMEOUT
  );
});

interface TestStats {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

interface TestResult {
  file: string;
  suite: string;
  name: string;
  status: "passed" | "failed";
  error?: Error;
}

enum TestStatus {
  Passed = "passed",
  Failed = "failed",
}

class TestRunner {
  private runtime: IAgentRuntime;
  private stats: TestStats;
  private testResults: Map<string, TestResult[]> = new Map();

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    this.stats = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    };
  }

  private async runTestCase(
    test: TestCase,
    file: string,
    suite: string
  ): Promise<void> {
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

  private async runTestSuite(suite: TestSuite, file: string): Promise<void> {
    logger.info(`\nTest suite: ${suite.name}`);
    for (const test of suite.tests) {
      this.stats.total++;
      await this.runTestCase(test, file, suite.name);
    }
  }

  public async runPluginTests(): Promise<TestStats> {
    const plugins = this.runtime.plugins;

    for (const plugin of plugins) {
      try {
        logger.info(`Running tests for plugin: ${plugin.name}`);
        const pluginTests = plugin.tests;
        // Handle both single suite and array of suites
        const testSuites = Array.isArray(pluginTests)
          ? pluginTests
          : [pluginTests];

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
      throw new Error("An error occurred during plugin tests.");
    }
    return this.stats;
  }

  private logTestSummary(): void {
    const COLORS = {
      reset: "\x1b[0m",
      red: "\x1b[31m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      blue: "\x1b[34m",
      magenta: "\x1b[35m",
      cyan: "\x1b[36m",
      gray: "\x1b[90m",
      bold: "\x1b[1m",
      underline: "\x1b[4m",
    };

    const colorize = (
      text: string,
      color: keyof typeof COLORS,
      bold = false
    ): string => {
      return `${bold ? COLORS.bold : ""}${COLORS[color]}${text}${COLORS.reset}`;
    };

    const printSectionHeader = (title: string, color: keyof typeof COLORS) => {
      console.log(
        colorize(
          `\n${"⎯".repeat(25)}  ${title} ${"⎯".repeat(25)}\n`,
          color,
          true
        )
      );
    };

    const printTestSuiteSummary = () => {
      printSectionHeader("Test Suites", "cyan");

      let failedTestSuites = 0;
      this.testResults.forEach((tests, file) => {
        const failed = tests.filter((t) => t.status === "failed").length;
        const total = tests.length;

        if (failed > 0) {
          failedTestSuites++;
          console.log(` ${colorize("❯", "yellow")} ${file} (${total})`);
        } else {
          console.log(` ${colorize("✓", "green")} ${file} (${total})`);
        }

        const groupedBySuite = new Map<string, TestResult[]>();
        tests.forEach((t) => {
          if (!groupedBySuite.has(t.suite)) {
            groupedBySuite.set(t.suite, []);
          }
          groupedBySuite.get(t.suite)?.push(t);
        });

        groupedBySuite.forEach((suiteTests, suite) => {
          const failed = suiteTests.filter((t) => t.status === "failed").length;
          if (failed > 0) {
            console.log(
              `   ${colorize("❯", "yellow")} ${suite} (${suiteTests.length})`
            );
            suiteTests.forEach((test) => {
              const symbol =
                test.status === "passed"
                  ? colorize("✓", "green")
                  : colorize("×", "red");
              console.log(`     ${symbol} ${test.name}`);
            });
          } else {
            console.log(
              `   ${colorize("✓", "green")} ${suite} (${suiteTests.length})`
            );
          }
        });
      });

      return failedTestSuites;
    };

    const printFailedTests = () => {
      printSectionHeader("Failed Tests", "red");

      this.testResults.forEach((tests) => {
        tests.forEach((test) => {
          if (test.status === "failed") {
            console.log(
              ` ${colorize("FAIL", "red")} ${test.file} > ${test.suite} > ${
                test.name
              }`
            );
            console.log(
              ` ${colorize(`AssertionError: ${test.error?.message}`, "red")}`
            );
            console.log(`\n${colorize("⎯".repeat(66), "red")}\n`);
          }
        });
      });
    };

    const printTestSummary = (failedTestSuites: number) => {
      printSectionHeader("Test Summary", "cyan");

      console.log(
        ` ${colorize("Test Suites:", "gray")} ${
          failedTestSuites > 0
            ? colorize(`${failedTestSuites} failed | `, "red")
            : ""
        }${colorize(
          `${this.testResults.size - failedTestSuites} passed`,
          "green"
        )} (${this.testResults.size})`
      );
      console.log(
        ` ${colorize("      Tests:", "gray")} ${
          this.stats.failed > 0
            ? colorize(`${this.stats.failed} failed | `, "red")
            : ""
        }${colorize(`${this.stats.passed} passed`, "green")} (${
          this.stats.total
        })`
      );
    };

    const failedTestSuites = printTestSuiteSummary();
    if (this.stats.failed > 0) {
      printFailedTests();
    }
    printTestSummary(failedTestSuites);
  }
}
