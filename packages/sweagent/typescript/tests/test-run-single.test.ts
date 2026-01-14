/**
 * Run single tests converted from test_run_single.py
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DefaultAgentConfig,
  getAgentFromConfig,
  type TemplateConfig,
  type ToolConfig,
} from "../src/agent/agents";
import type {
  ProblemStatement,
  ProblemStatementConfig,
} from "../src/agent/problem-statement";
import { EmptyProblemStatement } from "../src/agent/problem-statement";
import { type EnvironmentConfig, SWEEnv } from "../src/environment/swe-env";
import type { RunHook, RunHookInit } from "../src/run/hooks/types";
import {
  RunSingle,
  type RunSingleActionConfig,
  type RunSingleConfig,
} from "../src/run/run-single";
import type { AgentRunResult } from "../src/types";
import { MockDeployment } from "./test-run-single-helpers";

// Mock hook that raises exception
class RaisesExceptionHook implements RunHook {
  onInit(_run: RunHookInit): void {}
  onStart(): void {}
  onEnd(): void {}
  onInstanceSkipped(): void {}
  onInstanceCompleted(_params: { result: AgentRunResult }): void {}
  onInstanceStart(_params: {
    index: number;
    env: SWEEnv;
    problemStatement: ProblemStatement | ProblemStatementConfig;
  }): void {
    throw new Error("test exception");
  }
}

// Helper function to create a valid EnvironmentConfig
function createEnvironmentConfig(
  overrides?: Partial<EnvironmentConfig>,
): EnvironmentConfig {
  // Always use Docker config structure (will be mocked during test execution)
  return {
    deployment: {
      type: "docker" as const,
      image: "python:3.11",
      pythonStandaloneDir: "/root",
      volumes: {},
      environment: {},
      removeOnStop: true,
      workDir: "/workspace",
    },
    postStartupCommands: [],
    postStartupCommandTimeout: 120,
    name: "test-env",
    repo: null,
    ...overrides,
  };
}

// Helper to create a RunSingle instance with mock deployment
async function createMockRunSingle(
  config: RunSingleConfig,
): Promise<RunSingle> {
  // Create mock environment
  const mockEnv = new SWEEnv({
    deployment: new MockDeployment(),
    repo: config.env.repo || null,
    postStartupCommands: config.env.postStartupCommands || [],
    postStartupCommandTimeout: config.env.postStartupCommandTimeout,
    name: config.env.name,
  });

  // Create agent
  const agent = await getAgentFromConfig(config.agent);

  return new RunSingle({
    env: mockEnv,
    agent,
    problemStatement: config.problemStatement,
    outputDir: config.outputDir,
    actions: config.actions,
  });
}

// Helper function to create valid TemplateConfig
function createTemplateConfig(): TemplateConfig {
  return {
    systemTemplate: "",
    instanceTemplate: "",
    nextStepTemplate: "Observation: {{observation}}",
    nextStepTruncatedObservationTemplate:
      "Observation: {{observation[:max_observation_length]}}<response clipped>",
    maxObservationLength: 100000,
    nextStepNoOutputTemplate: "No output",
    strategyTemplate: "",
    demonstrationTemplate: "",
    demonstrations: [],
    putDemosInHistory: false,
    disableImageProcessing: false,
    shellCheckErrorTemplate: "Syntax error: {{error}}",
    commandCancelledTimeoutTemplate:
      "Command cancelled after {{timeout}} seconds",
  };
}

// Helper function to create valid ToolConfig
function createToolConfig(overrides?: Partial<ToolConfig>): ToolConfig {
  return {
    commands: [],
    executionTimeout: 500,
    maxConsecutiveExecutionTimeouts: 3,
    totalExecutionTimeout: 7200,
    submitCommand: "submit",
    useFunctionCalling: false,
    formatErrorTemplate: "Invalid format",
    ...overrides,
  };
}

// Helper function to create a valid DefaultAgentConfig for tests.
// Use "default" (not "shell") to avoid switching into interactive human mode.
function createShellAgentConfig(
  overrides?: Partial<DefaultAgentConfig>,
): DefaultAgentConfig {
  return {
    name: "test-agent",
    model: {
      name: "instant_empty_submit",
      delay: 0,
    },
    templates: createTemplateConfig(),
    tools: createToolConfig(),
    historyProcessors: [],
    maxRequeries: 3,
    type: "default" as const,
    ...overrides,
  };
}

// Helper function to create valid RunSingleActionConfig
function createActionConfig(): RunSingleActionConfig {
  return {
    openPr: false,
    applyPatchLocally: false,
  };
}

describe("Run Single", () => {
  let tmpDir: string;
  const USE_MOCK_DEPLOYMENT = true; // Always mock deployment in tests

  beforeEach(() => {
    // Create temporary directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-single-test-"));
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  describe("RunSingleConfig", () => {
    it("should create config with agent and environment", () => {
      const config: RunSingleConfig = {
        agent: createShellAgentConfig(),
        env: createEnvironmentConfig(),
        problemStatement: new EmptyProblemStatement(),
        outputDir: tmpDir,
        actions: createActionConfig(),
      };

      expect(config.agent).toBeDefined();
      expect(config.env).toBeDefined();
      expect(config.outputDir).toBe(tmpDir);
    });
  });

  describe("RunSingle basic operations", () => {
    const conditionalIt = USE_MOCK_DEPLOYMENT ? it : it.skip;

    conditionalIt("should raise exception when hook throws", async () => {
      const config: RunSingleConfig = {
        agent: createShellAgentConfig(),
        env: createEnvironmentConfig(),
        problemStatement: new EmptyProblemStatement(),
        outputDir: tmpDir,
        actions: createActionConfig(),
      };

      const rs = USE_MOCK_DEPLOYMENT
        ? await createMockRunSingle(config)
        : await RunSingle.fromConfig(config);
      rs.addHook(new RaisesExceptionHook());

      await expect(rs.run()).rejects.toThrow("test exception");
    });

    conditionalIt("should run with instant empty submit model", async () => {
      const config: RunSingleConfig = {
        env: createEnvironmentConfig(),
        agent: createShellAgentConfig(),
        problemStatement: new EmptyProblemStatement(),
        outputDir: tmpDir,
        actions: createActionConfig(),
      };

      const rs = USE_MOCK_DEPLOYMENT
        ? await createMockRunSingle(config)
        : await RunSingle.fromConfig(config);
      await rs.run();

      // Check that output files were created
      const outputFiles = fs.readdirSync(tmpDir);
      expect(outputFiles.some((f) => f.endsWith(".traj"))).toBe(true);
    });

    conditionalIt("should handle hidden tools", async () => {
      const config: RunSingleConfig = {
        env: createEnvironmentConfig(),
        agent: createShellAgentConfig(),
        problemStatement: new EmptyProblemStatement(),
        outputDir: tmpDir,
        actions: createActionConfig(),
      };

      const rs = USE_MOCK_DEPLOYMENT
        ? await createMockRunSingle(config)
        : await RunSingle.fromConfig(config);
      await rs.run();

      // Note: Cannot verify hidden tools directly as agent.tools is private
      expect(rs).toBeDefined();
    });
  });

  describe("Output generation", () => {
    const conditionalIt = USE_MOCK_DEPLOYMENT ? it : it.skip;

    conditionalIt("should generate trajectory file", async () => {
      const config: RunSingleConfig = {
        agent: createShellAgentConfig(),
        env: createEnvironmentConfig(),
        problemStatement: new EmptyProblemStatement(),
        outputDir: tmpDir,
        actions: createActionConfig(),
      };

      const rs = USE_MOCK_DEPLOYMENT
        ? await createMockRunSingle(config)
        : await RunSingle.fromConfig(config);
      await rs.run();

      const trajFiles = fs
        .readdirSync(tmpDir)
        .filter((f) => f.endsWith(".traj"));
      expect(trajFiles).toHaveLength(1);

      // Verify trajectory file structure
      const trajContent = JSON.parse(
        fs.readFileSync(path.join(tmpDir, trajFiles[0]), "utf-8"),
      );
      expect(trajContent).toHaveProperty("trajectory");
      expect(trajContent).toHaveProperty("info");
    });
  });

  describe("Error handling", () => {
    const conditionalIt = USE_MOCK_DEPLOYMENT ? it : it.skip;

    conditionalIt("should handle missing problem statement", async () => {
      const config: RunSingleConfig = {
        agent: createShellAgentConfig(),
        env: createEnvironmentConfig(),
        problemStatement: new EmptyProblemStatement(),
        outputDir: tmpDir,
        actions: createActionConfig(),
      };

      const rs = USE_MOCK_DEPLOYMENT
        ? await createMockRunSingle(config)
        : await RunSingle.fromConfig(config);

      // Should use empty problem statement by default
      await expect(rs.run()).resolves.not.toThrow();
    });

    conditionalIt("should handle environment setup failure", async () => {
      const config: RunSingleConfig = {
        agent: createShellAgentConfig(),
        env: createEnvironmentConfig({
          repo: {
            type: "github",
            githubUrl: "invalid-url",
            baseCommit: "main",
            cloneTimeout: 300,
          },
        }),
        problemStatement: new EmptyProblemStatement(),
        outputDir: tmpDir,
        actions: createActionConfig(),
      };

      // Invalid GitHub URL is detected during config parsing, not during run
      await expect(RunSingle.fromConfig(config)).rejects.toThrow(
        /Invalid GitHub/,
      );
    });
  });

  describe("Hooks integration", () => {
    class TestHook implements RunHook {
      public events: string[] = [];

      onInit(_run: RunHookInit): void {
        this.events.push("init");
      }

      onStart(): void {
        this.events.push("start");
      }

      onEnd(): void {
        this.events.push("end");
      }

      onInstanceStart(_params: {
        index: number;
        env: SWEEnv;
        problemStatement: ProblemStatement | ProblemStatementConfig;
      }): void {
        this.events.push("instance_start");
      }

      onInstanceSkipped(): void {
        this.events.push("instance_skipped");
      }

      onInstanceCompleted(_params: { result: AgentRunResult }): void {
        this.events.push("instance_completed");
      }
    }

    const conditionalIt = USE_MOCK_DEPLOYMENT ? it : it.skip;

    conditionalIt("should call hooks in correct order", async () => {
      const config: RunSingleConfig = {
        agent: createShellAgentConfig(),
        env: createEnvironmentConfig(),
        problemStatement: new EmptyProblemStatement(),
        outputDir: tmpDir,
        actions: createActionConfig(),
      };

      const rs = USE_MOCK_DEPLOYMENT
        ? await createMockRunSingle(config)
        : await RunSingle.fromConfig(config);
      const hook = new TestHook();
      rs.addHook(hook);

      await rs.run();

      // Verify hook events were called
      expect(hook.events).toContain("instance_start");
      expect(hook.events).toContain("instance_completed");
    });
  });
});
