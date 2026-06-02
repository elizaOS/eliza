import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTwilioConnectorContribution } from "./twilio.js";

const twilioMocks = vi.hoisted(() => ({
  sendTwilioSms: vi.fn(),
  sendTwilioVoiceCall: vi.fn(),
}));

vi.mock("@elizaos/plugin-phone", () => ({
  readTwilioCredentialsFromEnv: () => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
    const fromPhoneNumber = process.env.TWILIO_PHONE_NUMBER?.trim();
    return accountSid && authToken && fromPhoneNumber
      ? { accountSid, authToken, fromPhoneNumber }
      : null;
  },
  sendTwilioSms: twilioMocks.sendTwilioSms,
  sendTwilioVoiceCall: twilioMocks.sendTwilioVoiceCall,
}));

vi.mock("../service.js", () => ({
  LifeOpsServiceError: class LifeOpsServiceError extends Error {
    readonly status: number;

    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
}));

const ORIGINAL_ENV = { ...process.env };

function configureTwilioEnv(): void {
  process.env.TWILIO_ACCOUNT_SID = "AC_test";
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_PHONE_NUMBER = "+15550000000";
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  configureTwilioEnv();
  twilioMocks.sendTwilioSms.mockReset();
  twilioMocks.sendTwilioVoiceCall.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createTwilioConnectorContribution", () => {
  it("rejects empty sms/voice targets before transport dispatch", async () => {
    const connector = createTwilioConnectorContribution({} as IAgentRuntime);

    await expect(
      connector.send?.({ target: "voice: \t ", message: "call me" }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "unknown_recipient",
      userActionable: true,
      message: "Twilio target is empty.",
    });

    expect(twilioMocks.sendTwilioSms).not.toHaveBeenCalled();
    expect(twilioMocks.sendTwilioVoiceCall).not.toHaveBeenCalled();
  });

  it("maps Twilio rate limits into retryable dispatch failures", async () => {
    twilioMocks.sendTwilioSms.mockResolvedValue({
      ok: false,
      status: 429,
      error: "Too Many Requests",
    });
    const connector = createTwilioConnectorContribution({} as IAgentRuntime);

    await expect(
      connector.send?.({ target: "sms:+15551234567", message: "ping" }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "rate_limited",
      retryAfterMinutes: 5,
      userActionable: false,
    });

    expect(twilioMocks.sendTwilioSms).toHaveBeenCalledWith({
      credentials: {
        accountSid: "AC_test",
        authToken: "token",
        fromPhoneNumber: "+15550000000",
      },
      to: "+15551234567",
      body: "ping",
    });
  });

  it("returns disconnected instead of throwing when credentials are absent", async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
    const connector = createTwilioConnectorContribution({} as IAgentRuntime);

    await expect(
      connector.send?.({ target: "+15551234567", message: "ping" }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "disconnected",
      userActionable: true,
    });
  });
});
