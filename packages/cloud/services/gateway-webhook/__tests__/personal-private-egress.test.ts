/**
 * Drives the real gateway webhook handler over HTTP into a local Cloud route
 * and proves private Personal Shared replies leave through the identity that
 * received the message, and that terminal no-response turns are never silent.
 * Only the external provider APIs (Telegram, Blooio) are substituted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PERSONAL_SHARED_NO_RESPONSE_REPLY } from "@elizaos/cloud-services-common/transport";
import { blooioAdapter } from "../src/adapters/blooio";
import { telegramAdapter } from "../src/adapters/telegram";
import type { GatewayRedis } from "../src/redis";
import { handleWebhook } from "../src/webhook-handler";
import {
  configureTelegramIdentity,
  resetTelegramIdentityAttestation,
  TELEGRAM_TEST_BOT_ID,
  TELEGRAM_TEST_WEBHOOK_SECRET,
  telegramGetMeResponse,
} from "./telegram-identity-fixture";

class MemoryRedis implements GatewayRedis {
  async eval(): Promise<unknown> {
    throw new Error("Cutover persistence is not part of this fixture");
  }
  readonly values = new Map<string, string>();
  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.values.get(key) ?? null) as T | null;
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
  async delIfEquals(key: string, value: string): Promise<boolean> {
    if (this.values.get(key) !== value) return false;
    return this.values.delete(key);
  }
  async expireIfEquals(key: string, value: string): Promise<boolean> {
    return this.values.get(key) === value;
  }
  async zadd(): Promise<unknown> {
    return 1;
  }
  async zrangebyscore(): Promise<string[]> {
    return [];
  }
  async zrem(): Promise<unknown> {
    return 1;
  }
}

interface ProviderCall {
  url: string;
  body: Record<string, unknown>;
}

const originalFetch = globalThis.fetch;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const envKeys = [
  "ELIZA_APP_TELEGRAM_BOT_TOKEN",
  "ELIZA_APP_TELEGRAM_BOT_ID",
  "ELIZA_APP_TELEGRAM_BOT_USERNAME",
  "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
  "ELIZA_APP_BLOOIO_API_KEY",
  "ELIZA_APP_BLOOIO_WEBHOOK_SECRET",
  "ELIZA_APP_BLOOIO_PHONE_NUMBER",
  "ELIZA_APP_WEBHOOK_PROJECT",
] as const;
const savedEnv = new Map<string, string | undefined>();

let providerCalls: ProviderCall[];
let providerSent: Promise<ProviderCall>;
let resolveProviderSent: (call: ProviderCall) => void;

beforeEach(() => {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
  process.env.ELIZA_APP_WEBHOOK_PROJECT = "eliza-app";
  resetTelegramIdentityAttestation();
  providerCalls = [];
  providerSent = new Promise((resolve) => {
    resolveProviderSent = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      if (/\/getMe$/.test(url)) return telegramGetMeResponse(input);
      const call = {
        url,
        body: JSON.parse(String(init?.body ?? "{}")),
      } satisfies ProviderCall;
      providerCalls.push(call);
      if (url.endsWith("/sendMessage")) {
        resolveProviderSent(call);
        return Response.json({ ok: true, result: { message_id: 4242 } });
      }
      return Response.json({ ok: true, result: true });
    }
    if (url.startsWith("https://api.blooio.com/")) {
      const call = {
        url,
        body: JSON.parse(String(init?.body ?? "{}")),
      } satisfies ProviderCall;
      providerCalls.push(call);
      if (url === "https://api.blooio.com/v4/messages") {
        resolveProviderSent(call);
        return Response.json({ id: "msg_provider_1" });
      }
      return Response.json({ ok: true });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const server of servers.splice(0)) server.stop(true);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetTelegramIdentityAttestation();
});

function startCloud(data: Record<string, unknown>): {
  origin: string;
  turns: Array<Record<string, unknown>>;
} {
  const turns: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/api/internal/eliza-app/personal-shared/messages") {
        return new Response("not found", { status: 404 });
      }
      turns.push((await request.json()) as Record<string, unknown>);
      return Response.json({ success: true, data });
    },
  });
  servers.push(server);
  return { origin: server.url.origin, turns };
}

function deps(cloudBaseUrl: string, redis: GatewayRedis) {
  return {
    redis,
    cloudBaseUrl,
    getAuthHeader: () => ({ Authorization: "Bearer gateway-test" }),
    reacquireAuthHeader: async () => ({ Authorization: "Bearer gateway-test" }),
  };
}

function telegramPrivateUpdate(updateId: number): Request {
  return new Request("http://gateway.test/webhook/eliza-app/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": TELEGRAM_TEST_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: 7,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 5550001, type: "private" },
        from: { id: 5550001, is_bot: false, first_name: "Ada" },
        text: "please rename my list",
      },
    }),
  });
}

describe("private Telegram Personal Shared egress", () => {
  test("a terminal no-response turn sends one visible notice through the attested bot", async () => {
    configureTelegramIdentity();
    const cloud = startCloud({
      reply: "",
      responded: false,
      responseReason: "no_response",
    });
    const redis = new MemoryRedis();

    const response = await handleWebhook(
      telegramPrivateUpdate(9001),
      telegramAdapter,
      deps(cloud.origin, redis),
      "eliza-app",
    );

    expect(response.status).toBe(200);
    expect(cloud.turns).toHaveLength(1);
    expect(cloud.turns[0]).toMatchObject({
      platform: "telegram",
      connectorAccountId: `bot:${TELEGRAM_TEST_BOT_ID}`,
      chatId: "5550001",
    });
    const sends = providerCalls.filter((call) =>
      call.url.endsWith("/sendMessage"),
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]?.url).toContain(`/bot${TELEGRAM_TEST_BOT_ID}:`);
    expect(sends[0]?.body).toMatchObject({
      chat_id: "5550001",
      text: PERSONAL_SHARED_NO_RESPONSE_REPLY,
    });

    // A provider redelivery of the same update neither reruns the turn nor
    // sends a second notice.
    const replay = await handleWebhook(
      telegramPrivateUpdate(9001),
      telegramAdapter,
      deps(cloud.origin, redis),
      "eliza-app",
    );
    expect(replay.status).toBe(200);
    expect(cloud.turns).toHaveLength(1);
    expect(
      providerCalls.filter((call) => call.url.endsWith("/sendMessage")),
    ).toHaveLength(1);
  });

  test("a media-only private reply delivers every distinct HTTPS artifact link", async () => {
    configureTelegramIdentity();
    const cloud = startCloud({
      reply: "",
      mediaUrls: [
        "https://cdn.example.test/a.png",
        "http://cdn.example.test/insecure.png",
        "https://cdn.example.test/a.png",
        "https://cdn.example.test/b.png",
        "https://cdn.example.test/c.png",
        "https://cdn.example.test/d.png",
        "https://cdn.example.test/e.png",
      ],
    });

    const response = await handleWebhook(
      telegramPrivateUpdate(9002),
      telegramAdapter,
      deps(cloud.origin, new MemoryRedis()),
      "eliza-app",
    );

    expect(response.status).toBe(200);
    const sends = providerCalls.filter((call) =>
      call.url.endsWith("/sendMessage"),
    );
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body.text).toBe(
      [
        "https://cdn.example.test/a.png",
        "https://cdn.example.test/b.png",
        "https://cdn.example.test/c.png",
        "https://cdn.example.test/d.png",
        "https://cdn.example.test/e.png",
      ].join("\n"),
    );
  });

  test("an ordinary reply is delivered unchanged", async () => {
    configureTelegramIdentity();
    const cloud = startCloud({ reply: "Renamed it to Groceries." });

    const response = await handleWebhook(
      telegramPrivateUpdate(9003),
      telegramAdapter,
      deps(cloud.origin, new MemoryRedis()),
      "eliza-app",
    );

    expect(response.status).toBe(200);
    const sends = providerCalls.filter((call) =>
      call.url.endsWith("/sendMessage"),
    );
    expect(sends.map((call) => call.body.text)).toEqual([
      "Renamed it to Groceries.",
    ]);
  });
});

describe("private Blooio Personal Shared egress", () => {
  test("replies from the number that received the message, not the configured default", async () => {
    const webhookSecret = "blooio-test-secret";
    process.env.ELIZA_APP_BLOOIO_API_KEY = "blooio-test-key";
    process.env.ELIZA_APP_BLOOIO_WEBHOOK_SECRET = webhookSecret;
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15559990000";
    const cloud = startCloud({ reply: "Hi Ada." });
    const body = JSON.stringify({
      id: "evt_1",
      type: "message.received",
      created_at: Date.now(),
      data: {
        message_id: "msg_inbound_1",
        sender: "+15551234567",
        recipient: "+15550001111",
        text: "hello",
        protocol: "imessage",
      },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");

    const response = await handleWebhook(
      new Request("http://gateway.test/webhook/eliza-app/blooio", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-blooio-signature": `t=${timestamp},v1=${signature}`,
        },
        body,
      }),
      blooioAdapter,
      deps(cloud.origin, new MemoryRedis()),
      "eliza-app",
    );
    expect(response.status).toBe(200);

    const send = await providerSent;
    expect(cloud.turns).toHaveLength(1);
    expect(cloud.turns[0]).toMatchObject({
      platform: "blooio",
      phoneNumber: "+15551234567",
    });
    expect(send.body).toMatchObject({
      text: "Hi Ada.",
      to: "+15551234567",
      from: "+15550001111",
    });
  });
});
