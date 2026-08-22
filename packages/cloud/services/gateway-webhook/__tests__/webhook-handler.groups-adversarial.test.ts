/**
 * Adversarial group egress coverage for the gateway webhook handler with
 * deterministic in-memory Redis and fixture adapters: a failed group receipt
 * persistence must keep the dedupe closed (no double provider egress on
 * provider retry), the receipt POST must survive a stale-auth 401, and a
 * Telegram supergroup turn must run the full group classification and
 * receipt path without being rerouted onto the personal edge-forward.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type {
  ChatEvent,
  PlatformAdapter,
  WebhookConfig,
} from "../src/adapters/types";
import { logger } from "../src/logger";
import type { GatewayRedis } from "../src/redis";
import { handleWebhook } from "../src/webhook-handler";

type RedisSetOptions = { ex?: number; nx?: boolean };

class MemoryRedis implements GatewayRedis {
  readonly store = new Map<string, string>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
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
const envKeys = [
  "ELIZA_APP_TELEGRAM_BOT_TOKEN",
  "ELIZA_APP_BLOOIO_PHONE_NUMBER",
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

async function waitFor(assertion: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function blooioGroupEvent(messageId: string): ChatEvent {
  return {
    platform: "blooio",
    messageId,
    chatId: "chat_group_123",
    chatType: "group",
    senderId: "+15551234567",
    senderName: "Ada",
    text: "@eliza status?",
    rawPayload: {},
  };
}

function blooioGroupAdapter(event: ChatEvent): PlatformAdapter & {
  sendReplyWithReceipt: ReturnType<typeof mock>;
  sendReply: ReturnType<typeof mock>;
} {
  return {
    platform: "blooio",
    verifyWebhook: mock(async () => true),
    extractEvent: mock(async () => event),
    sendTypingIndicator: mock(async () => undefined),
    stopTypingIndicator: mock(async () => undefined),
    sendReply: mock(async () => undefined),
    sendReplyWithReceipt: mock(async () => ({
      providerMessageIds: ["provider-eliza-reply-1"],
    })),
  };
}

function blooioRequest(): Request {
  return new Request("https://gateway.example/webhook/eliza-app/blooio", {
    method: "POST",
    body: "{}",
  });
}

describe("gateway webhook group egress adversarial paths", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    mock.restore();
  });

  test("keeps the dedupe closed after group egress when receipt persistence fails", async () => {
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15550000001";
    const redis = new MemoryRedis();
    const event = blooioGroupEvent("blooio-group-receipt-500");
    const adapter = blooioGroupAdapter(event);
    const errorLog = spyOn(logger, "error").mockImplementation(() => undefined);
    let turnCalls = 0;
    let receiptCalls = 0;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url.endsWith("/api/internal/eliza-app/personal-shared/messages")
      ) {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.eventType === "delivery_receipt") {
          receiptCalls += 1;
          return new Response("receipt store unavailable", { status: 500 });
        }
        turnCalls += 1;
        return Response.json({ success: true, data: { reply: "group reply" } });
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    const deps = {
      redis,
      cloudBaseUrl: "https://api.elizacloud.ai",
      getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
    };

    const response = await handleWebhook(
      blooioRequest(),
      adapter,
      deps,
      "eliza-app",
    );
    expect(response.status).toBe(200);
    await waitFor(
      () =>
        errorLog.mock.calls.some(
          ([message]) => message === "Background message processing failed",
        ),
      "background receipt persistence failure",
    );

    // The provider message already went out: the failure is post-egress, so
    // the dedupe key must survive (a PersonalSharedPreEgressError would have
    // reopened it) and the receipt-tail error must name the real cause.
    expect(adapter.sendReplyWithReceipt).toHaveBeenCalledTimes(1);
    expect(receiptCalls).toBe(1);
    expect(
      redis.store.has("webhook:blooio:blooio-group-receipt-500"),
    ).toBe(true);
    expect(errorLog).toHaveBeenCalledWith(
      "Background message processing failed",
      expect.objectContaining({
        error: expect.stringContaining(
          "group delivery receipt persistence failed (500)",
        ),
      }),
    );

    // A Blooio retry of the identical webhook is acked as a duplicate: no
    // second turn, no second provider egress into the group.
    const replay = await handleWebhook(
      blooioRequest(),
      adapter,
      deps,
      "eliza-app",
    );
    expect(replay.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(turnCalls).toBe(1);
    expect(adapter.sendReplyWithReceipt).toHaveBeenCalledTimes(1);
    expect(receiptCalls).toBe(1);
  });

  test("retries the group receipt once with fresh auth after a stale 401", async () => {
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15550000001";
    const redis = new MemoryRedis();
    const event = blooioGroupEvent("blooio-group-receipt-401");
    const adapter = blooioGroupAdapter(event);
    const errorLog = spyOn(logger, "error").mockImplementation(() => undefined);
    const infoLog = spyOn(logger, "info").mockImplementation(() => undefined);
    const reauth = mock(async () => ({ Authorization: "Bearer fresh" }));
    const receiptAttempts: Array<string | null> = [];
    let receiptBody: Record<string, unknown> | null = null;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url.endsWith("/api/internal/eliza-app/personal-shared/messages")
      ) {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.eventType === "delivery_receipt") {
          receiptAttempts.push(request.headers.get("authorization"));
          if (receiptAttempts.length === 1) {
            return new Response("unauthorized", { status: 401 });
          }
          receiptBody = body;
          return Response.json({ success: true, data: { inserted: 1 } });
        }
        return Response.json({ success: true, data: { reply: "group reply" } });
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    const response = await handleWebhook(
      blooioRequest(),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer stale" }),
        reacquireAuthHeader: reauth,
      },
      "eliza-app",
    );
    expect(response.status).toBe(200);
    await waitFor(
      () => receiptBody !== null,
      "reauthenticated receipt persistence",
    );

    expect(reauth).toHaveBeenCalledTimes(1);
    expect(receiptAttempts).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(receiptBody).toEqual({
      eventType: "delivery_receipt",
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: "+15550000001",
      chatId: "chat_group_123",
      sourceMessageId: "blooio:eliza-app:blooio-group-receipt-401",
      providerMessageIds: ["provider-eliza-reply-1"],
    });
    expect(adapter.sendReplyWithReceipt).toHaveBeenCalledTimes(1);
    await waitFor(
      () =>
        infoLog.mock.calls.some(
          ([message]) => message === "Personal Eliza connector message completed",
        ),
      "group turn completion log",
    );
    expect(
      errorLog.mock.calls.some(
        ([message]) => message === "Background message processing failed",
      ),
    ).toBe(false);
  });

  test("runs a Telegram supergroup turn through the delivery ledger, not the edge forward", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const redis = new MemoryRedis();
    const event: ChatEvent = {
      platform: "telegram",
      messageId: "tg-group-update-1",
      platformRecordId: "tg-group-message-1",
      chatId: "-100123456789",
      chatType: "supergroup",
      senderId: "123456789",
      senderName: "Nubs",
      text: "@ElizaIsNotABot hello",
      groupActorRole: "administrator",
      groupInvocation: "mention",
      rawPayload: {},
    };
    const sendReply = mock(async () => undefined);
    const sendReplyWithReceipt = mock(async () => ({
      providerMessageIds: ["tg-provider-7"],
    }));
    const adapter: PlatformAdapter = {
      platform: "telegram",
      getDedupeScope: () => "scope",
      verifyWebhook: mock(async () => true),
      extractEvent: mock(async () => event),
      sendTypingIndicator: mock(async () => undefined),
      sendReply,
      sendReplyWithReceipt,
    };
    let turnBody: Record<string, unknown> | null = null;
    let receiptBody: Record<string, unknown> | null = null;
    let turnCalls = 0;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/api/eliza-app/webhook/telegram/edge")) {
        throw new Error(
          "group turn was rerouted onto the personal edge forward",
        );
      }
      if (
        request.url.endsWith("/api/internal/eliza-app/personal-shared/messages")
      ) {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.eventType === "delivery_receipt") {
          receiptBody = body;
          return Response.json({ success: true, data: { inserted: 1 } });
        }
        turnCalls += 1;
        turnBody = body;
        return Response.json({
          success: true,
          data: { reply: "group turn reply" },
        });
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    const deps = {
      redis,
      cloudBaseUrl: "https://api.elizacloud.ai",
      // The edge cutover secret is configured; DMs would take the edge
      // forward, but groups must stay on the gateway-owned ledger path.
      deliveryAuthoritySecret: "edge-secret",
      getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
    };
    const request = () =>
      new Request("https://gateway.example/webhook/eliza-app/telegram", {
        method: "POST",
        body: "{}",
      });

    const response = await handleWebhook(
      request(),
      adapter,
      deps,
      "eliza-app",
    );
    expect(response.status).toBe(200);

    expect(turnBody).toEqual({
      platform: "telegram",
      chatType: "supergroup",
      project: "eliza-app",
      connectorAccountId:
        "bot:a7df583dbeed5b233d355143673e458bf882856d938ab4bd0fc7adfa4be6bf3c",
      chatId: "-100123456789",
      actor: {
        platformUserId: "123456789",
        displayName: "Nubs",
        role: "administrator",
      },
      messageId: "telegram:eliza-app:tg-group-update-1",
      message: "@ElizaIsNotABot hello",
      invocation: "mention",
    });
    expect(sendReplyWithReceipt).toHaveBeenCalledTimes(1);
    expect(sendReply).not.toHaveBeenCalled();
    expect(receiptBody).toEqual({
      eventType: "delivery_receipt",
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId:
        "bot:a7df583dbeed5b233d355143673e458bf882856d938ab4bd0fc7adfa4be6bf3c",
      chatId: "-100123456789",
      sourceMessageId: "telegram:eliza-app:tg-group-update-1",
      providerMessageIds: ["tg-provider-7"],
    });
    expect(
      redis.store.get("webhook:telegram:scope:message:tg-group-update-1"),
    ).toBe("delivered");

    // Telegram redelivers the same update: the delivery ledger refuses the
    // replay outright — no second turn, no second group egress.
    const replay = await handleWebhook(request(), adapter, deps, "eliza-app");
    expect(replay.status).toBe(200);
    expect(turnCalls).toBe(1);
    expect(sendReplyWithReceipt).toHaveBeenCalledTimes(1);
  });
});
