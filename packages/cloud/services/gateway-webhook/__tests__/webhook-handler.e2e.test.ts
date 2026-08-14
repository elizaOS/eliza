/** Exercises gateway webhook routing with deterministic cloud-service fixtures. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
  ChatEvent,
  PlatformAdapter,
  WebhookConfig,
} from "../src/adapters/types";
import { MemoryRedisAdapter as MemoryRedis } from "../src/redis";
import {
  handleWebhook,
  recoverQueuedWebhookDeliveries,
} from "../src/webhook-handler";

type RedisSetOptions = { ex?: number; nx?: boolean };

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

async function waitFor(
  assertion: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    if (await assertion()) return;
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

  test("acks before an unresolved phone message enters personal Shared chat", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent();
    const adapter = createAdapter(event);
    let personalMessageBody: Record<string, unknown> | null = null;
    let resolvePersonalMessage: ((response: Response) => void) | undefined;
    const personalMessageResponse = new Promise<Response>((resolve) => {
      resolvePersonalMessage = resolve;
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
        personalMessageBody = (await request.json()) as Record<string, unknown>;
        return personalMessageResponse;
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
    const dedupKey = `webhook:twilio:${event.messageId}`;
    expect(await redis.get<string>(dedupKey)).toBe("queued");
    expect(await redis.get(`${dedupKey}:delivery`)).toMatchObject({
      event: { messageId: event.messageId },
      state: "queued",
    });
    await waitFor(
      () => personalMessageBody !== null,
      "background personal Shared request",
    );
    expect(personalMessageBody).toMatchObject({
      message: "My name is Ada",
      platform: "twilio",
      phoneNumber: "+15551234567",
      messageId: event.messageId,
    });
    resolvePersonalMessage?.(
      new Response(
        JSON.stringify({
          success: true,
          data: { reply: "same personal Eliza, now on your phone" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await waitFor(() => adapter.replies.length === 1, "personal Shared reply");
    expect(adapter.replies).toEqual(["same personal Eliza, now on your phone"]);
  });

  test("retries transient personal Shared failures before one provider reply", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({ messageId: "SM_personal_retry" });
    const adapter = createAdapter(event);
    let personalCalls = 0;

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
        personalCalls += 1;
        if (personalCalls < 3) {
          return new Response("temporarily unavailable", { status: 503 });
        }
        return new Response(
          JSON.stringify({
            success: true,
            data: { reply: "recovered without a duplicate turn" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    expect(
      (
        await handleWebhook(
          requestFor(event),
          adapter,
          {
            redis,
            cloudBaseUrl: "https://api.elizacloud.ai",
            getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
          },
          "eliza-app",
        )
      ).status,
    ).toBe(200);

    await waitFor(() => adapter.replies.length === 1, "retried personal reply");
    expect(personalCalls).toBe(3);
    expect(adapter.replies).toEqual(["recovered without a duplicate turn"]);
  });

  test("recovers queued personal Shared work without a second provider webhook", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({ messageId: "SM_personal_replay" });
    const firstAdapter = createAdapter(event);
    let personalCalls = 0;
    let recovered = false;

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
        personalCalls += 1;
        return recovered
          ? new Response(
              JSON.stringify({
                success: true,
                data: { reply: "safe provider replay recovered the reply" },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            )
          : new Response("still unavailable", { status: 503 });
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;

    await handleWebhook(
      requestFor(event),
      firstAdapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );

    const dedupKey = `webhook:twilio:${event.messageId}`;
    await waitFor(() => personalCalls === 3, "personal retry exhaustion");
    expect(await redis.get<string>(dedupKey)).toBe("queued");
    expect(firstAdapter.replies).toEqual([]);

    recovered = true;
    const replayAdapter = createAdapter(event);
    const replay = await handleWebhook(
      requestFor(event),
      replayAdapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
      },
      "eliza-app",
    );
    expect(replay.status).toBe(200);
    expect(replayAdapter.replies).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await recoverQueuedWebhookDeliveries({ twilio: replayAdapter } as never, {
      redis,
      cloudBaseUrl: "https://api.elizacloud.ai",
      getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
    });
    await waitFor(() => replayAdapter.replies.length === 1, "recovered reply");
    expect(replayAdapter.replies).toEqual([
      "safe provider replay recovered the reply",
    ]);
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
    const sendReply = mock(async () => undefined);
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
        if (value === "egress_started") return null;
        return super.set(key, value, options);
      }
    }
    const redis = new EgressContendedRedis();
    await redis.set(
      "identity:telegram:sender-1",
      JSON.stringify({
        userId: "user-1",
        organizationId: "org-1",
        agentId: "agent-1",
      }),
    );
    await redis.set("agent:agent-1:server", "server-1");
    await redis.set("server:server-1:url", "http://agent-server.local");
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ response: "agent reply" }), {
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
    expect(sendReply).not.toHaveBeenCalled();
    expect(
      await redis.get("webhook:telegram:scope:message:update-1:processing"),
    ).toBeNull();
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
    await redis.set(
      "identity:telegram:sender-1",
      JSON.stringify({ notFound: true }),
    );
    let onboardingAttempts = 0;
    globalThis.fetch = mock(async () => {
      onboardingAttempts += 1;
      if (onboardingAttempts === 1) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({ data: { reply: "onboarding reply" } }),
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
    ).rejects.toThrow(/onboarding chat failed \(503\)/);
    expect(await redis.get(processingKey)).toBeNull();

    const retry = await handleWebhook(request(), adapter, deps, "eliza-app");
    expect(retry.status).toBe(200);
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(await redis.get(processingKey)).not.toBeNull();
  });

  test("retries personal Shared once with fresh auth and the same message id", async () => {
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
        messageId: event.messageId,
      },
      {
        authorization: "Bearer fresh",
        messageId: event.messageId,
      },
    ]);
    expect(adapter.replies).toEqual(["fresh-token reply"]);
  });

  test("routes linked Twilio identity to the running agent server and sends the agent reply", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    await redis.set("agent:agent-1:server", "server-1");
    await redis.set("server:server-1:url", "http://agent-server.local");
    const event = createTwilioEvent({
      messageId: "SM_linked_1",
      text: "Are you running?",
    });
    const adapter = createAdapter(event);
    let forwardedBody: Record<string, unknown> | null = null;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/identity/resolve"
      ) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              user: { id: "user-1", organizationId: "org-1" },
              agent: { id: "agent-1" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (request.url === "http://agent-server.local/agents/agent-1/message") {
        forwardedBody = (await request.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ response: "agent reply: container is running" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
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
    expect(forwardedBody).toMatchObject({
      userId: "user-1",
      text: "Are you running?",
      platformName: "twilio",
      senderName: "Ada",
      chatId: "+15551234567",
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
    await redis.set("agent:agent-1:server", "server-1");
    await redis.set("server:server-1:url", "http://agent-server.local");
    const event = createTwilioEvent({
      messageId: "SM_silent_1",
      text: "(a message the agent chooses not to answer)",
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
            data: {
              user: { id: "user-1", organizationId: "org-1" },
              agent: { id: "agent-1" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (request.url === "http://agent-server.local/agents/agent-1/message") {
        return new Response(JSON.stringify({ response: "" }), {
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
    // message with no reply at all. The user must instead get the onboarding
    // worker's provisioning status, and must NOT be routed to the project
    // default agent (a runtime that belongs to nobody in particular).
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({
      messageId: "SM_provisioning_1",
      text: "is my agent ready?",
    });
    const adapter = createAdapter(event);
    let personalMessageBody: Record<string, unknown> | null = null;

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
        personalMessageBody = (await request.json()) as Record<string, unknown>;
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
    expect(personalMessageBody).toMatchObject({
      platform: "twilio",
      phoneNumber: "+15551234567",
      messageId: "SM_provisioning_1",
    });
  });

  test("re-resolves an unresolved identity on the next message", async () => {
    // A sender can finish browser onboarding between two provider messages, so
    // an unresolved result must not hide the completed link from the next turn.
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({ messageId: "SM_negcache_1" });
    const adapter = createAdapter(event);
    let resolveCalls = 0;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/identity/resolve"
      ) {
        resolveCalls += 1;
        return new Response(JSON.stringify({ success: false }), {
          status: 404,
        });
      }
      if (
        request.url ===
        "https://api.elizacloud.ai/api/internal/eliza-app/personal-shared/messages"
      ) {
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

    // A second inbound message re-queries even while the sender is still
    // unlinked; if browser onboarding completed between these messages, this
    // request would observe the new account and route it immediately.
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

    expect(resolveCalls).toBe(2);
    expect(await redis.get("identity:twilio:+15551234567")).toBeNull();
  });

  test("uses personal Shared when the Dedicated server is not registered", async () => {
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

  test("stays silent rather than onboarding when an established agent's pod is down", async () => {
    // `agent:<id>:server` lives 30 days; `server:<name>:url` is heartbeat-backed
    // and expires after 120s. Routing key present + URL gone means an agent that
    // HAS booted whose pod is now down or scaled to zero. Onboarding that owner
    // would answer "you're live" while the message goes nowhere, and copy the
    // transcript into their agent's memory again.
    configureEnv();
    const redis = new MemoryRedis();
    await redis.set("agent:agent-7:server", "server-7");
    const event = createTwilioEvent({
      messageId: "SM_down_1",
      text: "Are you there?",
    });
    const adapter = createAdapter(event);
    let onboardingCalls = 0;

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
            agentId: "agent-7",
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
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onboardingCalls).toBe(0);
    expect(adapter.replies).toEqual([]);
  });

  test("keeps per-agent webhook precedence for a sender that owns no agent", async () => {
    // `/webhook/:project/:platform/:agentId` names the agent to serve. A sender
    // who happens to have a cloud account without a sandbox must still reach
    // that agent — diverting them would run personal onboarding on someone
    // else's bot.
    configureEnv();
    const redis = new MemoryRedis();
    await redis.set("agent:bound-agent:server", "server-1");
    await redis.set("server:server-1:url", "http://agent-server.local");
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

  test("never diverts a per-agent webhook whose bound agent has no server", async () => {
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
