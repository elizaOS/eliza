/**
 * Regression tests for the hono-mount body-size cap.
 *
 * `readNodeBody` previously for-awaited every POST/PUT/PATCH chunk then allocated
 * `new ArrayBuffer(concatenated.byteLength)` with no maxBytes, no 413, and no
 * req.destroy. Since `tryHandleHonoRuntimeRoute` always awaits `readNodeBody`
 * before `app.fetch` for any runtime.routes routeHandler, and the Hono fallback
 * never uses the sibling JSON/body reader in server.ts (which caps at
 * MAX_BODY_BYTES = 1 MiB), a POST to any Hono-eligible plugin routeHandler with
 * an unbounded body was fully buffered — hanging or OOM-ing the process.
 *
 * The fix caps `readNodeBody` at 1 MiB to match server.ts. Real Node HTTP tests
 * prove both declared-length and chunked oversized requests receive a complete
 * 413 response before the connection closes; GET/HEAD still skip the body.
 */

import { EventEmitter } from "node:events";
import {
  createServer,
  type IncomingMessage,
  request,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetHonoMountCache,
  tryHandleHonoRuntimeRoute,
} from "./hono-mount.ts";

const ONE_MIB = 1024 * 1024;

let routeCalls = 0;

async function echoHandler() {
  routeCalls += 1;
  return { status: 200, body: { ok: true } };
}

function makeRuntime(): IAgentRuntime {
  return {
    routes: [
      {
        type: "POST",
        path: "/api/test-plugin/echo",
        public: true,
        name: "test-echo",
        publicReason: "Hono mount body-cap fixture route.",
        publicWrite:
          "Fixture POST authenticated by the test harness, not the local gate.",
        routeHandler: echoHandler,
      },
      {
        type: "GET",
        path: "/api/test-plugin/data",
        public: true,
        name: "test-data",
        publicReason: "Hono mount body-cap fixture route.",
        routeHandler: async () => ({ status: 200, body: { ok: true } }),
      },
    ],
  } as unknown as IAgentRuntime;
}

interface FakeRes {
  res: ServerResponse;
  status: () => number;
  body: () => string;
  ended: () => Promise<void>;
}

function makeReqRes(
  method: string,
  url: string,
  body: Buffer | null,
): { req: IncomingMessage } & FakeRes {
  const req = Readable.from(body ? [body] : []) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost" };

  const chunks: Buffer[] = [];
  let endedResolve: () => void;
  const endedPromise = new Promise<void>((resolve) => {
    endedResolve = resolve;
  });
  const emitter = new EventEmitter() as unknown as ServerResponse & {
    statusCode: number;
    writableEnded: boolean;
  };
  emitter.statusCode = 0;
  emitter.writableEnded = false;
  Object.assign(emitter, {
    setHeader: () => emitter,
    write: (c: Uint8Array | string) => {
      chunks.push(Buffer.from(c));
      return true;
    },
    end: (c?: Uint8Array | string) => {
      if (c != null) chunks.push(Buffer.from(c));
      emitter.writableEnded = true;
      endedResolve();
      return emitter;
    },
  });

  return {
    req,
    res: emitter,
    status: () => emitter.statusCode,
    body: () => Buffer.concat(chunks).toString("utf8"),
    ended: () => endedPromise,
  };
}

async function realHttpPost(
  chunks: Buffer[],
  contentLength?: number,
): Promise<{ status: number; body: string }> {
  const runtime = makeRuntime();
  const server = createServer((req, res) => {
    void tryHandleHonoRuntimeRoute({
      req,
      res,
      runtime,
      isAuthorized: () => true,
    }).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/test-plugin/echo",
          method: "POST",
          headers:
            contentLength === undefined
              ? undefined
              : { "content-length": String(contentLength) },
        },
        (res) => {
          const responseChunks: Buffer[] = [];
          res.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(responseChunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      for (const chunk of chunks) req.write(chunk);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("tryHandleHonoRuntimeRoute body cap", () => {
  beforeEach(() => {
    resetHonoMountCache();
    routeCalls = 0;
  });

  it("returns a complete 413 over real HTTP for an oversized declared body", async () => {
    const oversized = Buffer.alloc(ONE_MIB + 1, 0x61);
    const response = await realHttpPost([oversized], oversized.byteLength);
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      error: "Request body too large",
      maxBytes: ONE_MIB,
    });
    expect(routeCalls).toBe(0);
  });

  it("returns a complete 413 over real HTTP when a chunked body crosses the cap", async () => {
    const response = await realHttpPost([
      Buffer.alloc(ONE_MIB, 0x61),
      Buffer.from("overflow"),
    ]);
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      error: "Request body too large",
      maxBytes: ONE_MIB,
    });
    expect(routeCalls).toBe(0);
  });

  it("still dispatches routeHandler for a body of exactly 1 MiB", async () => {
    const exact = Buffer.alloc(ONE_MIB, 0x62);
    const h = makeReqRes("POST", "/api/test-plugin/echo", exact);
    const handled = await tryHandleHonoRuntimeRoute({
      req: h.req,
      res: h.res,
      runtime: makeRuntime(),
      isAuthorized: () => true,
    });

    expect(handled).toBe(true);
    await h.ended();
    expect(h.status()).toBe(200);
    expect(JSON.parse(h.body())).toEqual({ ok: true });
    expect(routeCalls).toBe(1);
  });

  it("does not buffer a body for GET", async () => {
    const h = makeReqRes("GET", "/api/test-plugin/data", null);
    const handled = await tryHandleHonoRuntimeRoute({
      req: h.req,
      res: h.res,
      runtime: makeRuntime(),
      isAuthorized: () => true,
    });

    expect(handled).toBe(true);
    await h.ended();
    expect(h.status()).toBe(200);
    expect(JSON.parse(h.body())).toEqual({ ok: true });
  });

  it("does not buffer a body for HEAD", async () => {
    const headRuntime: IAgentRuntime = {
      routes: [
        {
          type: "HEAD",
          path: "/api/test-plugin/data",
          public: true,
          name: "test-head",
          publicReason: "Hono mount body-cap fixture route.",
          routeHandler: async () => ({ status: 200, body: null }),
        },
      ],
    } as unknown as IAgentRuntime;

    const h = makeReqRes("HEAD", "/api/test-plugin/data", null);
    const handled = await tryHandleHonoRuntimeRoute({
      req: h.req,
      res: h.res,
      runtime: headRuntime,
      isAuthorized: () => true,
    });

    expect(handled).toBe(true);
  });
});
