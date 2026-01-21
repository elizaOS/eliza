/**
 * ART Format Validation Tests
 *
 * Validates that our trajectories convert correctly to ART/GRPO format.
 * Based on actual ART tic-tac-toe example structure.
 *
 * Critical: These tests ensure our data works with OpenPipe ART!
 *
 * NOTE: Requires trajectory schema and TrajectoryLoggerService
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type { IAgentRuntime, Logger, UUID } from "@elizaos/core";
import { createUniqueUuid } from "@elizaos/core";
import type { JsonValue } from "../../../types/common";
import {
  extractSharedPrefix,
  groupTrajectories,
  prepareForRULER,
  toARTMessages,
  toARTTrajectory,
  validateARTCompatibility,
} from "../art-format";
import { TrajectoryLoggerService } from "../TrajectoryLoggerService";
import type { Trajectory } from "../types";

// Note: fs, path, and export functions are used in integration tests that are skipped in CI

// Type for stored trajectory in mock database
interface MockTrajectoryData {
  trajectoryId: string;
  scenarioId?: string | null;
  startTime: Date;
  endTime: Date;
  metrics: Record<string, JsonValue>;
  metadata: Record<string, JsonValue>;
  [key: string]: JsonValue | Date | undefined | null;
}

// Type for trajectory creation args
interface TrajectoryCreateArgs {
  data: {
    trajectoryId?: string;
    scenarioId?: string | null;
    startTime: Date | string;
    endTime: Date | string;
    metricsJson?: string;
    metadataJson?: string;
    [key: string]: JsonValue | Date | undefined | null;
  };
}

// Type for trajectory query args
interface TrajectoryQueryArgs {
  where?: {
    trajectoryId?: string | { in: string[] };
    scenarioId?: string | { in: string[] };
  };
  by?: string[];
}

// Store created trajectories for retrieval
const createdTrajectories: MockTrajectoryData[] = [];

// Mock database
const mockDb = {
  trajectory: {
    create: mock(async (args: TrajectoryCreateArgs) => {
      const trajectory: MockTrajectoryData = {
        ...args.data,
        trajectoryId: args.data.trajectoryId || crypto.randomUUID(),
        startTime:
          args.data.startTime instanceof Date
            ? args.data.startTime
            : new Date(args.data.startTime),
        endTime:
          args.data.endTime instanceof Date
            ? args.data.endTime
            : new Date(args.data.endTime),
        metrics: args.data.metricsJson ? JSON.parse(args.data.metricsJson) : {},
        metadata: args.data.metadataJson
          ? JSON.parse(args.data.metadataJson)
          : {},
      };
      createdTrajectories.push(trajectory);
      return trajectory;
    }),
    deleteMany: mock(async () => {
      // clear created trajectories
      // createdTrajectories.length = 0; // don't clear because we might need them for findMany
      return { count: 1 };
    }),
    findUnique: mock(async (args: TrajectoryQueryArgs) => {
      const trajectoryId =
        typeof args.where?.trajectoryId === "string"
          ? args.where.trajectoryId
          : null;
      return (
        createdTrajectories.find((t) => t.trajectoryId === trajectoryId) || null
      );
    }),
    findMany: mock(async (args: TrajectoryQueryArgs) => {
      // Simple filtering mock
      let result = [...createdTrajectories];

      const trajectoryIdFilter = args?.where?.trajectoryId;
      if (
        trajectoryIdFilter &&
        typeof trajectoryIdFilter === "object" &&
        "in" in trajectoryIdFilter
      ) {
        result = result.filter((t) =>
          trajectoryIdFilter.in.includes(t.trajectoryId),
        );
      }

      const scenarioIdFilter = args?.where?.scenarioId;
      if (
        scenarioIdFilter &&
        typeof scenarioIdFilter === "object" &&
        "in" in scenarioIdFilter
      ) {
        result = result.filter(
          (t) => t.scenarioId && scenarioIdFilter.in.includes(t.scenarioId),
        );
      }

      return result;
    }),
    groupBy: mock(async (args: TrajectoryQueryArgs) => {
      // Mock grouping for scenario discovery
      // args: { by: ['scenarioId'], where: {...} }
      if (args?.by?.includes("scenarioId")) {
        const scenarios = new Set(
          createdTrajectories.map((t) => t.scenarioId).filter(Boolean),
        );
        return Array.from(scenarios).map((id) => ({ scenarioId: id }));
      }
      return [];
    }),
  },
  llmCallLog: {
    create: mock(async () => ({})),
    deleteMany: mock(async () => ({ count: 1 })),
  },
};

mock.module("@polyagent/db", () => ({
  db: mockDb,
}));

describe("ART Format Validation", () => {
  let mockRuntime: Partial<IAgentRuntime>;
  const testTrajectoryIds: string[] = [];

  beforeAll(() => {
    const mockLogger: Partial<Logger> = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      success: () => {},
      level: "info" as const,
    };

    const agentId = createUniqueUuid({} as IAgentRuntime, "art-test-agent");
    mockRuntime = {
      agentId: agentId as UUID,
      logger: mockLogger as Logger,
    };
  });

  afterAll(async () => {
    // Cleanup
    if (testTrajectoryIds.length > 0) {
      const { db } = await import("@polyagent/db");
      await db.trajectory.deleteMany({
        where: { trajectoryId: { in: testTrajectoryIds } },
      });
      // Note: llmCallLog model may not exist in all schemas
      // Type for db with optional llmCallLog
      interface DbWithLlmCallLog {
        llmCallLog?: {
          deleteMany: (args: {
            where: { trajectoryId: { in: string[] } };
          }) => Promise<{ count: number }>;
        };
      }

      if ("llmCallLog" in db) {
        const dbWithLog = db as DbWithLlmCallLog;
        if (dbWithLog.llmCallLog?.deleteMany) {
          await dbWithLog.llmCallLog.deleteMany({
            where: { trajectoryId: { in: testTrajectoryIds } },
          });
        }
      }
    }
  });

  describe("Message Array Conversion", () => {
    it("should convert trajectory to OpenAGI message array format", () => {
      const logger = new TrajectoryLoggerService();

      const trajId = logger.startTrajectory(mockRuntime.agentId as string);
      const stepId = logger.startStep(trajId!, {
        timestamp: Date.now(),
        agentBalance: 1000,
        agentPoints: 0,
        agentPnL: 0,
        openPositions: 0,
      });

      logger.logLLMCall(stepId, {
        model: "llama-3.1-8b",
        systemPrompt: "You are a trading agent with momentum strategy.",
        userPrompt: "Current balance: $1000. BTC at 50%. Should you trade?",
        response: "I will buy YES shares in BTC because momentum is strong.",
        temperature: 0.8,
        maxTokens: 200,
        purpose: "action",
        actionType: "BUY_SHARES",
      });

      logger.completeStep(trajId, stepId, {
        actionType: "BUY_SHARES",
        actionName: "BUY_SHARES",
        parameters: {},
        success: true,
      });

      const trajectory = logger.getActiveTrajectory(trajId)!;
      const messages = toARTMessages(trajectory);

      // Validate message structure matches ART format
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBeGreaterThan(0);

      // Should have system message
      const systemMsg = messages.find(
        (m: { role: string; content: string }) => m.role === "system",
      );
      expect(systemMsg).toBeDefined();
      expect(systemMsg?.content).toContain("trading agent");

      // Should have user message (observation)
      const userMsg = messages.find(
        (m: { role: string; content: string }) => m.role === "user",
      );
      expect(userMsg).toBeDefined();
      expect(userMsg?.content).toContain("$1000");
      expect(userMsg?.content).toContain("BTC");

      // Should have assistant message (action)
      const assistantMsg = messages.find(
        (m: { role: string; content: string }) => m.role === "assistant",
      );
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg?.content).toContain("buy");

      console.log("✅ Converts to valid message array");
    });

    it("should handle multi-turn conversations", () => {
      const logger = new TrajectoryLoggerService();

      const trajId = logger.startTrajectory(mockRuntime.agentId as string);

      // Turn 1: Analyze market
      const step1 = logger.startStep(trajId!, {
        timestamp: Date.now(),
        agentBalance: 1000,
        agentPoints: 0,
        agentPnL: 0,
        openPositions: 0,
      });

      logger.logLLMCall(step1, {
        model: "llama-3.1-8b",
        systemPrompt: "You are a trading agent.",
        userPrompt: "Market state: BTC at 50%, ETH at 60%. Analyze.",
        response: "BTC looks undervalued compared to ETH.",
        temperature: 0.8,
        maxTokens: 100,
        purpose: "reasoning",
      });

      logger.completeStep(trajId, step1, {
        actionType: "ANALYZE",
        actionName: "ANALYZE",
        parameters: {},
        success: true,
      });

      // Turn 2: Make decision
      const step2 = logger.startStep(trajId!, {
        timestamp: Date.now(),
        agentBalance: 1000,
        agentPoints: 0,
        agentPnL: 0,
        openPositions: 0,
      });

      logger.logLLMCall(step2, {
        model: "llama-3.1-8b",
        systemPrompt: "You are a trading agent.",
        userPrompt: "Based on analysis, which should you buy?",
        response: "I will buy BTC YES shares for $100.",
        temperature: 0.8,
        maxTokens: 100,
        purpose: "action",
        actionType: "BUY_SHARES",
      });

      logger.completeStep(trajId, step2, {
        actionType: "BUY_SHARES",
        actionName: "BUY_SHARES",
        parameters: {},
        success: true,
      });

      const trajectory = logger.getActiveTrajectory(trajId)!;
      const messages = toARTMessages(trajectory);

      // Should have alternating user/assistant pattern
      expect(messages.length).toBeGreaterThanOrEqual(5); // system + 2 turns

      // Check pattern: system, user, assistant, user, assistant
      expect(messages[0]?.role).toBe("system");
      expect(messages[1]?.role).toBe("user");
      expect(messages[2]?.role).toBe("assistant");
      expect(messages[3]?.role).toBe("user");
      expect(messages[4]?.role).toBe("assistant");

      console.log("✅ Multi-turn conversation preserved");
    });
  });

  describe("ART Trajectory Format", () => {
    it("should convert to exact ART format (matches tic-tac-toe example)", () => {
      const logger = new TrajectoryLoggerService();

      const trajId = logger.startTrajectory(mockRuntime.agentId as string, {
        scenarioId: "trading-test-1",
        metadata: {
          agentModel: "llama-3.1-8b",
          goalDescription: "maximize profit while managing risk",
        },
      });

      const stepId = logger.startStep(trajId!, {
        timestamp: Date.now(),
        agentBalance: 1000,
        agentPoints: 0,
        agentPnL: 0,
        openPositions: 0,
      });

      logger.logLLMCall(stepId, {
        model: "llama-3.1-8b",
        systemPrompt: "You are a trading agent.",
        userPrompt: "BTC at 50%. Trade?",
        response: "Buy YES $100",
        temperature: 0.8,
        maxTokens: 100,
        purpose: "action",
        actionType: "BUY_SHARES",
      });

      logger.completeStep(
        trajId!,
        stepId!,
        {
          actionType: "BUY_SHARES",
          actionName: "BUY_SHARES",
          parameters: { marketId: "btc", amount: 100 },
          success: true,
          result: { shares: 95 },
        },
        {
          reward: 1.5,
        },
      );

      const trajectory = logger.getActiveTrajectory(trajId!)!;
      const artTraj = toARTTrajectory(trajectory);

      // Match ART structure from tic-tac-toe example
      expect(artTraj).toHaveProperty("messages");
      expect(artTraj).toHaveProperty("reward");
      expect(artTraj).toHaveProperty("metadata");
      expect(artTraj).toHaveProperty("metrics");

      // Messages should be array of {role, content}
      expect(Array.isArray(artTraj.messages)).toBe(true);
      expect(artTraj.messages.length).toBeGreaterThan(0);

      for (const msg of artTraj.messages) {
        expect(msg).toHaveProperty("role");
        expect(msg).toHaveProperty("content");
        expect(["system", "user", "assistant"]).toContain(msg.role);
        expect(typeof msg.content).toBe("string");
      }

      // Reward should be single number
      expect(typeof artTraj.reward).toBe("number");
      expect(Number.isNaN(artTraj.reward)).toBe(false);

      // Metadata should have context for RULER
      expect(artTraj.metadata.trajectoryId).toBeDefined();
      expect(artTraj.metadata.scenarioId).toBe("trading-test-1");
      expect(artTraj.metadata.environmentContext).toBeDefined();

      console.log("✅ Matches ART format exactly");
    });

    it("should include environment context for RULER judge", () => {
      const logger = new TrajectoryLoggerService();

      const trajId = logger.startTrajectory(mockRuntime.agentId as string, {
        metadata: {
          goalDescription: "make profitable trades",
        },
      });
      if (!trajId) throw new Error("Failed to start trajectory");

      const stepId = logger.startStep(trajId, {
        timestamp: Date.now(),
        agentBalance: 1000,
        agentPoints: 500,
        agentPnL: 50,
        openPositions: 2,
      });

      logger.logLLMCall(stepId, {
        model: "test",
        systemPrompt: "System",
        userPrompt: "User",
        response: "Response",
        temperature: 0.8,
        maxTokens: 100,
        purpose: "action",
      });

      logger.completeStep(trajId, stepId, {
        actionType: "TEST",
        actionName: "TEST",
        parameters: {},
        success: true,
      });

      // Update to final state
      const trajectory = logger.getActiveTrajectory(trajId)!;
      trajectory.metrics.finalBalance = 950;
      trajectory.metrics.finalPnL = 55;

      const artTraj = toARTTrajectory(trajectory);

      // RULER needs this context to rank trajectories!
      expect(artTraj.metadata.environmentContext).toBeDefined();
      expect(artTraj.metadata.environmentContext?.initialBalance).toBe(1000);
      expect(artTraj.metadata.environmentContext?.finalBalance).toBe(950);
      expect(artTraj.metadata.environmentContext?.initialPnL).toBe(50);
      expect(artTraj.metadata.environmentContext?.finalPnL).toBe(55);
      expect(
        Array.isArray(artTraj.metadata.environmentContext?.actionsTaken),
      ).toBe(true);

      console.log("✅ Environment context available for RULER");
    });

    it("should include game knowledge for RULER judge", () => {
      const logger = new TrajectoryLoggerService();

      const trajId = logger.startTrajectory(mockRuntime.agentId as string, {
        metadata: {
          // Game master knowledge!
          trueProbabilities: {
            "btc-100k": 0.75, // Agent doesn't know this, but we do!
          },
          futureOutcomes: {
            "btc-100k": "YES", // We know the future!
            "btc-price-1h": 0.65, // We know what price will be!
          },
          hiddenVariables: {
            momentum: "bullish",
            whaleActivity: "accumulating",
          },
        },
      });

      const stepId = logger.startStep(trajId!, {
        timestamp: Date.now(),
        agentBalance: 1000,
        agentPoints: 0,
        agentPnL: 0,
        openPositions: 0,
      });

      logger.logLLMCall(stepId, {
        model: "test",
        systemPrompt: "System",
        userPrompt: "User",
        response: "Response",
        temperature: 0.8,
        maxTokens: 100,
        purpose: "action",
      });

      logger.completeStep(trajId, stepId, {
        actionType: "BUY_SHARES",
        actionName: "BUY_SHARES",
        parameters: { marketId: "btc-100k", side: "YES" },
        success: true,
      });

      const trajectory = logger.getActiveTrajectory(trajId)!;
      const artTraj = toARTTrajectory(trajectory);

      // RULER can use this to judge decision quality!
      expect(artTraj.metadata.gameKnowledge).toBeDefined();
      expect(artTraj.metadata.gameKnowledge?.trueProbabilities).toEqual({
        "btc-100k": 0.75,
      });
      expect(artTraj.metadata.gameKnowledge?.actualOutcomes).toEqual({
        "btc-100k": "YES",
        "btc-price-1h": 0.65,
      });

      console.log("✅ Game knowledge available for RULER");
    });
  });

  describe("GRPO Grouping", () => {
    it("should group trajectories by scenario", () => {
      const logger = new TrajectoryLoggerService();

      // Create 4 trajectories with same scenario (like ART does!)
      const scenarioId = "test-scenario-001";
      const trajectories: Trajectory[] = [];

      for (let i = 0; i < 4; i++) {
        const trajId = logger.startTrajectory(mockRuntime.agentId as string, {
          scenarioId,
          metadata: {
            groupIndex: i,
          },
        });
        if (!trajId) throw new Error("Failed to start trajectory");
        testTrajectoryIds.push(trajId);

        const stepId = logger.startStep(trajId, {
          timestamp: Date.now() + i * 1000,
          agentBalance: 1000,
          agentPoints: 0,
          agentPnL: 0,
          openPositions: 0,
        });

        logger.logLLMCall(stepId, {
          model: "llama-3.1-8b",
          systemPrompt: "You are a trading agent.", // Same system prompt
          userPrompt: "BTC at 50%. Trade?", // Same user prompt
          response:
            i === 0
              ? "Buy $100"
              : i === 1
                ? "Buy $50"
                : i === 2
                  ? "Skip"
                  : "Sell", // Different responses!
          temperature: 0.8,
          maxTokens: 100,
          purpose: "action",
        });

        logger.completeStep(
          trajId,
          stepId,
          {
            actionType: "TEST",
            actionName: "TEST",
            parameters: {},
            success: true,
          },
          {
            reward: i * 0.5, // Different rewards
          },
        );

        // Get trajectory from memory (don't call endTrajectory which needs DB)
        const traj = logger.getActiveTrajectory(trajId);
        if (traj) {
          trajectories.push(traj);
        }
      }

      // Group trajectories (like gather_trajectory_groups_by_index)
      const groups = groupTrajectories(trajectories);

      expect(groups).toHaveLength(1); // One scenario
      expect(groups[0]?.trajectories).toHaveLength(4); // 4 parallel rollouts
      expect(groups[0]?.scenarioId).toBe(scenarioId);

      console.log("✅ Groups trajectories by scenario");
    });

    it("should extract shared prefix from trajectory group", () => {
      const logger = new TrajectoryLoggerService();
      const trajectories: Trajectory[] = [];

      // Create 3 trajectories with same start, different endings
      for (let i = 0; i < 3; i++) {
        const trajId = logger.startTrajectory(mockRuntime.agentId as string, {
          scenarioId: "same-start-test",
        });
        if (!trajId) throw new Error("Failed to start trajectory");

        const stepId = logger.startStep(trajId, {
          timestamp: Date.now(),
          agentBalance: 1000,
          agentPoints: 0,
          agentPnL: 0,
          openPositions: 0,
        });

        logger.logLLMCall(stepId, {
          model: "llama-3.1-8b",
          systemPrompt: "You are a trading agent.", // SAME
          userPrompt: "BTC at 50%. What do you do?", // SAME
          response: i === 0 ? "Buy" : i === 1 ? "Hold" : "Sell", // DIFFERENT
          temperature: 0.8,
          maxTokens: 100,
          purpose: "action",
        });

        logger.completeStep(trajId, stepId, {
          actionType: "TEST",
          actionName: "TEST",
          parameters: {},
          success: true,
        });

        trajectories.push(logger.getActiveTrajectory(trajId)!);
      }

      // Extract shared prefix (RULER optimization!)
      const sharedPrefix = extractSharedPrefix(trajectories);

      // Should extract system + user messages (same across all 3)
      expect(sharedPrefix.length).toBeGreaterThanOrEqual(2);
      expect(sharedPrefix[0]?.role).toBe("system");
      expect(sharedPrefix[0]?.content).toBe("You are a trading agent.");
      expect(sharedPrefix[1]?.role).toBe("user");
      expect(sharedPrefix[1]?.content).toBe("BTC at 50%. What do you do?");

      console.log("✅ Shared prefix extracted (saves tokens for RULER!)");
    });

    it("should prepare trajectory group for RULER ranking", () => {
      const logger = new TrajectoryLoggerService();
      const trajectories: Trajectory[] = [];

      // Create trajectory group (N=4, like ART examples)
      for (let i = 0; i < 4; i++) {
        const trajId = logger.startTrajectory(mockRuntime.agentId as string, {
          scenarioId: "ruler-test",
          metadata: {
            groupIndex: i,
            initialBalance: 1000,
          },
        });
        if (!trajId) throw new Error("Failed to start trajectory");

        const stepId = logger.startStep(trajId, {
          timestamp: Date.now(),
          agentBalance: 1000,
          agentPoints: 0,
          agentPnL: 0,
          openPositions: 0,
        });

        logger.logLLMCall(stepId, {
          model: "llama-3.1-8b",
          systemPrompt: "You are a trading agent.",
          userPrompt: "BTC at 50%, balance $1000. Trade?",
          response: `Buy $${100 + i * 50}`, // Different amounts
          temperature: 0.8,
          maxTokens: 100,
          purpose: "action",
        });

        logger.completeStep(
          trajId,
          stepId,
          {
            actionType: "BUY_SHARES",
            actionName: "BUY_SHARES",
            parameters: { amount: 100 + i * 50 },
            success: true,
          },
          {
            reward: i * 0.3,
          },
        );

        const traj = logger.getActiveTrajectory(trajId)!;
        traj.metrics.finalBalance = 1000 - (100 + i * 50);
        traj.metrics.finalPnL = i * 5;
        trajectories.push(traj);
      }

      const groups = groupTrajectories(trajectories);
      const rulerInput = prepareForRULER(groups[0]!);

      // Validate RULER input structure
      expect(rulerInput.sharedPrefix).toBeDefined();
      expect(rulerInput.suffixes).toHaveLength(4);
      expect(rulerInput.metadata).toHaveLength(4);

      // Shared prefix should have system + user (same for all)
      expect(rulerInput.sharedPrefix.length).toBeGreaterThan(0);
      expect(rulerInput.sharedPrefix[0]?.role).toBe("system");

      // Suffixes should have different responses
      expect(rulerInput.suffixes[0]?.[0]?.content).toContain("$100");
      expect(rulerInput.suffixes[1]?.[0]?.content).toContain("$150");
      expect(rulerInput.suffixes[2]?.[0]?.content).toContain("$200");
      expect(rulerInput.suffixes[3]?.[0]?.content).toContain("$250");

      // Metadata should have environment context for judging
      for (const meta of rulerInput.metadata) {
        expect(meta.environmentContext).toBeDefined();
        expect(meta.environmentContext?.finalBalance).toBeDefined();
        expect(meta.environmentContext?.finalPnL).toBeDefined();
      }

      console.log("✅ RULER input format correct");
    });
  });

  describe("Export Validation", () => {
    it("should convert trajectory to ART-compatible JSONL format", () => {
      const logger = new TrajectoryLoggerService();

      // Create trajectory in memory
      const trajId = logger.startTrajectory(mockRuntime.agentId as string, {
        scenarioId: "art-test",
      });
      if (!trajId) throw new Error("Failed to start trajectory");
      testTrajectoryIds.push(trajId);

      const stepId = logger.startStep(trajId, {
        timestamp: Date.now(),
        agentBalance: 1000,
        agentPoints: 100,
        agentPnL: 0,
        openPositions: 0,
      });

      logger.logLLMCall(stepId, {
        model: "test-model",
        systemPrompt: "You are a trading agent.",
        userPrompt: "What trade should I make?",
        response: "Buy BTC at $100",
        temperature: 0.7,
        maxTokens: 100,
        purpose: "action",
      });

      logger.completeStep(trajId, stepId, {
        actionType: "TRADE",
        actionName: "BUY",
        parameters: { amount: 100 },
        success: true,
      });

      // Get trajectory and convert
      const trajectory = logger.getActiveTrajectory(trajId);
      expect(trajectory).toBeDefined();

      const artFormat = toARTTrajectory(trajectory!);

      // Validate matches ART format
      expect(artFormat.messages).toBeDefined();
      expect(Array.isArray(artFormat.messages)).toBe(true);

      // Validate message array
      for (const msg of artFormat.messages) {
        expect(msg.role).toMatch(/^(system|user|assistant)$/);
        expect(typeof msg.content).toBe("string");
        expect(msg.content.length).toBeGreaterThan(0);
      }

      console.log("✅ ART export format valid");
    });

    it("should create grouped trajectories for GRPO", () => {
      const logger = new TrajectoryLoggerService();
      const scenarioId = `grpo-test-${Date.now()}`;
      const trajectories: Trajectory[] = [];

      // Create 5 trajectories for same scenario (GRPO group)
      for (let i = 0; i < 5; i++) {
        const trajId = logger.startTrajectory(mockRuntime.agentId as string, {
          scenarioId,
          metadata: { groupIndex: i },
        });
        if (!trajId) throw new Error("Failed to start trajectory");
        testTrajectoryIds.push(trajId);

        const stepId = logger.startStep(trajId, {
          timestamp: Date.now() + i * 1000,
          agentBalance: 1000 + i * 100,
          agentPoints: 100,
          agentPnL: i * 10,
          openPositions: 0,
        });

        logger.logLLMCall(stepId, {
          model: "test-model",
          systemPrompt: "You are a trading agent.",
          userPrompt: "What trade should I make?",
          response: `Trade response ${i}`,
          temperature: 0.7,
          maxTokens: 100,
          purpose: "action",
        });

        logger.completeStep(
          trajId,
          stepId,
          {
            actionType: "TRADE",
            actionName: "BUY",
            parameters: { amount: 100 + i * 10 },
            success: true,
          },
          { reward: i * 0.5 },
        );

        const traj = logger.getActiveTrajectory(trajId);
        if (traj) trajectories.push(traj);
      }

      // Group trajectories
      const groups = groupTrajectories(trajectories);

      expect(groups).toHaveLength(1);
      expect(groups[0]?.scenarioId).toBe(scenarioId);
      expect(groups[0]?.trajectories).toHaveLength(5);

      // All trajectories should convert to ART format
      for (const traj of groups[0]?.trajectories) {
        const artFormat = toARTTrajectory(traj);
        expect(artFormat.messages).toBeDefined();
        expect(Array.isArray(artFormat.messages)).toBe(true);
      }

      console.log("✅ GRPO group export correct");
    });
  });

  describe("Compatibility Validation", () => {
    it("should validate trajectory is ART-compatible", () => {
      const logger = new TrajectoryLoggerService();

      const trajId = logger.startTrajectory(mockRuntime.agentId as string);
      const stepId = logger.startStep(trajId!, {
        timestamp: Date.now(),
        agentBalance: 1000,
        agentPoints: 0,
        agentPnL: 0,
        openPositions: 0,
      });

      logger.logLLMCall(stepId, {
        model: "llama-3.1-8b",
        systemPrompt: "You are a trading agent.",
        userPrompt:
          "Current state: $1000 balance, BTC at 50%. What should you do?",
        response:
          "I will buy YES shares in BTC for $100 because momentum is strong.",
        temperature: 0.8,
        maxTokens: 200,
        purpose: "action",
        actionType: "BUY_SHARES",
      });

      logger.completeStep(
        trajId,
        stepId,
        {
          actionType: "BUY_SHARES",
          actionName: "BUY_SHARES",
          parameters: {},
          success: true,
        },
        {
          reward: 1.5,
        },
      );

      const trajectory = logger.getActiveTrajectory(trajId)!;
      const validation = validateARTCompatibility(trajectory);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);

      console.log("✅ Trajectory is ART-compatible");
    });

    it("should detect incompatible trajectories", () => {
      const logger = new TrajectoryLoggerService();

      const trajId = logger.startTrajectory(mockRuntime.agentId as string);
      const stepId = logger.startStep(trajId!, {
        timestamp: Date.now(),
        agentBalance: 0,
        agentPoints: 0,
        agentPnL: 0,
        openPositions: 0,
      });

      // No LLM calls! (incompatible!)
      logger.completeStep(trajId, stepId, {
        actionType: "TEST",
        actionName: "TEST",
        parameters: {},
        success: true,
      });

      const trajectory = logger.getActiveTrajectory(trajId)!;
      const validation = validateARTCompatibility(trajectory);

      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
      expect(validation.errors[0]).toContain("no LLM calls");

      console.log("✅ Detects incompatible data");
    });

    it("should validate message array structure", () => {
      const logger = new TrajectoryLoggerService();

      const trajId = logger.startTrajectory(mockRuntime.agentId as string);
      const stepId = logger.startStep(trajId!, {
        timestamp: Date.now(),
        agentBalance: 1000,
        agentPoints: 0,
        agentPnL: 0,
        openPositions: 0,
      });

      logger.logLLMCall(stepId, {
        model: "llama-3.1-8b",
        systemPrompt:
          "You are a trading agent with sophisticated risk management.",
        userPrompt:
          "Portfolio: $1000, 2 open positions. BTC at 50%, ETH at 60%. Liquidity: BTC $1000, ETH $500. Recent: +$50 P&L. Should you make a trade? If yes, which market and how much?",
        response:
          "I will buy YES shares in BTC for $100. Reasoning: BTC is undervalued at 50% based on momentum indicators and recent volume increase.",
        temperature: 0.8,
        maxTokens: 200,
        purpose: "action",
        actionType: "BUY_SHARES",
      });

      logger.completeStep(trajId, stepId, {
        actionType: "BUY_SHARES",
        actionName: "BUY_SHARES",
        parameters: {},
        success: true,
      });

      const trajectory = logger.getActiveTrajectory(trajId)!;
      const messages = toARTMessages(trajectory);

      // Validate each message
      for (const msg of messages) {
        // Must have role
        expect(msg.role).toBeDefined();
        expect(["system", "user", "assistant"]).toContain(msg.role);

        // Must have content
        expect(msg.content).toBeDefined();
        expect(typeof msg.content).toBe("string");
        expect(msg.content.length).toBeGreaterThan(0);

        // No undefined or null values
        expect(msg.content).not.toBe("undefined");
        expect(msg.content).not.toBe("null");
      }

      // System message should establish identity
      const systemMsg = messages.find(
        (m: { role: string; content: string }) => m.role === "system",
      )!;
      expect(systemMsg.content.length).toBeGreaterThan(20);

      // User message should have context
      const userMsg = messages.find(
        (m: { role: string; content: string }) => m.role === "user",
      )!;
      expect(userMsg.content.length).toBeGreaterThan(50);
      expect(userMsg.content).toContain("$1000");

      // Assistant message should have decision
      const assistantMsg = messages.find(
        (m: { role: string; content: string }) => m.role === "assistant",
      )!;
      expect(assistantMsg.content.length).toBeGreaterThan(20);
      expect(assistantMsg.content.toLowerCase()).toContain("buy");

      console.log("✅ Message array structure valid");
    });
  });
});

/**
 * Helper: Create complete ART-compatible trajectory
 * Prefixed with underscore as it's a utility for future tests
 */
async function _createCompleteARTTrajectory(
  logger: TrajectoryLoggerService,
  options: {
    scenarioId?: string;
    groupIndex?: number;
  } = {},
): Promise<string> {
  const trajId = logger.startTrajectory("test-agent-id", {
    scenarioId: options.scenarioId || "test-scenario",
    metadata: {
      groupIndex: options.groupIndex,
      agentModel: "llama-3.1-8b",
      goalDescription: "maximize profit",
    },
  });

  const stepId = logger.startStep(trajId!, {
    timestamp: Date.now(),
    agentBalance: 1000,
    agentPoints: 500,
    agentPnL: 50,
    openPositions: 1,
  });

  logger.logProviderAccess(stepId, {
    providerName: "MARKETS",
    data: {
      markets: [{ id: "btc", price: 0.5, liquidity: 1000 }],
    },
    purpose: "Get markets",
  });

  logger.logLLMCall(stepId, {
    model: "llama-3.1-8b",
    systemPrompt: "You are a trading agent with momentum strategy.",
    userPrompt: "Balance: $1000. BTC at 50%. Trade?",
    response: "Buy BTC YES $100",
    temperature: 0.8,
    maxTokens: 100,
    purpose: "action",
    actionType: "BUY_SHARES",
  });

  logger.completeStep(
    trajId,
    stepId,
    {
      actionType: "BUY_SHARES",
      actionName: "BUY_SHARES",
      parameters: { marketId: "btc", amount: 100 },
      success: true,
      result: { shares: 95 },
    },
    {
      reward: 1.0,
    },
  );

  await logger.endTrajectory(trajId, "completed", {
    finalBalance: 900,
    finalPnL: 55,
  });

  return trajId;
}
