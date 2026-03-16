import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proseCompileAction } from "../actions/compile";
import { proseHelpAction } from "../actions/help";
import { proseRunAction } from "../actions/run";
import { actionSpecs, requireActionSpec } from "../generated/specs/specs";
import { proseProvider } from "../providers/prose";
import { ProseService, createProseService } from "../services/proseService";

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

// Mock fs
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
  readdir: vi.fn(() => Promise.resolve([])),
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

describe("plugin-prose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("action specs", () => {
    it("should have PROSE_RUN spec", () => {
      expect(actionSpecs.PROSE_RUN).toBeDefined();
      expect(actionSpecs.PROSE_RUN.name).toBe("PROSE_RUN");
      expect(actionSpecs.PROSE_RUN.description).toContain("OpenProse");
    });

    it("should have PROSE_COMPILE spec", () => {
      expect(actionSpecs.PROSE_COMPILE).toBeDefined();
      expect(actionSpecs.PROSE_COMPILE.name).toBe("PROSE_COMPILE");
      expect(actionSpecs.PROSE_COMPILE.description).toContain("Validate");
    });

    it("should have PROSE_HELP spec", () => {
      expect(actionSpecs.PROSE_HELP).toBeDefined();
      expect(actionSpecs.PROSE_HELP.name).toBe("PROSE_HELP");
      expect(actionSpecs.PROSE_HELP.description).toContain("help");
    });

    it("requireActionSpec should throw for unknown spec", () => {
      expect(() => requireActionSpec("UNKNOWN_ACTION")).toThrow(
        "Action spec not found: UNKNOWN_ACTION",
      );
    });
  });

  describe("proseRunAction", () => {
    it("should have correct name and description", () => {
      expect(proseRunAction.name).toBe("PROSE_RUN");
      expect(proseRunAction.description).toBeDefined();
    });

    it("should have similes", () => {
      expect(Array.isArray(proseRunAction.similes)).toBe(true);
      expect(proseRunAction.similes.length).toBeGreaterThan(0);
    });

    describe("validate", () => {
      it("should return true for 'prose run' messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("prose run workflow.prose");
        const result = await proseRunAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return true for messages with .prose files", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("run my-workflow.prose");
        const result = await proseRunAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return true for 'execute' messages with .prose", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("execute test.prose");
        const result = await proseRunAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return false for unrelated messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("what is the weather today?");
        const result = await proseRunAction.validate(runtime, message);
        expect(result).toBe(false);
      });
    });
  });

  describe("proseCompileAction", () => {
    it("should have correct name and description", () => {
      expect(proseCompileAction.name).toBe("PROSE_COMPILE");
      expect(proseCompileAction.description).toBeDefined();
    });

    describe("validate", () => {
      it("should return true for 'prose compile' messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("prose compile workflow.prose");
        const result = await proseCompileAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return true for 'prose validate' messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("prose validate test.prose");
        const result = await proseCompileAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return true for 'check' messages with .prose", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("check my-workflow.prose");
        const result = await proseCompileAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return false for unrelated messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("what is the weather today?");
        const result = await proseCompileAction.validate(runtime, message);
        expect(result).toBe(false);
      });
    });
  });

  describe("proseHelpAction", () => {
    it("should have correct name and description", () => {
      expect(proseHelpAction.name).toBe("PROSE_HELP");
      expect(proseHelpAction.description).toBeDefined();
    });

    describe("validate", () => {
      it("should return true for 'prose help' messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("prose help");
        const result = await proseHelpAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return true for 'prose examples' messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("prose examples");
        const result = await proseHelpAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return true for 'prose syntax' messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("prose syntax");
        const result = await proseHelpAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return true for tutorial questions", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("how do I write a prose program?");
        const result = await proseHelpAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return true for 'what is openprose' messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("what is openprose?");
        const result = await proseHelpAction.validate(runtime, message);
        expect(result).toBe(true);
      });

      it("should return false for unrelated messages", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("what is the weather today?");
        const result = await proseHelpAction.validate(runtime, message);
        expect(result).toBe(false);
      });
    });

    describe("handler", () => {
      it("should provide quick reference help", async () => {
        const runtime = createMockRuntime();
        const message = createMockMessage("prose help");
        let responseText = "";
        const callback = vi.fn((response: { text: string }) => {
          responseText = response.text;
        });

        await proseHelpAction.handler(runtime, message, undefined, {}, callback);

        expect(callback).toHaveBeenCalled();
        expect(responseText).toContain("OpenProse");
        expect(responseText).toContain("prose run");
      });
    });
  });

  describe("proseProvider", () => {
    it("should have correct name", () => {
      expect(proseProvider.name).toBe("prose");
    });

    it("should provide minimal context for non-prose messages", async () => {
      const runtime = createMockRuntime();
      const message = createMockMessage("hello world");

      const context = await proseProvider.get(runtime, message);
      expect(typeof context).toBe("string");
      expect(context).toContain("OpenProse");
    });
  });

  describe("ProseService", () => {
    it("should create instance with runtime", () => {
      const runtime = createMockRuntime();
      const service = createProseService(runtime);
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(ProseService);
    });

    it("should accept config options", () => {
      const runtime = createMockRuntime();
      const service = createProseService(runtime, {
        workspaceDir: "custom/.prose",
        defaultStateMode: "sqlite",
      });
      expect(service).toBeDefined();
    });

    it("should return undefined for unloaded skill files", () => {
      const runtime = createMockRuntime();
      const service = createProseService(runtime);

      expect(service.getVMSpec()).toBeUndefined();
      expect(service.getSkillSpec()).toBeUndefined();
      expect(service.getHelp()).toBeUndefined();
    });

    it("should build VM context", () => {
      const runtime = createMockRuntime();
      const service = createProseService(runtime);

      const context = service.buildVMContext({
        stateMode: "filesystem",
      });

      expect(typeof context).toBe("string");
      expect(context).toContain("OpenProse");
    });

    it("should get loaded skills list", () => {
      const runtime = createMockRuntime();
      const service = createProseService(runtime);

      const skills = service.getLoadedSkills();
      expect(Array.isArray(skills)).toBe(true);
    });

    it("should get authoring guidance", () => {
      const runtime = createMockRuntime();
      const service = createProseService(runtime);

      const guidance = service.getAuthoringGuidance();
      expect(guidance).toBeDefined();
      expect("patterns" in guidance).toBe(true);
      expect("antipatterns" in guidance).toBe(true);
    });
  });

  describe("types", () => {
    it("should export ProseStateMode type correctly", async () => {
      const { ProseService } = await import("../services/proseService");
      expect(ProseService).toBeDefined();
    });
  });
});
