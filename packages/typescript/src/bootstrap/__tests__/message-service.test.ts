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

      // Verify getSetting was called to check the setting
      expect(mockRuntime.getSetting).toHaveBeenCalledWith("DISABLE_MEMORY_CREATION");
      // When disabled, createMemory should not be called for the incoming message
      expect(mockRuntime.createMemory).not.toHaveBeenCalled();
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
      // When enabled, createMemory should be called
      expect(mockRuntime.createMemory).toHaveBeenCalled();
    });
  });

  describe("ALLOW_MEMORY_SOURCE_IDS", () => {
    it("should allow memory creation for whitelisted source IDs", async () => {
      const mockRuntime = createMockRuntime({ 
        DISABLE_MEMORY_CREATION: false,
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
      // Whitelisted source should allow memory creation
      expect(mockRuntime.createMemory).toHaveBeenCalled();
    });

    it("should block memory creation for non-whitelisted source IDs", async () => {
      const mockRuntime = createMockRuntime({ 
        DISABLE_MEMORY_CREATION: false,
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
        metadata: { sourceId: "blocked-source" },
      };

      await service.handleMessage(mockRuntime, message, undefined);

      expect(mockRuntime.getSetting).toHaveBeenCalledWith("ALLOW_MEMORY_SOURCE_IDS");
      // Non-whitelisted source should block memory creation
      expect(mockRuntime.createMemory).not.toHaveBeenCalled();
    });
  });

  describe("keepExistingResponses / BOOTSTRAP_KEEP_RESP", () => {
    it("should read BOOTSTRAP_KEEP_RESP setting during message handling", async () => {
      const mockRuntime = createMockRuntime({ 
        BOOTSTRAP_KEEP_RESP: "true",
        DISABLE_MEMORY_CREATION: false 
      });
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

      // Verify the setting is read during message handling
      expect(mockRuntime.getSetting).toHaveBeenCalledWith("BOOTSTRAP_KEEP_RESP");
    });
  });
});
