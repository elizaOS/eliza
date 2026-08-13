/**
 * Deterministic tests for the WeChat webhook listener: account-path resolution,
 * fail-closed payload normalization, and raw HTTP requests against the real
 * local server. No live WeChat proxy.
 */
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizePayload,
  resolveWebhookAccount,
  startCallbackServer,
} from "./callback-server";

const ACCOUNTS = [{ accountId: "main", apiKey: "secret-key" }];
const PADDED = [{ accountId: "foo bar", apiKey: "secret-key" }];

function requestRaw(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "POST",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
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

describe("resolveWebhookAccount", () => {
  it("matches a named account and the single-account default path", () => {
    expect(resolveWebhookAccount("/webhook/wechat/main", ACCOUNTS)).toEqual(
      ACCOUNTS[0],
    );
    expect(resolveWebhookAccount("/webhook/wechat", ACCOUNTS)).toEqual(
      ACCOUNTS[0],
    );
    expect(
      resolveWebhookAccount("/webhook/wechat/missing", ACCOUNTS),
    ).toBeNull();
    expect(resolveWebhookAccount("/webhook/wechat/foo%20bar", PADDED)).toEqual(
      PADDED[0],
    );
  });

  it("returns null for malformed percent-encoding instead of throwing", () => {
    expect(() =>
      resolveWebhookAccount("/webhook/wechat/%", ACCOUNTS),
    ).not.toThrow();
    expect(resolveWebhookAccount("/webhook/wechat/%", ACCOUNTS)).toBeNull();
    expect(resolveWebhookAccount("/webhook/wechat/%ZZ", ACCOUNTS)).toBeNull();
    expect(
      resolveWebhookAccount("/webhook/wechat/%E0%A4%A", ACCOUNTS),
    ).toBeNull();
    expect(resolveWebhookAccount(undefined, ACCOUNTS)).toBeNull();
  });
});

describe("normalizePayload", () => {
  it("still accepts nested and flattened valid payloads", () => {
    expect(
      normalizePayload({
        data: {
          type: 60001,
          sender: "wxid_alice",
          recipient: "wxid_bot",
          content: "hello",
          timestamp: 1_700_000_000,
          msgId: "direct-1",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        id: "direct-1",
        type: "text",
        timestamp: 1_700_000_000,
      }),
    );

    expect(
      normalizePayload({
        type: 60001,
        sender: "wxid_alice",
        recipient: "wxid_bot",
        content: "flat hello",
        timestamp: 1_700_000_002,
        msgId: "flat-1",
      }),
    ).toEqual(
      expect.objectContaining({
        id: "flat-1",
        content: "flat hello",
        timestamp: 1_700_000_002,
      }),
    );
  });

  it("rejects non-object payloads and non-object data without throwing", () => {
    expect(normalizePayload(null)).toBeNull();
    expect(normalizePayload("x")).toBeNull();
    expect(normalizePayload([])).toBeNull();
    expect(normalizePayload({ data: "not-an-object" })).toBeNull();
    expect(normalizePayload({ data: ["60001"] })).toBeNull();
  });

  it("defaults a missing timestamp and drops non-finite timestamps", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000);
    expect(
      normalizePayload({
        data: {
          type: 60001,
          sender: "wxid_alice",
          recipient: "wxid_bot",
          content: "hello",
          msgId: "no-ts",
        },
      }),
    ).toEqual(
      expect.objectContaining({ id: "no-ts", timestamp: 1_800_000_000 }),
    );

    expect(
      normalizePayload({
        data: {
          type: 60001,
          sender: "wxid_alice",
          recipient: "wxid_bot",
          content: "hello",
          timestamp: "not-a-date",
          msgId: "bad-ts",
        },
      }),
    ).toBeNull();
    expect(
      normalizePayload({
        data: {
          type: 60001,
          sender: "wxid_alice",
          recipient: "wxid_bot",
          content: "hello",
          timestamp: Number.POSITIVE_INFINITY,
          msgId: "inf-ts",
        },
      }),
    ).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("startCallbackServer HTTP boundary", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("returns 404 for a raw malformed account path without crashing", async () => {
    const onMessage = vi.fn();
    const server = await startCallbackServer({
      port: 0,
      accounts: ACCOUNTS,
      onMessage,
    });
    servers.push(server);

    const malformed = await requestRaw(server.port, "/webhook/wechat/%");
    expect(malformed.status).toBe(404);
    expect(malformed.body).toBe("Not Found");

    const invalidHex = await requestRaw(server.port, "/webhook/wechat/%ZZ");
    expect(invalidHex.status).toBe(404);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("accepts a valid authenticated payload and rejects a non-finite timestamp", async () => {
    const onMessage = vi.fn();
    const server = await startCallbackServer({
      port: 0,
      accounts: ACCOUNTS,
      onMessage,
    });
    servers.push(server);

    const ok = await requestRaw(server.port, "/webhook/wechat/main", {
      headers: {
        "x-api-key": "secret-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        data: {
          type: 60001,
          sender: "wxid_alice",
          recipient: "wxid_bot",
          content: "hello",
          timestamp: 1_700_000_000,
          msgId: "http-1",
        },
      }),
    });
    expect(ok.status).toBe(200);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toBe("main");
    expect(onMessage.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ id: "http-1", timestamp: 1_700_000_000 }),
    );

    const dropped = await requestRaw(server.port, "/webhook/wechat/main", {
      headers: {
        "x-api-key": "secret-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        data: {
          type: 60001,
          sender: "wxid_alice",
          recipient: "wxid_bot",
          content: "hello",
          timestamp: "not-a-date",
          msgId: "http-bad-ts",
        },
      }),
    });
    expect(dropped.status).toBe(200);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});
