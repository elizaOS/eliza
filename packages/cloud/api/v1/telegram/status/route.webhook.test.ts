/**
 * GET /api/v1/telegram/status `webhook` is Telegram debug-probe
 * identity, not leftover Life Ops inbox bool tax. Stock develop
 * compared the token to exact `true`, so `webhook=TRUE` / `1`
 * silently omitted getWebhookInfo.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, err: unknown) => {
    throw err;
  },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { info: mock(() => undefined), error: mock(() => undefined) },
}));

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const getConnectionStatus = mock(async () => ({
  configured: true,
  connected: true,
  botUsername: "demo_bot",
  botId: 1,
  error: null,
}));
const getBotToken = mock(async () => "bot-token");
const getWebhookUrl = mock(() => "https://example.test/hook");
const getWebhookInfo = mock(async () => ({
  url: "https://example.test/hook",
  has_custom_certificate: false,
  pending_update_count: 0,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/telegram-automation", () => ({
  telegramAutomationService: {
    getConnectionStatus,
    getBotToken,
    getWebhookUrl,
  },
}));
mock.module("telegraf", () => ({
  Telegraf: class {
    telegram = { getWebhookInfo };
  },
}));

const { default: statusRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/telegram/status", statusRoute);
  return app;
}

function request(query = "") {
  return buildApp().request(`/api/v1/telegram/status${query}`);
}

describe("GET /api/v1/telegram/status webhook identity", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    getConnectionStatus.mockClear();
    getBotToken.mockClear();
    getWebhookUrl.mockClear();
    getWebhookInfo.mockClear();
  });

  test.each(["", "?webhook=", "?webhook=false"])(
    "accepts %s without probing Telegram webhook info",
    async (query) => {
      const response = await request(query);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { webhookInfo: unknown };
      expect(body.webhookInfo).toBeNull();
      expect(getConnectionStatus).toHaveBeenCalledTimes(1);
      expect(getBotToken).not.toHaveBeenCalled();
      expect(getWebhookInfo).not.toHaveBeenCalled();
    },
  );

  test("accepts webhook=true as the Telegram webhook probe", async () => {
    const response = await request("?webhook=true");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      webhookInfo: { url?: string; pendingUpdateCount: number };
    };
    expect(body.webhookInfo.url).toBe("https://example.test/hook");
    expect(body.webhookInfo.pendingUpdateCount).toBe(0);
    expect(getConnectionStatus).toHaveBeenCalledTimes(1);
    expect(getBotToken).toHaveBeenCalledTimes(1);
    expect(getWebhookInfo).toHaveBeenCalledTimes(1);
  });

  test.each(["TRUE", "1", "yes", "foo"])(
    "rejects webhook=%s before connection status and the webhook probe",
    async (token) => {
      const response = await request(`?webhook=${token}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("invalid_webhook");
      expect(getConnectionStatus).not.toHaveBeenCalled();
      expect(getBotToken).not.toHaveBeenCalled();
      expect(getWebhookInfo).not.toHaveBeenCalled();
    },
  );
});
