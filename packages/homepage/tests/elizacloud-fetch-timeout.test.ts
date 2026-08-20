/**
 * elizacloudFetch AbortSignal contract (#22907): default timeout signal,
 * caller signal passthrough, fail-closed on a hung Cloud hop, and honest
 * JSON success.
 */

import { afterAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { elizacloudAuthFetch, elizacloudFetch } from "../src/lib/api/client";

const servers: net.Server[] = [];

async function listenHold(): Promise<string> {
  // Accept-and-hold: connection opens, response never comes.
  const server = net.createServer(() => {});
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as net.AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function listenJson(body: string): Promise<string> {
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      socket.end(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          "Connection: close\r\n\r\n" +
          body,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as net.AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterAll(() => {
  for (const server of servers) server.close();
});

describe("elizacloudFetch abort signal (#22907)", () => {
  test("applies a default AbortSignal when the caller passes none", async () => {
    const realFetch = globalThis.fetch;
    let captured: RequestInit | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;
    try {
      await elizacloudFetch("/api/agents");
      expect(captured?.signal).toBeInstanceOf(AbortSignal);
      expect(captured?.signal?.aborted).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("caller-passed signal is used unchanged, not replaced", async () => {
    const realFetch = globalThis.fetch;
    let captured: RequestInit | undefined;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch;
    try {
      const controller = new AbortController();
      await elizacloudFetch("/api/agents", { signal: controller.signal });
      expect(captured?.signal).toBe(controller.signal);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("hung Cloud hop fails closed with TimeoutError", async () => {
    process.env.VITE_ELIZACLOUD_API_URL = await listenHold();
    expect(
      elizacloudFetch("/api/agents", { signal: AbortSignal.timeout(250) }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  test("honest JSON success still returns", async () => {
    process.env.VITE_ELIZACLOUD_API_URL = await listenJson(
      JSON.stringify({ ok: true, source: "hold-free" }),
    );
    const result = await elizacloudFetch<{ ok: boolean; source: string }>(
      "/api/agents",
    );
    expect(result).toEqual({ ok: true, source: "hold-free" });
  });

  test("elizacloudAuthFetch inherits the timeout via the shared helper", async () => {
    process.env.VITE_ELIZACLOUD_API_URL = await listenHold();
    expect(
      elizacloudAuthFetch("/api/agents", { signal: AbortSignal.timeout(250) }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
