/**
 * Fail-closed coverage for the webhook boundary (#19060): malformed
 * percent-encoding in the account path answers 404 over a real HTTP
 * round-trip instead of throwing out of the request handler, non-object
 * payload data is rejected, and present-but-unusable timestamps drop the
 * message instead of producing a non-finite inbound createdAt. The server
 * suite runs against a real listener on an ephemeral port; only the
 * onMessage sink is a recording stub.
 */

import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
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

  it("drops messages whose present timestamp is unusable", () => {
    expect(
      normalizePayload(basePayload({ timestamp: "not-a-date" })),
    ).toBeNull();
    expect(
      normalizePayload(basePayload({ timestamp: Number.POSITIVE_INFINITY })),
    ).toBeNull();
    expect(normalizePayload(basePayload({ timestamp: -5 }))).toBeNull();
  });

  it("keeps a usable timestamp and defaults a genuinely missing one to now", () => {
    const kept = normalizePayload(basePayload());
    expect(kept?.timestamp).toBe(VALID_MS);

    const before = Date.now();
    const defaulted = normalizePayload(basePayload({ timestamp: undefined }));
    expect(defaulted?.timestamp).toBeGreaterThanOrEqual(before);
    expect(Number.isFinite(defaulted?.timestamp)).toBe(true);
  });
});

describe("webhook server malformed-path handling (#19060)", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.map((close) => close()));
    closers.length = 0;
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
});
