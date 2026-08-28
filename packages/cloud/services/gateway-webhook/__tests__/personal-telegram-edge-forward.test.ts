/** Proves the flag-off gateway hands Personal Telegram to the Worker authority once. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { TELEGRAM_CONNECTOR_ACCOUNT_ID_HEADER } from "@elizaos/cloud-services-common/telegram-connector";
import type { ChatEvent, PlatformAdapter } from "../src/adapters/types";
import type { GatewayRedis } from "../src/redis";
import { handleWebhook } from "../src/webhook-handler";
import {
  configureTelegramIdentity,
  resetTelegramIdentityAttestation,
  withTelegramIdentity,
} from "./telegram-identity-fixture";

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
const originalBotId = process.env.ELIZA_APP_TELEGRAM_BOT_ID;
const originalBotUsername = process.env.ELIZA_APP_TELEGRAM_BOT_USERNAME;
const originalWebhookSecret = process.env.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET;
const rawPayload = ` { "update_id": 1, "message": { "text": "hey how are you? 👋" } }\n`;
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
      [TELEGRAM_CONNECTOR_ACCOUNT_ID_HEADER]: "bot:spoofed",
      "X-Eliza-Trace-Id": "11111111-1111-4111-8111-111111111111",
      "X-Telegram-Bot-Api-Secret-Token": "provider-secret",
    },
    body: rawPayload,
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBotToken === undefined) {
    delete process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN;
  } else {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = originalBotToken;
  }
  if (originalBotId === undefined) {
    delete process.env.ELIZA_APP_TELEGRAM_BOT_ID;
  } else {
    process.env.ELIZA_APP_TELEGRAM_BOT_ID = originalBotId;
  }
  if (originalBotUsername === undefined) {
    delete process.env.ELIZA_APP_TELEGRAM_BOT_USERNAME;
  } else {
    process.env.ELIZA_APP_TELEGRAM_BOT_USERNAME = originalBotUsername;
  }
  if (originalWebhookSecret === undefined) {
    delete process.env.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET;
  } else {
    process.env.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET = originalWebhookSecret;
  }
  resetTelegramIdentityAttestation();
  mock.restore();
});

describe("Personal Telegram gateway-to-edge handoff", () => {
  test("preserves the signed payload and lets the Worker own egress", async () => {
    configureTelegramIdentity({ token: "123:test-token" });
    const redis = new MemoryRedis();
    let forwarded: Request | null = null;
    globalThis.fetch = mock(
      withTelegramIdentity(async (input, init) => {
        forwarded = new Request(input, init);
        expect(
          redis.values.get("webhook:telegram:scope:message:edge-forward-1"),
        ).toBe("egress_started");
        return Response.json({ ok: true });
      }),
    ) as unknown as typeof fetch;

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
    expect(forwarded?.headers.get(TELEGRAM_CONNECTOR_ACCOUNT_ID_HEADER)).toBe(
      "bot:123",
    );
    expect(
      forwarded?.headers.get(TELEGRAM_CONNECTOR_ACCOUNT_ID_HEADER),
    ).not.toContain("test-token");
    expect(forwarded?.headers.get("x-telegram-bot-api-secret-token")).toBe(
      "provider-secret",
    );
    expect(await forwarded?.text()).toBe(rawPayload);
    expect(
      redis.values.get("webhook:telegram:scope:message:edge-forward-1"),
    ).toBe("delivered");
    expect(
      redis.values.has(
        "webhook:telegram:scope:message:edge-forward-1:processing",
      ),
    ).toBe(false);
  });

  test("reopens a connector-account rejection for a corrected retry", async () => {
    configureTelegramIdentity({ token: "123:test-token" });
    const redis = new MemoryRedis();
    let edgeAttempts = 0;
    globalThis.fetch = mock(
      withTelegramIdentity(async (input, init) => {
        edgeAttempts += 1;
        const forwarded = new Request(input, init);
        expect(
          forwarded.headers.get(TELEGRAM_CONNECTOR_ACCOUNT_ID_HEADER),
        ).toBe("bot:123");
        expect(await forwarded.text()).toBe(rawPayload);
        if (edgeAttempts === 1) {
          return Response.json(
            { error: "connector account mismatch" },
            {
              status: 409,
              headers: { "X-Eliza-Failure-Stage": "connector_account" },
            },
          );
        }
        return Response.json({ ok: true });
      }),
    ) as unknown as typeof fetch;

    const deps = {
      redis,
      cloudBaseUrl: "https://api-staging.eliza.app",
      deliveryAuthoritySecret: "gateway-secret",
      getAuthHeader: () => ({ Authorization: "Bearer internal" }),
    };

    const rejected = await handleWebhook(
      request(),
      adapter(),
      deps,
      "eliza-app",
    );

    expect(rejected.status).toBe(409);
    expect(
      redis.values.has("webhook:telegram:scope:message:edge-forward-1"),
    ).toBe(false);

    const retried = await handleWebhook(
      request(),
      adapter(),
      deps,
      "eliza-app",
    );

    expect(retried.status).toBe(200);
    expect(edgeAttempts).toBe(2);
    expect(
      redis.values.get("webhook:telegram:scope:message:edge-forward-1"),
    ).toBe("delivered");
  });

  test("keeps an ambiguous unclassified rejection fenced", async () => {
    configureTelegramIdentity({ token: "123:test-token" });
    const redis = new MemoryRedis();
    globalThis.fetch = mock(
      withTelegramIdentity(async () =>
        Response.json({ error: "conflict" }, { status: 409 }),
      ),
    ) as unknown as typeof fetch;

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

    expect(response.status).toBe(409);
    expect(
      redis.values.get("webhook:telegram:scope:message:edge-forward-1"),
    ).toBe("egress_started");
  });

  test("reconciles an old ambiguous Railway send without invoking edge egress", async () => {
    configureTelegramIdentity({ token: "123:test-token" });
    const redis = new MemoryRedis();
    redis.values.set(
      "webhook:telegram:scope:message:edge-forward-1",
      "egress_started",
    );
    let reconciliationBody: Record<string, unknown> = {};
    globalThis.fetch = mock(
      withTelegramIdentity(async (input, init) => {
        expect(String(input)).toEndWith(
          "/api/eliza-app/webhook/telegram/delivery",
        );
        reconciliationBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return Response.json({ state: "uncertain" });
      }),
    ) as unknown as typeof fetch;

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
    configureTelegramIdentity({ token: "123:test-token" });
    const redis = new MemoryRedis();
    redis.values.set(
      "webhook:telegram:scope:message:edge-forward-1",
      "egress_started",
    );
    let reconciliationBody: Record<string, unknown> = {};
    globalThis.fetch = mock(
      withTelegramIdentity(async (_input, init) => {
        reconciliationBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return Response.json({ state: "delivered" });
      }),
    ) as unknown as typeof fetch;

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
    configureTelegramIdentity({ token: "123:test-token" });
    globalThis.fetch = mock(
      withTelegramIdentity(async () => {
        throw new Error("edge egress must not run");
      }),
    ) as unknown as typeof fetch;
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
