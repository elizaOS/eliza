/**
 * Regression tests for the hono-mount path-normalization seam.
 *
 * `hasHonoEligibleRoute` gates the Hono hand-off with the canonical
 * `matchPluginRoutePath` matcher, which splits on `/` and drops empty
 * segments — so `/api/x/` and `/api//x` match `/api/x`. Hono's router is
 * strict about both. Before the fix, a trailing-slash request passed the
 * tolerant gate, then 404'd inside Hono, and `tryHandleHonoRuntimeRoute`
 * returned `true` — swallowing a request that `dispatchRoute` (the canonical
 * dispatcher used by the in-process IPC surface) serves with 200.
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

function makeRuntime(): IAgentRuntime {
  return {
    routes: [
      {
        type: "GET",
        path: "/api/test-plugin/data",
        public: true,
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
  url: string,
): { req: IncomingMessage; res: FakeRes["res"] } & FakeRes {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = "GET";
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

describe("tryHandleHonoRuntimeRoute path normalization", () => {
  beforeEach(() => {
    resetHonoMountCache();
  });

  it("serves a trailing-slash path the canonical matcher accepts", async () => {
    const h = makeReqRes("/api/test-plugin/data/");
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

  it("serves a duplicate-slash path the canonical matcher accepts", async () => {
    const h = makeReqRes("/api//test-plugin/data");
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

  it("still serves the exact path (control)", async () => {
    const h = makeReqRes("/api/test-plugin/data");
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

  it("leaves unmatched paths unhandled so the server chain continues", async () => {
    const h = makeReqRes("/api/test-plugin/other");
    const handled = await tryHandleHonoRuntimeRoute({
      req: h.req,
      res: h.res,
      runtime: makeRuntime(),
      isAuthorized: () => true,
    });

    expect(handled).toBe(false);
    expect(h.status()).toBe(0);
    expect(h.body()).toBe("");
  });
});
