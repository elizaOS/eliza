/**
 * Exercises Blooio adapter exports — media allowlisting, webhook parse
 * branches, signature checks, and v2/v4 outbound routing — against the real
 * module with a deterministic stubbed provider fetch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import {
  ALLOWED_MEDIA_DOMAINS,
  BLOOIO_REQUEST_TIMEOUT_MS,
  BlooioApiResponseError,
  BlooioConfigurationError,
  blooioAdapter,
  blooioFetch,
  isValidMediaUrl,
} from "./blooio";
import {
  type ChatEvent,
  PlatformDeliveryError,
  type WebhookConfig,
} from "./types";

const SECRET = "whsec_test_secret";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sign(rawBody: string, secret: string, ageSeconds = 0): string {
  const timestamp = Math.floor(Date.now() / 1000) - ageSeconds;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}

function signedRequest(header: string | null): Request {
  const headers = new Headers();
  if (header !== null) headers.set("x-blooio-signature", header);
  return new Request("https://gateway.example/webhook/eliza-app/blooio", {
    method: "POST",
    headers,
  });
}

function config(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    apiKey: "bl_live_test",
    blooioWebhookSecret: SECRET,
    fromNumber: "+15550001111",
    ...overrides,
  };
}

function chatEvent(overrides: Partial<ChatEvent> = {}): ChatEvent {
  return {
    platform: "blooio",
    messageId: "msg_abc123",
    chatId: "+15551234567",
    senderId: "+15551234567",
    text: "hey eliza",
    rawPayload: {},
    ...overrides,
  };
}

function v2Payload(overrides: Record<string, unknown> = {}): string {
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

function v4Payload(
  dataOverrides: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    id: "evt_abc123",
    type: "message.received",
    created_at: 1_786_244_262_331,
    ...envelopeOverrides,
    data: {
      id: "msg_v4_abc123",
      chat_id: "chat_abc123",
      channel_id: "ch_abc123",
      channel_type: "blooio",
      sender: "+15551234567",
      recipient: "+15550001111",
      text: "hey from v4",
      protocol: "imessage",
      is_group: false,
      attachments: [],
      ...dataOverrides,
    },
  });
}

function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch;
}

describe("blooio exported constants and helpers", () => {
  test("pins the owned hop timeout", () => {
    expect(BLOOIO_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  test("pins the runtime-local media domain allowlist", () => {
    expect([...ALLOWED_MEDIA_DOMAINS]).toEqual([
      "blooio.com",
      "backend.blooio.com",
      "api.blooio.com",
      "media.blooio.com",
    ]);
  });

  test("identifies the adapter platform", () => {
    expect(blooioAdapter.platform).toBe("blooio");
  });

  test("rejects a non-positive blooioFetch timeout before dispatch", async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });

    await expect(
      blooioFetch("https://api.blooio.com/v4/messages", undefined, 0),
    ).rejects.toThrow(/timer-safe positive integers/);
    expect(called).toBe(false);
  });

  test("returns the provider response for a successful blooioFetch hop", async () => {
    stubFetch(async (url, init) => {
      expect(url).toBe("https://api.blooio.com/v4/messages");
      expect(init.method).toBe("POST");
      return new Response("hop-ok", { status: 200 });
    });

    const response = await blooioFetch("https://api.blooio.com/v4/messages", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hop-ok");
  });
});

describe("isValidMediaUrl", () => {
  test("accepts https URLs on allowlisted hosts and their subdomains", () => {
    expect(isValidMediaUrl("https://blooio.com/a.gif")).toBe(true);
    expect(isValidMediaUrl("https://cdn.blooio.com/a.gif")).toBe(true);
    expect(isValidMediaUrl("https://backend.blooio.com/a.png")).toBe(true);
    expect(isValidMediaUrl("https://cdn.backend.blooio.com/a.png")).toBe(true);
    expect(isValidMediaUrl("https://api.blooio.com/v4/files/a.heic")).toBe(
      true,
    );
    expect(isValidMediaUrl("https://media.blooio.com/files/a.jpg")).toBe(true);
    expect(isValidMediaUrl("https://cdn.media.blooio.com/files/a.jpg")).toBe(
      true,
    );
  });

  test("lowercases the hostname before matching", () => {
    expect(isValidMediaUrl("https://MEDIA.BLOOIO.COM/files/a.jpg")).toBe(true);
  });

  test("rejects http, foreign hosts, suffix spoofs, and unparseable input", () => {
    expect(isValidMediaUrl("http://media.blooio.com/a.jpg")).toBe(false);
    expect(isValidMediaUrl("ftp://media.blooio.com/a.jpg")).toBe(false);
    expect(isValidMediaUrl("https://notblooio.com/a.jpg")).toBe(false);
    expect(isValidMediaUrl("https://evilblooio.com/a.jpg")).toBe(false);
    expect(isValidMediaUrl("https://blooio.com.evil.com/a.jpg")).toBe(false);
    expect(isValidMediaUrl("https://media.blooio.com.evil.com/a.jpg")).toBe(
      false,
    );
    expect(isValidMediaUrl("not a url")).toBe(false);
    expect(isValidMediaUrl("")).toBe(false);
  });
});

describe("BlooioApiResponseError", () => {
  test("marks 5xx provider rejections uncertain and not retryable", () => {
    const error = new BlooioApiResponseError(
      503,
      "Blooio rejected delivery (503)",
    );
    expect(error).toBeInstanceOf(PlatformDeliveryError);
    expect(error.name).toBe("BlooioApiResponseError");
    expect(error).toMatchObject({
      status: 503,
      deliveryStatus: "uncertain",
      code: "DELIVERY_PROVIDER_REJECTED",
      retryable: false,
      providerStatus: 503,
    });
  });

  test("marks a 429 retryable and other 4xx as failed", () => {
    expect(new BlooioApiResponseError(429, "limited")).toMatchObject({
      deliveryStatus: "failed",
      retryable: true,
      providerStatus: 429,
    });
    expect(new BlooioApiResponseError(400, "bad")).toMatchObject({
      deliveryStatus: "failed",
      retryable: false,
      providerStatus: 400,
    });
  });
});

describe("BlooioConfigurationError", () => {
  test("records the missing account sender for a legacy group chat", () => {
    const error = new BlooioConfigurationError("grp_legacy_123");
    expect(error).toBeInstanceOf(PlatformDeliveryError);
    expect(error.name).toBe("BlooioConfigurationError");
    expect(error.message).toBe(
      "Missing fromNumber for Blooio legacy group reply",
    );
    expect(error).toMatchObject({
      deliveryStatus: "failed",
      code: "BLOOIO_LEGACY_GROUP_FROM_NUMBER_MISSING",
      retryable: false,
      context: {
        setting: "fromNumber",
        chatId: "grp_legacy_123",
      },
    });
  });
});

describe("blooioAdapter.verifyWebhook", () => {
  test("accepts a header that still contains t= and v1= among extra parts", async () => {
    const body = v2Payload();
    const [timestampPart, signaturePart] = sign(body, SECRET).split(",");
    const ok = await blooioAdapter.verifyWebhook(
      signedRequest(`${timestampPart},extra=1,${signaturePart}`),
      body,
      config(),
    );
    expect(ok).toBe(true);
  });

  test("rejects a header whose v1= part is padded with a leading space", async () => {
    const body = v2Payload();
    const [timestampPart, signaturePart] = sign(body, SECRET).split(",");
    const ok = await blooioAdapter.verifyWebhook(
      signedRequest(`${timestampPart}, ${signaturePart}`),
      body,
      config(),
    );
    expect(ok).toBe(false);
  });

  test("rejects a correctly timestamped signature of the wrong length", async () => {
    const body = v2Payload();
    const header = sign(body, SECRET);
    const ok = await blooioAdapter.verifyWebhook(
      signedRequest(`${header}00`),
      body,
      config(),
    );
    expect(ok).toBe(false);
  });

  test("rejects when the configured webhook secret is an empty string", async () => {
    const body = v2Payload();
    const ok = await blooioAdapter.verifyWebhook(
      signedRequest(sign(body, SECRET)),
      body,
      config({ blooioWebhookSecret: "" }),
    );
    expect(ok).toBe(false);
  });
});

describe("blooioAdapter.extractEvent", () => {
  test("infers a legacy group from a grp_ chat id when is_group is omitted", async () => {
    const event = await blooioAdapter.extractEvent(
      v2Payload({
        chat_id: "GRP_legacy_123",
        is_group: undefined,
        external_id: "+15551234567",
        internal_id: "+15550001111",
        sender: undefined,
      }),
    );
    expect(event).toMatchObject({
      chatId: "GRP_legacy_123",
      chatType: "group",
      senderId: "+15551234567",
      channelId: "+15550001111",
    });
  });

  test("uses a v4 message id when message_id is absent", async () => {
    const event = await blooioAdapter.extractEvent(
      v4Payload({ message_id: undefined, id: "msg_from_id" }),
    );
    expect(event?.messageId).toBe("msg_from_id");
  });

  test("infers a v4 group from a present group object when is_group is omitted", async () => {
    const event = await blooioAdapter.extractEvent(
      v4Payload({ is_group: undefined, group: { group_id: "grp_1" } }),
    );
    expect(event?.chatType).toBe("group");
  });

  test("prefers received_at over timestamp and converts epoch seconds", async () => {
    const event = await blooioAdapter.extractEvent(
      v2Payload({ received_at: 1_786_244_262, timestamp: 99 }),
    );
    expect(event?.providerSentAtMs).toBe(1_786_244_262_000);
  });

  test("omits providerSentAtMs for non-positive timestamps", async () => {
    expect(
      (await blooioAdapter.extractEvent(v2Payload({ timestamp: 0 })))
        ?.providerSentAtMs,
    ).toBeUndefined();
    expect(
      (await blooioAdapter.extractEvent(v2Payload({ timestamp: -5 })))
        ?.providerSentAtMs,
    ).toBeUndefined();
  });

  test("omits providerSentAtMs when the converted instant is not a safe integer", async () => {
    const event = await blooioAdapter.extractEvent(
      v2Payload({ timestamp: 9_100_000_000_000_000 }),
    );
    expect(event?.providerSentAtMs).toBeUndefined();
  });

  test("treats an exact 1e11 timestamp as milliseconds, not seconds", async () => {
    const event = await blooioAdapter.extractEvent(
      v2Payload({ timestamp: 100_000_000_000 }),
    );
    expect(event?.providerSentAtMs).toBe(100_000_000_000);
  });

  test("accepts raw string attachments and keeps existing text", async () => {
    const event = await blooioAdapter.extractEvent(
      v2Payload({
        attachments: [
          "https://media.blooio.com/files/photo.jpg",
          "https://evil.example/steal.jpg",
        ],
      }),
    );
    expect(event?.text).toBe("hey eliza");
    expect(event?.mediaUrls).toEqual([
      "https://media.blooio.com/files/photo.jpg",
    ]);
  });

  test("synthesizes text from allowlisted media when the body is empty", async () => {
    const event = await blooioAdapter.extractEvent(
      v2Payload({
        text: "",
        attachments: [
          { url: "https://media.blooio.com/a.jpg", name: "a" },
          { url: "https://api.blooio.com/b.png", name: "b" },
        ],
      }),
    );
    expect(event?.text).toBe(
      "[media: https://media.blooio.com/a.jpg, https://api.blooio.com/b.png]",
    );
    expect(event?.mediaUrls).toEqual([
      "https://media.blooio.com/a.jpg",
      "https://api.blooio.com/b.png",
    ]);
  });

  test("still emits an event when attachments exist but every URL is rejected", async () => {
    const event = await blooioAdapter.extractEvent(
      v2Payload({
        text: "",
        attachments: [{ url: "https://evil.example/steal.jpg" }],
      }),
    );
    expect(event).toMatchObject({
      messageId: "msg_abc123",
      senderId: "+15551234567",
      text: "",
    });
    expect(event?.mediaUrls).toBeUndefined();
  });

  test("skips a delivery whose only sender candidate is whitespace", async () => {
    const event = await blooioAdapter.extractEvent(
      v2Payload({ sender: undefined, external_id: "   " }),
    );
    expect(event).toBeNull();
  });

  test("skips a v4 envelope that is not message.received", async () => {
    const event = await blooioAdapter.extractEvent(
      v4Payload({}, { type: "message.delivered" }),
    );
    expect(event).toBeNull();
  });
});

describe("blooioAdapter.sendReply", () => {
  test("POSTs a case-insensitive chat_ id to the encoded v4 chat resource", async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    stubFetch(async (url, init) => {
      captured.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ id: "out_1" });
    });

    await blooioAdapter.sendReply(
      config(),
      chatEvent({ chatId: "CHAT_a/b" }),
      "hello",
    );

    expect(captured).toEqual([
      {
        url: "https://api.blooio.com/v4/chats/CHAT_a%2Fb/messages",
        body: { text: "hello" },
      },
    ]);
  });

  test("encodes a legacy grp_ chat id on the v2 messages path", async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    stubFetch(async (url, init) => {
      captured.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ message_id: "out_legacy" });
    });

    await blooioAdapter.sendReply(
      config(),
      chatEvent({ chatId: "grp_a/b", chatType: "group" }),
      "hello group",
    );

    expect(captured).toEqual([
      {
        url: "https://api.blooio.com/v2/api/chats/grp_a%2Fb/messages",
        body: { text: "hello group", from_number: "+15550001111" },
      },
    ]);
  });

  test("prefers the provider id field and trims the receipt", async () => {
    stubFetch(async () =>
      Response.json({ id: "  out_id  ", message_id: "out_message" }),
    );

    await expect(
      blooioAdapter.sendReplyWithReceipt?.(
        config(),
        chatEvent(),
        "remember this",
      ),
    ).resolves.toEqual({ providerMessageIds: ["out_id"] });
  });

  test("uses message_id when id is not a string", async () => {
    stubFetch(async () => Response.json({ id: 17, message_id: "out_msg" }));

    await expect(
      blooioAdapter.sendReplyWithReceipt?.(config(), chatEvent(), "hi"),
    ).resolves.toEqual({ providerMessageIds: ["out_msg"] });
  });

  test("keeps a 5xx rejection uncertain", async () => {
    stubFetch(async () => new Response("upstream", { status: 503 }));

    await expect(
      blooioAdapter.sendReply(config(), chatEvent(), "hi"),
    ).rejects.toMatchObject({
      name: "BlooioApiResponseError",
      deliveryStatus: "uncertain",
      code: "DELIVERY_PROVIDER_REJECTED",
      retryable: false,
      providerStatus: 503,
    });
  });

  test("rejects whitespace-only and non-object receipts as uncertain", async () => {
    for (const body of ["   ", "[]", "42", "not-json"]) {
      stubFetch(async () => new Response(body, { status: 200 }));
      await expect(
        blooioAdapter.sendReplyWithReceipt?.(config(), chatEvent(), "hi"),
      ).rejects.toMatchObject({
        deliveryStatus: "uncertain",
        code: "DELIVERY_RECEIPT_INVALID",
        retryable: false,
      });
    }
  });
});

describe("blooioAdapter typing indicators", () => {
  test("posts a v2 read receipt with X-From-Number and encoded chat id", async () => {
    const captured: Array<{
      url: string;
      method: string;
      headers: Headers;
    }> = [];
    stubFetch(async (url, init) => {
      captured.push({
        url,
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
      });
      return new Response(null, { status: 200 });
    });

    await blooioAdapter.sendTypingIndicator(
      config(),
      chatEvent({ chatId: "+15551234567" }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(
      "https://api.blooio.com/v2/api/chats/%2B15551234567/read",
    );
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.headers.get("Authorization")).toBe(
      "Bearer bl_live_test",
    );
    expect(captured[0]?.headers.get("X-From-Number")).toBe("+15550001111");
  });

  test("omits X-From-Number on the v2 read path when fromNumber is missing", async () => {
    const capturedHeaders: Headers[] = [];
    stubFetch(async (_url, init) => {
      capturedHeaders.push(new Headers(init.headers));
      return new Response(null, { status: 200 });
    });

    await blooioAdapter.sendTypingIndicator(
      config({ fromNumber: undefined }),
      chatEvent({ chatId: "grp_legacy_123" }),
    );

    expect(capturedHeaders).toHaveLength(1);
    expect(capturedHeaders[0]?.has("X-From-Number")).toBe(false);
  });

  test("swallows a rejected v2 read receipt", async () => {
    stubFetch(async () => new Response("nope", { status: 500 }));

    await expect(
      blooioAdapter.sendTypingIndicator(config(), chatEvent()),
    ).resolves.toBeUndefined();
  });

  test("swallows a rejected v4 typing hop when the paired read succeeded", async () => {
    stubFetch(async (url) => {
      if (url.endsWith("/read")) return new Response(null, { status: 200 });
      return new Response("busy", { status: 429 });
    });

    await expect(
      blooioAdapter.sendTypingIndicator(
        config(),
        chatEvent({ chatId: "chat_group_123" }),
      ),
    ).resolves.toBeUndefined();
  });

  test("does not stop typing without an api key or a v4 chat id", async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return new Response(null, { status: 200 });
    });

    await blooioAdapter.stopTypingIndicator?.(
      config({ apiKey: undefined }),
      chatEvent({ chatId: "chat_abc123" }),
    );
    await blooioAdapter.stopTypingIndicator?.(
      config(),
      chatEvent({ chatId: "grp_legacy_123" }),
    );
    expect(called).toBe(false);
  });

  test("swallows a rejected stop-typing request", async () => {
    stubFetch(async () => new Response("nope", { status: 500 }));

    await expect(
      blooioAdapter.stopTypingIndicator?.(
        config(),
        chatEvent({ chatId: "chat_abc123" }),
      ),
    ).resolves.toBeUndefined();
  });
});
