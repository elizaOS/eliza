import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import conversationHistoryProvider from "../../providers/conversationHistory";

describe("conversationHistoryProvider", () => {
  let mockRuntime: IAgentRuntime;
  let mockTwilioService: any;
  let mockState: State;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTwilioService = {
      getConversationHistory: vi.fn(),
    };

    mockRuntime = {
      getService: vi.fn().mockReturnValue(mockTwilioService),
    } as any;

    mockState = {} as State;
  });

  describe("metadata", () => {
    it("should have correct name and description", () => {
      expect(conversationHistoryProvider.name).toBe("twilioConversationHistory");
      expect(conversationHistoryProvider.description).toBe(
        "Provides recent SMS/MMS conversation history with a phone number"
      );
    });
  });

  describe("get", () => {
    it("should return conversation history when phone number is in content", async () => {
      const mockHistory = [
        {
          direction: "inbound",
          dateCreated: new Date("2024-01-01T10:00:00Z"),
          body: "Hello",
        },
        {
          direction: "outbound",
          dateCreated: new Date("2024-01-01T10:01:00Z"),
          body: "Hi there",
        },
      ];

      mockTwilioService.getConversationHistory.mockReturnValue(mockHistory);

      const message = {
        content: {
          phoneNumber: "+18885551234",
          text: "Get history",
        },
      } as any as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(mockTwilioService.getConversationHistory).toHaveBeenCalledWith("+18885551234", 10);
      expect(result.text).toContain("Recent SMS conversation with +18885551234:");
      expect(result.text).toContain("From +18885551234: Hello");
      expect(result.text).toContain("To +18885551234: Hi there");
      expect(result.data).toEqual({
        phoneNumber: "+18885551234",
        messageCount: 2,
        lastMessage: mockHistory[1],
      });
    });

    it("should extract phone number from text if not in phoneNumber field", async () => {
      mockTwilioService.getConversationHistory.mockReturnValue([]);

      const message = {
        content: {
          text: "Show me messages with +18885551234",
        },
      } as any as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(mockTwilioService.getConversationHistory).toHaveBeenCalledWith("+18885551234", 10);
      expect(result.text).toBe("No recent conversation history with +18885551234");
    });

    it("should handle when service is not initialized", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);

      const message = {
        content: {
          phoneNumber: "+18885551234",
        },
      } as any as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe(
        "No Twilio conversation history available - service not initialized"
      );
    });

    it("should handle when content is a string", async () => {
      const message = {
        content: "Just a string",
      } as any as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("No phone number found in context");
    });

    it("should handle when no phone number is found", async () => {
      const message = {
        content: {
          text: "No phone number here",
        },
      } as any as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("No phone number found in context");
    });

    it("should handle when phone number is not a string", async () => {
      const message = {
        content: {
          phoneNumber: 123456, // Not a string
        },
      } as any as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("No phone number found in context");
    });

    it("should handle empty conversation history", async () => {
      mockTwilioService.getConversationHistory.mockReturnValue([]);

      const message = {
        content: {
          phoneNumber: "+18885551234",
        },
      } as any as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("No recent conversation history with +18885551234");
    });

    it("should handle errors gracefully", async () => {
      mockTwilioService.getConversationHistory.mockImplementation(() => {
        throw new Error("Service error");
      });

      const message = {
        content: {
          phoneNumber: "+18885551234",
        },
      } as any as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      expect(result.text).toBe("Error retrieving conversation history");
    });

    it("should format messages with correct timestamps", async () => {
      const mockHistory = [
        {
          direction: "inbound",
          dateCreated: new Date("2024-01-01T10:00:00Z"),
          body: "Test message",
        },
      ];

      mockTwilioService.getConversationHistory.mockReturnValue(mockHistory);

      const message = {
        content: {
          phoneNumber: "+18885551234",
        },
      } as any as Memory;

      const result = await conversationHistoryProvider.get(mockRuntime, message, mockState);

      // The exact format depends on the locale, but it should contain the message
      expect(result.text).toContain("Test message");
      expect(result.text).toContain("From +18885551234");
    });
  });
});
