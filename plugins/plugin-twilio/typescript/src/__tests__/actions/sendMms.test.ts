import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sendMmsAction from "../../actions/sendMms";

// Mock the dependencies
vi.mock("../../utils", () => ({
  validatePhoneNumber: vi.fn((phone) => phone.startsWith("+")),
  extractPhoneNumber: vi.fn((text) => {
    const match = text.match(/\+\d{11}/);
    return match ? match[0] : null;
  }),
}));

describe("sendMmsAction", () => {
  let mockRuntime: IAgentRuntime;
  let mockTwilioService: any;
  let mockCallback: HandlerCallback;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTwilioService = {
      sendSms: vi.fn().mockResolvedValue({
        sid: "MM123",
        from: "+18885550000",
        to: "+18885551234",
        body: "Test MMS",
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
      expect(sendMmsAction.name).toBe("SEND_MMS");
      expect(sendMmsAction.description).toBe(
        "Send an MMS (multimedia message) with images, audio, or video via Twilio"
      );
    });

    it("should have examples", () => {
      expect(sendMmsAction.examples).toBeDefined();
      expect(sendMmsAction.examples?.length).toBeGreaterThan(0);
    });

    it("should have similes", () => {
      expect(sendMmsAction.similes).toContain("send mms");
      expect(sendMmsAction.similes).toContain("send picture");
      expect(sendMmsAction.similes).toContain("send photo");
    });
  });

  describe("validate", () => {
    it("should return true when service exists and message has phone number and media intent", async () => {
      const message: Memory = {
        content: { text: "Send a picture to +18885551234" },
      } as Memory;

      const result = await sendMmsAction.validate(mockRuntime, message);
      expect(result).toBe(true);
    });

    it("should return true when message contains URLs", async () => {
      const message: Memory = {
        content: { text: "Send +18885551234 https://example.com/image.jpg" },
      } as Memory;

      const result = await sendMmsAction.validate(mockRuntime, message);
      expect(result).toBe(true);
    });

    it("should return false when service is not available", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);
      const message: Memory = {
        content: { text: "Send picture to +18885551234" },
      } as Memory;

      const result = await sendMmsAction.validate(mockRuntime, message);
      expect(result).toBe(false);
    });

    it("should return false when no phone number in message", async () => {
      const message: Memory = {
        content: { text: "Send a picture" },
      } as Memory;

      const result = await sendMmsAction.validate(mockRuntime, message);
      expect(result).toBe(false);
    });

    it("should return false when no media intent or URLs", async () => {
      const message: Memory = {
        content: { text: "+18885551234 Hello" },
      } as Memory;

      const result = await sendMmsAction.validate(mockRuntime, message);
      expect(result).toBe(false);
    });

    it("should handle different media intent keywords", async () => {
      const intents = ["image", "photo", "picture", "video", "media", "mms"];
      for (const intent of intents) {
        const message: Memory = {
          content: { text: `Send ${intent} to +18885551234` },
        } as Memory;

        const result = await sendMmsAction.validate(mockRuntime, message);
        expect(result).toBe(true);
      }
    });
  });

  describe("handler", () => {
    it("should send MMS with URL successfully", async () => {
      const message: Memory = {
        content: {
          text: "Send picture to +18885551234 with https://example.com/image.jpg saying 'Check this out!'",
        },
      } as Memory;

      await sendMmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockTwilioService.sendSms).toHaveBeenCalledWith(
        "+18885551234",
        "with   'Check this out!",
        ["https://example.com/image.jpg"]
      );
      expect(mockCallback).toHaveBeenCalledWith({
        text: "MMS sent successfully to +18885551234 with 1 media attachment(s)",
        success: true,
      });
    });

    it("should handle multiple media URLs", async () => {
      const message: Memory = {
        content: {
          text: "Send MMS to +18885551234 with https://example.com/image1.jpg and https://example.com/image2.jpg",
        },
      } as Memory;

      await sendMmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockTwilioService.sendSms).toHaveBeenCalledWith("+18885551234", "with  and", [
        "https://example.com/image1.jpg",
        "https://example.com/image2.jpg",
      ]);
    });

    it("should use default demo image when no URLs provided", async () => {
      const message: Memory = {
        content: { text: "Send a picture to +18885551234" },
      } as Memory;

      await sendMmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockTwilioService.sendSms).toHaveBeenCalledWith(
        "+18885551234",
        "Here's the media you requested",
        ["https://demo.twilio.com/owl.png"]
      );
    });

    it("should extract message content correctly", async () => {
      const testCases = [
        {
          input:
            "Send picture to +18885551234 with https://example.com/img.jpg saying 'Look at this!'",
          expectedMessage: "with   'Look  this!",
        },
        {
          input: "Send an MMS to +18885551234 with the image https://example.com/img.jpg",
          expectedMessage: "Here's the media you requested",
        },
      ];

      for (const testCase of testCases) {
        vi.clearAllMocks();
        const message: Memory = {
          content: { text: testCase.input },
        } as Memory;

        await sendMmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

        expect(mockTwilioService.sendSms).toHaveBeenCalledWith(
          "+18885551234",
          testCase.expectedMessage,
          expect.any(Array)
        );
      }
    });

    it("should handle errors gracefully", async () => {
      mockTwilioService.sendSms.mockRejectedValue(new Error("API Error"));

      const message: Memory = {
        content: { text: "Send picture to +18885551234" },
      } as Memory;

      await sendMmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Failed to send MMS: API Error",
        success: false,
      });
    });

    it("should handle missing service", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);

      const message: Memory = {
        content: { text: "Send picture to +18885551234" },
      } as Memory;

      await sendMmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Failed to send MMS: Twilio service not available",
        success: false,
      });
    });

    it("should handle invalid phone number", async () => {
      const { validatePhoneNumber } = await import("../../utils");
      (validatePhoneNumber as any).mockReturnValue(false);

      const message: Memory = {
        content: { text: "Send picture to +18885551234" },
      } as Memory;

      await sendMmsAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Failed to send MMS: Invalid phone number format",
        success: false,
      });
    });
  });
});
