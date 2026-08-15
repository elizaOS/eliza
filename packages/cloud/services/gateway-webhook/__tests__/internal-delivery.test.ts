/** Verifies proactive Telegram delivery ownership and replay against the gateway boundary. */

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

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined)
    delete process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN;
  else process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = originalToken;
  mock.restore();
});

function request(overrides: Record<string, unknown> = {}) {
  return new Request("https://gateway.example/internal/deliver", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "telegram",
      project: "eliza-app",
      chatId: "123456789",
      text: "take a break",
      idempotencyKey: "task-1:2026-08-14T20:00:00.000Z",
      ...overrides,
    }),
  });
}

function dependencies(redis: GatewayRedis) {
  return {
    redis,
    cloudBaseUrl: "https://api-staging.eliza.app",
    getAuthHeader: () => ({ Authorization: "Bearer internal" }),
  };
}

describe("internal proactive delivery", () => {
  test("delivers once and replays the completed idempotency key", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const redis = new MemoryRedis();
    const telegramBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async (input, init) => {
      const outgoing = new Request(input, init);
      expect(outgoing.url).toBe(
        "https://api.telegram.org/bottelegram-test-token/sendMessage",
      );
      telegramBodies.push((await outgoing.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 1 } });
    }) as typeof fetch;

    const first = await deliverInternalMessage(request(), dependencies(redis));
    const replay = await deliverInternalMessage(request(), dependencies(redis));

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      success: true,
      replayed: false,
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({
      success: true,
      replayed: true,
      idempotencyKey: "task-1:2026-08-14T20:00:00.000Z",
    });
    expect(telegramBodies).toEqual([
      {
        chat_id: "123456789",
        text: "take a break",
        parse_mode: "Markdown",
      },
    ]);
  });

  test("rejects a concurrent duplicate while the first send owns delivery", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const redis = new MemoryRedis();
    let finishSend: (() => void) | undefined;
    const pendingSend = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    globalThis.fetch = mock(async () => {
      await pendingSend;
      return Response.json({ ok: true, result: { message_id: 1 } });
    }) as typeof fetch;

    const firstPromise = deliverInternalMessage(request(), dependencies(redis));
    await Promise.resolve();
    const duplicate = await deliverInternalMessage(
      request(),
      dependencies(redis),
    );

    expect(duplicate.status).toBe(409);
    expect(duplicate.headers.get("Retry-After")).toBe("1");
    finishSend?.();
    expect((await firstPromise).status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("rejects model-controlled or malformed recipients before egress", async () => {
    const redis = new MemoryRedis();
    globalThis.fetch = mock(async () => {
      throw new Error("egress must not run");
    }) as typeof fetch;

    expect(
      (
        await deliverInternalMessage(
          request({ chatId: "@someone" }),
          dependencies(redis),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await deliverInternalMessage(
          request({ platform: "discord" }),
          dependencies(redis),
        )
      ).status,
    ).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
