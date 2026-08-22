/** Proves Blooio logs and error responses exclude message and phone sentinels. */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const sentinelPhone = "+19995550123";
const sentinelRecipient = "+19995550999";
const sentinelOrgId = "SENTINEL_BLOOIO_ORG_PATH";
const sentinelContent = "SENTINEL_BLOOIO_MESSAGE_BODY";
const sentinelProviderBody = "SENTINEL_BLOOIO_PROVIDER_BODY";
const sentinelProviderProtocol = "SENTINEL_BLOOIO_PROVIDER_PROTOCOL";
const loggerInfo = mock();
const loggerWarn = mock();
const loggerError = mock();
const loggerDebug = mock();

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { AGGRESSIVE: {} },
  rateLimit: () => async (_context: unknown, next: () => Promise<void>) =>
    next(),
}));

mock.module("@/lib/services/agent-gateway-router", () => ({
  agentGatewayRouterService: {
    routePhoneMessage: mock(async () => {
      throw new Error(sentinelProviderBody);
    }),
  },
}));

mock.module("@/lib/services/blooio-automation", () => ({
  blooioAutomationService: {
    getApiKey: mock(async () => "test-api-key"),
    getFromNumber: mock(async () => sentinelRecipient),
    getWebhookSecret: mock(async () => "test-webhook-secret"),
  },
}));

mock.module("@/lib/services/message-router", () => ({
  messageRouterService: {
    sendMessage: mock(async () => false),
  },
}));

mock.module("@/lib/utils/blooio-api", () => ({
  extractBlooioMediaUrls: () => [],
  markChatAsRead: mock(async () => {
    throw new Error(sentinelProviderBody);
  }),
  parseBlooioWebhookEvent: () => ({
    event: "message.received",
    message_id: "provider-message-id",
    sender: sentinelPhone,
    external_id: sentinelRecipient,
    text: sentinelContent,
    protocol: sentinelProviderProtocol,
    attachments: [],
  }),
  verifyBlooioSignature: mock(async () => true),
}));

mock.module("@/lib/utils/idempotency", () => ({
  isAlreadyProcessed: mock(async () => false),
  markAsProcessed: mock(async () => undefined),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
    debug: loggerDebug,
  },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:orgId", route);

describe("Blooio webhook privacy", () => {
  test("uses bounded logs and a generic error response", async () => {
    const response = await app.fetch(
      new Request(`https://api.example.test/${sentinelOrgId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      { NODE_ENV: "test", SKIP_WEBHOOK_VERIFICATION: "true" },
    );
    await Promise.resolve();

    expect(response.status).toBe(500);
    const responseBody = await response.text();
    expect(responseBody).not.toContain(sentinelPhone);
    expect(responseBody).not.toContain(sentinelRecipient);
    expect(responseBody).not.toContain(sentinelOrgId);
    expect(responseBody).not.toContain(sentinelContent);
    expect(responseBody).not.toContain(sentinelProviderBody);
    expect(responseBody).not.toContain(sentinelProviderProtocol);

    const serializedLogs = JSON.stringify([
      ...loggerInfo.mock.calls,
      ...loggerWarn.mock.calls,
      ...loggerError.mock.calls,
      ...loggerDebug.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(sentinelPhone);
    expect(serializedLogs).not.toContain(sentinelRecipient);
    expect(serializedLogs).not.toContain(sentinelOrgId);
    expect(serializedLogs).not.toContain(sentinelContent);
    expect(serializedLogs).not.toContain(sentinelProviderBody);
    expect(serializedLogs).not.toContain(sentinelProviderProtocol);
  });
});
