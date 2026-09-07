// @vitest-environment node

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { configureDevApiProxy } from "../vite/dev-http-proxy";

let upstream: Server | undefined;
let downstream: Server | undefined;
let vite: ViteDevServer | undefined;
let directory: string | undefined;
const controllers: AbortController[] = [];

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return address.port;
}

async function serve(handler: RequestListener): Promise<string> {
  upstream = createHttpServer(handler);
  const upstreamPort = await listen(upstream);
  directory = await mkdtemp(join(tmpdir(), "eliza-dev-proxy-"));
  vite = await createViteServer({
    configFile: false,
    root: directory,
    cacheDir: join(directory, "cache"),
    logLevel: "silent",
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      middlewareMode: true,
      hmr: false,
      watch: null,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${upstreamPort}`,
          changeOrigin: false,
          xfwd: true,
          configure: configureDevApiProxy,
        },
      },
    },
  });
  downstream = createHttpServer(vite.middlewares);
  return `http://127.0.0.1:${await listen(downstream)}/api/test/stream`;
}

function request(url: string): Promise<Response> {
  const controller = new AbortController();
  controllers.push(controller);
  return fetch(url, { method: "POST", signal: controller.signal });
}

function bodyReader(response: Response) {
  assert(response.body, "Expected a response body");
  return response.body.getReader();
}

async function close(server: Server | undefined): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await close(downstream);
  await close(upstream);
  await vite?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  upstream = downstream = vite = directory = undefined;
});

async function readOutcome(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read().then(
        ({ done }) => (done ? "closed" : "chunk"),
        () => "rejected",
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("still pending"), 750);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("dev API proxy response lifecycle", () => {
  it("settles an SSE body when the API disconnects after its first frame", async () => {
    let response: ServerResponse | undefined;
    const url = await serve((_request, res) => {
      response = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"type":"status","status":{"kind":"thinking"}}\n\n');
    });
    const browser = await request(url);
    const reader = bodyReader(browser);
    expect((await reader.read()).done).toBe(false);
    assert(response);
    response.destroy();
    expect(["closed", "rejected"]).toContain(await readOutcome(reader));
  });

  it("does not turn a truncated JSON response into a successful body", async () => {
    let response: ServerResponse | undefined;
    const url = await serve((_request, res) => {
      response = res;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": "100",
      });
      res.write('{"messages":[');
    });
    const browser = await request(url);
    const body = browser.json();
    const failure = expect(body).rejects.toThrow();
    assert(response);
    response.destroy();
    await failure;
  });

  it("delivers a complete response including its final frame and buffered tail", async () => {
    const text = `data: ${"x".repeat(100_000)}\n\ndata: {"type":"done"}\n\n`;
    const url = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(text);
    });
    expect(await (await request(url)).text()).toBe(text);
  });

  it("keeps a quiet upstream live until it sends its next frame", async () => {
    let response: ServerResponse | undefined;
    const url = await serve((_request, res) => {
      response = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": heartbeat\n\n");
    });
    const reader = bodyReader(await request(url));
    expect((await reader.read()).done).toBe(false);
    let settled = false;
    const next = reader.read().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);
    assert(response);
    response.end('data: {"type":"done"}\n\n');
    expect(new TextDecoder().decode((await next).value)).toContain('"done"');
    expect((await reader.read()).done).toBe(true);
  });

  it("returns the existing JSON 502 when the API is unavailable before headers", async () => {
    const url = await serve((_request, response) => response.end("unused"));
    await close(upstream);
    const browser = await request(url);
    expect(browser.status).toBe(502);
    expect(await browser.json()).toEqual({ error: "API server unavailable" });
  });

  it("releases the upstream connection when the browser cancels", async () => {
    let closed: Promise<unknown> | undefined;
    const url = await serve((_request, response) => {
      closed = once(response, "close");
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(": heartbeat\n\n");
    });
    const reader = bodyReader(await request(url));
    await reader.read();
    await reader.cancel();
    assert(closed);
    await closed;
  });
});
