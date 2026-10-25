/** Public gateway regression; actual handler with deterministic external boundaries. */
import { afterEach, expect, mock, test } from "bun:test";
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
