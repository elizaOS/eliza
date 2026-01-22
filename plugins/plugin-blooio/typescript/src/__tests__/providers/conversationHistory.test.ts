import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import conversationHistoryProvider from "../../providers/conversationHistory";

describe("conversationHistoryProvider", () => {
  let mockRuntime: IAgentRuntime;
  let mockBlooioService: {
    getConversationHistory: (
      chatId: string,
      limit: number
    ) => Array<{
      direction: "inbound" | "outbound";
      timestamp: number;
      text?: string;
    }>;
  };
  let mockState: State;

  beforeEach(() => {
    vi.clearAllMocks();

    mockBlooioService = {
      getConversationHistory: vi.fn(),
    };

    mockRuntime = {
      getService: vi.fn().mockReturnValue(mockBlooioService),
    } as IAgentRuntime;

    mockState = {} as State;
  });

  describe("metadata", () => {
    it("should have correct name and description", () => {
      expect(conversationHistoryProvider.name).toBe("blooioConversationHistory");
      expect(conversationHistoryProvider.description).toBe(
        "Provides recent Blooio conversation history with a chat"
      );
    });
  });

  describe("get", () => {
    it("should return conversation history when chat id is in content", async () => {
      const mockHistory = [
        {
          direction: "inbound",
          timestamp: new Date("2024-01-01T10:00:00Z").getTime(),
          text: "Hello",
        },
        {
          direction: "outbound",
          timestamp: new Date("2024-01-01T10:01:00Z").getTime(),
          text: "Hi there",
        },
      ];

      mockBlooioService.getConversationHistory = vi.fn().mockReturnValue(mockHistory);

      const message: Memory = {
        content: {
          chatId: "+18885551234",
          text: "Get history",
        },
      } as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(mockBlooioService.getConversationHistory).toHaveBeenCalledWith("+18885551234", 10);
      expect(result.text).toContain("Recent Blooio conversation with +18885551234:");
      expect(result.text).toContain("From +18885551234: Hello");
      expect(result.text).toContain("To +18885551234: Hi there");
      expect(result.data).toEqual({
        chatId: "+18885551234",
        messageCount: 2,
        lastMessage: mockHistory[1],
      });
    });

    it("should extract chat id from text if not in chatId field", async () => {
      mockBlooioService.getConversationHistory = vi.fn().mockReturnValue([]);

      const message: Memory = {
        content: {
          text: "Show me messages with jane@example.com",
        },
      } as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(mockBlooioService.getConversationHistory).toHaveBeenCalledWith("jane@example.com", 10);
      expect(result.text).toBe("No recent conversation history with jane@example.com");
    });

    it("should handle when service is not initialized", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);

      const message: Memory = {
        content: {
          chatId: "+18885551234",
        },
      } as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe(
        "No Blooio conversation history available - service not initialized"
      );
    });

    it("should handle when content is a string", async () => {
      const message: Memory = {
        content: "Just a string",
      } as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("No chat identifier found in context");
    });

    it("should handle when no chat id is found", async () => {
      const message: Memory = {
        content: {
          text: "No identifiers here",
        },
      } as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("No chat identifier found in context");
    });

    it("should handle empty conversation history", async () => {
      mockBlooioService.getConversationHistory = vi.fn().mockReturnValue([]);

      const message: Memory = {
        content: {
          chatId: "+18885551234",
        },
      } as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("No recent conversation history with +18885551234");
    });

    it("should handle errors gracefully", async () => {
      mockBlooioService.getConversationHistory = vi.fn(() => {
        throw new Error("Service error");
      });

      const message: Memory = {
        content: {
          chatId: "+18885551234",
        },
      } as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("Error retrieving conversation history");
    });
  });
});
