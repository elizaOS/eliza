import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwilioService } from "../service";
import { TwilioError } from "../types";

// Mock dependencies first before any other code
vi.mock("twilio", () => {
  return {
    default: vi.fn(),
  };
});

vi.mock("express", () => ({
  default: vi.fn(() => ({
    use: vi.fn(),
    post: vi.fn(),
    listen: vi.fn((port, cb) => {
      cb();
      return { close: vi.fn() };
    }),
  })),
}));

vi.mock("ws", () => ({
  WebSocketServer: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// Create mock Twilio client factory
const createMockTwilioClient = () => {
  const mockClient = {
    messages: {
      create: vi.fn(),
    },
    calls: {
      create: vi.fn(),
    },
    incomingPhoneNumbers: {
      list: vi.fn(),
    },
  };

  // Make incomingPhoneNumbers callable as a function
  mockClient.incomingPhoneNumbers = Object.assign(
    vi.fn((sid: string) => ({
      update: vi.fn().mockResolvedValue({}),
    })),
    {
      list: vi.fn(),
    }
  );

  return mockClient;
};

describe("TwilioService", () => {
  let service: TwilioService;
  let mockRuntime: IAgentRuntime;
  let mockTwilioClient: any;
  let mockTwilio: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Get the mocked twilio function
    const twilioModule = await import("twilio");
    mockTwilio = twilioModule.default as any;

    mockRuntime = {
      getSetting: vi.fn((key: string) => {
        const settings: Record<string, string> = {
          TWILIO_ACCOUNT_SID: "AC123",
          TWILIO_AUTH_TOKEN: "auth123",
          TWILIO_PHONE_NUMBER: "+18885550000",
          TWILIO_WEBHOOK_URL: "https://example.com",
          TWILIO_WEBHOOK_PORT: "3000",
        };
        return settings[key];
      }),
      agentId: "agent123",
      createMemory: vi.fn(),
      emitEvent: vi.fn(),
    } as any;

    service = new TwilioService();

    // Set up the mock Twilio client
    mockTwilioClient = createMockTwilioClient();
    mockTwilio.mockReturnValue(mockTwilioClient);
  });

  afterEach(async () => {
    if (service) {
      await service.cleanup();
    }
  });

  describe("initialization", () => {
    it("should initialize successfully with valid configuration", async () => {
      mockTwilioClient.incomingPhoneNumbers.list.mockResolvedValue([{ sid: "PN123" }]);

      await service.initialize(mockRuntime);

      expect(service.isConnected).toBe(true);
      expect(service.phoneNumber).toBe("+18885550000");
    });

    it("should throw error when credentials are missing", async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === "TWILIO_ACCOUNT_SID") return "";
        return "value";
      });

      await expect(service.initialize(mockRuntime)).rejects.toThrow(TwilioError);
    });

    it("should handle duplicate initialization gracefully", async () => {
      mockTwilioClient.incomingPhoneNumbers.list.mockResolvedValue([{ sid: "PN123" }]);

      await service.initialize(mockRuntime);
      await service.initialize(mockRuntime); // Second call

      expect(service.isConnected).toBe(true);
    });
  });

  describe("sendSms", () => {
    beforeEach(async () => {
      mockTwilioClient.incomingPhoneNumbers.list.mockResolvedValue([{ sid: "PN123" }]);
      await service.initialize(mockRuntime);
    });

    it("should send SMS successfully", async () => {
      const mockMessage = {
        sid: "SM123",
        from: "+18885550000",
        to: "+18885551234",
        body: "Test message",
        status: "sent",
        dateCreated: new Date(),
      };

      mockTwilioClient.messages.create.mockResolvedValue(mockMessage);

      const result = await service.sendSms("+18885551234", "Test message");

      expect(result.sid).toBe("SM123");
      expect(result.body).toBe("Test message");
      expect(mockTwilioClient.messages.create).toHaveBeenCalledWith({
        from: "+18885550000",
        to: "+18885551234",
        body: "Test message",
        mediaUrl: undefined,
        statusCallback: "https://example.com/webhooks/twilio/status",
      });
    });

    it("should send MMS with media URLs", async () => {
      const mockMessage = {
        sid: "MM123",
        from: "+18885550000",
        to: "+18885551234",
        body: "Test MMS",
        status: "sent",
        dateCreated: new Date(),
      };

      mockTwilioClient.messages.create.mockResolvedValue(mockMessage);

      const mediaUrls = ["https://example.com/image.jpg"];
      const result = await service.sendSms("+18885551234", "Test MMS", mediaUrls);

      expect(result.sid).toBe("MM123");
      expect(mockTwilioClient.messages.create).toHaveBeenCalledWith({
        from: "+18885550000",
        to: "+18885551234",
        body: "Test MMS",
        mediaUrl: mediaUrls,
        statusCallback: "https://example.com/webhooks/twilio/status",
      });
    });

    it("should throw error for invalid phone number", async () => {
      await expect(service.sendSms("invalid", "Test")).rejects.toThrow(TwilioError);
    });

    it("should handle API errors", async () => {
      mockTwilioClient.messages.create.mockRejectedValue(new Error("API Error"));

      await expect(service.sendSms("+18885551234", "Test")).rejects.toThrow(TwilioError);
    });

    it("should emit SMS_SENT event", async () => {
      const mockMessage = {
        sid: "SM123",
        from: "+18885550000",
        to: "+18885551234",
        body: "Test",
        status: "sent",
        dateCreated: new Date(),
      };

      mockTwilioClient.messages.create.mockResolvedValue(mockMessage);

      await service.sendSms("+18885551234", "Test");

      expect(mockRuntime.emitEvent).toHaveBeenCalledWith(
        "sms:sent",
        expect.objectContaining({ sid: "SM123" })
      );
    });
  });

  describe("makeCall", () => {
    beforeEach(async () => {
      mockTwilioClient.incomingPhoneNumbers.list.mockResolvedValue([{ sid: "PN123" }]);
      await service.initialize(mockRuntime);
    });

    it("should make call with TwiML", async () => {
      const mockCall = {
        sid: "CA123",
        from: "+18885550000",
        to: "+18885551234",
        status: "initiated",
        dateCreated: new Date(),
      };

      mockTwilioClient.calls.create.mockResolvedValue(mockCall);

      const twiml = "<Response><Say>Hello</Say></Response>";
      const result = await service.makeCall("+18885551234", twiml);

      expect(result.sid).toBe("CA123");
      expect(mockTwilioClient.calls.create).toHaveBeenCalledWith({
        from: "+18885550000",
        to: "+18885551234",
        twiml,
        statusCallback: "https://example.com/webhooks/twilio/status",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      });
    });

    it("should make call with URL", async () => {
      const mockCall = {
        sid: "CA123",
        from: "+18885550000",
        to: "+18885551234",
        status: "initiated",
        dateCreated: new Date(),
      };

      mockTwilioClient.calls.create.mockResolvedValue(mockCall);

      const url = "https://example.com/twiml";
      const result = await service.makeCall("+18885551234", undefined, url);

      expect(result.sid).toBe("CA123");
      expect(mockTwilioClient.calls.create).toHaveBeenCalledWith(expect.objectContaining({ url }));
    });

    it("should use default TwiML when no TwiML or URL provided", async () => {
      const mockCall = {
        sid: "CA123",
        from: "+18885550000",
        to: "+18885551234",
        status: "initiated",
        dateCreated: new Date(),
      };

      mockTwilioClient.calls.create.mockResolvedValue(mockCall);

      await service.makeCall("+18885551234");

      expect(mockTwilioClient.calls.create).toHaveBeenCalledWith(
        expect.objectContaining({
          twiml: expect.stringContaining("Hello from Eliza AI assistant"),
        })
      );
    });

    it("should throw error for invalid phone number", async () => {
      await expect(service.makeCall("invalid")).rejects.toThrow(TwilioError);
    });
  });

  describe("conversation history", () => {
    beforeEach(async () => {
      mockTwilioClient.incomingPhoneNumbers.list.mockResolvedValue([{ sid: "PN123" }]);
      await service.initialize(mockRuntime);
    });

    it("should return conversation history", async () => {
      // Send a message to populate history
      const mockMessage = {
        sid: "SM123",
        from: "+18885550000",
        to: "+18885551234",
        body: "Test",
        status: "sent",
        dateCreated: new Date(),
      };

      mockTwilioClient.messages.create.mockResolvedValue(mockMessage);
      await service.sendSms("+18885551234", "Test");

      const history = service.getConversationHistory("+18885551234");

      expect(history).toHaveLength(1);
      expect(history[0].body).toBe("Test");
    });

    it("should return empty array for no history", () => {
      const history = service.getConversationHistory("+18885559999");
      expect(history).toEqual([]);
    });

    it("should limit history to requested number", async () => {
      // Send multiple messages
      for (let i = 0; i < 5; i++) {
        const mockMessage = {
          sid: `SM${i}`,
          from: "+18885550000",
          to: "+18885551234",
          body: `Message ${i}`,
          status: "sent",
          dateCreated: new Date(),
        };

        mockTwilioClient.messages.create.mockResolvedValue(mockMessage);
        await service.sendSms("+18885551234", `Message ${i}`);
      }

      const history = service.getConversationHistory("+18885551234", 3);

      expect(history).toHaveLength(3);
      expect(history[0].body).toBe("Message 2"); // Should get last 3
    });
  });

  describe("call state", () => {
    beforeEach(async () => {
      mockTwilioClient.incomingPhoneNumbers.list.mockResolvedValue([{ sid: "PN123" }]);
      await service.initialize(mockRuntime);
    });

    it("should return call state", async () => {
      const mockCall = {
        sid: "CA123",
        from: "+18885550000",
        to: "+18885551234",
        status: "initiated",
        dateCreated: new Date(),
      };

      mockTwilioClient.calls.create.mockResolvedValue(mockCall);
      await service.makeCall("+18885551234");

      const callState = service.getCallState("CA123");

      expect(callState).toBeDefined();
      expect(callState?.sid).toBe("CA123");
    });

    it("should return undefined for unknown call", () => {
      const callState = service.getCallState("CA999");
      expect(callState).toBeUndefined();
    });
  });

  describe("cleanup", () => {
    it("should clean up resources", async () => {
      mockTwilioClient.incomingPhoneNumbers.list.mockResolvedValue([{ sid: "PN123" }]);

      await service.initialize(mockRuntime);
      await service.cleanup();

      expect(service.isConnected).toBe(false);
    });
  });

  describe("static methods", () => {
    it("should have correct service type", () => {
      expect(TwilioService.serviceType).toBe("twilio");
    });

    it("should start service", async () => {
      mockTwilioClient.incomingPhoneNumbers.list.mockResolvedValue([{ sid: "PN123" }]);

      const newService = await TwilioService.start(mockRuntime);

      expect(newService).toBeInstanceOf(TwilioService);
      expect(newService.isConnected).toBe(true);

      await newService.cleanup();
    });

    it("should stop service", async () => {
      await expect(TwilioService.stop(mockRuntime)).resolves.not.toThrow();
    });
  });
});
