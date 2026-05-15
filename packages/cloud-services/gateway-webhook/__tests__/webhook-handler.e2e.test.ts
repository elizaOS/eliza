import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ChatEvent, PlatformAdapter, WebhookConfig } from "../src/adapters/types";
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

  async set(key: string, value: string, options: RedisSetOptions = {}): Promise<unknown> {
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
    verifyWebhook: mock(async (_request: Request, _rawBody: string, config: WebhookConfig) => {
      expect(config.agentId).toBe("public-onboarding-agent");
      expect(config.accountSid).toBe("AC_test");
      expect(config.authToken).toBe("twilio-secret");
      expect(config.phoneNumber).toBe("+15550000000");
      return true;
    }),
    extractEvent: mock(async () => event),
    sendReply: mock(async (_config: WebhookConfig, _event: ChatEvent, text: string) => {
      adapter.replies.push(text);
    }),
    sendTypingIndicator: mock(async () => {
      adapter.typingCount += 1;
    }),
  };
  return adapter;
}

const originalFetch = globalThis.fetch;
const envKeys = [
  "ELIZA_APP_DEFAULT_AGENT_ID",
  "ELIZA_APP_TWILIO_ACCOUNT_SID",
  "ELIZA_APP_TWILIO_AUTH_TOKEN",
  "ELIZA_APP_TWILIO_PHONE_NUMBER",
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

function configureEnv(): void {
  process.env.ELIZA_APP_DEFAULT_AGENT_ID = "public-onboarding-agent";
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
      if (request.url === "https://api.elizacloud.ai/api/internal/identity/resolve") {
        return new Response(JSON.stringify({ success: false }), { status: 404 });
      }
      if (request.url === "https://api.elizacloud.ai/api/eliza-app/onboarding/chat") {
        expect(request.headers.get("authorization")).toBe("Bearer internal-secret");
        onboardingBody = (await request.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            success: true,
            data: { reply: "onboarding reply with control-panel action metadata" },
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
    expect(adapter.replies).toEqual(["onboarding reply with control-panel action metadata"]);
    expect(onboardingBody).toMatchObject({
      sessionId: "platform:twilio:+15551234567",
      message: "My name is Ada",
      platform: "twilio",
      platformUserId: "+15551234567",
      platformDisplayName: "Ada",
    });
  });

  test("routes linked Twilio identity to the running agent server and sends the agent reply", async () => {
    configureEnv();
    const redis = new MemoryRedis();
    redis.store.set("agent:agent-1:server", "server-1");
    redis.store.set("server:server-1:url", "http://agent-server.local");
    const event = createTwilioEvent({ messageId: "SM_linked_1", text: "Are you running?" });
    const adapter = createAdapter(event);
    let forwardedBody: Record<string, unknown> | null = null;

    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (request.url === "https://api.elizacloud.ai/api/internal/identity/resolve") {
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
        return new Response(JSON.stringify({ response: "agent reply: container is running" }), {
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
});
