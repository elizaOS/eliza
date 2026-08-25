/**
 * Adversarial group egress coverage for the gateway webhook handler with
 * deterministic in-memory Redis and fixture adapters. Every group turn runs
 * the real authorization → commit → provider egress → receipt ledger: a
 * receipt that the Shared endpoint rejects as stale authority must reopen the
 * webhook without a second provider send on replay, the receipt POST must
 * survive a stale-auth 401 while keeping the same lease token, and a Telegram
 * supergroup turn must run the full ledger path instead of the personal
 * edge-forward.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ChatEvent, PlatformAdapter } from "../src/adapters/types";
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
      // error-policy:J3 the handler stores both JSON documents and bare ledger
      // markers under the same client; a non-JSON value is the marker itself.
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

const SHARED_MESSAGES_PATH = "/api/internal/eliza-app/personal-shared/messages";
const AUTHORITY = {
  bindingId: "00000000-0000-4000-8000-000000000030",
  ownerUserId: "00000000-0000-4000-8000-000000000002",
  personalAgentId: "personal:3e91680e-2611-5ff5-b759-c16b990967bd",
  version: 7,
};

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

/**
 * Minimal Shared-endpoint ledger: one lease per source message. Authorization
 * is granted until a commit lands for that source message, which mirrors the
 * durable fence the cloud route applies on replay.
 */
class SharedLedgerMock {
  readonly committed = new Set<string>();
  readonly leaseTokens: string[] = [];
  authorizationCalls = 0;
  commitCalls = 0;

  authorize(body: Record<string, unknown>): Response {
    this.authorizationCalls += 1;
    const sourceMessageId = body.sourceMessageId as string;
    if (this.committed.has(sourceMessageId)) {
      return Response.json({
        success: true,
        data: {
          code: "group_delivery_authorization",
          authorized: false,
          leaseToken: null,
          expiresAt: null,
        },
      });
    }
    this.leaseTokens.push(body.leaseToken as string);
    return Response.json({
      success: true,
      data: {
        code: "group_delivery_authorization",
        authorized: true,
        leaseToken: body.leaseToken,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
  }

  commit(body: Record<string, unknown>): Response {
    this.commitCalls += 1;
    this.committed.add(body.sourceMessageId as string);
    return Response.json({
      success: true,
      data: { code: "group_delivery_committed", committed: true },
    });
  }
}

function turnResponse(reply: string): Response {
  return Response.json({
    success: true,
    data: {
      reply,
      groupDelivery: { kind: "binding", authority: AUTHORITY },
    },
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

  test("reopens the webhook after a stale-authority receipt rejection without resending into the group", async () => {
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15550000001";
    const redis = new MemoryRedis();
    const event = blooioGroupEvent("blooio-group-receipt-stale");
    const adapter = blooioGroupAdapter(event);
    const errorLog = spyOn(logger, "error").mockImplementation(() => undefined);
    const ledger = new SharedLedgerMock();
    let turnCalls = 0;
    let receiptCalls = 0;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith(SHARED_MESSAGES_PATH)) {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.eventType === "delivery_authorization") {
          return ledger.authorize(body);
        }
        if (body.eventType === "delivery_commit") {
          return ledger.commit(body);
        }
        if (body.eventType === "delivery_receipt") {
          receiptCalls += 1;
          // The binding's authority moved between commit and receipt: the
          // route persists nothing and reports the rejection explicitly.
          return Response.json({
            success: true,
            data: {
              code: "group_delivery_receipt_recorded",
              recorded: false,
              inserted: 0,
            },
          });
        }
        turnCalls += 1;
        return turnResponse("group reply");
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    const deps = {
      redis,
      cloudBaseUrl: "https://api.elizacloud.ai",
      getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
    };
    const dedupKey = "webhook:blooio:blooio-group-receipt-stale";

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

    // The provider message already went out once. The rejected receipt is a
    // recoverable post-egress failure: the error names the real cause and the
    // webhook is reopened so the gateway can retry the exact same message.
    expect(adapter.sendReplyWithReceipt).toHaveBeenCalledTimes(1);
    expect(receiptCalls).toBe(1);
    expect(errorLog).toHaveBeenCalledWith(
      "Background message processing failed",
      expect.objectContaining({
        error: "group delivery receipt persistence rejected stale authority",
        platform: "blooio",
        messageId: "blooio-group-receipt-stale",
      }),
    );
    await waitFor(() => !redis.store.has(dedupKey), "dedupe reopening");

    // A Blooio retry of the identical webhook re-runs the idempotent turn but
    // the committed lease refuses a second authorization: no second provider
    // egress into the group, and the replay settles as delivered.
    const replay = await handleWebhook(
      blooioRequest(),
      adapter,
      deps,
      "eliza-app",
    );
    expect(replay.status).toBe(200);
    await waitFor(
      () => ledger.authorizationCalls === 2,
      "replay authorization",
    );
    await waitFor(
      () => redis.store.get(dedupKey) === "delivered",
      "replay settling as delivered",
    );
    expect(turnCalls).toBe(2);
    expect(ledger.commitCalls).toBe(1);
    expect(adapter.sendReplyWithReceipt).toHaveBeenCalledTimes(1);
    expect(receiptCalls).toBe(1);
  });

  test("retries the group receipt once with fresh auth after a stale 401 under the same lease", async () => {
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15550000001";
    const redis = new MemoryRedis();
    const event = blooioGroupEvent("blooio-group-receipt-401");
    const adapter = blooioGroupAdapter(event);
    const errorLog = spyOn(logger, "error").mockImplementation(() => undefined);
    const infoLog = spyOn(logger, "info").mockImplementation(() => undefined);
    const reauth = mock(async () => ({ Authorization: "Bearer fresh" }));
    const ledger = new SharedLedgerMock();
    const receiptAttempts: Array<string | null> = [];
    let receiptBody: Record<string, unknown> | null = null;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith(SHARED_MESSAGES_PATH)) {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.eventType === "delivery_authorization") {
          return ledger.authorize(body);
        }
        if (body.eventType === "delivery_commit") {
          return ledger.commit(body);
        }
        if (body.eventType === "delivery_receipt") {
          // The internal token expires between the durable commit and the
          // receipt POST: only the receipt sees the stale credential.
          receiptAttempts.push(request.headers.get("authorization"));
          if (receiptAttempts.length === 1) {
            return new Response("unauthorized", { status: 401 });
          }
          receiptBody = body;
          return Response.json({
            success: true,
            data: {
              code: "group_delivery_receipt_recorded",
              recorded: true,
              inserted: 1,
            },
          });
        }
        return turnResponse("group reply");
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
    expect(ledger.leaseTokens).toHaveLength(1);
    expect(receiptBody).toEqual({
      eventType: "delivery_receipt",
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: "+15550000001",
      chatId: "chat_group_123",
      sourceMessageId: "blooio:eliza-app:blooio-group-receipt-401",
      providerMessageIds: ["provider-eliza-reply-1"],
      authority: AUTHORITY,
      // The retried receipt must still name the lease that was authorized and
      // committed; a fresh token would orphan the committed delivery.
      leaseToken: ledger.leaseTokens[0],
    });
    expect(adapter.sendReplyWithReceipt).toHaveBeenCalledTimes(1);
    await waitFor(
      () =>
        infoLog.mock.calls.some(
          ([message]) =>
            message === "Personal Eliza connector message completed",
        ),
      "group turn completion log",
    );
    expect(
      errorLog.mock.calls.some(
        ([message]) => message === "Background message processing failed",
      ),
    ).toBe(false);
    await waitFor(
      () =>
        redis.store.get("webhook:blooio:blooio-group-receipt-401") ===
        "delivered",
      "group turn settling as delivered",
    );
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
    const ledger = new SharedLedgerMock();
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
      if (request.url.endsWith(SHARED_MESSAGES_PATH)) {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.eventType === "delivery_authorization") {
          return ledger.authorize(body);
        }
        if (body.eventType === "delivery_commit") {
          return ledger.commit(body);
        }
        if (body.eventType === "delivery_receipt") {
          receiptBody = body;
          return Response.json({
            success: true,
            data: {
              code: "group_delivery_receipt_recorded",
              recorded: true,
              inserted: 1,
            },
          });
        }
        turnCalls += 1;
        turnBody = body;
        return turnResponse("group turn reply");
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

    const response = await handleWebhook(request(), adapter, deps, "eliza-app");
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
    expect(ledger.authorizationCalls).toBe(1);
    expect(ledger.commitCalls).toBe(1);
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
      authority: AUTHORITY,
      leaseToken: ledger.leaseTokens[0],
    });
    expect(
      redis.store.get("webhook:telegram:scope:message:tg-group-update-1"),
    ).toBe("delivered");

    // Telegram redelivers the same update: the delivery ledger refuses the
    // replay outright — no second turn, no second group egress.
    const replay = await handleWebhook(request(), adapter, deps, "eliza-app");
    expect(replay.status).toBe(200);
    expect(turnCalls).toBe(1);
    expect(ledger.authorizationCalls).toBe(1);
    expect(sendReplyWithReceipt).toHaveBeenCalledTimes(1);
  });
});
