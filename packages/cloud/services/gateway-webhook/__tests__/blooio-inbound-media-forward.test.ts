/**
 * Pins the Blooio inbound-media forward: allowlisted media URLs ride the
 * personal-Shared POST body only for Blooio one-to-one turns, media turns take
 * the voice-style long-turn retry posture (no status/transport re-POST that
 * could overlap a still-running vision route), group media events keep the
 * plain text-turn posture, and the gateway's runtime-local media allowlist
 * stays byte-identical to the canonical cloud-shared copy the Worker route
 * validates against. Deterministic fixtures with a mocked cloud fetch — no
 * live services.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  ALLOWED_BLOOIO_MEDIA_DOMAINS,
  isAllowedBlooioMediaUrl,
} from "@elizaos/cloud-shared/lib/services/eliza-app/blooio-media-allowlist";
import { ALLOWED_MEDIA_DOMAINS, isValidMediaUrl } from "../src/adapters/blooio";
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

const MEDIA_URL = "https://media.blooio.com/files/photo-1.jpeg";

function createEvent(
  platform: "blooio" | "twilio",
  overrides: Partial<ChatEvent> = {},
): ChatEvent {
  return {
    platform,
    messageId: `msg_${Math.random().toString(16).slice(2)}`,
    chatId: "+15551234567",
    senderId: "+15551234567",
    senderName: "Ada",
    text: `[media: ${MEDIA_URL}]`,
    rawPayload: {},
    ...overrides,
  };
}

function createAdapter(
  event: ChatEvent,
): PlatformAdapter & { replies: string[] } {
  const adapter: PlatformAdapter & { replies: string[] } = {
    platform: event.platform,
    replies: [],
    verifyWebhook: mock(async () => true),
    extractEvent: mock(async () => event),
    sendReply: mock(
      async (_config: WebhookConfig, _event: ChatEvent, text: string) => {
        adapter.replies.push(text);
      },
    ),
    sendTypingIndicator: mock(async () => {}),
  };
  return adapter;
}

const originalFetch = globalThis.fetch;
const envKeys = [
  "ELIZA_APP_BLOOIO_API_KEY",
  "ELIZA_APP_BLOOIO_WEBHOOK_SECRET",
  "ELIZA_APP_BLOOIO_PHONE_NUMBER",
  "ELIZA_APP_TWILIO_ACCOUNT_SID",
  "ELIZA_APP_TWILIO_AUTH_TOKEN",
  "ELIZA_APP_TWILIO_PHONE_NUMBER",
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

function configureEnv(): void {
  process.env.ELIZA_APP_BLOOIO_API_KEY = "bl_live_test";
  process.env.ELIZA_APP_BLOOIO_WEBHOOK_SECRET = "whsec_test";
  process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15550001111";
  process.env.ELIZA_APP_TWILIO_ACCOUNT_SID = "AC_test";
  process.env.ELIZA_APP_TWILIO_AUTH_TOKEN = "twilio-secret";
  process.env.ELIZA_APP_TWILIO_PHONE_NUMBER = "+15550002222";
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
  return new Request(
    `https://gateway.example/webhook/eliza-app/${event.platform}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "message.received" }),
    },
  );
}

async function deliverToPersonalShared(
  event: ChatEvent,
): Promise<Record<string, unknown>> {
  const redis = new MemoryRedis();
  const adapter = createAdapter(event);
  let sharedBody: Record<string, unknown> | null = null;

  globalThis.fetch = mock(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/api/internal/identity/resolve")) {
      return new Response(JSON.stringify({ success: false }), { status: 404 });
    }
    if (
      request.url.endsWith("/api/internal/eliza-app/personal-shared/messages")
    ) {
      sharedBody = (await request.json()) as Record<string, unknown>;
      return Response.json({ data: { reply: "seen" } });
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
  await waitFor(() => sharedBody !== null, "personal Shared request");
  await waitFor(() => adapter.replies.length === 1, "personal Shared reply");
  if (sharedBody === null) throw new Error("personal Shared body missing");
  return sharedBody;
}

describe("blooio inbound media forward", () => {
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

  test("forwards allowlisted Blooio media URLs on the personal Shared body", async () => {
    configureEnv();
    const event = createEvent("blooio", { mediaUrls: [MEDIA_URL] });

    const sharedBody = await deliverToPersonalShared(event);

    expect(sharedBody).toEqual({
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: "+15550001111",
      phoneNumber: "+15551234567",
      messageId: `blooio:eliza-app:${event.messageId}`,
      message: `[media: ${MEDIA_URL}]`,
      mediaUrls: [MEDIA_URL],
    });
  });

  test("a Blooio text turn carries no mediaUrls field", async () => {
    configureEnv();
    const event = createEvent("blooio", { text: "hey eliza" });

    const sharedBody = await deliverToPersonalShared(event);

    expect(sharedBody.message).toBe("hey eliza");
    expect("mediaUrls" in sharedBody).toBe(false);
  });

  test("a Twilio turn never forwards mediaUrls even when the event has them", async () => {
    configureEnv();
    const event = createEvent("twilio", { mediaUrls: [MEDIA_URL] });

    const sharedBody = await deliverToPersonalShared(event);

    expect(sharedBody.platform).toBe("twilio");
    expect("mediaUrls" in sharedBody).toBe(false);
  });
});

async function countFailingPersonalSharedPosts(
  event: ChatEvent,
  adapterOverrides: Partial<PlatformAdapter> = {},
): Promise<{ posts: () => number; bodies: Record<string, unknown>[] }> {
  const redis = new MemoryRedis();
  const adapter = { ...createAdapter(event), ...adapterOverrides };
  const bodies: Record<string, unknown>[] = [];

  globalThis.fetch = mock(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/api/internal/identity/resolve")) {
      return new Response(JSON.stringify({ success: false }), { status: 404 });
    }
    if (
      request.url.endsWith("/api/internal/eliza-app/personal-shared/messages")
    ) {
      bodies.push((await request.json()) as Record<string, unknown>);
      return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
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
  await waitFor(() => bodies.length >= 1, "first personal Shared attempt");
  return { posts: () => bodies.length, bodies };
}

describe("blooio media turn retry posture", () => {
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

  test("a text turn re-POSTs a 5xx up to the shared attempt budget (control)", async () => {
    configureEnv();
    const event = createEvent("blooio", { text: "hey eliza" });

    const { posts } = await countFailingPersonalSharedPosts(event);

    // 200ms + 400ms backoff between the three status-retried attempts.
    await waitFor(() => posts() === 3, "text-turn status retries");
  });

  test("a media turn is never re-POSTed on a 5xx (no overlapping vision runs)", async () => {
    configureEnv();
    const event = createEvent("blooio", { mediaUrls: [MEDIA_URL] });

    const { posts } = await countFailingPersonalSharedPosts(event);

    // Longer than the control test's full retry window: a status retry, if one
    // were still enabled for media turns, would have landed well within this.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(posts()).toBe(1);
  });

  test("a group media event keeps the plain-turn posture and drops mediaUrls", async () => {
    configureEnv();
    const event = createEvent("blooio", {
      chatType: "group",
      mediaUrls: [MEDIA_URL],
    });

    const { posts, bodies } = await countFailingPersonalSharedPosts(event, {
      sendReplyWithReceipt: mock(async () => ({ providerMessageIds: ["p1"] })),
    });

    await waitFor(() => posts() === 3, "group-turn status retries");
    for (const body of bodies) {
      expect("mediaUrls" in body).toBe(false);
    }
  });
});

describe("blooio media allowlist parity with cloud-shared", () => {
  test("the runtime-local domain list matches the canonical copy", () => {
    expect([...ALLOWED_MEDIA_DOMAINS]).toEqual([
      ...ALLOWED_BLOOIO_MEDIA_DOMAINS,
    ]);
  });

  test("both predicates agree across accept and reject cases", () => {
    const matrix = [
      "https://media.blooio.com/files/a.jpg",
      "https://cdn.backend.blooio.com/a.png",
      "https://api.blooio.com/v4/files/a.heic",
      "https://blooio.com/a.gif",
      "http://media.blooio.com/a.jpg",
      "https://notblooio.com/a.jpg",
      "https://blooio.com.evil.com/a.jpg",
      "not a url",
      "",
    ];
    for (const url of matrix) {
      expect(isValidMediaUrl(url)).toBe(isAllowedBlooioMediaUrl(url));
    }
  });
});
