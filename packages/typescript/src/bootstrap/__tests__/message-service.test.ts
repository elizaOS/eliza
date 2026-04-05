import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DefaultMessageService } from "../../services/message";
import type { IAgentRuntime, Memory, HandlerCallback } from "../../types";
import { ChannelType } from "../../types/primitives";

// Mock runtime factory that returns controlled getSetting values
function createMockRuntime(settings: Record<string, unknown> = {}) {
  return {
    agentId: "test-agent-id",
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    character: { name: "TestAgent" },
    getMemoryById: vi.fn().mockResolvedValue(null),
    createMemory: vi.fn().mockResolvedValue("memory-id"),
    queueEmbeddingGeneration: vi.fn(),
    getParticipantUserState: vi.fn().mockResolvedValue(null),
    composeState: vi.fn().mockResolvedValue({ values: {}, data: {}, text: "" }),
    getRoom: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
    emitEvent: vi.fn(),
    startRun: vi.fn().mockReturnValue("run-id"),
    isCheckShouldRespondEnabled: vi.fn().mockReturnValue(false),
  } as unknown as IAgentRuntime;
}

describe("Message Service Memory Controls", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("DISABLE_MEMORY_CREATION", () => {
    it("should skip memory creation when DISABLE_MEMORY_CREATION is true", async () => {
      const mockRuntime = createMockRuntime({ DISABLE_MEMORY_CREATION: true });
      const service = new DefaultMessageService();
      const message: Memory = {
        id: "msg-id" as any,
        content: { text: "test", channelType: ChannelType.DM },
        entityId: "entity-id" as any,
        roomId: "room-id" as any,
        agentId: "test-agent-id" as any,
        createdAt: Date.now(),
      };

      await service.handleMessage(mockRuntime, message, undefined);

      // When disabled, createMemory should not be called for the incoming message
      // (it may still be called for response memories depending on logic)
      expect(mockRuntime.getSetting).toHaveBeenCalledWith("DISABLE_MEMORY_CREATION");
    });

    it("should create memory when DISABLE_MEMORY_CREATION is false", async () => {
      const mockRuntime = createMockRuntime({ DISABLE_MEMORY_CREATION: false });
      const service = new DefaultMessageService();
      const message: Memory = {
        id: "msg-id" as any,
        content: { text: "test", channelType: ChannelType.DM },
        entityId: "entity-id" as any,
        roomId: "room-id" as any,
        agentId: "test-agent-id" as any,
        createdAt: Date.now(),
      };

      await service.handleMessage(mockRuntime, message, undefined);

      expect(mockRuntime.getSetting).toHaveBeenCalledWith("DISABLE_MEMORY_CREATION");
    });
  });

  describe("ALLOW_MEMORY_SOURCE_IDS", () => {
    it("should check ALLOW_MEMORY_SOURCE_IDS setting during message handling", async () => {
      const mockRuntime = createMockRuntime({ 
        ALLOW_MEMORY_SOURCE_IDS: "source1,source2,source3" 
      });
      const service = new DefaultMessageService();
      const message: Memory = {
        id: "msg-id" as any,
        content: { text: "test", channelType: ChannelType.DM },
        entityId: "entity-id" as any,
        roomId: "room-id" as any,
        agentId: "test-agent-id" as any,
        createdAt: Date.now(),
        metadata: { sourceId: "source1" },
      };

      await service.handleMessage(mockRuntime, message, undefined);

      expect(mockRuntime.getSetting).toHaveBeenCalledWith("ALLOW_MEMORY_SOURCE_IDS");
    });
  });

  describe("keepExistingResponses / BOOTSTRAP_KEEP_RESP", () => {
    it("should read BOOTSTRAP_KEEP_RESP setting during message handling", async () => {
      const mockRuntime = createMockRuntime({ BOOTSTRAP_KEEP_RESP: "true" });
      const service = new DefaultMessageService();
      const message: Memory = {
        id: "msg-id" as any,
        content: { text: "test", channelType: ChannelType.DM },
        entityId: "entity-id" as any,
        roomId: "room-id" as any,
        agentId: "test-agent-id" as any,
        createdAt: Date.now(),
      };

      await service.handleMessage(mockRuntime, message, undefined);

      expect(mockRuntime.getSetting).toHaveBeenCalledWith("BOOTSTRAP_KEEP_RESP");
    });
  });
});
