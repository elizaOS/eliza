/**
 * Pins the Blooio inbound-media forward: with ELIZA_APP_INBOUND_MEDIA_VISION
 * set to "true", allowlisted media URLs ride the personal-Shared POST body only
 * for Blooio one-to-one turns and those turns take the voice-style long-turn
 * retry posture (no status/transport re-POST that could overlap a still-running
 * vision route); a lost Worker response reopens the durable webhook claim and
 * the redelivery re-POSTs the identical enrichment idempotency key (messageId
 * plus mediaUrls) the Worker's description ledger is keyed by; with the flag
 * unset the same image turn is byte-identical to a plain text turn (no
 * mediaUrls, full retry budget); group media events keep the plain text-turn
 * posture either way; and the gateway's runtime-local media allowlist stays
 * byte-identical to the canonical cloud-shared copy the Worker route validates
 * against. Deterministic fixtures with a mocked cloud fetch — no live services.
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
    sendReplyWithReceipt: mock(
      async (config: WebhookConfig, replyEvent: ChatEvent, text: string) => {
        await adapter.sendReply(config, replyEvent, text);
        return { providerMessageIds: [`reply-${replyEvent.messageId}`] };
      },
    ),
    sendTypingIndicator: mock(async () => {}),
  };
  return adapter;
}

const originalFetch = globalThis.fetch;
const envKeys = [
  "ELIZA_APP_INBOUND_MEDIA_VISION",
  "ELIZA_APP_BLOOIO_API_KEY",
  "ELIZA_APP_BLOOIO_WEBHOOK_SECRET",
  "ELIZA_APP_BLOOIO_PHONE_NUMBER",
  "ELIZA_APP_TWILIO_ACCOUNT_SID",
  "ELIZA_APP_TWILIO_AUTH_TOKEN",
  "ELIZA_APP_TWILIO_PHONE_NUMBER",
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

function configureEnv(options: { mediaVision?: boolean } = {}): void {
  if (options.mediaVision === false) {
    delete process.env.ELIZA_APP_INBOUND_MEDIA_VISION;
  } else {
    process.env.ELIZA_APP_INBOUND_MEDIA_VISION = "true";
  }
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

  test("with the vision flag unset a Blooio image turn forwards no mediaUrls", async () => {
    configureEnv({ mediaVision: false });
    const event = createEvent("blooio", { mediaUrls: [MEDIA_URL] });

    const sharedBody = await deliverToPersonalShared(event);

    expect(sharedBody).toEqual({
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: "+15550001111",
      phoneNumber: "+15551234567",
      messageId: `blooio:eliza-app:${event.messageId}`,
      message: `[media: ${MEDIA_URL}]`,
    });
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

  test("with the vision flag unset an image turn keeps the full text-turn retry budget", async () => {
    configureEnv({ mediaVision: false });
    const event = createEvent("blooio", { mediaUrls: [MEDIA_URL] });

    const { posts, bodies } = await countFailingPersonalSharedPosts(event);

    await waitFor(() => posts() === 3, "dark image-turn status retries");
    for (const body of bodies) {
      expect("mediaUrls" in body).toBe(false);
    }
  });

  test("a group media event keeps the plain-turn posture and drops mediaUrls", async () => {
    configureEnv();
    const event = createEvent("blooio", {
      chatType: "group",
      mediaUrls: [MEDIA_URL],
    });

    const { posts, bodies } = await countFailingPersonalSharedPosts(event);

    await waitFor(() => posts() === 3, "group-turn status retries");
    for (const body of bodies) {
      expect("mediaUrls" in body).toBe(false);
    }
  });
});

describe("blooio media turn redelivery idempotency key", () => {
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

  test("a lost Worker response reopens the claim and the redelivery forwards the same key", async () => {
    configureEnv();
    const event = createEvent("blooio", { mediaUrls: [MEDIA_URL] });
    const redis = new MemoryRedis();
    const adapter = createAdapter(event);
    const bodies: Record<string, unknown>[] = [];
    let lostResponses = 0;

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
        bodies.push((await request.json()) as Record<string, unknown>);
        if (bodies.length === 1) {
          // The Worker ran (and may have spent on vision) but its response
          // never reached the gateway.
          lostResponses += 1;
          throw new TypeError("fetch failed: socket hang up");
        }
        return Response.json({ data: { reply: "seen" } });
      }
      throw new Error(`Unexpected fetch: ${request.url}`);
    }) as typeof fetch;
    const deps = {
      redis,
      cloudBaseUrl: "https://api.elizacloud.ai",
      getAuthHeader: () => ({ Authorization: "Bearer internal-secret" }),
    };
    const dedupKey = `webhook:blooio:${event.messageId}`;

    const first = await handleWebhook(
      requestFor(event),
      adapter,
      deps,
      "eliza-app",
    );
    expect(first.status).toBe(200);
    await waitFor(() => bodies.length === 1, "first personal Shared POST");
    await waitFor(
      () => !redis.store.has(dedupKey),
      "reopened webhook claim after the lost response",
    );
    expect(lostResponses).toBe(1);
    expect(adapter.replies).toEqual([]);

    // The provider redelivers the same inbound message.
    const second = await handleWebhook(
      requestFor(event),
      adapter,
      deps,
      "eliza-app",
    );
    expect(second.status).toBe(200);
    await waitFor(
      () => bodies.length === 2,
      "redelivered personal Shared POST",
    );
    await waitFor(() => adapter.replies.length === 1, "redelivered reply");

    // The Worker's description ledger is keyed by exactly this forwarded
    // identity, so the redelivery resolves to the stored description.
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1]).toMatchObject({
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: "+15550001111",
      messageId: `blooio:eliza-app:${event.messageId}`,
      mediaUrls: [MEDIA_URL],
    });
    expect(redis.store.get(dedupKey)).toBe("delivered");
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
