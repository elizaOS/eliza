import { describe, it, expect, vi, beforeEach } from "vitest";
import { DefaultMessageService } from "./message";

// Tests for DISABLE_MEMORY_CREATION and ALLOW_MEMORY_SOURCE_IDS logic
// These tests exercise the actual MessageService shouldRespond method
describe("MessageService", () => {
  let messageService: DefaultMessageService;

  beforeEach(() => {
    messageService = new DefaultMessageService();
  });

  describe("shouldRespond", () => {
    // Minimal mock runtime for testing shouldRespond
    const createMockRuntime = (settings: Record<string, unknown> = {}) => ({
      getSetting: (key: string) => settings[key],
      character: { name: "TestAgent" },
    });

    it("should respond in DM channel", () => {
      const runtime = createMockRuntime() as any;
      const message = { content: { source: "discord" } } as any;
      const room = { type: "DM" } as any;

      const result = messageService.shouldRespond(runtime, message, room, undefined);

      expect(result.shouldRespond).toBe(true);
      expect(result.skipEvaluation).toBe(true);
    });

    it("should respond when mentioned", () => {
      const runtime = createMockRuntime() as any;
      const message = { content: { source: "discord" } } as any;
      const room = { type: "GROUP" } as any;
      const mentionContext = { isMention: true, isReply: false };

      const result = messageService.shouldRespond(runtime, message, room, mentionContext);

      expect(result.shouldRespond).toBe(true);
      expect(result.skipEvaluation).toBe(true);
    });

    it("should defer to LLM for ambiguous cases", () => {
      const runtime = createMockRuntime() as any;
      const message = { content: { source: "discord" } } as any;
      const room = { type: "GROUP" } as any;

      const result = messageService.shouldRespond(runtime, message, room, undefined);

      expect(result.skipEvaluation).toBe(false);
      expect(result.reason).toBe("needs LLM evaluation");
    });

    it("should not respond when no room context", () => {
      const runtime = createMockRuntime() as any;
      const message = { content: { source: "discord" } } as any;

      const result = messageService.shouldRespond(runtime, message, undefined, undefined);

      expect(result.shouldRespond).toBe(false);
      expect(result.skipEvaluation).toBe(true);
    });

    it("should respond for whitelisted source", () => {
      const runtime = createMockRuntime() as any;
      const message = { content: { source: "client_chat" } } as any;
      const room = { type: "GROUP" } as any;

      const result = messageService.shouldRespond(runtime, message, room, undefined);

      expect(result.shouldRespond).toBe(true);
      expect(result.skipEvaluation).toBe(true);
    });
  });
});
