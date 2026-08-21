/** Proves Twilio logs and billing metadata exclude message and phone sentinels. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const sentinelPhone = "+19995550123";
const sentinelRecipient = "+19995550999";
const sentinelOrgId = "SENTINEL_TWILIO_ORG_PATH";
const sentinelContent = "SENTINEL_TWILIO_MESSAGE_BODY";
const sentinelReply = "SENTINEL_TWILIO_AGENT_REPLY";
const sentinelProviderBody = "SENTINEL_TWILIO_PROVIDER_BODY";
const sentinelNumMedia = "SENTINEL_TWILIO_NUM_MEDIA";
const loggerInfo = mock();
const loggerWarn = mock();
const loggerError = mock();
const loggerDebug = mock();
const sendMessage = mock(async () => true);
const markAsProcessed = mock(async () => undefined);
const usageCreate = mock(async (_record: unknown) => {
  throw new Error(sentinelProviderBody);
});

mock.module("@elizaos/cloud-shared/billing", () => ({
  calculateTwilioSmsBilling: () => ({
    rawCost: 0.01,
    markup: 0.001,
    segments: 1,
    costPerSegment: 0.01,
  }),
  resolveTwilioSmsCostPerSegment: () => 0.01,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { AGGRESSIVE: {} },
  rateLimit: () => async (_context: unknown, next: () => Promise<void>) =>
    next(),
}));

mock.module("@/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: {
    routePhoneMessage: mock(async () => ({
      handled: true,
      replyText: sentinelReply,
      agentId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
    })),
  },
}));

mock.module("@/lib/services/message-router", () => ({
  messageRouterService: {
    sendMessage,
  },
}));

mock.module("@/lib/services/twilio-automation", () => ({
  twilioAutomationService: {
    getAuthToken: mock(async () => "test-token"),
  },
}));

mock.module("@/lib/services/usage", () => ({
  usageService: { create: usageCreate },
}));

mock.module("@/lib/utils/idempotency", () => ({
  isAlreadyProcessed: mock(async () => false),
  markAsProcessed,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
    debug: loggerDebug,
  },
}));

mock.module("@/lib/utils/twilio-api", () => ({
  extractMediaUrls: () => [],
  parseTwilioWebhookEvent: () => ({
    From: sentinelPhone,
    To: sentinelRecipient,
    Body: sentinelContent,
    MessageSid: "provider-message-id",
    NumMedia: sentinelNumMedia,
    AccountSid: "provider-account-id",
    FromCity: "SENTINEL_CITY",
    FromState: "SENTINEL_STATE",
    FromCountry: "SENTINEL_COUNTRY",
  }),
  verifyTwilioSignature: mock(async () => true),
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:orgId", route);

describe("Twilio webhook privacy", () => {
  beforeEach(() => {
    sendMessage.mockReset();
    sendMessage.mockResolvedValue(true);
    markAsProcessed.mockClear();
    usageCreate.mockClear();
    loggerInfo.mockClear();
    loggerWarn.mockClear();
    loggerError.mockClear();
    loggerDebug.mockClear();
  });

  test("uses bounded logs and excludes phone data from billing metadata", async () => {
    const response = await app.fetch(
      new Request(`https://api.example.test/${sentinelOrgId}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "test=value",
      }),
      { NODE_ENV: "test", SKIP_WEBHOOK_VERIFICATION: "true" },
    );

    expect(response.status).toBe(200);
    const serializedLogs = JSON.stringify([
      ...loggerInfo.mock.calls,
      ...loggerWarn.mock.calls,
      ...loggerError.mock.calls,
      ...loggerDebug.mock.calls,
    ]);
    for (const sentinel of [
      sentinelPhone,
      sentinelRecipient,
      sentinelOrgId,
      sentinelContent,
      sentinelReply,
      sentinelProviderBody,
      sentinelNumMedia,
      "SENTINEL_CITY",
      "SENTINEL_STATE",
      "SENTINEL_COUNTRY",
    ]) {
      expect(serializedLogs).not.toContain(sentinel);
    }

    expect(usageCreate).toHaveBeenCalledTimes(1);
    const usageRecord = usageCreate.mock.calls[0]?.[0];
    const serializedUsage = JSON.stringify(usageRecord);
    expect(serializedUsage).not.toContain(sentinelPhone);
    expect(serializedUsage).not.toContain(sentinelRecipient);
    expect(serializedUsage).not.toContain(sentinelContent);
    expect(serializedUsage).not.toContain(sentinelReply);
  });

  test("does not claim the event when response dispatch unexpectedly throws", async () => {
    sendMessage.mockRejectedValueOnce(
      Object.assign(new Error("response dispatch failed"), {
        code: "PROVIDER_DISPATCH_FAILED",
      }),
    );

    const response = await app.fetch(
      new Request(`https://api.example.test/${sentinelOrgId}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "test=value",
      }),
      { NODE_ENV: "test", SKIP_WEBHOOK_VERIFICATION: "true" },
    );

    expect(response.status).toBe(500);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(markAsProcessed).not.toHaveBeenCalled();
    expect(usageCreate).not.toHaveBeenCalled();
  });
});
