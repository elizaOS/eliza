import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lobsterResumeAction } from "../actions/resume";
import { lobsterRunAction } from "../actions/run";
import { actionSpecs, requireActionSpec } from "../generated/specs/specs";
import { lobsterProvider } from "../providers/lobster";
import { LobsterService } from "../services/lobsterService";

// Mock @elizaos/core
vi.mock("@elizaos/core", async () => {
  const actual = await vi.importActual("@elizaos/core");
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    generateText: vi.fn(),
    ModelType: {
      TEXT_SMALL: "text-small",
    },
  };
});

// Mock child_process for LobsterService
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const createMockRuntime = (settings: Record<string, string> = {}): IAgentRuntime =>
  ({
    getSetting: vi.fn((key: string) => settings[key]),
    agentId: "test-agent",
  }) as unknown as IAgentRuntime;

const createMockMessage = (text: string): Memory =>
  ({
    id: "test-message-id",
    content: { text },
    userId: "test-user",
    roomId: "test-room",
    createdAt: Date.now(),
  }) as Memory;

describe("plugin-lobster", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("action specs", () => {
    it("should have LOBSTER_RUN spec", () => {
      expect(actionSpecs.LOBSTER_RUN).toBeDefined();
      expect(actionSpecs.LOBSTER_RUN.name).toBe("LOBSTER_RUN");
      expect(actionSpecs.LOBSTER_RUN.description).toContain("Lobster");
    });

    it("should have LOBSTER_RESUME spec", () => {
      expect(actionSpecs.LOBSTER_RESUME).toBeDefined();
      expect(actionSpecs.LOBSTER_RESUME.name).toBe("LOBSTER_RESUME");
      expect(actionSpecs.LOBSTER_RESUME.description).toContain("resume");
    });

    it("requireActionSpec should throw for unknown spec", () => {
      expect(() => requireActionSpec("UNKNOWN_ACTION")).toThrow(
        "Action spec not found: UNKNOWN_ACTION"
      );
    });
  });

  describe("lobsterRunAction", () => {
    it("should have correct name and description", () => {
      expect(lobsterRunAction.name).toBe("LOBSTER_RUN");
      expect(lobsterRunAction.description).toBeDefined();
    });

    it("should have similes", () => {
      expect(Array.isArray(lobsterRunAction.similes)).toBe(true);
      expect(lobsterRunAction.similes.length).toBeGreaterThan(0);
    });

    describe("validate", () => {
      it("should return true for 'lobster run' messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("lobster run deploy-pipeline");
        const result = await lobsterRunAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return true for 'start lobster' messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("start lobster pipeline build");
        const result = await lobsterRunAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return true for 'execute pipeline' messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("execute pipeline my-workflow");
        const result = await lobsterRunAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return false for unrelated messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("what is the weather today?");
        const result = await lobsterRunAction.validate(runtime, message);
        expect(result).toBe(false);
      });
    });
  });

  describe("lobsterResumeAction", () => {
    it("should have correct name and description", () => {
      expect(lobsterResumeAction.name).toBe("LOBSTER_RESUME");
      expect(lobsterResumeAction.description).toBeDefined();
    });

    describe("validate", () => {
      it("should return true for 'approve' messages with token in state", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("yes, approve it");
        const state: State = {
          pendingLobsterToken: "abc123",
        } as State;
        const result = await lobsterResumeAction.validate(runtime, message, state);
        expect(result).toBe(true);
      });

      it("should return true for 'lobster resume' messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("lobster resume token123");
        const result = await lobsterResumeAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return false for unrelated messages without token", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("hello world");
        const result = await lobsterResumeAction.validate(runtime, message);
        expect(result).toBe(false);
      });
    });
  });

  describe("lobsterProvider", () => {
    it("should have correct name", () => {
      expect(lobsterProvider.name).toBe("lobster");
    });

    it("should provide context about Lobster availability", async () => {
      const runtime = createMockRuntime();
      const message = createMockMessage("what can lobster do?");

      // Provider will try to check availability
      const context = await lobsterProvider.get(runtime, message);
      expect(typeof context).toBe("string");
    });
  });

  describe("LobsterService", () => {
    it("should create instance with runtime", () => {
      const runtime = createMockRuntime();
      const service = new LobsterService(runtime);
      expect(service).toBeDefined();
    });

    it("should use configured LOBSTER_PATH", () => {
      const runtime = createMockRuntime({
        LOBSTER_PATH: "/custom/path/lobster",
      });
      const service = new LobsterService(runtime);
      expect(service).toBeDefined();
    });

    it("should use configured LOBSTER_TIMEOUT_MS", () => {
      const runtime = createMockRuntime({
        LOBSTER_TIMEOUT_MS: "60000",
      });
      const service = new LobsterService(runtime);
      expect(service).toBeDefined();
    });
  });
});
