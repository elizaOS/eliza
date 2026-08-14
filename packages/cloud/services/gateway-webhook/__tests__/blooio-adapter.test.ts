/**
 * Exercises the Blooio iMessage adapter with deterministic signature,
 * malformed-delivery, deduplication, and outbound idempotency coverage.
 */
import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { blooioAdapter } from "../src/adapters/blooio";
import type { ChatEvent, WebhookConfig } from "../src/adapters/types";

const SECRET = "whsec_test_secret";

function sign(rawBody: string, secret: string, ageSeconds = 0): string {
  const timestamp = Math.floor(Date.now() / 1000) - ageSeconds;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}

function makeRequest(signature: string | null): Request {
  const headers = new Headers();
  if (signature !== null) headers.set("x-blooio-signature", signature);
  return new Request("https://gateway.example/webhook/eliza-app/blooio", {
    method: "POST",
    headers,
  });
}

function makeConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    apiKey: "bl_live_test",
    blooioWebhookSecret: SECRET,
    fromNumber: "+15550001111",
    ...overrides,
  } as WebhookConfig;
}

function inboundPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "message.received",
    message_id: "msg_abc123",
    sender: "+15551234567",
    text: "hey eliza",
    protocol: "imessage",
    is_group: false,
    ...overrides,
  });
}

function v4InboundPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt_abc123",
    type: "message.received",
    created_at: 1_786_244_262_331,
    organization_id: "org_abc123",
    data: {
      id: "msg_v4_abc123",
      chat_id: "chat_abc123",
      channel_id: "ch_abc123",
      channel_type: "blooio",
      direction: "inbound",
      sender: "+15551234567",
      recipient: "+15550001111",
      channel_address: "+15550001111",
      text: "hey from v4",
      protocol: "imessage",
      is_group: false,
      attachments: [],
      ...overrides,
    },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("blooio verifyWebhook", () => {
  test("accepts a correctly signed fresh delivery", async () => {
    const body = inboundPayload();
    const ok = await blooioAdapter.verifyWebhook(
      makeRequest(sign(body, SECRET)),
      body,
      makeConfig(),
    );
    expect(ok).toBe(true);
  });

  test("accepts a delivery signed 200s ago (inside Blooio's documented 300s window)", async () => {
    // Bidirectional: fails against the previous 120s tolerance, which dropped
    // legitimately retried deliveries.
    const body = inboundPayload();
    const ok = await blooioAdapter.verifyWebhook(
      makeRequest(sign(body, SECRET, 200)),
      body,
      makeConfig(),
    );
    expect(ok).toBe(true);
  });

  test("rejects a delivery older than the 300s window", async () => {
    const body = inboundPayload();
    const ok = await blooioAdapter.verifyWebhook(
      makeRequest(sign(body, SECRET, 400)),
      body,
      makeConfig(),
    );
    expect(ok).toBe(false);
  });

  test("rejects a tampered body", async () => {
    const body = inboundPayload();
    const ok = await blooioAdapter.verifyWebhook(
      makeRequest(sign(body, SECRET)),
      inboundPayload({ text: "tampered" }),
      makeConfig(),
    );
    expect(ok).toBe(false);
  });

  test("rejects a signature computed with the wrong secret", async () => {
    const body = inboundPayload();
    const ok = await blooioAdapter.verifyWebhook(
      makeRequest(sign(body, "whsec_other")),
      body,
      makeConfig(),
    );
    expect(ok).toBe(false);
  });

  test("rejects a malformed signature header", async () => {
    const body = inboundPayload();
    const ok = await blooioAdapter.verifyWebhook(
      makeRequest("not-a-signature"),
      body,
      makeConfig(),
    );
    expect(ok).toBe(false);
  });

  test("rejects when the signature header is absent", async () => {
    const body = inboundPayload();
    const ok = await blooioAdapter.verifyWebhook(
      makeRequest(null),
      body,
      makeConfig(),
    );
    expect(ok).toBe(false);
  });

  test("rejects when no webhook secret is configured", async () => {
    const body = inboundPayload();
    const ok = await blooioAdapter.verifyWebhook(
      makeRequest(sign(body, SECRET)),
      body,
      makeConfig({ blooioWebhookSecret: undefined }),
    );
    expect(ok).toBe(false);
  });
});

describe("blooio extractEvent", () => {
  test("maps an inbound message to a ChatEvent", async () => {
    const event = await blooioAdapter.extractEvent(inboundPayload());
    expect(event).not.toBeNull();
    expect(event?.platform).toBe("blooio");
    expect(event?.messageId).toBe("msg_abc123");
    expect(event?.chatId).toBe("+15551234567");
    expect(event?.senderId).toBe("+15551234567");
    expect(event?.text).toBe("hey eliza");
  });

  test("maps a current v4 webhook envelope to a ChatEvent", async () => {
    const body = v4InboundPayload();
    const event = await blooioAdapter.extractEvent(body);

    expect(event).not.toBeNull();
    expect(event?.messageId).toBe("msg_v4_abc123");
    expect(event?.chatId).toBe("+15551234567");
    expect(event?.senderId).toBe("+15551234567");
    expect(event?.text).toBe("hey from v4");
    expect(event?.channelId).toBe("ch_abc123");
    expect(event?.channelType).toBe("blooio");
    expect(event?.rawPayload).toEqual(JSON.parse(body));
  });

  test("preserves v4 channel_id and channel_type for WhatsApp channels", async () => {
    const event = await blooioAdapter.extractEvent(
      v4InboundPayload({
        channel_id: "ch_whatsapp_001",
        channel_type: "whatsapp",
        protocol: "whatsapp",
      }),
    );

    expect(event?.channelId).toBe("ch_whatsapp_001");
    expect(event?.channelType).toBe("whatsapp");
  });

  test("omits channelId/channelType when a v4 delivery lacks channel metadata", async () => {
    const event = await blooioAdapter.extractEvent(
      v4InboundPayload({
        channel_id: null,
        channel_type: null,
      }),
    );

    expect(event).not.toBeNull();
    expect(event?.channelId).toBeUndefined();
    expect(event?.channelType).toBeUndefined();
  });

  test("v2 events never carry channel metadata", async () => {
    const event = await blooioAdapter.extractEvent(inboundPayload());

    expect(event).not.toBeNull();
    expect(event?.channelId).toBeUndefined();
    expect(event?.channelType).toBeUndefined();
  });

  test("uses the v4 contact identity when sender is absent", async () => {
    const event = await blooioAdapter.extractEvent(
      v4InboundPayload({
        sender: null,
        contact: { identifier: "+15557654321" },
      }),
    );

    expect(event?.senderId).toBe("+15557654321");
  });

  test("skips an event with no sender instead of emitting an unroutable ChatEvent", async () => {
    // Bidirectional: the previous code returned chatId/senderId as empty
    // strings, which walked the whole pipeline and produced a malformed
    // reply POST to /chats//messages.
    const event = await blooioAdapter.extractEvent(
      inboundPayload({ sender: null }),
    );
    expect(event).toBeNull();
  });

  test("skips group messages", async () => {
    const event = await blooioAdapter.extractEvent(
      inboundPayload({ is_group: true }),
    );
    expect(event).toBeNull();
  });

  test("skips non message.received events", async () => {
    const event = await blooioAdapter.extractEvent(
      inboundPayload({ event: "message.delivered" }),
    );
    expect(event).toBeNull();
  });

  test("skips events with neither text nor attachments", async () => {
    const event = await blooioAdapter.extractEvent(
      inboundPayload({ text: null, attachments: [] }),
    );
    expect(event).toBeNull();
  });

  test("returns null for unparseable payloads", async () => {
    expect(await blooioAdapter.extractEvent("not json")).toBeNull();
    expect(await blooioAdapter.extractEvent("{}")).toBeNull();
  });

  test("accepts media from allowed Blooio domains and synthesizes text", async () => {
    const event = await blooioAdapter.extractEvent(
      inboundPayload({
        text: null,
        attachments: [
          { url: "https://media.blooio.com/files/photo.jpg", name: "photo" },
        ],
      }),
    );
    expect(event?.mediaUrls).toEqual([
      "https://media.blooio.com/files/photo.jpg",
    ]);
    expect(event?.text).toContain("https://media.blooio.com/files/photo.jpg");
  });

  test("drops media URLs from foreign domains and plain http", async () => {
    const event = await blooioAdapter.extractEvent(
      inboundPayload({
        attachments: [
          { url: "https://evil.example/steal.jpg" },
          { url: "http://media.blooio.com/downgraded.jpg" },
        ],
      }),
    );
    expect(event?.mediaUrls).toBeUndefined();
    expect(event?.text).toBe("hey eliza");
  });

  test("skips events without a stable message_id even when identity fields exist", async () => {
    const payload = inboundPayload({
      message_id: null,
      internal_id: "+15550001111",
      external_id: "+15551234567",
    });

    expect(await blooioAdapter.extractEvent(payload)).toBeNull();
    expect(await blooioAdapter.extractEvent(payload)).toBeNull();
  });

  test("skips blank message and sender identifiers", async () => {
    expect(
      await blooioAdapter.extractEvent(inboundPayload({ message_id: "  " })),
    ).toBeNull();
    expect(
      await blooioAdapter.extractEvent(inboundPayload({ sender: "  " })),
    ).toBeNull();
  });
});

describe("blooio sendReply", () => {
  const chatEvent: ChatEvent = {
    platform: "blooio",
    messageId: "msg_abc123",
    chatId: "+15551234567",
    senderId: "+15551234567",
    text: "hey eliza",
    rawPayload: {},
  };

  test("POSTs to the chat with bearer auth, from-number, and an idempotency key", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ message_id: "out_1" }), {
        status: 200,
      });
    }) as typeof fetch;

    await blooioAdapter.sendReply(makeConfig(), chatEvent, "hello back");

    expect(captured).not.toBeNull();
    const { url, init } = captured as unknown as {
      url: string;
      init: RequestInit;
    };
    expect(url).toBe(
      "https://api.blooio.com/v2/api/chats/%2B15551234567/messages",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer bl_live_test");
    expect(headers["X-From-Number"]).toBe("+15550001111");
    expect(headers["Idempotency-Key"]).toBe("gw-reply-msg_abc123");
    expect(JSON.parse(String(init.body))).toEqual({ text: "hello back" });
  });

  test("omits X-From-Number when no fromNumber is configured", async () => {
    let headers: Record<string, string> = {};
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await blooioAdapter.sendReply(
      makeConfig({ fromNumber: undefined }),
      chatEvent,
      "hi",
    );
    expect(headers["X-From-Number"]).toBeUndefined();
  });

  test("throws when the API key is missing", async () => {
    await expect(
      blooioAdapter.sendReply(
        makeConfig({ apiKey: undefined }),
        chatEvent,
        "hi",
      ),
    ).rejects.toThrow("Missing apiKey");
  });

  test("throws with status and body on a non-ok response", async () => {
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429 })) as typeof fetch;

    await expect(
      blooioAdapter.sendReply(makeConfig(), chatEvent, "hi"),
    ).rejects.toThrow("Blooio send error (429): rate limited");
  });

  const v4ChatEvent: ChatEvent = {
    platform: "blooio",
    messageId: "msg_v4_abc123",
    chatId: "+15551234567",
    senderId: "+15551234567",
    text: "hey from v4",
    channelId: "ch_abc123",
    channelType: "blooio",
    rawPayload: {},
  };

  test("POSTs to the v4 channel-aware endpoint when channelId is present", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ message_id: "out_v4" }), {
        status: 200,
      });
    }) as typeof fetch;

    await blooioAdapter.sendReply(makeConfig(), v4ChatEvent, "reply via v4");

    expect(captured).not.toBeNull();
    const { url, init } = captured as unknown as {
      url: string;
      init: RequestInit;
    };
    expect(url).toBe(
      "https://api.blooio.com/v4/api/channels/ch_abc123/messages",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer bl_live_test");
    expect(headers["Idempotency-Key"]).toBe("gw-reply-msg_v4_abc123");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "reply via v4",
      channel_id: "ch_abc123",
      channel_type: "blooio",
    });
  });

  test("includes channel_id but omits channel_type from v4 body when absent", async () => {
    let captured: { init: RequestInit } | null = null;
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      captured = { init: init ?? {} };
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const eventWithoutType: ChatEvent = {
      ...v4ChatEvent,
      channelType: undefined,
    };
    await blooioAdapter.sendReply(makeConfig(), eventWithoutType, "hi");

    expect(captured).not.toBeNull();
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      text: "hi",
      channel_id: "ch_abc123",
    });
  });

  test("falls back to v2 chat endpoint when no channelId is present", async () => {
    let captured: { url: string } | null = null;
    globalThis.fetch = (async (url: string | URL | Request) => {
      captured = { url: String(url) };
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const v2Event: ChatEvent = {
      platform: "blooio",
      messageId: "msg_v2",
      chatId: "+15551234567",
      senderId: "+15551234567",
      text: "hey",
      rawPayload: {},
    };
    await blooioAdapter.sendReply(makeConfig(), v2Event, "legacy reply");

    expect(captured).not.toBeNull();
    expect(captured?.url).toBe(
      "https://api.blooio.com/v2/api/chats/%2B15551234567/messages",
    );
  });

  test("v4 sendReply throws with status and body on a non-ok response", async () => {
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as typeof fetch;

    await expect(
      blooioAdapter.sendReply(makeConfig(), v4ChatEvent, "hi"),
    ).rejects.toThrow("Blooio send error (403): forbidden");
  });
});
describe("blooio sendTypingIndicator", () => {
  const chatEvent: ChatEvent = {
    platform: "blooio",
    messageId: "msg_abc123",
    chatId: "+15551234567",
    senderId: "+15551234567",
    text: "hey eliza",
    rawPayload: {},
  };

  test("swallows network failures (non-critical UX)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    await expect(
      blooioAdapter.sendTypingIndicator(makeConfig(), chatEvent),
    ).resolves.toBeUndefined();
  });

  test("does nothing without an API key", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await blooioAdapter.sendTypingIndicator(
      makeConfig({ apiKey: "" }),
      chatEvent,
    );
    expect(called).toBe(false);
  });

  test("uses the v4 channel-aware read endpoint when channelId is present", async () => {
    let capturedUrl: string | null = null;
    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const v4Event: ChatEvent = {
      ...chatEvent,
      channelId: "ch_abc123",
      channelType: "blooio",
    };
    await blooioAdapter.sendTypingIndicator(makeConfig(), v4Event);

    expect(capturedUrl).toBe(
      "https://api.blooio.com/v4/api/channels/ch_abc123/read",
    );
  });

  test("uses the v2 chat read endpoint when no channelId is present", async () => {
    let capturedUrl: string | null = null;
    globalThis.fetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await blooioAdapter.sendTypingIndicator(makeConfig(), chatEvent);

    expect(capturedUrl).toBe(
      "https://api.blooio.com/v2/api/chats/%2B15551234567/read",
    );
  });
});
