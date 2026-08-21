/** Exercises gateway webhook routing with deterministic cloud-service fixtures. */
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

function createTwilioEvent(overrides: Partial<ChatEvent> = {}): ChatEvent {
  return {
    platform: "twilio",
    messageId: `SM${Math.random().toString(16).slice(2)}`,
    chatId: "+15551234567",
    senderId: "+15551234567",
    senderName: "Ada",
    text: "My name is Ada",
    rawPayload: {},
    ...overrides,
  };
}

function createAdapter(event: ChatEvent): PlatformAdapter & {
  replies: string[];
  typingCount: number;
} {
  const adapter: PlatformAdapter & {
    replies: string[];
    typingCount: number;
  } = {
    platform: "twilio",
    replies: [],
    typingCount: 0,
    verifyWebhook: mock(
      async (_request: Request, _rawBody: string, config: WebhookConfig) => {
        expect(config.accountSid).toBe("AC_test");
        expect(config.authToken).toBe("twilio-secret");
        expect(config.phoneNumber).toBe("+15550000000");
        return true;
      },
    ),
    extractEvent: mock(async () => event),
    sendReply: mock(
      async (_config: WebhookConfig, _event: ChatEvent, text: string) => {
        adapter.replies.push(text);
      },
    ),
    sendTypingIndicator: mock(async () => {
      adapter.typingCount += 1;
    }),
  };
  return adapter;
}

const originalFetch = globalThis.fetch;
const envKeys = [
  "ELIZA_APP_TWILIO_ACCOUNT_SID",
  "ELIZA_APP_TWILIO_AUTH_TOKEN",
  "ELIZA_APP_TWILIO_PHONE_NUMBER",
  "ELIZA_APP_TELEGRAM_BOT_TOKEN",
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

function configureEnv(): void {
  process.env.ELIZA_APP_TWILIO_ACCOUNT_SID = "AC_test";
  process.env.ELIZA_APP_TWILIO_AUTH_TOKEN = "twilio-secret";
  process.env.ELIZA_APP_TWILIO_PHONE_NUMBER = "+15550000000";
}

async function waitFor(assertion: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function requestFor(event: ChatEvent): Request {
  return new Request("https://gateway.example/webhook/eliza-app/twilio", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      MessageSid: event.messageId,
      From: event.senderId,
      To: "+15550000000",
      Body: event.text,
    }).toString(),
  });
}

describe("gateway webhook handler e2e routing", () => {
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

  test("handles a link code before an existing provisional identity can route it as chat", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({ text: "LINK-ABCDEFGH" });
    const adapter = createAdapter(event);
    const negativeCacheKey = `identity:twilio:${event.senderId}`;
    await redis.set(negativeCacheKey, JSON.stringify({ notFound: true }));
    let confirmBody: Record<string, unknown> | null = null;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/api/eliza-app/identity-link/confirm")) {
        confirmBody = (await request.json()) as Record<string, unknown>;
        return Response.json({ success: true, data: { status: "linked" } });
      }
      throw new Error(
        `Link challenge incorrectly entered normal routing: ${request.url}`,
      );
    }) as typeof fetch;

    const response = await handleWebhook(
      requestFor(event),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(200);
    await waitFor(() => adapter.replies.length === 1, "identity-link reply");
    expect(confirmBody).toEqual({
      code: "LINK-ABCDEFGH",
      platform: "twilio",
      platformId: event.senderId,
      platformName: event.senderName,
    });
    expect(adapter.replies[0]).toContain("linked");
    expect(await redis.get(negativeCacheKey)).toBeNull();
  });

  test("does not let a group participant capture a Personal Shared agent", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({
      chatId: "group-thread-1",
      chatType: "group",
    });
    const adapter = createAdapter(event);
    let fetched = false;
    globalThis.fetch = mock(async () => {
      fetched = true;
      throw new Error("group guard must run before identity or Shared routing");
    }) as typeof fetch;

    const response = await handleWebhook(
      requestFor(event),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(200);
    expect(fetched).toBe(false);
    expect(adapter.replies).toEqual([]);
    expect(redis.store.size).toBe(0);
  });

  test("acks before an unresolved phone message enters personal Shared", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent();
    const adapter = createAdapter(event);
    let sharedBody: Record<string, unknown> | null = null;
    let resolveShared: ((response: Response) => void) | undefined;
    const sharedResponse = new Promise<Response>((resolve) => {
      resolveShared = resolve;
    });

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/identity/resolve"
      ) {
        return new Response(JSON.stringify({ success: false }), {
          status: 404,
        });
      }
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/eliza-app/personal-shared/messages"
      ) {
        expect(request.headers.get("authorization")).toBe(
          "Bearer internal-secret",
        );
        sharedBody = (await request.json()) as Record<string, unknown>;
        return sharedResponse;
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    const response = await handleWebhook(
      requestFor(event),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/xml");
    expect(adapter.replies).toEqual([]);
    await waitFor(() => sharedBody !== null, "personal Shared request");
    expect(sharedBody).toEqual({
      message: "My name is Ada",
      platform: "twilio",
      project: "eliza-app",
      phoneNumber: "+15551234567",
      messageId: `twilio:eliza-app:${event.messageId}`,
    });
    resolveShared?.(
      new Response(JSON.stringify({ data: { reply: "same personal Eliza" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await waitFor(() => adapter.replies.length === 1, "personal Shared reply");
    expect(adapter.replies).toEqual(["same personal Eliza"]);
  });

  test("routes an unresolved Blooio iMessage to the same phone Shared path", async () => {
    const redis = new MemoryRedis();
    const event: ChatEvent = {
      platform: "blooio",
      messageId: "blooio-message-1",
      chatId: "+15551234567",
      channelType: "blooio",
      protocol: "imessage",
      senderId: "+15551234567",
      senderName: "Ada",
      text: "hello from iMessage",
      rawPayload: {},
    };
    const replies: string[] = [];
    const adapter: PlatformAdapter = {
      platform: "blooio",
      verifyWebhook: mock(async () => true),
      extractEvent: mock(async () => event),
      sendTypingIndicator: mock(async () => undefined),
      sendReply: mock(async (_config, _event, reply) => {
        replies.push(reply);
      }),
    };
    let sharedBody: Record<string, unknown> | null = null;
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/api/internal/identity/resolve")) {
        return new Response(JSON.stringify({ success: false }), {
          status: 404,
        });
      }
      if (
        request.url.endsWith("/api/internal/eliza-app/personal-shared/messages")
      ) {
        sharedBody = (await request.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ data: { reply: "hello from personal Eliza" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    const response = await handleWebhook(
      new Request("https://gateway.example/webhook/eliza-app/blooio", {
        method: "POST",
        body: "{}",
      }),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(200);
    await waitFor(() => replies.length === 1, "Blooio personal Shared reply");
    expect(sharedBody).toEqual({
      platform: "blooio",
      project: "eliza-app",
      phoneNumber: "+15551234567",
      messageId: "blooio:eliza-app:blooio-message-1",
      message: "hello from iMessage",
    });
    expect(replies).toEqual(["hello from personal Eliza"]);
  });

  test("refuses Telegram egress when another worker atomically claimed delivery", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const event: ChatEvent = {
      platform: "telegram",
      messageId: "update-1",
      platformRecordId: "message-1",
      chatId: "chat-1",
      chatType: "private",
      senderId: "sender-1",
      senderName: "Ada",
      text: "hello",
      rawPayload: {},
    };
    const sendReply = mock(async (_config, _event, text, deliveryHooks) => {
      await deliveryHooks?.prepare([text]);
      if (await deliveryHooks?.shouldSend(0, text)) {
        await deliveryHooks.accepted(0, text, "provider-1");
      }
    });
    const adapter: PlatformAdapter = {
      platform: "telegram",
      getDedupeScope: () => "scope",
      verifyWebhook: mock(async () => true),
      extractEvent: mock(async () => event),
      sendTypingIndicator: mock(async () => undefined),
      sendReply,
    };
    class EgressContendedRedis extends MemoryRedis {
      override async set(
        key: string,
        value: string,
        options: RedisSetOptions = {},
      ): Promise<unknown> {
        if (value === "uncertain" && key.includes(":chunk:")) return null;
        return super.set(key, value, options);
      }
    }
    const redis = new EgressContendedRedis();
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ data: { reply: "agent reply" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;

    const response = await handleWebhook(
      new Request("https://gateway.example/webhook/eliza-app/telegram", {
        method: "POST",
        body: "{}",
      }),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(503);
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(
      redis.store.has("webhook:telegram:scope:message:update-1:processing"),
    ).toBe(false);
  });

  test("releases Telegram processing ownership after a pre-egress failure so the update can retry immediately", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const event: ChatEvent = {
      platform: "telegram",
      messageId: "update-retry-before-egress",
      platformRecordId: "message-retry-before-egress",
      chatId: "chat-1",
      chatType: "private",
      senderId: "sender-1",
      senderName: "Ada",
      text: "hello",
      rawPayload: {},
    };
    const sendReply = mock(async () => undefined);
    const adapter: PlatformAdapter = {
      platform: "telegram",
      getDedupeScope: () => "scope",
      verifyWebhook: mock(async () => true),
      extractEvent: mock(async () => event),
      sendReply,
    };
    const redis = new MemoryRedis();
    redis.store.set(
      "identity:telegram:sender-1",
      JSON.stringify({ notFound: true }),
    );
    let sharedAttempts = 0;
    globalThis.fetch = mock(async () => {
      sharedAttempts += 1;
      if (sharedAttempts <= 3) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({ data: { reply: "personal Shared reply" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const request = () =>
      new Request("https://gateway.example/webhook/eliza-app/telegram", {
        method: "POST",
        body: "{}",
      });
    const deps = {
      redis,
      cloudBaseUrl: "https://api.elizacloud.ai",
      getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
    };
    const processingKey =
      "webhook:telegram:scope:message:update-retry-before-egress:processing";

    await expect(
      handleWebhook(request(), adapter, deps, "eliza-app"),
    ).rejects.toThrow(/personal Shared chat failed \(503\)/);
    expect(redis.store.has(processingKey)).toBe(false);

    const retry = await handleWebhook(request(), adapter, deps, "eliza-app");
    expect(retry.status).toBe(200);
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(redis.store.has(processingKey)).toBe(false);
  });

  test("routes an unlinked Telegram DM to rowless personal Shared", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const event: ChatEvent = {
      platform: "telegram",
      messageId: "update-personal-1",
      chatId: "chat-1",
      chatType: "private",
      senderId: "123456789",
      senderName: "Ada",
      text: "what should I focus on today?",
      providerSentAtMs: Date.now() - 2_000,
      rawPayload: {},
    };
    const sendReply = mock(async () => undefined);
    const adapter: PlatformAdapter = {
      platform: "telegram",
      getDedupeScope: () => "scope",
      verifyWebhook: mock(async () => true),
      extractEvent: mock(async () => event),
      sendTypingIndicator: mock(async () => undefined),
      sendReply,
    };
    const redis = new MemoryRedis();
    const completionLog = spyOn(logger, "info").mockImplementation(
      () => undefined,
    );
    let sharedBody: Record<string, unknown> | null = null;
    let sharedTraceId: string | null = null;
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      const url = request.url;
      if (url.endsWith("/api/internal/identity/resolve")) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
        });
      }
      if (url.endsWith("/api/internal/eliza-app/personal-shared/messages")) {
        sharedTraceId = request.headers.get("x-eliza-trace-id");
        sharedBody = (await request.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: { reply: "start with the launch checklist" },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "server-timing": "account;dur=5.2, shared;dur=17.8",
            },
          },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const response = await handleWebhook(
      new Request("https://gateway.example/webhook/eliza-app/telegram", {
        method: "POST",
        headers: {
          "x-eliza-trace-id": "11111111-1111-4111-8111-111111111111",
        },
        body: "{}",
      }),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(200);
    expect(sharedTraceId).toBe("11111111-1111-4111-8111-111111111111");
    expect(sharedBody).toEqual({
      platform: "telegram",
      project: "eliza-app",
      chatId: "chat-1",
      telegramUserId: "123456789",
      displayName: "Ada",
      messageId: "telegram:eliza-app:update-personal-1",
      message: "what should I focus on today?",
    });
    expect(sendReply).toHaveBeenCalledWith(
      expect.anything(),
      event,
      "start with the launch checklist",
      expect.anything(),
    );
    expect(completionLog).toHaveBeenCalledWith(
      "Personal Shared Cloud attempt completed",
      expect.objectContaining({
        traceId: "11111111-1111-4111-8111-111111111111",
        attempt: 1,
        maxAttempts: 4,
        status: 200,
        retryable: false,
        retryDelayMs: null,
        cloudServerTiming: "account;dur=5.2, shared;dur=17.8",
      }),
    );
    expect(completionLog).toHaveBeenCalledWith(
      "Personal Eliza connector message completed",
      expect.objectContaining({
        project: "eliza-app",
        platform: "telegram",
        messageId: "update-personal-1",
        traceId: "11111111-1111-4111-8111-111111111111",
        providerToGatewayMs: expect.any(Number),
        cloudMs: expect.any(Number),
        cloudAttempts: 1,
        cloudServerTiming: "account;dur=5.2, shared;dur=17.8",
        egressMs: expect.any(Number),
        totalMs: expect.any(Number),
      }),
    );
  });

  test("correlates every retry and preserves prior Cloud timing", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const traceId = "22222222-2222-4222-8222-222222222222";
    const event: ChatEvent = {
      platform: "telegram",
      messageId: "update-attempt-trace",
      chatId: "chat-1",
      chatType: "private",
      senderId: "123456789",
      senderName: "Ada",
      text: "trace this turn",
      providerSentAtMs: Date.now() - 1_000,
      rawPayload: {},
    };
    const adapter: PlatformAdapter = {
      platform: "telegram",
      getDedupeScope: () => "scope",
      verifyWebhook: mock(async () => true),
      extractEvent: mock(async () => event),
      sendTypingIndicator: mock(async () => undefined),
      sendReply: mock(async () => undefined),
    };
    const redis = new MemoryRedis();
    const infoLog = spyOn(logger, "info").mockImplementation(() => undefined);
    const warnLog = spyOn(logger, "warn").mockImplementation(() => undefined);
    const forwardedTraceIds: Array<string | null> = [];
    let attempt = 0;
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        !request.url.endsWith(
          "/api/internal/eliza-app/personal-shared/messages",
        )
      ) {
        throw new Error(`unexpected request: ${request.url}`);
      }
      forwardedTraceIds.push(request.headers.get("x-eliza-trace-id"));
      attempt += 1;
      if (attempt === 1) {
        return new Response("cold failure", {
          status: 503,
          headers: {
            "Retry-After": "0",
            "Server-Timing": "failed_worker;dur=1234",
            "X-Eliza-Failure-Stage": "shared_runtime",
            "X-Eliza-Failure-Name": "TypeError",
          },
        });
      }
      return Response.json(
        { data: { reply: "retried successfully" } },
        { headers: { "Server-Timing": "account;dur=4, shared;dur=20" } },
      );
    }) as typeof fetch;

    const response = await handleWebhook(
      new Request("https://gateway.example/webhook/eliza-app/telegram", {
        method: "POST",
        headers: { "X-Eliza-Trace-Id": traceId },
        body: "{}",
      }),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(200);
    expect(forwardedTraceIds).toEqual([traceId, traceId]);
    expect(warnLog).toHaveBeenCalledWith(
      "Personal Shared Cloud attempt failed",
      expect.objectContaining({
        traceId,
        attempt: 1,
        status: 503,
        retryable: true,
        retryReason: "status",
        retryAfterSeconds: 0,
        retryDelayMs: 0,
        cloudServerTiming: "failed_worker;dur=1234",
        cloudFailureStage: "shared_runtime",
        cloudFailureName: "TypeError",
      }),
    );
    expect(infoLog).toHaveBeenCalledWith(
      "Personal Shared Cloud attempt completed",
      expect.objectContaining({
        traceId,
        attempt: 2,
        status: 200,
        retryable: false,
        retryDelayMs: null,
        cloudServerTiming: "account;dur=4, shared;dur=20",
      }),
    );
    expect(infoLog).toHaveBeenCalledWith(
      "Personal Eliza connector message completed",
      expect.objectContaining({
        traceId,
        providerToGatewayMs: expect.any(Number),
        cloudAttempts: 2,
      }),
    );
  });

  test("resolves captionless Telegram voice bytes before the trusted Shared boundary", async () => {
    process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = "telegram-test-token";
    const event: ChatEvent = {
      platform: "telegram",
      messageId: "update-voice-1",
      chatId: "chat-1",
      chatType: "private",
      senderId: "123456789",
      senderName: "Ada",
      text: "",
      voiceNote: {
        fileId: "provider-file-id",
        durationSeconds: 2,
        sizeBytes: 8,
        mimeType: "audio/ogg",
      },
      rawPayload: {},
    };
    const resolveVoiceNote = mock(async () => ({
      bytesBase64: Buffer.from("OggSdata").toString("base64"),
      mimeType: "audio/ogg" as const,
      filename: "telegram-update-voice-1.ogg",
      sizeBytes: 8,
      durationSeconds: 2,
    }));
    const sendReply = mock(async () => undefined);
    const adapter: PlatformAdapter = {
      platform: "telegram",
      getDedupeScope: () => "scope",
      verifyWebhook: mock(async () => true),
      extractEvent: mock(async () => event),
      resolveVoiceNote,
      sendTypingIndicator: mock(async () => undefined),
      sendReply,
    };
    const redis = new MemoryRedis();
    let sharedBody: Record<string, unknown> | null = null;
    globalThis.fetch = mock(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/internal/eliza-app/personal-shared/messages")) {
        sharedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ data: { reply: "I heard you" } });
      }
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;

    const response = await handleWebhook(
      new Request("https://gateway.example/webhook/eliza-app/telegram", {
        method: "POST",
        body: "{}",
      }),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(200);
    expect(resolveVoiceNote).toHaveBeenCalledWith(expect.anything(), event);
    expect(sharedBody).toEqual({
      platform: "telegram",
      project: "eliza-app",
      chatId: "chat-1",
      telegramUserId: "123456789",
      displayName: "Ada",
      messageId: "telegram:eliza-app:update-voice-1",
      voiceNote: {
        bytesBase64: Buffer.from("OggSdata").toString("base64"),
        mimeType: "audio/ogg",
        filename: "telegram-update-voice-1.ogg",
        sizeBytes: 8,
        durationSeconds: 2,
      },
    });
    expect(sendReply).toHaveBeenCalledWith(
      expect.anything(),
      event,
      "I heard you",
      expect.anything(),
    );
  });

  test("retries personal Shared with fresh auth and the same message id", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({ messageId: "SM_onboarding_retry" });
    const adapter = createAdapter(event);
    const reauth = mock(async () => ({ Authorization: "Bearer fresh" }));
    const personalRequests: Array<{
      authorization: string | null;
      messageId: unknown;
    }> = [];

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/identity/resolve"
      ) {
        return new Response(JSON.stringify({ success: false }), {
          status: 404,
        });
      }
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/eliza-app/personal-shared/messages"
      ) {
        const body = (await request.json()) as Record<string, unknown>;
        personalRequests.push({
          authorization: request.headers.get("authorization"),
          messageId: body.messageId,
        });
        if (personalRequests.length === 1) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(
          JSON.stringify({ data: { reply: "fresh-token reply" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    const response = await handleWebhook(
      requestFor(event),
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
      () => adapter.replies.length === 1,
      "retried personal Shared reply",
    );
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(personalRequests).toEqual([
      {
        authorization: "Bearer stale",
        messageId: `twilio:eliza-app:${event.messageId}`,
      },
      {
        authorization: "Bearer fresh",
        messageId: `twilio:eliza-app:${event.messageId}`,
      },
    ]);
    expect(adapter.replies).toEqual(["fresh-token reply"]);
  });

  test("still refreshes stale Cloud auth when transport retries happened first", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({ messageId: "SM_transport_then_auth" });
    const adapter = createAdapter(event);
    const reauth = mock(async () => ({ Authorization: "Bearer fresh" }));
    const personalRequests: Array<{
      authorization: string | null;
      messageId: unknown;
    }> = [];

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/eliza-app/personal-shared/messages"
      ) {
        const body = (await request.json()) as Record<string, unknown>;
        personalRequests.push({
          authorization: request.headers.get("authorization"),
          messageId: body.messageId,
        });
        if (personalRequests.length <= 2) {
          throw new Error("The operation timed out.");
        }
        if (personalRequests.length === 3) {
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json({ data: { reply: "recovered reply" } });
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    const response = await handleWebhook(
      requestFor(event),
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
      () => adapter.replies.length === 1,
      "transport-then-auth personal Shared reply",
    );
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(personalRequests).toEqual([
      {
        authorization: "Bearer stale",
        messageId: `twilio:eliza-app:${event.messageId}`,
      },
      {
        authorization: "Bearer stale",
        messageId: `twilio:eliza-app:${event.messageId}`,
      },
      {
        authorization: "Bearer stale",
        messageId: `twilio:eliza-app:${event.messageId}`,
      },
      {
        authorization: "Bearer fresh",
        messageId: `twilio:eliza-app:${event.messageId}`,
      },
    ]);
    expect(adapter.replies).toEqual(["recovered reply"]);
  });

  test("routes linked Twilio through the canonical personal conversation", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({
      messageId: "SM_linked_1",
      text: "Are you running?",
    });
    const adapter = createAdapter(event);
    let personalBody: Record<string, unknown> | null = null;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/eliza-app/personal-shared/messages"
      ) {
        personalBody = (await request.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            data: { reply: "agent reply: container is running" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    const response = await handleWebhook(
      requestFor(event),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(200);
    await waitFor(() => adapter.replies.length === 1, "agent reply");
    expect(adapter.typingCount).toBe(1);
    expect(adapter.replies).toEqual(["agent reply: container is running"]);
    expect(personalBody).toEqual({
      platform: "twilio",
      project: "eliza-app",
      phoneNumber: "+15551234567",
      messageId: "twilio:eliza-app:SM_linked_1",
      message: "Are you running?",
    });
  });

  test("skips sendReply when the agent server returns an empty (no-response) reply", async () => {
    // A deliberate agent silence surfaces as an empty `response` string (the
    // agent-server no longer fabricates a "No response generated." reply). The
    // gateway must NOT forward the empty string to the platform adapter — an
    // empty send is invalid on WhatsApp/Twilio/Telegram — and must stay
    // distinct from a forward failure (which returns without a reply too, but
    // is logged as an error). Here the forward SUCCEEDS with an empty body, so
    // no reply is sent and no error is raised.
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({
      messageId: "SM_silent_1",
      text: "(a message the agent chooses not to answer)",
    });
    const adapter = createAdapter(event);

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/eliza-app/personal-shared/messages"
      ) {
        return new Response(JSON.stringify({ data: { reply: "" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    const response = await handleWebhook(
      requestFor(event),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(200);
    // Give the fire-and-forget processMessage a moment; assert it NEVER sends.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(adapter.replies).toEqual([]);
  });

  test("keeps a linked user on personal Shared while Dedicated is provisioning", async () => {
    // Identity resolve returns a real user with `agent: null` while the
    // provisioning job is still in flight. Previously resolveIdentity threw on
    // the missing agentId, which aborted processMessage and dropped the user's
    // message with no reply at all. The user must instead retain the personal
    // Shared identity, and must NOT be routed to the project
    // default agent (a runtime that belongs to nobody in particular).
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({
      messageId: "SM_provisioning_1",
      text: "is my agent ready?",
    });
    const adapter = createAdapter(event);
    let sharedBody: Record<string, unknown> | null = null;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/identity/resolve"
      ) {
        return new Response(
          JSON.stringify({
            success: true,
            userId: "user-7",
            organizationId: "org-7",
            agentId: null,
            data: {
              user: { id: "user-7", organizationId: "org-7" },
              agent: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/eliza-app/personal-shared/messages"
      ) {
        sharedBody = (await request.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            success: true,
            data: { reply: "I am still here while Dedicated starts." },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    const response = await handleWebhook(
      requestFor(event),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    expect(response.status).toBe(200);
    await waitFor(() => adapter.replies.length === 1, "personal Shared reply");
    expect(adapter.replies).toEqual([
      "I am still here while Dedicated starts.",
    ]);
    expect(sharedBody).toMatchObject({
      platform: "twilio",
      project: "eliza-app",
      phoneNumber: "+15551234567",
      messageId: "twilio:eliza-app:SM_provisioning_1",
    });
  });

  test("leaves account identity resolution to the canonical personal route", async () => {
    // The API resolves the latest phone/account link transactionally. Gateway
    // identity caching would let a newly linked sender fork back onto a stale
    // generic-agent room between provider messages.
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({ messageId: "SM_negcache_1" });
    const adapter = createAdapter(event);
    let personalCalls = 0;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/identity/resolve"
      ) {
        throw new Error(
          "account transports must not use generic identity routing",
        );
      }
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/eliza-app/personal-shared/messages"
      ) {
        personalCalls += 1;
        return new Response(
          JSON.stringify({ success: true, data: { reply: "hi there" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    await handleWebhook(
      requestFor(event),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );
    await waitFor(() => adapter.replies.length === 1, "first personal reply");

    // A second inbound message reaches the same canonical endpoint, where a
    // just-completed account link is visible without gateway cache invalidation.
    const second = createTwilioEvent({ messageId: "SM_negcache_2" });
    const secondAdapter = createAdapter(second);
    await handleWebhook(
      requestFor(second),
      secondAdapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );
    await waitFor(
      () => secondAdapter.replies.length === 1,
      "second personal reply",
    );

    expect(personalCalls).toBe(2);
    expect(redis.store.has("identity:twilio:+15551234567")).toBe(false);
  });

  test("uses personal Shared when the owned agent has no registered server", async () => {
    // A sandbox row exists from the moment provisioning starts, but
    // `agent:<id>:server` only appears once a container has booted. Between the
    // two, routing on the row alone logs and returns — silence for the whole
    // boot window, and for good if provisioning ends in error.
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({
      messageId: "SM_pending_1",
      text: "Any progress?",
    });
    const adapter = createAdapter(event);

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/identity/resolve"
      ) {
        return new Response(
          JSON.stringify({
            success: true,
            userId: "user-9",
            organizationId: "org-9",
            agentId: "sandbox-pending",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/eliza-app/personal-shared/messages"
      ) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { reply: "Still starting up, Ada." },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    await handleWebhook(
      requestFor(event),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    await waitFor(() => adapter.replies.length === 1, "personal Shared reply");
    expect(adapter.replies).toEqual(["Still starting up, Ada."]);
  });

  test("retries a waking Dedicated target without reopening Shared", async () => {
    // The canonical API owns wake/resume and returns a retryable status while
    // preserving the Dedicated marker. Gateway must never synthesize a Shared
    // onboarding reply for that established account.
    configureEnv();
    const redis = new MemoryRedis();
    redis.store.set("agent:agent-7:server", "server-7");
    const event = createTwilioEvent({
      messageId: "SM_down_1",
      text: "Are you there?",
    });
    const adapter = createAdapter(event);
    let personalCalls = 0;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/eliza-app/personal-shared/messages"
      ) {
        personalCalls += 1;
        return new Response(JSON.stringify({ code: "dedicated_starting" }), {
          status: 503,
          headers: {
            "content-type": "application/json",
            "Retry-After": "0",
          },
        });
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    await handleWebhook(
      requestFor(event),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(personalCalls).toBe(3);
    expect(adapter.replies).toEqual([]);
  });

  test("keeps per-agent webhook precedence for a sender that owns no agent", async () => {
    // `/webhook/:project/:platform/:agentId` names the agent to serve. A sender
    // who happens to have a cloud account without a sandbox must still reach
    // that agent — diverting them would run personal onboarding on someone
    // else's bot.
    configureEnv();
    const redis = new MemoryRedis();
    redis.store.set("agent:bound-agent:server", "server-1");
    redis.store.set("server:server-1:url", "http://agent-server.local");
    const event = createTwilioEvent({
      messageId: "SM_bound_1",
      text: "Hello bound agent",
    });
    const adapter = createAdapter(event);
    let forwardedBody: Record<string, unknown> | null = null;
    let onboardingCalls = 0;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url.startsWith(
          "https://api.elizacloud.ai/api/internal/webhook/config",
        )
      ) {
        return new Response(
          JSON.stringify({
            accountSid: "AC_test",
            authToken: "twilio-secret",
            phoneNumber: "+15550000000",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/identity/resolve"
      ) {
        return new Response(
          JSON.stringify({
            success: true,
            userId: "user-9",
            organizationId: "org-9",
            agentId: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/eliza-app/personal-shared/messages"
      ) {
        onboardingCalls += 1;
        return new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        request.url === "http://agent-server.local/agents/bound-agent/message"
      ) {
        forwardedBody = (await request.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ response: "bound agent reply" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    await handleWebhook(
      requestFor(event),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
      "bound-agent",
    );

    await waitFor(() => adapter.replies.length === 1, "bound agent reply");
    expect(adapter.replies).toEqual(["bound agent reply"]);
    expect(onboardingCalls).toBe(0);
    expect(forwardedBody).toMatchObject({
      userId: "user-9",
      text: "Hello bound agent",
    });
  });

  test("never onboards on a per-agent webhook whose bound agent has no server", async () => {
    // The URL agent is down. Falling through to onboarding here would run one
    // sender's personal Eliza Cloud signup on a third party's bot.
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({
      messageId: "SM_bound_down_1",
      text: "Hello bound agent",
    });
    const adapter = createAdapter(event);
    let onboardingCalls = 0;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url.startsWith(
          "https://api.elizacloud.ai/api/internal/webhook/config",
        )
      ) {
        return new Response(
          JSON.stringify({
            accountSid: "AC_test",
            authToken: "twilio-secret",
            phoneNumber: "+15550000000",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/identity/resolve"
      ) {
        return new Response(
          JSON.stringify({
            success: true,
            userId: "user-9",
            organizationId: "org-9",
            agentId: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/eliza-app/personal-shared/messages"
      ) {
        onboardingCalls += 1;
        return new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    await handleWebhook(
      requestFor(event),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
      "unbooted-agent",
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onboardingCalls).toBe(0);
    expect(adapter.replies).toEqual([]);
  });
});
