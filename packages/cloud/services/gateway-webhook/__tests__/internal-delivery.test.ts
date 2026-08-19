/** Verifies proactive Telegram delivery ownership and replay against the gateway boundary. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { deliverInternalMessage } from "../src/internal-delivery";
import type { GatewayRedis } from "../src/redis";

type RedisSetOptions = { ex?: number; nx?: boolean };

class MemoryRedis implements GatewayRedis {
  readonly store = new Map<string, string>();
  failCompletionWrite = false;
  failGet = false;
  failClaimWrite = false;
  failDelete = false;

  async get<T = unknown>(key: string): Promise<T | null> {
    if (this.failGet) throw new Error("receipt read unavailable");
    return (this.store.get(key) as T | undefined) ?? null;
  }

  async set(
    key: string,
    value: string,
    options: RedisSetOptions = {},
  ): Promise<unknown> {
    if (this.failClaimWrite && options.nx) throw new Error("claim unavailable");
    if (options.nx && this.store.has(key)) return null;
    if (this.failCompletionWrite && value.includes('"state":"complete"')) {
      throw new Error("completion receipt unavailable");
    }
    this.store.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<unknown> {
    if (this.failDelete) throw new Error("claim release unavailable");
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
const originalTwilioSid = process.env.ELIZA_APP_TWILIO_ACCOUNT_SID;
const originalTwilioToken = process.env.ELIZA_APP_TWILIO_AUTH_TOKEN;
const originalTwilioNumber = process.env.ELIZA_APP_TWILIO_PHONE_NUMBER;

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
  if (originalTwilioSid === undefined)
    delete process.env.ELIZA_APP_TWILIO_ACCOUNT_SID;
  else process.env.ELIZA_APP_TWILIO_ACCOUNT_SID = originalTwilioSid;
  if (originalTwilioToken === undefined)
    delete process.env.ELIZA_APP_TWILIO_AUTH_TOKEN;
  else process.env.ELIZA_APP_TWILIO_AUTH_TOKEN = originalTwilioToken;
  if (originalTwilioNumber === undefined)
    delete process.env.ELIZA_APP_TWILIO_PHONE_NUMBER;
  else process.env.ELIZA_APP_TWILIO_PHONE_NUMBER = originalTwilioNumber;
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
  return { redis };
}

describe("internal proactive delivery", () => {
  test("reports Redis read and claim failures as retryable before egress", async () => {
    const send = mock(async () => {
      throw new Error("provider must not run");
    });
    globalThis.fetch = send as typeof fetch;
    for (const failure of ["read", "claim"] as const) {
      const redis = new MemoryRedis();
      if (failure === "read") redis.failGet = true;
      else redis.failClaimWrite = true;
      const response = await deliverInternalMessage(
        request(),
        dependencies(redis),
      );
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        retryable: true,
        acceptance: "not_accepted",
      });
    }
    expect(send).not.toHaveBeenCalled();
  });

  test("does not mask an explicit provider rejection when claim release fails", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const redis = new MemoryRedis();
    redis.failDelete = true;
    globalThis.fetch = mock(async () =>
      Response.json({ ok: false, error_code: 403, description: "blocked" }),
    ) as typeof fetch;

    const response = await deliverInternalMessage(
      request(),
      dependencies(redis),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      acceptance: "not_accepted",
      claimReleased: false,
      retryable: false,
    });
  });

  test("delivers without Cloud API auth and replays the completed idempotency key", async () => {
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
    await expect(replay.json()).resolves.toMatchObject({
      success: true,
      replayed: true,
      idempotencyKey: "task-1:2026-08-14T20:00:00.000Z",
      providerMessageIds: ["1"],
    });
    expect(telegramBodies).toEqual([
      {
        chat_id: "123456789",
        text: "take a break",
        parse_mode: "Markdown",
      },
    ]);
  });

  test("delivers Blooio iMessage once with the provider idempotency key and receipt", async () => {
    process.env.ELIZA_APP_BLOOIO_API_KEY = "blooio-test-key";
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15550001111";
    const redis = new MemoryRedis();
    const requests: Request[] = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ id: "blooio-message-1" });
    }) as typeof fetch;
    const delivery = request({
      platform: "blooio",
      phoneNumber: "+15551234567",
    });

    const first = await deliverInternalMessage(delivery, dependencies(redis));
    const replay = await deliverInternalMessage(
      request({
        platform: "blooio",
        phoneNumber: "+15551234567",
      }),
      dependencies(redis),
    );

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      success: true,
      replayed: false,
      providerMessageIds: ["blooio-message-1"],
    });
    await expect(replay.json()).resolves.toMatchObject({
      success: true,
      replayed: true,
      providerMessageIds: ["blooio-message-1"],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.blooio.com/v4/messages");
    expect(requests[0]?.headers.get("Idempotency-Key")).toBe(
      "gw-reply-task-1:2026-08-14T20:00:00.000Z",
    );
    await expect(requests[0]?.json()).resolves.toEqual({
      to: "+15551234567",
      from: "+15550001111",
      text: "take a break",
    });
  });

  test("delivers Twilio SMS to the fixed phone recipient and replays its receipt", async () => {
    process.env.ELIZA_APP_TWILIO_ACCOUNT_SID = "AC123";
    process.env.ELIZA_APP_TWILIO_AUTH_TOKEN = "twilio-token";
    process.env.ELIZA_APP_TWILIO_PHONE_NUMBER = "+15550001111";
    const redis = new MemoryRedis();
    const requests: Request[] = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ sid: "SM123" });
    }) as typeof fetch;
    const delivery = () =>
      request({
        platform: "twilio",
        phoneNumber: "+15551234567",
      });

    const first = await deliverInternalMessage(delivery(), dependencies(redis));
    const replay = await deliverInternalMessage(
      delivery(),
      dependencies(redis),
    );

    expect(first.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      success: true,
      replayed: true,
      providerMessageIds: ["SM123"],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/Accounts/AC123/Messages.json");
    expect(await requests[0]?.text()).toContain("To=%2B15551234567");
  });

  test("rejects a concurrent duplicate while the first send owns delivery", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const redis = new MemoryRedis();
    let finishSend: (() => void) | undefined;
    let markSendStarted: (() => void) | undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const pendingSend = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    globalThis.fetch = mock(async () => {
      markSendStarted?.();
      await pendingSend;
      return Response.json({ ok: true, result: { message_id: 1 } });
    }) as typeof fetch;

    const firstPromise = deliverInternalMessage(request(), dependencies(redis));
    await sendStarted;
    const duplicate = await deliverInternalMessage(
      request(),
      dependencies(redis),
    );

    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toMatchObject({
      success: false,
      replayed: true,
      acceptanceUnknown: true,
      acceptance: "unknown",
    });
    finishSend?.();
    expect((await firstPromise).status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("does not resend after Telegram accepts but the completion receipt write fails", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const redis = new MemoryRedis();
    redis.failCompletionWrite = true;
    globalThis.fetch = mock(async () =>
      Response.json({ ok: true, result: { message_id: 91 } }),
    ) as typeof fetch;

    const first = await deliverInternalMessage(request(), dependencies(redis));
    const replay = await deliverInternalMessage(request(), dependencies(redis));

    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      success: false,
      acceptanceUnknown: true,
      replayed: false,
    });
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({
      success: false,
      acceptanceUnknown: true,
      replayed: true,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("retains an indeterminate tombstone when the provider response times out", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const redis = new MemoryRedis();
    globalThis.fetch = mock(async () => {
      throw new Error("response timeout");
    }) as typeof fetch;

    const first = await deliverInternalMessage(request(), dependencies(redis));
    const replay = await deliverInternalMessage(request(), dependencies(redis));

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("never reports a pre-existing indeterminate tombstone as accepted", async () => {
    const redis = new MemoryRedis();
    redis.store.set(
      "internal-delivery:telegram:eliza-app:task-1:2026-08-14T20:00:00.000Z",
      "indeterminate",
    );
    globalThis.fetch = mock(async () => {
      throw new Error("must not resend an indeterminate delivery");
    }) as typeof fetch;

    const response = await deliverInternalMessage(
      request(),
      dependencies(redis),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      acceptance: "unknown",
      retryable: false,
      acceptanceUnknown: true,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("retries without Markdown only after Telegram explicitly rejects formatting", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const redis = new MemoryRedis();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async (input, init) => {
      const outgoing = new Request(input, init);
      bodies.push((await outgoing.json()) as Record<string, unknown>);
      if (bodies.length === 1) {
        return Response.json({
          ok: false,
          error_code: 400,
          description: "can't parse entities",
        });
      }
      return Response.json({ ok: true, result: { message_id: 92 } });
    }) as typeof fetch;

    const response = await deliverInternalMessage(
      request(),
      dependencies(redis),
    );

    expect(response.status).toBe(200);
    expect(bodies).toEqual([
      {
        chat_id: "123456789",
        text: "take a break",
        parse_mode: "Markdown",
      },
      { chat_id: "123456789", text: "take a break" },
    ]);
  });

  test("releases the delivery claim when Telegram explicitly rate-limits the first send", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const redis = new MemoryRedis();
    globalThis.fetch = mock(async () =>
      Response.json({
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry later",
        parameters: { retry_after: 7 },
      }),
    ) as typeof fetch;

    const first = await deliverInternalMessage(request(), dependencies(redis));
    const retry = await deliverInternalMessage(request(), dependencies(redis));

    expect(first.status).toBe(429);
    expect(first.headers.get("Retry-After")).toBe("7");
    await expect(first.json()).resolves.toMatchObject({
      success: false,
      acceptance: "not_accepted",
      retryable: true,
    });
    expect(retry.status).toBe(429);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(redis.store).toEqual(new Map());
  });

  test("releases the claim when the plain-text retry is explicitly forbidden", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const redis = new MemoryRedis();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async (input, init) => {
      const outgoing = new Request(input, init);
      bodies.push((await outgoing.json()) as Record<string, unknown>);
      if (bodies.length === 1) {
        return Response.json({
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse entities",
        });
      }
      return Response.json({
        ok: false,
        error_code: 403,
        description: "Forbidden: bot was blocked by the user",
      });
    }) as typeof fetch;

    const response = await deliverInternalMessage(
      request(),
      dependencies(redis),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      acceptance: "not_accepted",
      retryable: false,
    });
    expect(bodies).toHaveLength(2);
    expect(redis.store).toEqual(new Map());
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
