/** Proves WhatsApp webhook logs exclude message, phone, and provider-body sentinels. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const sentinelPhone = "+19995550123";
const sentinelContent = "SENTINEL_WHATSAPP_MESSAGE_BODY";
const sentinelProviderBody = "SENTINEL_WHATSAPP_PROVIDER_BODY";
const sentinelMessageType = "SENTINEL_WHATSAPP_MESSAGE_TYPE";
const loggerInfo = mock();
const loggerWarn = mock();
const loggerError = mock();
const loggerDebug = mock();
const releaseProcessingClaim = mock(async () => undefined);
const tryClaimForProcessing = mock(async () => true);
const routeIncomingMessage = mock(async (): Promise<unknown> => {
  throw new Error(sentinelProviderBody);
});

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { AGGRESSIVE: {}, STANDARD: {} },
  rateLimit: () => async (_context: unknown, next: () => Promise<void>) =>
    next(),
}));

mock.module("@/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: {
    routeWhatsAppMessage: mock(async () => ({ handled: false })),
  },
}));

mock.module("@/lib/services/message-router", () => ({
  messageRouterService: {
    routeIncomingMessage,
  },
}));

mock.module("@/lib/services/whatsapp-automation", () => ({
  whatsappAutomationService: {
    getAccessToken: mock(async () => null),
    getBusinessPhone: mock(async () => null),
    getPhoneNumberId: mock(async () => null),
    verifyWebhookSignature: mock(async () => true),
    verifyWebhookSubscription: mock(async () => null),
  },
}));

mock.module("@/lib/utils/idempotency", () => ({
  releaseProcessingClaim,
  tryClaimForProcessing,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
    debug: loggerDebug,
  },
}));

mock.module("@/lib/utils/perf-trace", () => ({
  createPerfTrace: () => ({ mark: mock(), end: mock() }),
}));

mock.module("@/lib/utils/whatsapp-api", () => ({
  extractWhatsAppMessages: () => [
    {
      from: sentinelPhone,
      messageId: "provider-message-id",
      phoneNumberId: sentinelPhone,
      timestamp: "1787263200",
      type: sentinelMessageType,
      text: sentinelContent,
    },
  ],
  isValidWhatsAppId: () => true,
  markWhatsAppMessageAsRead: mock(async () => undefined),
  parseWhatsAppWebhookPayload: (payload: unknown) => payload,
  startWhatsAppTypingIndicator: () => () => undefined,
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:orgId", route);
const organizationId = "51111111-1111-4111-8111-111111111111";
const idempotencyKey = `whatsapp:org:${organizationId}:provider-message-id`;

async function postWebhook(): Promise<Response> {
  return app.fetch(
    new Request(`https://api.example.test/${organizationId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { NODE_ENV: "test", SKIP_WEBHOOK_VERIFICATION: "true" },
  );
}

describe("WhatsApp webhook logging", () => {
  beforeEach(() => {
    routeIncomingMessage.mockReset();
    routeIncomingMessage.mockRejectedValue(new Error(sentinelProviderBody));
    releaseProcessingClaim.mockReset();
    releaseProcessingClaim.mockResolvedValue(undefined);
    tryClaimForProcessing.mockReset();
    tryClaimForProcessing.mockResolvedValue(true);
    loggerInfo.mockClear();
    loggerWarn.mockClear();
    loggerError.mockClear();
    loggerDebug.mockClear();
  });

  test("uses only bounded diagnostics", async () => {
    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(releaseProcessingClaim).toHaveBeenCalledTimes(1);
    const serializedLogs = JSON.stringify([
      ...loggerInfo.mock.calls,
      ...loggerWarn.mock.calls,
      ...loggerError.mock.calls,
      ...loggerDebug.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(sentinelPhone);
    expect(serializedLogs).not.toContain(sentinelContent);
    expect(serializedLogs).not.toContain(sentinelProviderBody);
    expect(serializedLogs).not.toContain(sentinelMessageType);
  });

  test("preserves the existing WhatsApp claim contract", async () => {
    routeIncomingMessage.mockResolvedValueOnce({ success: false });

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(tryClaimForProcessing).toHaveBeenCalledWith(
      idempotencyKey,
      "whatsapp-org",
    );
    expect(releaseProcessingClaim).not.toHaveBeenCalled();
  });

  test("continues to acknowledge concurrent duplicates", async () => {
    tryClaimForProcessing.mockResolvedValue(false);

    const response = await postWebhook();

    expect(response.status).toBe(200);
    expect(routeIncomingMessage).not.toHaveBeenCalled();
    expect(releaseProcessingClaim).not.toHaveBeenCalled();
  });
});
