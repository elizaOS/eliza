import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import makeCallAction from "../../actions/makeCall";

// Mock the dependencies
vi.mock("../../utils", () => ({
  validatePhoneNumber: vi.fn((phone) => phone.startsWith("+")),
  generateTwiML: {
    say: vi.fn((message) => `<Response><Say>${message}</Say></Response>`),
  },
  extractPhoneNumber: vi.fn((text) => {
    const match = text.match(/\+\d{11}/);
    return match ? match[0] : null;
  }),
}));

describe("makeCallAction", () => {
  let mockRuntime: IAgentRuntime;
  let mockTwilioService: any;
  let mockCallback: HandlerCallback;

  beforeEach(() => {
    vi.clearAllMocks();

    mockTwilioService = {
      makeCall: vi.fn().mockResolvedValue({
        sid: "CA123",
        from: "+18885550000",
        to: "+18885551234",
        status: "initiated",
      }),
    };

    mockRuntime = {
      getService: vi.fn().mockReturnValue(mockTwilioService),
    } as any;

    mockCallback = vi.fn();
  });

  describe("metadata", () => {
    it("should have correct name and description", () => {
      expect(makeCallAction.name).toBe("MAKE_CALL");
      expect(makeCallAction.description).toBe(
        "Make a phone call via Twilio with a message or custom TwiML"
      );
    });

    it("should have examples", () => {
      expect(makeCallAction.examples).toBeDefined();
      expect(makeCallAction.examples?.length).toBeGreaterThan(0);
    });

    it("should have similes", () => {
      expect(makeCallAction.similes).toContain("make call");
      expect(makeCallAction.similes).toContain("phone call");
      expect(makeCallAction.similes).toContain("dial number");
    });
  });

  describe("validate", () => {
    it("should return true when service exists and message has phone number and call intent", async () => {
      const message: Memory = {
        content: { text: "Call +18885551234 and say hello" },
      } as Memory;

      const result = await makeCallAction.validate(mockRuntime, message);
      expect(result).toBe(true);
    });

    it("should return false when service is not available", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);
      const message: Memory = {
        content: { text: "Call +18885551234" },
      } as Memory;

      const result = await makeCallAction.validate(mockRuntime, message);
      expect(result).toBe(false);
    });

    it("should return false when no phone number in message", async () => {
      const message: Memory = {
        content: { text: "Make a call and say hello" },
      } as Memory;

      const result = await makeCallAction.validate(mockRuntime, message);
      expect(result).toBe(false);
    });

    it("should return false when no call intent", async () => {
      const message: Memory = {
        content: { text: "+18885551234 Hello" },
      } as Memory;

      const result = await makeCallAction.validate(mockRuntime, message);
      expect(result).toBe(false);
    });

    it("should handle different call intent keywords", async () => {
      const intents = ["call", "phone", "dial"];
      for (const intent of intents) {
        const message: Memory = {
          content: { text: `${intent} +18885551234` },
        } as Memory;

        const result = await makeCallAction.validate(mockRuntime, message);
        expect(result).toBe(true);
      }
    });
  });

  describe("handler", () => {
    it("should make call successfully with message", async () => {
      const message: Memory = {
        content: {
          text: "Call +18885551234 and say 'This is an important reminder'",
        },
      } as Memory;

      await makeCallAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockTwilioService.makeCall).toHaveBeenCalledWith(
        "+18885551234",
        "<Response><Say>This is an important reminder</Say></Response>"
      );
      expect(mockCallback).toHaveBeenCalledWith({
        text: "Call initiated successfully to +18885551234. Call ID: CA123",
        success: true,
      });
    });

    it("should extract call message correctly", async () => {
      const testCases = [
        {
          input: "Call +18885551234 saying Important update",
          expected: "saying Important update",
        },
        {
          input: "Make a call to +18885551234 with the message Hello there",
          expected: "Make a  to   Hello there",
        },
        {
          input: "Phone +18885551234 and say Meeting at 3pm",
          expected: "Meeting at 3pm",
        },
      ];

      for (const testCase of testCases) {
        vi.clearAllMocks();
        const message: Memory = {
          content: { text: testCase.input },
        } as Memory;

        await makeCallAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

        const { generateTwiML } = await import("../../utils");
        expect(generateTwiML.say).toHaveBeenCalledWith(testCase.expected);
      }
    });

    it("should remove quotes from message", async () => {
      const message: Memory = {
        content: { text: `Call +18885551234 and say "Hello world"` },
      } as Memory;

      await makeCallAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      const { generateTwiML } = await import("../../utils");
      expect(generateTwiML.say).toHaveBeenCalledWith("Hello world");
    });

    it("should handle errors gracefully", async () => {
      mockTwilioService.makeCall.mockRejectedValue(new Error("API Error"));

      const message: Memory = {
        content: { text: "Call +18885551234" },
      } as Memory;

      await makeCallAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Failed to make call: API Error",
        success: false,
      });
    });

    it("should handle missing service", async () => {
      mockRuntime.getService = vi.fn().mockReturnValue(null);

      const message: Memory = {
        content: { text: "Call +18885551234" },
      } as Memory;

      await makeCallAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Failed to make call: Twilio service not available",
        success: false,
      });
    });

    it("should handle missing phone number", async () => {
      const { extractPhoneNumber } = await import("../../utils");
      (extractPhoneNumber as any).mockReturnValue(null);

      const message: Memory = {
        content: { text: "Make a call" },
      } as Memory;

      await makeCallAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Failed to make call: No phone number found in message",
        success: false,
      });
    });

    it("should handle invalid phone number", async () => {
      const { validatePhoneNumber, extractPhoneNumber } = await import("../../utils");
      (extractPhoneNumber as any).mockReturnValue("+18885551234");
      (validatePhoneNumber as any).mockReturnValue(false);

      const message: Memory = {
        content: { text: "Call +18885551234" },
      } as Memory;

      await makeCallAction.handler(mockRuntime, message, undefined, undefined, mockCallback);

      expect(mockCallback).toHaveBeenCalledWith({
        text: "Failed to make call: Invalid phone number format",
        success: false,
      });
    });
  });
});
