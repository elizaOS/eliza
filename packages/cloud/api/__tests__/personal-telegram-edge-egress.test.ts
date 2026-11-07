/**
 * Runs the Worker-native Personal Telegram edge against the real exact-once
 * delivery Durable Object (over in-memory storage) and proves a private turn
 * that completes without a reply still reaches the user through the attested
 * bot. Only Telegram's Bot API is substituted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetTelegramIdentityAttestationCacheForTests } from "@elizaos/cloud-services-common/testing";
import { PERSONAL_SHARED_NO_RESPONSE_REPLY } from "@elizaos/cloud-services-common/transport";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { PersonalTelegramDelivery } from "@/api-app/personal-telegram-delivery";
import { handlePersonalTelegramEdge } from "../eliza-app/webhook/_telegram-edge";

const BOT_ID = "123456789";
const BOT_TOKEN = `${BOT_ID}:edge-test-token`;
const BOT_USERNAME = "ElizaEdgeTestBot";
const WEBHOOK_SECRET = "edge-webhook-secret";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put(
    keyOrEntries: string | Record<string, unknown>,
    value?: unknown,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.values.set(keyOrEntries, value);
      return;
    }
    for (const [key, entry] of Object.entries(keyOrEntries)) {
      this.values.set(key, entry);
    }
  }
  async delete(keys: string | string[]): Promise<boolean> {
    let deleted = false;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      deleted = this.values.delete(key) || deleted;
    }
    return deleted;
  }
  async list<T>(): Promise<Map<string, T>> {
    return new Map(this.values) as Map<string, T>;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(value: number): Promise<void> {
    this.alarm = value;
  }
}

function deliveryNamespace() {
  const objects = new Map<string, PersonalTelegramDelivery>();
  return {
    getByName(name: string) {
      let object = objects.get(name);
      if (!object) {
        object = new PersonalTelegramDelivery(
          { storage: new MemoryStorage() } as unknown as DurableObjectState,
          {} as AppEnv["Bindings"],
        );
        objects.set(name, object);
      }
      const target = object;
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          target.fetch(new Request(input, init)),
      };
    },
  };
}

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

const originalFetch = globalThis.fetch;
let telegramCalls: TelegramCall[];

beforeEach(() => {
  __resetTelegramIdentityAttestationCacheForTests();
  telegramCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const match = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    if (!match) return originalFetch(input, init);
    const [, token, method] = match;
    if (method === "getMe") {
      return Response.json({
        ok: true,
        result: {
          id: Number(token?.split(":", 1)[0]),
          is_bot: true,
          username: BOT_USERNAME,
        },
      });
    }
    telegramCalls.push({
      method: method ?? "",
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    if (method === "sendMessage") {
      expect(token).toBe(BOT_TOKEN);
      return Response.json({ ok: true, result: { message_id: 77 } });
    }
    return Response.json({ ok: true, result: true });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetTelegramIdentityAttestationCacheForTests();
});

function edgeApp(turnData: Record<string, unknown>) {
  const turns: Array<Record<string, unknown>> = [];
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("traceId", "0123456789abcdef0123456789abcdef");
    await next();
  });
  app.post("/edge", (c) =>
    handlePersonalTelegramEdge(c, {
      runTurn: async (body) => {
        turns.push(body);
        return Response.json({ success: true, data: turnData });
      },
    }),
  );
  const env = {
    ELIZA_APP_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    ELIZA_APP_TELEGRAM_BOT_ID: BOT_ID,
    ELIZA_APP_TELEGRAM_BOT_USERNAME: BOT_USERNAME,
    ELIZA_APP_TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ELIZA_APP_WEBHOOK_PROJECT: "eliza-app",
    PERSONAL_TELEGRAM_DELIVERIES: deliveryNamespace(),
  } as unknown as AppEnv["Bindings"];
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  const send = (update: Record<string, unknown>) =>
    app.request(
      "/edge",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": WEBHOOK_SECRET,
        },
        body: JSON.stringify(update),
      },
      env,
      executionCtx,
    );
  return { send, turns };
}

function privateUpdate(updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: 11,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 4440001, type: "private" },
      from: { id: 4440001, is_bot: false, first_name: "Grace" },
      text: "archive last week's notes",
    },
  };
}

describe("Worker Personal Telegram edge terminal replies", () => {
  test("a private no-response turn sends one visible notice and replays without a second send", async () => {
    const edge = edgeApp({
      reply: "",
      responded: false,
      responseReason: "no_response",
    });

    const first = await edge.send(privateUpdate(3101));
    expect(first.status).toBe(200);
    expect(edge.turns).toHaveLength(1);
    expect(edge.turns[0]).toMatchObject({
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: `bot:${BOT_ID}`,
      chatId: "4440001",
    });
    const sends = telegramCalls.filter((call) => call.method === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body).toMatchObject({
      chat_id: "4440001",
      text: PERSONAL_SHARED_NO_RESPONSE_REPLY,
    });

    const replay = await edge.send(privateUpdate(3101));
    expect(replay.status).toBe(200);
    expect(edge.turns).toHaveLength(1);
    expect(
      telegramCalls.filter((call) => call.method === "sendMessage"),
    ).toHaveLength(1);
  });

  test("a whitespace-only private reply with artifacts delivers the links", async () => {
    const edge = edgeApp({
      reply: "  \n ",
      mediaUrls: [
        "https://cdn.example.test/one.png",
        "javascript:alert(1)",
        "https://cdn.example.test/one.png",
        "https://cdn.example.test/two.png",
      ],
    });

    const response = await edge.send(privateUpdate(3102));
    expect(response.status).toBe(200);
    const sends = telegramCalls.filter((call) => call.method === "sendMessage");
    expect(sends.map((call) => call.body.text)).toEqual([
      "https://cdn.example.test/one.png\nhttps://cdn.example.test/two.png",
    ]);
  });
});
