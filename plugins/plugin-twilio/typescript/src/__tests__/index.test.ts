import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import twilioPlugin from "../index";

describe("twilioPlugin", () => {
  it("should have correct metadata", () => {
    expect(twilioPlugin.name).toBe("twilio");
    expect(twilioPlugin.description).toContain("Twilio plugin");
  });

  it("should export SMS/MMS actions", () => {
    expect(twilioPlugin.actions).toBeDefined();

    const actionNames = twilioPlugin.actions?.map((a) => a.name);
    expect(actionNames).toContain("SEND_SMS");
    expect(actionNames).toContain("MAKE_CALL");
    expect(actionNames).toContain("SEND_MMS");
  });

  it("should export voice call actions", () => {
    const actionNames = twilioPlugin.actions?.map((a) => a.name);
    expect(actionNames).toContain("VOICE_CALL_INITIATE");
    expect(actionNames).toContain("VOICE_CALL_MAKE");
    expect(actionNames).toContain("VOICE_CALL_CONTINUE");
    expect(actionNames).toContain("VOICE_CALL_SPEAK");
    expect(actionNames).toContain("VOICE_CALL_END");
    expect(actionNames).toContain("VOICE_CALL_STATUS");
  });

  it("should export all 9 actions total", () => {
    expect(twilioPlugin.actions).toHaveLength(9);
  });

  it("should export SMS providers", () => {
    expect(twilioPlugin.providers).toBeDefined();

    const providerNames = twilioPlugin.providers?.map((p) => p.name);
    expect(providerNames).toContain("twilioConversationHistory");
    expect(providerNames).toContain("twilioCallState");
  });

  it("should export voice call providers", () => {
    const providerNames = twilioPlugin.providers?.map((p) => p.name);
    expect(providerNames).toContain("voiceCallContext");
    expect(providerNames).toContain("voiceCallState");
  });

  it("should export all 4 providers total", () => {
    expect(twilioPlugin.providers).toHaveLength(4);
  });

  it("should export both TwilioService and VoiceCallService", () => {
    expect(twilioPlugin.services).toBeDefined();
    expect(twilioPlugin.services).toHaveLength(2);
  });

  it("should export test suite", () => {
    expect(twilioPlugin.tests).toBeDefined();
    expect(twilioPlugin.tests).toHaveLength(1);
    expect(twilioPlugin.tests?.[0].name).toBe("Twilio Plugin Test Suite");
  });

  describe("init", () => {
    let mockRuntime: IAgentRuntime;

    beforeEach(() => {
      mockRuntime = {
        getSetting: vi.fn(),
      } as unknown as IAgentRuntime;
      vi.clearAllMocks();
    });

    it("should initialize successfully with all required settings", async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        const settings: Record<string, string> = {
          TWILIO_ACCOUNT_SID: "AC123",
          TWILIO_AUTH_TOKEN: "auth123",
          TWILIO_PHONE_NUMBER: "+18885550000",
          TWILIO_WEBHOOK_URL: "https://example.com",
        };
        return settings[key];
      });

      await twilioPlugin.init?.({}, mockRuntime);

      expect(logger.info).toHaveBeenCalledWith("Twilio plugin initialized successfully");
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("should warn when account SID is missing", async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === "TWILIO_ACCOUNT_SID") return "";
        return "value";
      });

      await twilioPlugin.init?.({}, mockRuntime);

      expect(logger.warn).toHaveBeenCalledWith(
        "Twilio Account SID not provided - Twilio plugin is loaded but will not be functional"
      );
    });

    it("should warn when auth token is missing", async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === "TWILIO_AUTH_TOKEN") return "";
        if (key === "TWILIO_ACCOUNT_SID") return "AC123";
        return "value";
      });

      await twilioPlugin.init?.({}, mockRuntime);

      expect(logger.warn).toHaveBeenCalledWith(
        "Twilio Auth Token not provided - Twilio plugin is loaded but will not be functional"
      );
    });

    it("should warn when phone number is missing", async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === "TWILIO_PHONE_NUMBER") return "";
        if (key === "TWILIO_ACCOUNT_SID") return "AC123";
        if (key === "TWILIO_AUTH_TOKEN") return "auth123";
        return "value";
      });

      await twilioPlugin.init?.({}, mockRuntime);

      expect(logger.warn).toHaveBeenCalledWith(
        "Twilio Phone Number not provided - Twilio plugin is loaded but will not be functional"
      );
    });

    it("should warn when webhook URL is missing", async () => {
      mockRuntime.getSetting = vi.fn((key: string) => {
        if (key === "TWILIO_WEBHOOK_URL") return "";
        if (key === "TWILIO_ACCOUNT_SID") return "AC123";
        if (key === "TWILIO_AUTH_TOKEN") return "auth123";
        if (key === "TWILIO_PHONE_NUMBER") return "+18885550000";
        return "value";
      });

      await twilioPlugin.init?.({}, mockRuntime);

      expect(logger.warn).toHaveBeenCalledWith(
        "Twilio Webhook URL not provided - Twilio will not be able to receive incoming messages or calls"
      );
    });
  });
});
