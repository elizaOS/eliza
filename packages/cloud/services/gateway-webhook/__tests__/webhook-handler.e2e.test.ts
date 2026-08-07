/** Exercises gateway webhook routing with deterministic cloud-service fixtures. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
  ChatEvent,
  PlatformAdapter,
  WebhookConfig,
} from "../src/adapters/types";
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

  test("routes unresolved Twilio identity into the Eliza Cloud onboarding chat", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent();
    const adapter = createAdapter(event);
    let onboardingBody: Record<string, unknown> | null = null;

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
        "https://api.elizacloud.ai/api/eliza-app/onboarding/chat"
      ) {
        expect(request.headers.get("authorization")).toBe(
          "Bearer internal-secret",
        );
        onboardingBody = (await request.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              reply: "onboarding reply with control-panel action metadata",
            },
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
    expect(response.headers.get("content-type")).toContain("text/xml");
    await waitFor(() => adapter.replies.length === 1, "onboarding reply");
    expect(adapter.replies).toEqual([
      "onboarding reply with control-panel action metadata",
    ]);
    expect(onboardingBody).toMatchObject({
      sessionId: "platform:twilio:+15551234567",
      message: "My name is Ada",
      platform: "twilio",
      platformUserId: "+15551234567",
      platformDisplayName: "Ada",
    });
  });

  test("retries onboarding once with fresh auth and the same idempotency key", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    const event = createTwilioEvent({ messageId: "SM_onboarding_retry" });
    const adapter = createAdapter(event);
    const reauth = mock(async () => ({ Authorization: "Bearer fresh" }));
    const onboardingRequests: Array<{
      authorization: string | null;
      idempotencyKey: string | null;
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
        "https://api.elizacloud.ai/api/eliza-app/onboarding/chat"
      ) {
        onboardingRequests.push({
          authorization: request.headers.get("authorization"),
          idempotencyKey: request.headers.get("idempotency-key"),
        });
        if (onboardingRequests.length === 1) {
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
      "retried onboarding reply",
    );
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(onboardingRequests).toEqual([
      {
        authorization: "Bearer stale",
        idempotencyKey: event.messageId,
      },
      {
        authorization: "Bearer fresh",
        idempotencyKey: event.messageId,
      },
    ]);
    expect(adapter.replies).toEqual(["fresh-token reply"]);
  });

  test("routes linked Twilio identity to the running agent server and sends the agent reply", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    redis.store.set("agent:agent-1:server", "server-1");
    redis.store.set("server:server-1:url", "http://agent-server.local");
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
    redis.store.set("agent:agent-1:server", "server-1");
    redis.store.set("server:server-1:url", "http://agent-server.local");
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

  test("routes a linked user whose agent is still provisioning to onboarding", async () => {
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
    let onboardingBody: Record<string, unknown> | null = null;

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
        "https://api.elizacloud.ai/api/eliza-app/onboarding/chat"
      ) {
        onboardingBody = (await request.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            success: true,
            data: { reply: "still setting up your agent, one moment" },
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
    await waitFor(() => adapter.replies.length === 1, "provisioning reply");
    expect(adapter.replies).toEqual([
      "still setting up your agent, one moment",
    ]);
    expect(onboardingBody).toMatchObject({
      sessionId: "platform:twilio:+15551234567",
      platform: "twilio",
      platformUserId: "+15551234567",
    });
  });

  test("caches an unresolved identity only briefly so linking takes effect quickly", async () => {
    // The negative result must be cached (so webhook retries don't stampede the
    // resolver) but on a short TTL: the message right after the user links their
    // account has to reach their real agent, not another onboarding turn.
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
        "https://api.elizacloud.ai/api/eliza-app/onboarding/chat"
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
    await waitFor(() => adapter.replies.length === 1, "first onboarding reply");

    // Second inbound message from the same still-unlinked sender reuses the
    // cached negative result instead of re-querying the resolver.
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
      "second onboarding reply",
    );

    expect(resolveCalls).toBe(1);
    expect(redis.store.get("identity:twilio:+15551234567")).toBe(
      JSON.stringify({ notFound: true }),
    );
  });

  test("routes to onboarding when the owned agent has no registered server", async () => {
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
        "https://api.elizacloud.ai/api/eliza-app/onboarding/chat"
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

    await waitFor(() => adapter.replies.length === 1, "onboarding reply");
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
    redis.store.set("agent:agent-7:server", "server-7");
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
        "https://api.elizacloud.ai/api/eliza-app/onboarding/chat"
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
        "https://api.elizacloud.ai/api/eliza-app/onboarding/chat"
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
        "https://api.elizacloud.ai/api/eliza-app/onboarding/chat"
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
