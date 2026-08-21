/**
 * Fail-closed coverage for the webhook boundary (#19060): malformed
 * percent-encoding in the account path answers 404 over a real HTTP
 * round-trip instead of throwing out of the request handler, non-object
 * payload data is rejected, present-but-unusable timestamps drop the message,
 * and delivery failures remain server errors rather than malformed-input
 * responses. The server suite runs against a real listener on an ephemeral
 * port; only the delivery and diagnostic sinks are recording stubs.
 */

import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bot } from "./bot";
import { normalizePayload, startCallbackServer } from "./callback-server";
import type { WechatMessageContext } from "./types";

const VALID_MS = 1_710_969_600_000;

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      type: 60001,
      sender: "alice",
      recipient: "bot",
      content: "hello",
      timestamp: VALID_MS,
      msgId: "msg-1",
      ...overrides,
    },
  };
}

function requestRaw(
  port: number,
  path: string,
  options: {
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: res.statusCode ?? 0,
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

describe("normalizePayload fail-closed boundaries (#19060)", () => {
  it("rejects primitive payloads and non-object data without throwing", () => {
    expect(normalizePayload(null)).toBeNull();
    expect(normalizePayload("just a string")).toBeNull();
    expect(normalizePayload(42)).toBeNull();
    expect(normalizePayload(["array"])).toBeNull();
    expect(normalizePayload({ data: "just a string" })).toBeNull();
    expect(normalizePayload({ data: 42 })).toBeNull();
    expect(normalizePayload({ data: ["array"] })).toBeNull();
    expect(normalizePayload({})).toBeNull();
  });

  it("does not reinterpret a present invalid nested envelope as flattened", () => {
    for (const data of [null, undefined, "invalid", 42, false, ["array"]]) {
      expect(
        normalizePayload({
          data,
          type: 60001,
          sender: "alice",
          recipient: "bot",
          content: "must not fall through",
          timestamp: VALID_MS,
        }),
      ).toBeNull();
    }
  });

  it("keeps valid nested and flattened payloads working", () => {
    expect(normalizePayload(basePayload())?.content).toBe("hello");
    expect(
      normalizePayload({
        type: 60001,
        sender: "alice",
        recipient: "bot",
        content: "flattened",
        timestamp: VALID_MS,
        msgId: "flat-1",
      }),
    ).toEqual(
      expect.objectContaining({
        content: "flattened",
        id: "flat-1",
        timestamp: VALID_MS,
      }),
    );
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["blank", ""],
    ["whitespace", "   "],
    ["boolean true", true],
    ["boolean false", false],
    ["garbage", "not-a-date"],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -5],
    ["fractional", VALID_MS + 0.5],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("drops a present %s timestamp", (_label, timestamp) => {
    expect(normalizePayload(basePayload({ timestamp }))).toBeNull();
  });

  it("keeps a usable timestamp and defaults a genuinely missing one to now", () => {
    const kept = normalizePayload(basePayload());
    expect(kept?.timestamp).toBe(VALID_MS);

    const { timestamp: _timestamp, ...withoutTimestamp } = basePayload().data;
    const before = Date.now();
    const defaulted = normalizePayload({ data: withoutTimestamp });
    expect(defaulted?.timestamp).toBeGreaterThanOrEqual(before);
    expect(Number.isFinite(defaulted?.timestamp)).toBe(true);

    expect(
      normalizePayload(basePayload({ timestamp: String(VALID_MS) }))?.timestamp,
    ).toBe(VALID_MS);
  });
});

describe("webhook server malformed-path handling (#19060)", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.map((close) => close()));
    closers.length = 0;
  });

  it("binds loopback only so the plaintext-HTTP API key stays off the LAN", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await startCallbackServer({
      port: 0,
      accounts: [{ accountId: "main", apiKey: "key-main" }],
      onMessage: (_accountId, msg) => {
        received.push(msg);
      },
    });
    closers.push(handle.close);

    expect(handle.host).toBe("127.0.0.1");
    const res = await requestRaw(handle.port, "/webhook/wechat/main", {
      headers: {
        "x-api-key": "key-main",
        "content-type": "application/json",
      },
      body: JSON.stringify(basePayload()),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  async function startServer(
    received: WechatMessageContext[],
    accounts = [
      { accountId: "main", apiKey: "key-main" },
      { accountId: "foo bar", apiKey: "key-space" },
    ],
  ) {
    const handle = await startCallbackServer({
      port: 0,
      accounts,
      onMessage: (_accountId, msg) => {
        received.push(msg);
      },
      onDeliveryError: () => undefined,
    });
    closers.push(handle.close);
    return handle.port;
  }

  it("answers 404 for malformed percent-encoding and keeps serving afterwards", async () => {
    const received: WechatMessageContext[] = [];
    const port = await startServer(received);

    for (const path of ["/webhook/wechat/%", "/webhook/wechat/%ZZ"]) {
      const res = await requestRaw(port, path, {
        headers: { "x-api-key": "key-main" },
        body: JSON.stringify(basePayload()),
      });
      expect(res.status).toBe(404);
    }

    // The URIError never escaped the handler: the same server still accepts
    // a well-formed request on the next connection.
    const ok = await requestRaw(port, "/webhook/wechat/main", {
      headers: {
        "x-api-key": "key-main",
        "content-type": "application/json",
      },
      body: JSON.stringify(basePayload()),
    });
    expect(ok.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.timestamp).toBe(VALID_MS);
  });

  it("still resolves percent-encoded account ids that decode cleanly", async () => {
    const received: WechatMessageContext[] = [];
    const port = await startServer(received);

    const res = await requestRaw(port, "/webhook/wechat/foo%20bar", {
      headers: {
        "x-api-key": "key-space",
        "content-type": "application/json",
      },
      body: JSON.stringify(basePayload()),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it("preserves single-account default and unknown-account behavior", async () => {
    const received: WechatMessageContext[] = [];
    const port = await startServer(received, [
      { accountId: "solo", apiKey: "key-solo" },
    ]);

    const defaultPath = await requestRaw(port, "/webhook/wechat", {
      headers: {
        "x-api-key": "key-solo",
        "content-type": "application/json",
      },
      body: JSON.stringify(basePayload()),
    });
    const unknown = await requestRaw(port, "/webhook/wechat/unknown", {
      headers: { "x-api-key": "key-solo" },
      body: JSON.stringify(basePayload()),
    });

    expect(defaultPath.status).toBe(200);
    expect(unknown.status).toBe(404);
    expect(received).toHaveLength(1);
  });

  it("acknowledges JSON primitives without dispatching a message", async () => {
    const received: WechatMessageContext[] = [];
    const port = await startServer(received);

    const res = await requestRaw(port, "/webhook/wechat/main", {
      headers: {
        "x-api-key": "key-main",
        "content-type": "application/json",
      },
      body: "null",
    });

    expect(res.status).toBe(200);
    expect(received).toHaveLength(0);
  });

  it("acknowledges but does not dispatch a message dropped for an unusable timestamp", async () => {
    const received: WechatMessageContext[] = [];
    const port = await startServer(received);

    const res = await requestRaw(port, "/webhook/wechat/main", {
      headers: {
        "x-api-key": "key-main",
        "content-type": "application/json",
      },
      body: JSON.stringify(basePayload({ timestamp: "not-a-date" })),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(0);
  });

  it("returns 500 and reports a delivery failure without calling it bad input", async () => {
    const failures: Array<{ accountId: string; error: unknown }> = [];
    const handle = await startCallbackServer({
      port: 0,
      accounts: [{ accountId: "main", apiKey: "key-main" }],
      onMessage: async () => {
        throw new Error("delivery exploded");
      },
      onDeliveryError: (error, accountId) => {
        failures.push({ accountId, error });
      },
    });
    closers.push(handle.close);

    const res = await requestRaw(handle.port, "/webhook/wechat/main", {
      headers: {
        "x-api-key": "key-main",
        "content-type": "application/json",
      },
      body: JSON.stringify(basePayload()),
    });

    expect(res).toEqual({ body: "Internal Server Error", status: 500 });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.accountId).toBe("main");
    expect(failures[0]?.error).toEqual(new Error("delivery exploded"));
  });

  it("keeps the legacy omitted diagnostic callback safe", async () => {
    const handle = await startCallbackServer({
      port: 0,
      accounts: [{ accountId: "main", apiKey: "key-main" }],
      onMessage: async () => {
        throw new Error("delivery exploded");
      },
    });
    closers.push(handle.close);

    const res = await requestRaw(handle.port, "/webhook/wechat/main", {
      headers: { "x-api-key": "key-main" },
      body: JSON.stringify(basePayload()),
    });

    expect(res).toEqual({ body: "Internal Server Error", status: 500 });
  });

  it("contains a throwing diagnostic callback after returning 500", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const handle = await startCallbackServer({
      port: 0,
      accounts: [{ accountId: "main", apiKey: "key-main" }],
      onMessage: async () => {
        throw new Error("delivery exploded");
      },
      onDeliveryError: async () => {
        throw new Error("reporter exploded");
      },
    });
    closers.push(handle.close);

    const res = await requestRaw(handle.port, "/webhook/wechat/main", {
      headers: { "x-api-key": "key-main" },
      body: JSON.stringify(basePayload()),
    });

    expect(res).toEqual({ body: "Internal Server Error", status: 500 });
    expect(consoleError).toHaveBeenCalledWith(
      "[wechat] Delivery error reporter failed",
      { error: "reporter exploded" },
    );
    consoleError.mockRestore();
  });

  it("makes simultaneous HTTP duplicates await one successful delivery", async () => {
    let resolveOwner: (() => void) | undefined;
    const ownerResult = new Promise<void>((resolve) => {
      resolveOwner = resolve;
    });
    const runtimeDelivery = vi.fn(() => ownerResult);
    const bot = new Bot({ onMessage: runtimeDelivery });
    let boundaryCalls = 0;
    const handle = await startCallbackServer({
      port: 0,
      accounts: [{ accountId: "main", apiKey: "key-main" }],
      onMessage: async (_accountId, message) => {
        boundaryCalls += 1;
        await bot.handleIncoming(message);
      },
    });
    closers.push(async () => {
      bot.stop();
      await handle.close();
    });

    const options = {
      headers: { "x-api-key": "key-main" },
      body: JSON.stringify(basePayload({ msgId: "concurrent-success" })),
    };
    const owner = requestRaw(handle.port, "/webhook/wechat/main", options);
    const duplicate = requestRaw(handle.port, "/webhook/wechat/main", options);
    await vi.waitFor(() => expect(boundaryCalls).toBe(2));
    expect(runtimeDelivery).toHaveBeenCalledTimes(1);
    resolveOwner?.();

    await expect(Promise.all([owner, duplicate])).resolves.toEqual([
      { body: "OK", status: 200 },
      { body: "OK", status: 200 },
    ]);
  });

  it("makes simultaneous HTTP duplicates share one failed delivery", async () => {
    let rejectOwner: ((error: Error) => void) | undefined;
    const ownerResult = new Promise<void>((_resolve, reject) => {
      rejectOwner = reject;
    });
    const runtimeDelivery = vi.fn(() => ownerResult);
    const bot = new Bot({ onMessage: runtimeDelivery });
    let boundaryCalls = 0;
    const handle = await startCallbackServer({
      port: 0,
      accounts: [{ accountId: "main", apiKey: "key-main" }],
      onMessage: async (_accountId, message) => {
        boundaryCalls += 1;
        await bot.handleIncoming(message);
      },
    });
    closers.push(async () => {
      bot.stop();
      await handle.close();
    });

    const options = {
      headers: { "x-api-key": "key-main" },
      body: JSON.stringify(basePayload({ msgId: "concurrent-failure" })),
    };
    const owner = requestRaw(handle.port, "/webhook/wechat/main", options);
    const duplicate = requestRaw(handle.port, "/webhook/wechat/main", options);
    await vi.waitFor(() => expect(boundaryCalls).toBe(2));
    expect(runtimeDelivery).toHaveBeenCalledTimes(1);
    rejectOwner?.(new Error("runtime unavailable"));

    await expect(Promise.all([owner, duplicate])).resolves.toEqual([
      { body: "Internal Server Error", status: 500 },
      { body: "Internal Server Error", status: 500 },
    ]);
  });
});
