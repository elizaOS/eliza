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
 * The fix caps `readNodeBody` at 1 MiB to match server.ts: when exceeded it
 * destroys the request, does not allocate the ArrayBuffer, and
 * `tryHandleHonoRuntimeRoute` writes 413 and returns true (request handled).
 * GET/HEAD still skip the body entirely.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
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

/**
 * Origin `readNodeBody` from `origin/develop` (no maxBytes / 413 / destroy).
 * Inlined so this file can prove the hang/OOM class without checking out the
 * parent: a 1 MiB + 1 body is fully buffered into an ArrayBuffer.
 */
async function originReadNodeBody(
  req: IncomingMessage,
): Promise<ArrayBuffer | null> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  const concatenated = Buffer.concat(chunks);
  const body = new ArrayBuffer(concatenated.byteLength);
  new Uint8Array(body).set(concatenated);
  return body;
}

describe("origin/develop readNodeBody (unbounded)", () => {
  it("fully buffers a 1 MiB + 1 POST body into an ArrayBuffer", async () => {
    const oversized = Buffer.alloc(ONE_MIB + 1, 0x61);
    const req = Readable.from([oversized]) as unknown as IncomingMessage;
    req.method = "POST";
    req.url = "/api/test-plugin/echo";
    req.headers = { host: "localhost" };
    const body = await originReadNodeBody(req);
    expect(body).not.toBeNull();
    expect(body?.byteLength).toBe(ONE_MIB + 1);
  });
});

describe("tryHandleHonoRuntimeRoute body cap", () => {
  beforeEach(() => {
    resetHonoMountCache();
    routeCalls = 0;
  });

  it("returns 413 and does not dispatch routeHandler when body exceeds 1 MiB", async () => {
    const oversized = Buffer.alloc(ONE_MIB + 1, 0x61);
    const h = makeReqRes("POST", "/api/test-plugin/echo", oversized);
    const handled = await tryHandleHonoRuntimeRoute({
      req: h.req,
      res: h.res,
      runtime: makeRuntime(),
      isAuthorized: () => true,
    });

    expect(handled).toBe(true);
    await h.ended();
    expect(h.status()).toBe(413);
    expect(JSON.parse(h.body())).toEqual({
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
