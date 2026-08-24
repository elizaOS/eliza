/** Proves the flag-off gateway hands Personal Telegram to the Worker authority once. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ChatEvent, PlatformAdapter } from "../src/adapters/types";
import type { GatewayRedis } from "../src/redis";
import { handleWebhook } from "../src/webhook-handler";

class MemoryRedis implements GatewayRedis {
  readonly values = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async set(
    key: string,
    value: string,
    options: { nx?: boolean } = {},
  ): Promise<unknown> {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    return this.values.delete(key) ? 1 : 0;
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

const originalFetch = globalThis.fetch;
const originalBotToken = process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN;
const event: ChatEvent = {
  platform: "telegram",
  messageId: "edge-forward-1",
  platformRecordId: "provider-message-1",
  chatId: "123456",
  chatType: "private",
  senderId: "123456",
  senderName: "Nubs",
  text: "hey how are you?",
  rawPayload: {},
};

function adapter(): PlatformAdapter {
  return {
    platform: "telegram",
    getDedupeScope: () => "scope",
    verifyWebhook: mock(async () => true),
    extractEvent: mock(async () => event),
    sendReply: mock(async () => {
      throw new Error("gateway must not send Personal Telegram replies");
    }),
    sendTypingIndicator: mock(async () => undefined),
  };
}

function request(): Request {
  return new Request("https://gateway.example/webhook/eliza-app/telegram", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Eliza-Trace-Id": "11111111-1111-4111-8111-111111111111",
      "X-Telegram-Bot-Api-Secret-Token": "provider-secret",
    },
    body: JSON.stringify({ update_id: 1, message: { text: event.text } }),
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBotToken === undefined) {
    delete process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN;
  } else {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = originalBotToken;
  }
  mock.restore();
});

describe("Personal Telegram gateway-to-edge handoff", () => {
  test("preserves the signed payload and lets the Worker own egress", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "123:test-token";
    const redis = new MemoryRedis();
    let forwarded: Request | null = null;
    globalThis.fetch = mock(async (input, init) => {
      forwarded = new Request(input, init);
      expect(
        redis.values.get("webhook:telegram:scope:message:edge-forward-1"),
      ).toBe("egress_started");
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    const response = await handleWebhook(
      request(),
      adapter(),
      {
        redis,
        cloudBaseUrl: "https://api-staging.eliza.app",
        deliveryAuthoritySecret: "gateway-secret",
        getAuthHeader: () => ({ Authorization: "Bearer internal" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(200);
    expect(forwarded?.url).toBe(
      "https://api-staging.eliza.app/api/eliza-app/webhook/telegram/edge",
    );
    expect(forwarded?.headers.get("x-eliza-webhook-forwarder-secret")).toBe(
      "gateway-secret",
    );
    expect(forwarded?.headers.get("x-telegram-bot-api-secret-token")).toBe(
      "provider-secret",
    );
    expect(await forwarded?.text()).toContain("hey how are you?");
    expect(
      redis.values.get("webhook:telegram:scope:message:edge-forward-1"),
    ).toBe("delivered");
    expect(
      redis.values.has(
        "webhook:telegram:scope:message:edge-forward-1:processing",
      ),
    ).toBe(false);
  });

  test("reconciles an old ambiguous Railway send without invoking edge egress", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "123:test-token";
    const redis = new MemoryRedis();
    redis.values.set(
      "webhook:telegram:scope:message:edge-forward-1",
      "egress_started",
    );
    let reconciliationBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (input, init) => {
      expect(String(input)).toEndWith(
        "/api/eliza-app/webhook/telegram/delivery",
      );
      reconciliationBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      return Response.json({ state: "uncertain" });
    }) as unknown as typeof fetch;

    const response = await handleWebhook(
      request(),
      adapter(),
      {
        redis,
        cloudBaseUrl: "https://api-staging.eliza.app",
        deliveryAuthoritySecret: "gateway-secret",
        getAuthHeader: () => ({ Authorization: "Bearer internal" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(503);
    expect(reconciliationBody).toMatchObject({
      deliveryEpoch: 2,
      connectorAccountId: "bot:123",
      operation: "mark_uncertain",
    });
  });

  test("heals a lost gateway receipt without downgrading Worker delivery", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "123:test-token";
    const redis = new MemoryRedis();
    redis.values.set(
      "webhook:telegram:scope:message:edge-forward-1",
      "egress_started",
    );
    let reconciliationBody: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_input, init) => {
      reconciliationBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      return Response.json({ state: "delivered" });
    }) as unknown as typeof fetch;

    const response = await handleWebhook(
      request(),
      adapter(),
      {
        redis,
        cloudBaseUrl: "https://api-staging.eliza.app",
        deliveryAuthoritySecret: "gateway-secret",
        getAuthHeader: () => ({ Authorization: "Bearer internal" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(200);
    expect(
      redis.values.get("webhook:telegram:scope:message:edge-forward-1"),
    ).toBe("delivered");
    expect(reconciliationBody).toMatchObject({
      deliveryEpoch: 2,
      connectorAccountId: "bot:123",
      operation: "mark_uncertain",
    });
  });

  test("keeps a Redis-only old gateway fenced after Worker authority begins", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "123:test-token";
    const redis = new MemoryRedis();
    redis.values.set(
      "webhook:telegram:scope:message:edge-forward-1",
      "egress_started",
    );
    const oldAdapter = adapter();

    const response = await handleWebhook(
      request(),
      oldAdapter,
      {
        redis,
        cloudBaseUrl: "https://api-staging.eliza.app",
        getAuthHeader: () => ({ Authorization: "Bearer internal" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(503);
    expect(oldAdapter.sendReply).not.toHaveBeenCalled();
  });
});
