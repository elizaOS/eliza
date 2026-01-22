import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sendSmsAction from "../../actions/sendSms";

// Mock the dependencies
vi.mock("../../utils", () => ({
  validatePhoneNumber: vi.fn((phone) => phone.startsWith("+")),
  extractPhoneNumber: vi.fn((text) => {
    const match = text.match(/\+\d{11}/);
    return match ? match[0] : null;
  }),
  chunkTextForSms: vi.fn((text) => [text]),
}));

describe("sendSmsAction", () => {
  let mockRuntime: IAgentRuntime;
  let mockTwilioService: any;
  let mockCallback: HandlerCallback;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTwilioService = {
      sendSms: vi.fn().mockResolvedValue({
        sid: "SM123",
        from: "+18885550000",
        to: "+18885551234",
        body: "Test message",
        status: "sent",
      }),
    };

    mockRuntime = {
      getService: vi.fn().mockReturnValue(mockTwilioService),
    } as any;

    mockCallback = vi.fn();
  });

  describe("metadata", () => {
    it("should have correct name and description", () => {
      expect(sendSmsAction.name).toBe("SEND_SMS");
      expect(sendSmsAction.description).toBe("Send an SMS message to a phone number via Twilio");
    });

    it("should have examples", () => {
      expect(sendSmsAction.examples).toBeDefined();
      expect(sendSmsAction.examples?.length).toBeGreaterThan(0);
    });

    it("should have similes", () => {
      expect(sendSmsAction.similes).toContain("send sms");
      expect(sendSmsAction.similes).toContain("send text");
      expect(sendSmsAction.similes).toContain("text message");
    });
  });

  describe("validate", () => {
    it("should return true when service exists and message has phone number", async () => {
      const message: Memory = {
        content: { text: "Send SMS to +18885551234" },
      } as Memory;

      const result = await sendSmsAction.validate(mockRuntime, message);
      expect(result).toBe(true);
    });

    it("should return false when service is not available", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);
      const message: Memory = {
        content: { text: "Send SMS to +18885551234" },
      } as Memory;

      const result = await sendSmsAction.validate(mockRuntime, message);
      expect(result).toBe(false);
    });

    it("should return false when no phone number in message", async () => {
      const message: Memory = {
        content: { text: "Send an SMS message" },
      } as Memory;

      const result = await sendSmsAction.validate(mockRuntime, message);
      expect(result).toBe(false);
    });

    it("should handle different text formats", async () => {
      const formats = [
        "Text +18885551234",
        "SMS +18885551234",
        "Message +18885551234",
        "Send text to +18885551234",
      ];

      for (const format of formats) {
        const message: Memory = {
          content: { text: format },
        } as Memory;

        const result = await sendSmsAction.validate(mockRuntime, message);
        expect(result).toBe(true);
      }
    });
  });

  describe("handler", () => {
    it("should send SMS successfully", async () => {
      const message: Memory = {
        content: {
          text: "Send SMS to +18885551234 saying 'Hello, this is a test!'",
        },
      } as Memory;

      await sendSmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockTwilioService.sendSms).toHaveBeenCalledWith(
        "+18885551234",
        "Hello, this is a test!"
      );
      expect(mockCallback).toHaveBeenCalledWith({
        text: "SMS message sent successfully to +18885551234",
        success: true,
      });
    });

    it("should extract message content correctly", async () => {
      const testCases = [
        {
          input: "Text +18885551234 with the message 'Hello!'",
          expectedMessage: "Hello!",
        },
        {
          input: "Send SMS to +18885551234 saying 'Test message'",
          expectedMessage: "Test message",
        },
        {
          input: "SMS +18885551234 'Important update'",
          expectedMessage: "SMS  'Important update",
        },
        {
          input: "Message +18885551234 Hello there",
          expectedMessage: "Message  Hello there",
        },
      ];

      for (const testCase of testCases) {
        vi.clearAllMocks();
        const message: Memory = {
          content: { text: testCase.input },
        } as Memory;

        await sendSmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

        expect(mockTwilioService.sendSms).toHaveBeenCalledWith(
          "+18885551234",
          testCase.expectedMessage
        );
      }
    });

    it("should handle errors gracefully", async () => {
      mockTwilioService.sendSms.mockRejectedValue(new Error("API Error"));

      const message: Memory = {
        content: { text: "Send SMS to +18885551234 saying 'Test'" },
      } as Memory;

      await sendSmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Failed to send SMS: API Error",
        success: false,
      });
    });

    it("should handle missing service", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);

      const message: Memory = {
        content: { text: "Send SMS to +18885551234" },
      } as Memory;

      await sendSmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Failed to send SMS: Twilio service not available",
        success: false,
      });
    });

    it("should handle invalid phone number", async () => {
      const { validatePhoneNumber } = await import("../../utils");
      (validatePhoneNumber as any).mockReturnValue(false);

      const message: Memory = {
        content: { text: "Send SMS to +18885551234" },
      } as Memory;

      await sendSmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Failed to send SMS: Invalid phone number format",
        success: false,
      });
    });

    it("should handle long messages", async () => {
      const longMessage =
        "This is a very long message that exceeds the typical SMS character limit. ".repeat(10);
      const message: Memory = {
        content: { text: `Send SMS to +18885551234 saying '${longMessage}'` },
      } as Memory;

      // Mock chunkTextForSms to return chunks
      const { chunkTextForSms, validatePhoneNumber } = await import("../../utils");
      (chunkTextForSms as any).mockReturnValue([
        longMessage.substring(0, 160),
        longMessage.substring(160, 320),
      ]);
      (validatePhoneNumber as any).mockReturnValue(true);

      await sendSmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      // The sendSms should be called multiple times due to chunking
      expect(mockTwilioService.sendSms).toHaveBeenCalledTimes(2);
      expect(mockCallback).toHaveBeenCalledWith({
        text: "SMS message sent successfully to +18885551234",
        success: true,
      });
    });
  });
});
