import http from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ElizaCloudClient } from "../src/cloud/bridge-client.js";

describe("ElizaCloudClient streaming over HTTP", () => {
  const servers = new Set<http.Server>();
  const sockets = new Set<Socket>();

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.all(
      [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    );
    servers.clear();
  });

  async function startServer(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.add(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind a TCP port");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it("keeps streaming past the idle window while chunks keep arriving", async () => {
    const idleTimeoutMs = 150;
    const chunkCount = 8;
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        response.write(`event: chunk\ndata: {"index":${sent}}\n\n`);
        if (sent === chunkCount) {
          clearInterval(timer);
          response.end('event: done\ndata: {"ok":true}\n\n');
        }
      }, 60);
      response.on("close", () => clearInterval(timer));
    });

    const client = new ElizaCloudClient(baseUrl, "test-key");
    const startedAt = Date.now();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const event of client.sendMessageStream("agent-123", "hello", "room-123", "DM", {
      idleTimeoutMs,
    })) {
      events.push(event);
    }

    // Total duration exceeds the idle window; the stream must still finish.
    expect(Date.now() - startedAt).toBeGreaterThan(idleTimeoutMs * 2);
    expect(events).toHaveLength(chunkCount + 1);
    expect(events.at(-1)).toEqual({ type: "done", data: { ok: true } });
  });

  it("aborts with TimeoutError when the bridge goes silent", async () => {
    const baseUrl = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('event: ready\ndata: {"phase":"ready"}\n\n');
    });

    const client = new ElizaCloudClient(baseUrl, "test-key");
    const stream = client.sendMessageStream("agent-123", "hello", "room-123", "DM", {
      idleTimeoutMs: 100,
    });

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "ready" },
      done: false,
    });
    await expect(stream.next()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("cancels a stalled response body when the caller aborts", async () => {
    let requestCount = 0;
    const server = http.createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write('event: ready\ndata: {"phase":"ready"}\n\n');
      // Keep the response open to model a bridge that stalls after headers.
    });
    servers.add(server);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind a TCP port");
    }

    const controller = new AbortController();
    const client = new ElizaCloudClient(`http://127.0.0.1:${address.port}`, "test-key");
    const stream = client.sendMessageStream("agent-123", "hello", "room-123", "DM", {
      signal: controller.signal,
    });

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "ready", data: { phase: "ready" } },
      done: false,
    });

    const waitingRead = stream.next();
    controller.abort();

    await expect(waitingRead).rejects.toMatchObject({ name: "AbortError" });
    expect(requestCount).toBe(1);
  });
});
