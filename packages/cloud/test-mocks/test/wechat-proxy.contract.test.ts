/** Proves the production WeChat client and webhook gate against a resettable real-HTTP proxy simulator. */

import { afterEach, describe, expect, test } from "bun:test";
import { Bot, ProxyClient } from "@elizaos/plugin-wechat";
import { startCallbackServer } from "@elizaos/plugin-wechat/callback-server";
import { startWechatProxyMock } from "../src/wechat";

const API_KEY = "wechat-contract-key";
const ACCOUNT_ID = "main";
const seed = {
  accounts: [
    {
      accountId: ACCOUNT_ID,
      apiKey: API_KEY,
      wcId: "wxid_bot",
      nickName: "Synthetic Bot",
      friends: [{ wxid: "wxid_alice", name: "Alice" }],
      chatrooms: [{ wxid: "team@chatroom", name: "Synthetic Team" }],
    },
  ],
};

const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

function client(
  url: string,
  options: ConstructorParameters<typeof ProxyClient>[1] = {},
): ProxyClient {
  return new ProxyClient(
    {
      id: ACCOUNT_ID,
      apiKey: API_KEY,
      proxyUrl: url,
      deviceType: "ipad",
      webhookPort: 0,
    },
    { requestTimeoutMs: 100, retryBaseDelayMs: 1, ...options },
  );
}

function inboundPayload(messageId = "wechat-msg-1") {
  return {
    data: {
      type: 60001,
      sender: "wxid_alice",
      recipient: "wxid_bot",
      content: "hello from the synthetic world",
      timestamp: 1_710_969_600_000,
      msgId: messageId,
    },
  };
}

describe("WeChat proxy production boundary", () => {
  test("authenticates, reads contacts, sends, delivers inbound, deduplicates, and resets", async () => {
    const proxy = await startWechatProxyMock(seed);
    stops.push(proxy.stop);
    const delivered: string[] = [];
    const bot = new Bot({
      onMessage: (message) => {
        delivered.push(message.id);
      },
    });
    const callback = await startCallbackServer({
      port: 0,
      accounts: [{ accountId: ACCOUNT_ID, apiKey: API_KEY }],
      onMessage: (_accountId, message) => bot.handleIncoming(message),
    });
    stops.push(async () => {
      bot.stop();
      await callback.close();
    });

    const productionClient = client(proxy.url);
    expect(await productionClient.getStatus()).toEqual(
      expect.objectContaining({ loginState: "logged_in", wcId: "wxid_bot" }),
    );
    expect(await productionClient.getContacts()).toEqual({
      friends: [{ wxid: "wxid_alice", name: "Alice" }],
      chatrooms: [{ wxid: "team@chatroom", name: "Synthetic Team" }],
    });
    await productionClient.registerWebhook(
      `http://127.0.0.1:${callback.port}/webhook/wechat/${ACCOUNT_ID}`,
    );
    await productionClient.sendText("wxid_alice", "outbound text");
    await productionClient.sendImage(
      "wxid_alice",
      "/synthetic/image.png",
      "caption",
    );

    const unauthorized = await proxy.deliverWebhook(
      ACCOUNT_ID,
      inboundPayload(),
      {
        apiKey: "wrong-key",
      },
    );
    expect(unauthorized.status).toBe(401);
    const unsupportedMedia = await fetch(
      `http://127.0.0.1:${callback.port}/webhook/wechat/${ACCOUNT_ID}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/xml",
          "x-api-key": API_KEY,
        },
        body: "<xml/>",
      },
    );
    expect(unsupportedMedia.status).toBe(415);
    const [first, duplicate] = await Promise.all([
      proxy.deliverWebhook(ACCOUNT_ID, inboundPayload()),
      proxy.deliverWebhook(ACCOUNT_ID, inboundPayload()),
    ]);
    expect([first.status, duplicate.status]).toEqual([200, 200]);
    expect(delivered).toEqual(["wechat-msg-1"]);

    const snapshot = proxy.snapshot();
    expect(snapshot.webhooks).toEqual({
      main: `http://127.0.0.1:${callback.port}/webhook/wechat/main`,
    });
    expect(snapshot.outboundMessages).toEqual([
      expect.objectContaining({
        kind: "text",
        to: "wxid_alice",
        text: "outbound text",
      }),
      expect.objectContaining({
        kind: "image",
        to: "wxid_alice",
        imagePath: "/synthetic/image.png",
        text: "caption",
      }),
    ]);
    expect(snapshot.requests.every((request) => request.authenticated)).toBe(
      true,
    );

    proxy.reset();
    expect(proxy.snapshot()).toEqual({
      generation: 1,
      requests: [],
      outboundMessages: [],
      webhooks: {},
    });
  });

  test("rejects bad client authentication without applying an effect", async () => {
    const proxy = await startWechatProxyMock(seed);
    stops.push(proxy.stop);
    const wrongClient = new ProxyClient(
      {
        id: ACCOUNT_ID,
        apiKey: "wrong-key",
        proxyUrl: proxy.url,
        deviceType: "ipad",
        webhookPort: 0,
      },
      { requestTimeoutMs: 100, retryBaseDelayMs: 1 },
    );

    await expect(
      wrongClient.sendText("wxid_alice", "must not send"),
    ).rejects.toThrow("HTTP 401");
    expect(proxy.snapshot().outboundMessages).toEqual([]);
    expect(proxy.snapshot().requests).toEqual([
      expect.objectContaining({ authenticated: false, path: "/api/send-text" }),
    ]);
  });

  test("rejects non-JSON and oversized chunked requests before applying effects", async () => {
    const proxy = await startWechatProxyMock(seed);
    stops.push(proxy.stop);
    const headers = {
      "x-api-key": API_KEY,
      "x-account-id": ACCOUNT_ID,
      "x-device-type": "ipad",
    };

    const wrongMediaType = await fetch(`${proxy.url}/api/send-text`, {
      method: "POST",
      headers: { ...headers, "content-type": "text/plain" },
      body: JSON.stringify({ to: "wxid_alice", text: "must not send" }),
    });
    expect(wrongMediaType.status).toBe(415);
    const encoded = await fetch(`${proxy.url}/api/send-text`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: "not-a-bounded-supported-gzip-stream",
    });
    expect(encoded.status).toBe(415);

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(64 * 1024).fill(97);
        for (let index = 0; index < 17; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const tooLarge = await fetch(`${proxy.url}/api/send-text`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json; charset=utf-8",
      },
      body: oversized,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(tooLarge.status).toBe(413);
    expect(proxy.snapshot().outboundMessages).toEqual([]);
  });

  test("honors rate limits and retries through the real client", async () => {
    const proxy = await startWechatProxyMock(seed);
    stops.push(proxy.stop);
    proxy.enqueueFault("/api/send-text", {
      status: 429,
      retryAfter: "0",
      body: { code: 1429, message: "rate limited" },
    });

    await client(proxy.url).sendText("wxid_alice", "retry me");
    expect(
      proxy
        .snapshot()
        .requests.filter((request) => request.path === "/api/send-text"),
    ).toHaveLength(2);
    expect(proxy.snapshot().outboundMessages).toHaveLength(1);
  });

  test("never trusts forged success JSON or retries an ambiguous send", async () => {
    const proxy = await startWechatProxyMock(seed);
    stops.push(proxy.stop);
    proxy.enqueueFault("/api/send-text", {
      status: 500,
      body: { code: 1000, message: "forged success" },
    });

    await expect(
      client(proxy.url).sendText("wxid_alice", "must not send"),
    ).rejects.toThrow("HTTP 500");
    expect(proxy.snapshot().requests).toHaveLength(1);
    expect(proxy.snapshot().outboundMessages).toEqual([]);
  });

  test("retries transient server errors boundedly for an idempotent read", async () => {
    const proxy = await startWechatProxyMock(seed);
    stops.push(proxy.stop);
    proxy.enqueueFault("/api/status", {
      status: 503,
      body: { code: 1503, message: "temporarily unavailable" },
    });

    await client(proxy.url).getStatus();
    expect(
      proxy
        .snapshot()
        .requests.filter((request) => request.path === "/api/status"),
    ).toHaveLength(2);
    expect(proxy.snapshot().outboundMessages).toEqual([]);
  });

  test("fences a delayed request when reset changes the simulator generation", async () => {
    const proxy = await startWechatProxyMock(seed);
    stops.push(proxy.stop);
    proxy.enqueueFault("/api/status", {
      status: 200,
      delayMs: 30,
      body: { code: 1000, data: { valid: true, loginState: "logged_in" } },
    });
    const pending = fetch(`${proxy.url}/api/status`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "x-account-id": ACCOUNT_ID,
        "x-device-type": "ipad",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    proxy.reset();

    expect((await pending).status).toBe(409);
    expect(proxy.snapshot()).toEqual({
      generation: 1,
      requests: [],
      outboundMessages: [],
      webhooks: {},
    });
  });

  test("bounds malformed responses and timed-out requests to three attempts", async () => {
    const proxy = await startWechatProxyMock(seed);
    stops.push(proxy.stop);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      proxy.enqueueFault("/api/status", { status: 200, rawBody: "not-json" });
    }
    await expect(client(proxy.url).getStatus()).rejects.toThrow();
    expect(proxy.snapshot().requests).toHaveLength(3);

    proxy.reset();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      proxy.enqueueFault("/api/status", {
        status: 200,
        delayMs: 80,
        body: { code: 1000, data: { valid: true, loginState: "logged_in" } },
      });
    }
    await expect(
      client(proxy.url, { requestTimeoutMs: 10 }).getStatus(),
    ).rejects.toThrow();
    expect(proxy.snapshot().requests).toHaveLength(3);
  });

  test("rejects an oversized successful proxy response boundedly", async () => {
    const proxy = await startWechatProxyMock(seed);
    stops.push(proxy.stop);
    const oversized = JSON.stringify({
      code: 1000,
      data: { padding: "x".repeat(1024 * 1024) },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      proxy.enqueueFault("/api/status", { status: 200, rawBody: oversized });
    }

    await expect(client(proxy.url).getStatus()).rejects.toThrow(
      "response body exceeds 1048576 bytes",
    );
    expect(proxy.snapshot().requests).toHaveLength(3);
  });

  test("external cancellation interrupts rate-limit backoff before a retry", async () => {
    const proxy = await startWechatProxyMock(seed);
    stops.push(proxy.stop);
    proxy.enqueueFault("/api/send-text", {
      status: 429,
      body: { code: 1429, message: "rate limited" },
    });
    const controller = new AbortController();
    const pending = client(proxy.url, {
      requestTimeoutMs: 1_000,
      retryBaseDelayMs: 500,
      signal: controller.signal,
    }).sendText("wxid_alice", "cancel me");
    setTimeout(() => controller.abort(new Error("test cancellation")), 10);

    await expect(pending).rejects.toThrow("test cancellation");
    expect(proxy.snapshot().requests).toHaveLength(1);
  });
});
