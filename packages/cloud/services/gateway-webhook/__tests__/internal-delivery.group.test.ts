/**
 * Verifies proactive group delivery at the gateway boundary: a Blooio
 * `chat_*` recipient reaches the provider's chat-thread endpoint with no
 * to/from pair, a Telegram group chat id reaches sendMessage unchanged, and
 * malformed group recipients are rejected before egress. In-memory Redis and
 * an intercepted provider fetch.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { deliverInternalMessage } from "../src/internal-delivery";
import type { GatewayRedis } from "../src/redis";

type RedisSetOptions = { ex?: number; nx?: boolean };

class MemoryRedis implements GatewayRedis {
  readonly store = new Map<string, string>();

  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.store.get(key) as T | undefined) ?? null;
  }

  async set(
    key: string,
    value: string,
    options: RedisSetOptions = {},
  ): Promise<unknown> {
    if (options.nx && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    return this.store.delete(key) ? 1 : 0;
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
const originalToken = process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN;
const originalBlooioKey = process.env.ELIZA_APP_BLOOIO_API_KEY;
const originalBlooioNumber = process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined)
    delete process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN;
  else process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = originalToken;
  if (originalBlooioKey === undefined)
    delete process.env.ELIZA_APP_BLOOIO_API_KEY;
  else process.env.ELIZA_APP_BLOOIO_API_KEY = originalBlooioKey;
  if (originalBlooioNumber === undefined)
    delete process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER;
  else process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = originalBlooioNumber;
  mock.restore();
});

function request(overrides: Record<string, unknown> = {}) {
  return new Request("https://gateway.example/internal/deliver", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "blooio",
      project: "eliza-app",
      chatId: "chat_group_123",
      text: "Reminder for this group from Nubs: pay the rent",
      idempotencyKey: "group-task-1:2026-08-20T19:30:00.000Z",
      ...overrides,
    }),
  });
}

describe("internal proactive group delivery", () => {
  test("sends a Blooio group reminder through the provider chat thread once", async () => {
    process.env.ELIZA_APP_BLOOIO_API_KEY = "blooio-test-key";
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15550001111";
    const redis = new MemoryRedis();
    const requests: Request[] = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Response.json({ id: "blooio-group-message-1" });
      },
    ) as typeof fetch;

    const first = await deliverInternalMessage(request(), { redis });
    const replay = await deliverInternalMessage(request(), { redis });

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      success: true,
      replayed: false,
      providerMessageIds: ["blooio-group-message-1"],
    });
    await expect(replay.json()).resolves.toMatchObject({
      success: true,
      replayed: true,
      providerMessageIds: ["blooio-group-message-1"],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://api.blooio.com/v4/chats/chat_group_123/messages",
    );
    expect(requests[0]?.headers.get("Idempotency-Key")).toBe(
      "gw-reply-group-task-1:2026-08-20T19:30:00.000Z",
    );
    // The chat thread owns its participants; v4 forbids to/from here.
    await expect(requests[0]?.json()).resolves.toEqual({
      text: "Reminder for this group from Nubs: pay the rent",
    });
  });

  test("sends a Telegram group reminder to its negative chat id unchanged", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const redis = new MemoryRedis();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const outgoing = new Request(input, init);
        expect(outgoing.url).toBe(
          "https://api.telegram.org/bottelegram-test-token/sendMessage",
        );
        bodies.push((await outgoing.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: { message_id: 71 } });
      },
    ) as typeof fetch;

    const response = await deliverInternalMessage(
      request({ platform: "telegram", chatId: "-100123456789" }),
      { redis },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      providerMessageIds: ["71"],
    });
    expect(bodies).toEqual([
      {
        chat_id: "-100123456789",
        text: "Reminder for this group from Nubs: pay the rent",
        parse_mode: "Markdown",
      },
    ]);
  });

  test("rejects malformed group recipients before egress", async () => {
    const redis = new MemoryRedis();
    globalThis.fetch = mock(async () => {
      throw new Error("egress must not run");
    }) as typeof fetch;

    for (const overrides of [
      { chatId: "group_123" },
      { chatId: "chat_" },
      { chatId: "chat_../escape" },
      { chatId: "+15551234567" },
    ]) {
      const response = await deliverInternalMessage(request(overrides), {
        redis,
      });
      expect(response.status).toBe(400);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("keeps the private phone-number recipient contract unchanged", async () => {
    process.env.ELIZA_APP_BLOOIO_API_KEY = "blooio-test-key";
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15550001111";
    const redis = new MemoryRedis();
    const requests: Request[] = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Response.json({ id: "blooio-dm-message-1" });
      },
    ) as typeof fetch;

    const response = await deliverInternalMessage(
      request({ chatId: undefined, phoneNumber: "+15551234567" }),
      { redis },
    );

    expect(response.status).toBe(200);
    expect(requests[0]?.url).toBe("https://api.blooio.com/v4/messages");
    await expect(requests[0]?.json()).resolves.toEqual({
      to: "+15551234567",
      from: "+15550001111",
      text: "Reminder for this group from Nubs: pay the rent",
    });
  });
});
