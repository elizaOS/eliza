import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { sayAloudAction } from "../actions/sayAloud";
import { cleanupTestRuntime, createTestMemory, createTestRuntime } from "./test-utils";

describe("SayAloudAction", () => {
  let runtime: IAgentRuntime;

  afterEach(async () => {
    if (runtime) {
      await cleanupTestRuntime(runtime);
    }
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(sayAloudAction.name).toBe("SAY_ALOUD");
    });

    it("has description mentioning SAM", () => {
      expect(sayAloudAction.description).toContain("SAM");
    });

    it("has examples", () => {
      expect(sayAloudAction.examples).toBeDefined();
      expect(sayAloudAction.examples?.length).toBeGreaterThan(0);
    });
  });

  describe("validate", () => {
    describe("speech triggers", () => {
      it("validates 'say aloud' trigger", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "say aloud hello world" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });

      it("validates 'speak' trigger", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "speak this text" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });

      it("validates 'read aloud' trigger", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "read aloud this message" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });

      it("validates 'voice' trigger", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "voice command test" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });

      it("validates voice modifier triggers", async () => {
        runtime = await createTestRuntime();

        const triggers = ["higher voice", "lower voice", "robotic voice", "retro voice"];
        for (const trigger of triggers) {
          const memory = createTestMemory({ content: { text: trigger } });
          expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
        }
      });
    });

    describe("vocalization patterns", () => {
      it("validates 'can you say' pattern", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "can you say hello" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });

      it("validates 'please say' pattern", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "please say goodbye" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });

      it("validates 'i want to hear' pattern", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "i want to hear a story" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });

      it("validates 'let me hear' pattern", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "let me hear that" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });
    });

    describe("quoted patterns", () => {
      it("validates say with double quotes", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: 'say "hello world"' } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });

      it("validates say with single quotes", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "say 'hello world'" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });

      it("validates speak with quotes", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: 'speak "test message"' } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });
    });

    describe("rejection", () => {
      it("rejects normal conversation", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "hello how are you" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(false);
      });

      it("rejects questions without triggers", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "what is the weather today" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(false);
      });

      it("rejects empty text", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(false);
      });
    });

    describe("case insensitivity", () => {
      it("validates uppercase triggers", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "SAY ALOUD hello" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });

      it("validates mixed case triggers", async () => {
        runtime = await createTestRuntime();
        const memory = createTestMemory({ content: { text: "Say Aloud hello" } });
        expect(await sayAloudAction.validate?.(runtime, memory)).toBe(true);
      });
    });
  });
});
