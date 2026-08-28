/** Verifies proactive Telegram delivery ownership and replay against the gateway boundary. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { deliverInternalMessage } from "../src/internal-delivery";
import type { GatewayRedis } from "../src/redis";
import {
  configureTelegramIdentity,
  resetTelegramIdentityAttestation,
  TELEGRAM_CONNECTOR_ACCOUNT_ID,
  TELEGRAM_TEST_TOKEN,
  withTelegramIdentity,
} from "./telegram-identity-fixture";

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
const originalBotId = process.env.ELIZA_APP_TELEGRAM_BOT_ID;
const originalBotUsername = process.env.ELIZA_APP_TELEGRAM_BOT_USERNAME;
const originalWebhookSecret = process.env.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET;
const originalBlooioKey = process.env.ELIZA_APP_BLOOIO_API_KEY;
const originalBlooioNumber = process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined)
    delete process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN;
  else process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = originalToken;
  if (originalBotId === undefined) delete process.env.ELIZA_APP_TELEGRAM_BOT_ID;
  else process.env.ELIZA_APP_TELEGRAM_BOT_ID = originalBotId;
  if (originalBotUsername === undefined)
    delete process.env.ELIZA_APP_TELEGRAM_BOT_USERNAME;
  else process.env.ELIZA_APP_TELEGRAM_BOT_USERNAME = originalBotUsername;
  if (originalWebhookSecret === undefined)
    delete process.env.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET;
  else process.env.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET = originalWebhookSecret;
  if (originalBlooioKey === undefined)
    delete process.env.ELIZA_APP_BLOOIO_API_KEY;
  else process.env.ELIZA_APP_BLOOIO_API_KEY = originalBlooioKey;
  if (originalBlooioNumber === undefined)
    delete process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER;
  else process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = originalBlooioNumber;
  resetTelegramIdentityAttestation();
  mock.restore();
});

function installTelegramProvider(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
) {
  const provider = mock(handler);
  globalThis.fetch = withTelegramIdentity(provider);
  return provider;
}

function request(overrides: Record<string, unknown> = {}) {
  return new Request("https://gateway.example/internal/deliver", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: TELEGRAM_CONNECTOR_ACCOUNT_ID,
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
    configureTelegramIdentity();
    const send = mock(async () => {
      throw new Error("provider must not run");
    });
    globalThis.fetch = withTelegramIdentity(send);
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
    configureTelegramIdentity();
    const redis = new MemoryRedis();
    redis.failDelete = true;
    installTelegramProvider(async () =>
      Response.json({ ok: false, error_code: 403, description: "blocked" }),
    );

    const response = await deliverInternalMessage(
      request(),
      dependencies(redis),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      acceptance: "not_accepted",
      claimReleased: false,
    });
  });

  test("delivers without Cloud API auth and replays the completed idempotency key", async () => {
    configureTelegramIdentity();
    const redis = new MemoryRedis();
    const telegramBodies: Array<Record<string, unknown>> = [];
    installTelegramProvider(async (input, init) => {
      const outgoing = new Request(input, init);
      expect(outgoing.url).toBe(
        `https://api.telegram.org/bot${TELEGRAM_TEST_TOKEN}/sendMessage`,
      );
      telegramBodies.push((await outgoing.json()) as Record<string, unknown>);
      return Response.json({ ok: true, result: { message_id: 1 } });
    });

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

  test("keeps the bot identity stable across Telegram secret rotation", async () => {
    const redis = new MemoryRedis();
    const connectorAccountId = "bot:123456789";
    configureTelegramIdentity({ token: "123456789:first-secret" });
    const provider = installTelegramProvider(async () =>
      Response.json({ ok: true, result: { message_id: 73 } }),
    );

    const first = await deliverInternalMessage(
      request({ connectorAccountId }),
      dependencies(redis),
    );
    configureTelegramIdentity({ token: "123456789:rotated-secret" });
    const replay = await deliverInternalMessage(
      request({ connectorAccountId }),
      dependencies(redis),
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      success: true,
      replayed: true,
      providerMessageIds: ["73"],
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect([...redis.store.keys()]).toEqual([
      "internal-delivery:telegram:eliza-app:task-1:2026-08-14T20:00:00.000Z",
    ]);
  });

  test("rejects a missing or different Telegram bot before receipt lookup or egress", async () => {
    configureTelegramIdentity({
      token: "987654321:configured-secret",
      botId: "987654321",
    });
    const redis = new MemoryRedis();
    redis.failGet = true;
    const provider = installTelegramProvider(async () => {
      throw new Error("provider must not run");
    });

    const missing = await deliverInternalMessage(
      request({ connectorAccountId: undefined }),
      dependencies(redis),
    );
    const differentBot = await deliverInternalMessage(
      request({ connectorAccountId: "bot:123456789" }),
      dependencies(redis),
    );

    expect(missing.status).toBe(400);
    expect(differentBot.status).toBe(422);
    await expect(differentBot.json()).resolves.toMatchObject({
      success: false,
      retryable: false,
      acceptance: "not_accepted",
    });
    expect(redis.store).toEqual(new Map());
    expect(provider).not.toHaveBeenCalled();
  });

  test("rejects a provider identity mismatch before reminder receipt or message egress", async () => {
    configureTelegramIdentity();
    const redis = new MemoryRedis();
    redis.failGet = true;
    const provider = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toEndWith("/getMe");
      return Response.json({
        ok: true,
        result: {
          id: 987654321,
          is_bot: true,
          username: "ElizaTestBot",
        },
      });
    });
    globalThis.fetch = provider as unknown as typeof fetch;

    const response = await deliverInternalMessage(
      request(),
      dependencies(redis),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "telegram-identity-not-ready",
      reason: "identity_mismatch",
      status: "not-attested",
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(redis.store).toEqual(new Map());
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

  test("rejects a concurrent duplicate while the first send owns delivery", async () => {
    configureTelegramIdentity();
    const redis = new MemoryRedis();
    let finishSend: (() => void) | undefined;
    let markSendStarted: (() => void) | undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const pendingSend = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    const provider = installTelegramProvider(async () => {
      markSendStarted?.();
      await pendingSend;
      return Response.json({ ok: true, result: { message_id: 1 } });
    });

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
    expect(provider).toHaveBeenCalledTimes(1);
  });

  test("does not resend after Telegram accepts but the completion receipt write fails", async () => {
    configureTelegramIdentity();
    const redis = new MemoryRedis();
    redis.failCompletionWrite = true;
    const provider = installTelegramProvider(async () =>
      Response.json({ ok: true, result: { message_id: 91 } }),
    );

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
    expect(provider).toHaveBeenCalledTimes(1);
  });

  test("retains an indeterminate tombstone when the provider response times out", async () => {
    configureTelegramIdentity();
    const redis = new MemoryRedis();
    const provider = installTelegramProvider(async () => {
      throw new Error("response timeout");
    });

    const first = await deliverInternalMessage(request(), dependencies(redis));
    const replay = await deliverInternalMessage(request(), dependencies(redis));

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  test("does not retry Blooio after a provider 5xx leaves acceptance uncertain", async () => {
    process.env.ELIZA_APP_BLOOIO_API_KEY = "blooio-test-key";
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15550001111";
    const redis = new MemoryRedis();
    globalThis.fetch = mock(async () =>
      Response.json({ error: "upstream failure" }, { status: 500 }),
    ) as typeof fetch;
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

    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      acceptance: "unknown",
      retryable: false,
      replayed: false,
    });
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({
      acceptance: "unknown",
      retryable: false,
      replayed: true,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("never reports a pre-existing indeterminate tombstone as accepted", async () => {
    configureTelegramIdentity();
    const redis = new MemoryRedis();
    redis.store.set(
      "internal-delivery:telegram:eliza-app:task-1:2026-08-14T20:00:00.000Z",
      "indeterminate",
    );
    const provider = installTelegramProvider(async () => {
      throw new Error("must not resend an indeterminate delivery");
    });

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
    expect(provider).not.toHaveBeenCalled();
  });

  test("retries without Markdown only after Telegram explicitly rejects formatting", async () => {
    configureTelegramIdentity();
    const redis = new MemoryRedis();
    const bodies: Array<Record<string, unknown>> = [];
    installTelegramProvider(async (input, init) => {
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
    });

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
    configureTelegramIdentity();
    const redis = new MemoryRedis();
    const provider = installTelegramProvider(async () =>
      Response.json({
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry later",
        parameters: { retry_after: 7 },
      }),
    );

    const first = await deliverInternalMessage(request(), dependencies(redis));
    const retry = await deliverInternalMessage(request(), dependencies(redis));

    expect(first.status).toBe(429);
    expect(first.headers.get("Retry-After")).toBe("7");
    await expect(first.json()).resolves.toMatchObject({
      success: false,
      acceptance: "not_accepted",
    });
    expect(retry.status).toBe(429);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(redis.store).toEqual(new Map());
  });

  test("releases the claim when the plain-text retry is explicitly forbidden", async () => {
    configureTelegramIdentity();
    const redis = new MemoryRedis();
    const bodies: Array<Record<string, unknown>> = [];
    installTelegramProvider(async (input, init) => {
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
    });

    const response = await deliverInternalMessage(
      request(),
      dependencies(redis),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      acceptance: "not_accepted",
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
