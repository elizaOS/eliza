/** Public gateway regression; actual handler with deterministic external boundaries. */
import { afterEach, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { blooioAdapter } from "../src/adapters/blooio";
import type { ChatEvent, PlatformAdapter } from "../src/adapters/types";
import type { GatewayRedis } from "../src/redis";
import { handleWebhook } from "../src/webhook-handler";

const originalFetch = globalThis.fetch;
const originalNumber = process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalNumber === undefined)
    delete process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER;
  else process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = originalNumber;
});
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(label);
}
class MemoryRedis implements GatewayRedis {
  async eval(): Promise<unknown> {
    throw new Error("Cutover persistence is not part of this fixture");
  }
  readonly values = new Map<string, string>();
  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.values.get(key) ?? null) as T | null;
  }
  async set(
    key: string,
    value: string,
    options: { nx?: boolean } = {},
  ): Promise<unknown> {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }
  async del(key: string): Promise<unknown> {
    return this.values.delete(key) ? 1 : 0;
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
  async delIfEquals(key: string, value: string): Promise<boolean> {
    if (this.values.get(key) !== value) return false;
    return this.values.delete(key);
  }
  async expireIfEquals(key: string, value: string): Promise<boolean> {
    return this.values.get(key) === value;
  }
  async zadd(): Promise<unknown> {
    return 1;
  }
  async zrangebyscore(): Promise<string[]> {
    return [];
  }
  async zrem(): Promise<unknown> {
    return 1;
  }
}

test("Blooio reply does not await typing start and cleanup follows a delayed start", async () => {
  process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15550000001";
  const redis = new MemoryRedis();
  const event: ChatEvent = {
    platform: "blooio",
    messageId: "blooio-typing-order",
    chatId: "chat_typing_order",
    channelType: "blooio",
    protocol: "imessage",
    senderId: "+15551234567",
    senderName: "Ada",
    text: "hello",
    rawPayload: {},
  };
  const order: string[] = [];
  let releaseStart: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const adapter: PlatformAdapter = {
    platform: "blooio",
    verifyWebhook: mock(async () => true),
    extractEvent: mock(async () => event),
    sendTypingIndicator: mock(async () => {
      await started;
      order.push("started");
    }),
    stopTypingIndicator: mock(async () => {
      order.push("stopped");
    }),
    sendReply: mock(async () => {
      order.push("reply");
    }),
    sendReplyWithReceipt: mock(async () => {
      order.push("reply");
      return { providerMessageIds: ["typing-order-reply"] };
    }),
  };
  globalThis.fetch = mock(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/api/internal/identity/resolve"))
      return Response.json({ success: false }, { status: 404 });
    if (
      request.url.endsWith("/api/internal/eliza-app/personal-shared/messages")
    )
      return Response.json({ data: { reply: "hello" } });
    throw new Error(`Unexpected fetch: ${request.url}`);
  }) as typeof fetch;
  try {
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
    await waitFor(
      () => order.includes("reply"),
      "reply before typing start settles",
    );
    expect(order).not.toContain("started");
    expect(order).not.toContain("stopped");
    releaseStart?.();
    await waitFor(
      () => order.includes("stopped"),
      "typing cleanup after delayed start",
    );
    expect(order.slice(-2)).toEqual(["started", "stopped"]);
    expect(adapter.stopTypingIndicator).toHaveBeenCalledTimes(1);
  } finally {
    releaseStart?.();
  }
});

async function privateBlooioOutcome(
  data: Record<string, unknown>,
  options: { networkConsentAfterCloud?: "opted_out" | "unavailable" } = {},
) {
  const project = options.networkConsentAfterCloud ? "network" : "eliza-app";
  const savedNetworkNumber = process.env.NETWORK_BLOOIO_PHONE_NUMBER;
  const savedTakeover = process.env.NETWORK_TAKEOVER;
  if (options.networkConsentAfterCloud) {
    process.env.NETWORK_BLOOIO_PHONE_NUMBER = "+15550000001";
    process.env.NETWORK_TAKEOVER = "0";
  }
  let cloudCompleted = false;
  process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15550000001";
  const redis = new MemoryRedis();
  const event: ChatEvent = {
    platform: "blooio",
    messageId: "msg_private_outcome",
    chatId: "chat_private_outcome",
    chatType: "private",
    channelType: "blooio",
    protocol: "imessage",
    senderId: "+15551234567",
    text: "Thanks",
    rawPayload: {},
  };
  const order: string[] = [];
  const adapter: PlatformAdapter = {
    platform: "blooio",
    verifyWebhook: mock(async () => true),
    extractEvent: mock(async () => event),
    sendReadReceipt: mock(async () => {
      order.push("read");
    }),
    sendTypingIndicator: mock(async (_config, _event, feedback) => {
      expect(feedback).toEqual({ markRead: false });
      order.push("typing");
    }),
    stopTypingIndicator: mock(async () => {
      order.push("stopped");
    }),
    sendAcknowledgementReaction: mock(async (_config, target, reaction) => {
      expect(target).toBe(event);
      order.push(`reaction:${reaction}`);
    }),
    sendReply: mock(async () => {
      throw new Error("receipt-less reply must not run");
    }),
    sendReplyWithReceipt: mock(async (_config, _event, text, _hooks, media) => {
      order.push(media?.length ? `media:${media.length}` : `reply:${text}`);
      return { providerMessageIds: ["provider-private-outcome"] };
    }),
  };
  globalThis.fetch = mock(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/api/internal/identity/resolve"))
      return Response.json({ success: false }, { status: 404 });
    if (
      request.url.endsWith("/api/internal/eliza-app/personal-shared/messages")
    ) {
      order.push("cloud");
      cloudCompleted = true;
      return Response.json({ success: true, data });
    }
    throw new Error(`Unexpected fetch: ${request.url}`);
  }) as typeof fetch;
  try {
    const response = await handleWebhook(
      new Request(`https://gateway.example/webhook/${project}/blooio`, {
        method: "POST",
        body: "{}",
      }),
      adapter,
      {
        redis,
        cloudBaseUrl: "https://api.elizacloud.ai",
        getAuthHeader: () => ({ Authorization: "Bearer internal-test" }),
        networkService: null,
        ...(options.networkConsentAfterCloud
          ? {
              networkConsentLedger: {
                current: async (_project: string, address: string) => {
                  if (!cloudCompleted) return null;
                  if (options.networkConsentAfterCloud === "unavailable")
                    throw new Error("consent state unavailable");
                  return {
                    project,
                    address,
                    channel: "blooio" as const,
                    state: "opted_out" as const,
                    source: "keyword:STOP",
                    at: new Date().toISOString(),
                  };
                },
                record: async () => {
                  throw new Error("This fixture must not change consent");
                },
              },
            }
          : {}),
      },
      project,
    );
    expect(response.status).toBe(200);
    await waitFor(
      () => [...redis.values.values()].includes("delivered"),
      "private terminal outcome persisted",
    );
    return { order, adapter };
  } finally {
    if (savedNetworkNumber === undefined)
      delete process.env.NETWORK_BLOOIO_PHONE_NUMBER;
    else process.env.NETWORK_BLOOIO_PHONE_NUMBER = savedNetworkNumber;
    if (savedTakeover === undefined) delete process.env.NETWORK_TAKEOVER;
    else process.env.NETWORK_TAKEOVER = savedTakeover;
  }
}

test("private IGNORE records read feedback without typing or another text", async () => {
  const { order } = await privateBlooioOutcome({ reply: "", responded: false });
  expect(order).toEqual(["read", "cloud"]);
});

for (const reaction of ["like", "👩🏽‍💻"]) {
  test(`private ignored turn carries the selected ${reaction} without typing or text`, async () => {
    const { order, adapter } = await privateBlooioOutcome({
      reply: "",
      responded: false,
      acknowledgementReaction: reaction,
    });
    expect(order).toEqual(["read", "cloud", `reaction:${reaction}`]);
    expect(adapter.sendReplyWithReceipt).not.toHaveBeenCalled();
  });
}

test("invalid reaction operations and absent deliberate-silence status remain no-response", async () => {
  for (const data of [
    { reply: "", responded: false, acknowledgementReaction: "+like" },
    { reply: "", responded: false, acknowledgementReaction: "😀😀" },
    { reply: "", acknowledgementReaction: "like" },
  ]) {
    const { order, adapter } = await privateBlooioOutcome(data);
    expect(order).toEqual(["read", "cloud"]);
    expect(adapter.sendAcknowledgementReaction).not.toHaveBeenCalled();
  }
});

test("a private text reply starts typing only when the reply is ready", async () => {
  const { order } = await privateBlooioOutcome({
    reply: "Hello",
    responded: true,
    acknowledgementReaction: "like",
  });
  await waitFor(
    () => order.includes("stopped"),
    "typing stopped after ready reply",
  );
  expect(order).toEqual(["read", "cloud", "typing", "reply:Hello", "stopped"]);
});

test("a modern media-only private reply remains deliverable and does not become a reaction", async () => {
  const { order, adapter } = await privateBlooioOutcome({
    reply: "",
    responded: true,
    acknowledgementReaction: "like",
    mediaUrls: ["https://images.example.test/photo.png"],
  });
  await waitFor(
    () => order.includes("stopped"),
    "typing stopped after media reply",
  );
  expect(order).toEqual(["read", "cloud", "typing", "media:1", "stopped"]);
  expect(adapter.sendAcknowledgementReaction).not.toHaveBeenCalled();
});

for (const fixture of [
  { reaction: "like", wrongReceipt: false },
  { reaction: "👩🏽‍💻", wrongReceipt: false },
  { reaction: "like", wrongReceipt: true },
]) {
  test(`signed Blooio ingress keeps ${fixture.reaction} acknowledgement on the verified current message, wrongReceipt=${fixture.wrongReceipt}`, async () => {
    const keys = [
      "ELIZA_APP_BLOOIO_API_KEY",
      "ELIZA_APP_BLOOIO_WEBHOOK_SECRET",
      "ELIZA_APP_WEBHOOK_PROJECT",
    ] as const;
    const saved = keys.map((key) => [key, process.env[key]] as const);
    const secret = "current-message-signature-test";
    process.env.ELIZA_APP_BLOOIO_API_KEY = "blooio-current-message-test";
    process.env.ELIZA_APP_BLOOIO_WEBHOOK_SECRET = secret;
    process.env.ELIZA_APP_WEBHOOK_PROJECT = "eliza-app";
    process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER = "+15550000001";
    const redis = new MemoryRedis();
    const providerCalls: Array<{
      url: string;
      body: unknown;
      key: string | null;
    }> = [];
    const cloudTurns: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/api/internal/identity/resolve"))
        return Response.json({ success: false }, { status: 404 });
      if (
        request.url.endsWith("/api/internal/eliza-app/personal-shared/messages")
      ) {
        cloudTurns.push((await request.json()) as Record<string, unknown>);
        return Response.json({
          success: true,
          data: {
            reply: "",
            responded: false,
            acknowledgementReaction: fixture.reaction,
          },
        });
      }
      if (request.url.startsWith("https://api.blooio.com/")) {
        const body = await request.text();
        providerCalls.push({
          url: request.url,
          body: body ? JSON.parse(body) : null,
          key: request.headers.get("Idempotency-Key"),
        });
        if (request.url.endsWith("/reactions"))
          return Response.json({
            data: {
              message_id: fixture.wrongReceipt
                ? "msg_different"
                : "msg_signed_current",
              reaction: `+${fixture.reaction}`,
            },
          });
        if (request.url.endsWith("/read")) return Response.json({});
      }
      throw new Error(`Unexpected source verification request: ${request.url}`);
    }) as typeof fetch;
    const body = JSON.stringify({
      id: "evt_signed_current",
      type: "message.received",
      created_at: Date.now(),
      data: {
        message_id: "msg_signed_current",
        chat_id: "chat_signed_current",
        sender: "+15551234567",
        recipient: "+15550000001",
        channel_type: "blooio",
        text: "Thanks",
        protocol: "imessage",
      },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    try {
      const response = await handleWebhook(
        new Request("https://gateway.example/webhook/eliza-app/blooio", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-blooio-signature": `t=${timestamp},v1=${signature}`,
          },
          body,
        }),
        blooioAdapter,
        {
          redis,
          cloudBaseUrl: "https://api.elizacloud.ai",
          getAuthHeader: () => ({ Authorization: "Bearer internal-test" }),
        },
        "eliza-app",
      );
      expect(response.status).toBe(200);
      await waitFor(
        () => [...redis.values.values()].includes("delivered"),
        "signed acknowledgement terminal marker",
      );
      expect(cloudTurns).toHaveLength(1);
      expect(cloudTurns[0].messageId).toBe(
        "blooio:eliza-app:msg_signed_current",
      );
      expect(providerCalls.map((call) => call.url)).toEqual([
        "https://api.blooio.com/v4/chats/chat_signed_current/read",
        "https://api.blooio.com/v4/chats/chat_signed_current/messages/msg_signed_current/reactions",
      ]);
      expect(providerCalls[1].body).toEqual({
        reaction: `+${fixture.reaction}`,
      });
      expect(providerCalls[1].key).toBe("gw-ack-msg_signed_current");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

for (const state of ["opted_out", "unavailable"] as const) {
  test(`Network consent ${state} after inference suppresses optional acknowledgement`, async () => {
    const { order, adapter } = await privateBlooioOutcome(
      { reply: "", responded: false, acknowledgementReaction: "like" },
      { networkConsentAfterCloud: state },
    );
    expect(order).toEqual(["read", "cloud"]);
    expect(adapter.sendAcknowledgementReaction).not.toHaveBeenCalled();
    expect(adapter.sendReplyWithReceipt).not.toHaveBeenCalled();
  });
}
