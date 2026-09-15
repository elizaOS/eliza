/** Proves the Railway ingress gate fails before event, ledger, or egress work. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { PlatformAdapter } from "../src/adapters/types";
import type { GatewayRedis } from "../src/redis";
import { registerTelegramIdentityReadinessRoute } from "../src/telegram-identity";
import { handleWebhook } from "../src/webhook-handler";
import {
  configureTelegramIdentity,
  resetTelegramIdentityAttestation,
  telegramGetMeResponse,
} from "./telegram-identity-fixture";

const originalFetch = globalThis.fetch;
const envKeys = [
  "ELIZA_APP_TELEGRAM_BOT_TOKEN",
  "ELIZA_APP_TELEGRAM_BOT_ID",
  "ELIZA_APP_TELEGRAM_BOT_USERNAME",
  "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
  "ELIZA_APP_WEBHOOK_PROJECT",
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

class NoSideEffectRedis implements GatewayRedis {
  readonly getCall = mock((_key: string) => undefined);
  readonly setCall = mock((_key: string, _value: string) => undefined);

  async get<T = unknown>(key: string): Promise<T | null> {
    this.getCall(key);
    return null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.setCall(key, value);
    return "OK";
  }

  async del(): Promise<unknown> {
    return 1;
  }

  async lpush(): Promise<unknown> {
    return 1;
  }

  async ltrim(): Promise<unknown> {
    return "OK";
  }

  async expire(): Promise<unknown> {
    return 1;
  }
}

function adapter(): PlatformAdapter {
  return {
    platform: "telegram",
    verifyWebhook: mock(async () => true),
    extractEvent: mock(async () => null),
    sendTypingIndicator: mock(async () => undefined),
    sendReply: mock(async () => undefined),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetTelegramIdentityAttestation();
  mock.restore();
});

describe("Railway canonical Telegram identity", () => {
  test("accepts the exact identity and publishes only a value-free readiness receipt", async () => {
    configureTelegramIdentity();
    globalThis.fetch = mock(async (input: RequestInfo | URL) =>
      telegramGetMeResponse(input, { botUsername: "elizatestbot" }),
    ) as typeof fetch;
    const app = new Hono();
    registerTelegramIdentityReadinessRoute(app);

    const response = await app.request("/ready/telegram-identity/eliza-app");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      project: "eliza-app",
      status: "attested",
    });
  });

  test("treats a blank paired webhook credential as not configured", async () => {
    configureTelegramIdentity({ webhookSecret: "   " });
    const provider = mock(async () => {
      throw new Error("provider must not run");
    });
    globalThis.fetch = provider as unknown as typeof fetch;
    const app = new Hono();
    registerTelegramIdentityReadinessRoute(app);

    const response = await app.request("/ready/telegram-identity/eliza-app");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      reason: "not_configured",
      status: "not-attested",
    });
    expect(provider).not.toHaveBeenCalled();
  });

  test("rejects wrong id, wrong username, and provider failure before event or ledger work", async () => {
    configureTelegramIdentity();
    const scenarios = [
      () =>
        telegramGetMeResponse("https://api.telegram.org", { botId: 987654321 }),
      () =>
        telegramGetMeResponse("https://api.telegram.org", {
          botUsername: "AnotherManagedBot",
        }),
      () =>
        Response.json(
          { ok: false, description: "private-provider-payload" },
          { status: 503 },
        ),
    ];

    for (const providerResult of scenarios) {
      resetTelegramIdentityAttestation();
      globalThis.fetch = mock(async () => providerResult()) as typeof fetch;
      const redis = new NoSideEffectRedis();
      const telegramAdapter = adapter();

      const response = await handleWebhook(
        new Request("https://gateway.example/webhook/eliza-app/telegram", {
          method: "POST",
          body: "{}",
        }),
        telegramAdapter,
        {
          redis,
          cloudBaseUrl: "https://api.eliza.test",
          getAuthHeader: () => ({ Authorization: "Bearer fixture" }),
        },
        "eliza-app",
      );
      const body = await response.text();

      expect(response.status).toBe(503);
      expect(response.headers.get("X-Eliza-Failure-Stage")).toBe(
        "connector_identity",
      );
      expect(body).toContain("telegram-identity-not-ready");
      expect(body).not.toContain("test-token");
      expect(body).not.toContain("private-provider-payload");
      expect(telegramAdapter.extractEvent).not.toHaveBeenCalled();
      expect(telegramAdapter.sendTypingIndicator).not.toHaveBeenCalled();
      expect(telegramAdapter.sendReply).not.toHaveBeenCalled();
      expect(redis.getCall).not.toHaveBeenCalled();
      expect(redis.setCall).not.toHaveBeenCalled();
    }
  });
});
