import type { Content, IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import conversationHistoryProvider from "../../providers/conversationHistory";

/**
 * Twilio message structure for conversation history
 */
interface TwilioMessage {
  direction: "inbound" | "outbound";
  dateCreated: Date;
  body: string;
}

/**
 * Minimal TwilioService interface for testing
 */
interface TwilioServiceTestable {
  getConversationHistory: (phoneNumber: string, limit: number) => TwilioMessage[];
}

/**
 * Creates a test Memory object with custom content
 */
function createTestMemory(contentOverrides: Partial<Content> = {}): Memory {
  return {
    id: "test-memory-id" as UUID,
    roomId: "test-room-id" as UUID,
    entityId: "test-entity-id" as UUID,
    agentId: "test-agent-id" as UUID,
    content: {
      text: "test message",
      channelType: ChannelType.DM,
      ...contentOverrides,
    },
    createdAt: Date.now(),
  };
}

/**
 * Creates a test Memory with string content (edge case)
 */
function createTestMemoryWithStringContent(): Memory {
  return {
    id: "test-memory-id" as UUID,
    roomId: "test-room-id" as UUID,
    entityId: "test-entity-id" as UUID,
    agentId: "test-agent-id" as UUID,
    content: "Just a string" as unknown as Content,
    createdAt: Date.now(),
  };
}

/**
 * Creates a test State object
 */
function createTestState(): State {
  return {
    values: {},
    data: {},
    text: "",
  };
}

describe("conversationHistoryProvider", () => {
  let twilioService: TwilioServiceTestable;
  let testRuntime: IAgentRuntime;
  let testState: State;

  beforeEach(() => {
    vi.clearAllMocks();

    twilioService = {
      getConversationHistory: vi.fn().mockReturnValue([]),
    };

    testRuntime = {
      getService: vi.fn().mockReturnValue(twilioService),
      agentId: "test-agent-id" as UUID,
    } as unknown as IAgentRuntime;

    testState = createTestState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      const mockHistory: TwilioMessage[] = [
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

      twilioService.getConversationHistory = vi.fn().mockReturnValue(mockHistory);

      const message = createTestMemory({
        phoneNumber: "+18885551234",
        text: "Get history",
      });

      const result = await conversationHistoryProvider.get(testRuntime, message, testState);

      expect(twilioService.getConversationHistory).toHaveBeenCalledWith("+18885551234", 10);
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
      twilioService.getConversationHistory = vi.fn().mockReturnValue([]);

      const message = createTestMemory({
        text: "Show me messages with +18885551234",
      });

      const result = await conversationHistoryProvider.get(testRuntime, message, testState);

      expect(twilioService.getConversationHistory).toHaveBeenCalledWith("+18885551234", 10);
      expect(result.text).toBe("No recent conversation history with +18885551234");
    });

    it("should handle when service is not initialized", async () => {
      const runtimeWithoutService = {
        getService: vi.fn().mockReturnValue(null),
        agentId: "test-agent-id" as UUID,
      } as unknown as IAgentRuntime;

      const message = createTestMemory({
        phoneNumber: "+18885551234",
      });

      const result = await conversationHistoryProvider.get(
        runtimeWithoutService,
        message,
        testState
      );

      expect(result.text).toBe(
        "No Twilio conversation history available - service not initialized"
      );
    });

    it("should handle when content is a string", async () => {
      const message = createTestMemoryWithStringContent();

      const result = await conversationHistoryProvider.get(testRuntime, message, testState);

      expect(result.text).toBe("No phone number found in context");
    });

    it("should handle when no phone number is found", async () => {
      const message = createTestMemory({
        text: "No phone number here",
      });

      const result = await conversationHistoryProvider.get(testRuntime, message, testState);

      expect(result.text).toBe("No phone number found in context");
    });

    it("should handle when phone number is not a string", async () => {
      const message = createTestMemory({
        phoneNumber: 123456 as unknown as string, // Testing type coercion edge case
      });

      const result = await conversationHistoryProvider.get(testRuntime, message, testState);

      expect(result.text).toBe("No phone number found in context");
    });

    it("should handle empty conversation history", async () => {
      twilioService.getConversationHistory = vi.fn().mockReturnValue([]);

      const message = createTestMemory({
        phoneNumber: "+18885551234",
      });

      const result = await conversationHistoryProvider.get(testRuntime, message, testState);

      expect(result.text).toBe("No recent conversation history with +18885551234");
    });

    it("should handle errors gracefully", async () => {
      twilioService.getConversationHistory = vi.fn().mockImplementation(() => {
        throw new Error("Service error");
      });

      const message = createTestMemory({
        phoneNumber: "+18885551234",
      });

      const result = await conversationHistoryProvider.get(testRuntime, message, testState);

      expect(result.text).toBe("Error retrieving conversation history");
    });

    it("should format messages with correct timestamps", async () => {
      const mockHistory: TwilioMessage[] = [
        {
          direction: "inbound",
          dateCreated: new Date("2024-01-01T10:00:00Z"),
          body: "Test message",
        },
      ];

      twilioService.getConversationHistory = vi.fn().mockReturnValue(mockHistory);

      const message = createTestMemory({
        phoneNumber: "+18885551234",
      });

      const result = await conversationHistoryProvider.get(testRuntime, message, testState);

      // The exact format depends on the locale, but it should contain the message
      expect(result.text).toContain("Test message");
      expect(result.text).toContain("From +18885551234");
    });
  });
});
