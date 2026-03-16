import { describe, it, expect, vi } from "vitest";
import { DefaultMessageService } from "../services/message";
import { ChannelType } from "../../types/primitives";
import type { IAgentRuntime, Memory, State } from "../../types";

describe("Memory Creation Controls", () => {
  let runtime: IAgentRuntime;
  let messageService: DefaultMessageService;

  beforeEach(() => {
    runtime = {
      agentId: "test-agent",
      getSetting: vi.fn(),
      createMemory: vi.fn(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(), 
        warn: vi.fn(),
        error: vi.fn()
      }
    } as unknown as IAgentRuntime;
    
    messageService = new DefaultMessageService();
  });

  describe("DISABLE_MEMORY_CREATION", () => {
    it("should skip memory creation when DISABLE_MEMORY_CREATION is true", async () => {
      vi.spyOn(runtime, "getSetting").mockImplementation((key) => {
        if (key === "DISABLE_MEMORY_CREATION") return "true";
        return null;
      });

      const message = {
        id: "test-id",
        content: {
          text: "Test message",
          channelType: ChannelType.GROUP
        },
        roomId: "room-id",
        entityId: "entity-id"
      } as Memory;

      await messageService.handleMessage(runtime, message);

      expect(runtime.createMemory).not.toHaveBeenCalled();
    });

    it("should create memory when DISABLE_MEMORY_CREATION is false", async () => {
      vi.spyOn(runtime, "getSetting").mockImplementation((key) => {
        if (key === "DISABLE_MEMORY_CREATION") return "false";
        return null;
      });

      const message = {
        id: "test-id",
        content: {
          text: "Test message",
          channelType: ChannelType.GROUP  
        },
        roomId: "room-id",
        entityId: "entity-id"
      } as Memory;

      await messageService.handleMessage(runtime, message);

      expect(runtime.createMemory).toHaveBeenCalled();
    });
  });

  describe("ALLOW_MEMORY_SOURCE_IDS", () => {
    it("should allow memory creation for whitelisted source IDs", async () => {
      vi.spyOn(runtime, "getSetting").mockImplementation((key) => {
        if (key === "ALLOW_MEMORY_SOURCE_IDS") return "source1,source2";
        return null;
      });

      const message = {
        content: {
          text: "Test message",
          channelType: ChannelType.GROUP
        },
        metadata: {
          sourceId: "source1"  
        },
        roomId: "room-id",
        entityId: "entity-id"
      } as Memory;

      await messageService.handleMessage(runtime, message);

      expect(runtime.createMemory).toHaveBeenCalled();
    });
  });
});

describe("Keeping Existing Responses", () => {
  let runtime: IAgentRuntime;
  let state: State;
  
  beforeEach(() => {
    runtime = {
      agentId: "test-agent",
      getSetting: vi.fn(),
      getMemoriesByRoomIds: vi.fn(),
      deleteMemory: vi.fn(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn() 
      }
    } as unknown as IAgentRuntime;
  });

  it("should preserve existing responses when keepExistingResponses is true", async () => {
    vi.spyOn(runtime, "getSetting").mockImplementation((key) => {
      if (key === "BOOTSTRAP_KEEP_RESP") return "true";
      return null; 
    });

    const existingMemories = [
      {
        id: "existing-1",
        content: { text: "Previous response" }
      }
    ] as Memory[];

    vi.spyOn(runtime, "getMemoriesByRoomIds").mockResolvedValue(existingMemories);

    const message = {
      roomId: "test-room",
      content: { text: "New message" }
    } as Memory;

    const messageService = new DefaultMessageService();
    await messageService.handleMessage(runtime, message);

    expect(runtime.deleteMemory).not.toHaveBeenCalledWith("existing-1");
  });
});
