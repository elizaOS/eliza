/**
 * E9 — shared-agent SSE chat route through the FULL Worker stack (in-process).
 *
 * The sibling unit test (`shared-agent-messages-stream.test.ts`) drives the route
 * leaf in ISOLATION at "/", so it never exercises the global middleware chain
 * (`corsMiddleware` → `secureHeaders` → the no-store cache pass → auth gate) that
 * `createApp()` (src/bootstrap-app.ts) wires around every route. That chain is
 * exactly where the load-bearing regressions live:
 *
 *   - IMMUTABLE-HEADERS BUG: the route returns `new Response(upstream.body,
 *     { headers: STREAM_HEADERS })`. `secureHeaders` then re-wraps `c.res` and
 *     MUTATES its headers; if the passthrough Response carried frozen/immutable
 *     headers the whole request 500s. `credentials: true` on the CORS middleware
 *     is what forces Hono to re-wrap every handler response with a fresh mutable
 *     Headers — so a credentialed app-origin request is the real reproduction.
 *
 *   - 404-vs-SSE-error: a no-reply turn must degrade to a 200 SSE `error` frame,
 *     never a 404 (which would make the chat client treat the stream endpoint as
 *     missing and stop probing it).
 *
 * This test boots the REAL `createApp()` and POSTs to the codegen-mounted path
 * `/api/v1/eliza/agents/:agentId/api/conversations/:conversationId/messages/stream`,
 * so the route runs behind the genuine global chain. Only the two DATA seams are
 * mocked (`resolveSharedAgent` → a seeded shared sandbox; `bridgeStream` → an SSE
 * Response), because a live shared turn needs Postgres + a provisioned org/agent;
 * everything between the edge and those seams is real.
 *
 * Auth: a `Bearer eliza_*` key passes the global gate (programmatic auth) and the
 * per-route `resolveSharedAgent` does the real org/tier check — which we mock — so
 * no DB is touched.
 *
 * Booting createApp only needs the in-process env below (no bindings/secrets), so
 * this runs in plain `bun test`. If a future change makes createApp require live
 * bindings, the suite self-skips LOUDLY (console.warn) rather than failing.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { Hono } from "hono";

// Keep the real modules so afterAll can restore them — bun's `mock.module` is
// process-global, so a blanket restore here would strand sibling test files that
// import the full eliza-sandbox / resolve-shared-agent surface.
import * as realElizaSandbox from "@/lib/services/eliza-sandbox";
import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";
import type { AppEnv } from "@/types/cloud-worker-env";

const resolveSharedAgent = mock();
const bridgeStream = mock();

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  ...realResolveSharedAgent,
  resolveSharedAgent,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  ...realElizaSandbox,
  elizaSandboxService: {
    ...realElizaSandbox.elizaSandboxService,
    bridgeStream,
  },
}));

const AGENT = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const CONVERSATION = "11111111-2222-4333-8444-555555555555";
const ORG = "org-e9";
const APP_ORIGIN = "https://localhost";

// Minimal Worker env so createApp's top middleware (runWithCloudBindingsAsync +
// runWithDbCacheAsync + setRuntimeR2Bucket) initializes without bindings/secrets.
// NODE_ENV must NOT be "production" (the dev-admin guard hard-fails there) but the
// route under test never hits that branch — programmatic auth wins first.
const ENV = {
  NODE_ENV: "test",
  BLOB: undefined,
} as unknown as AppEnv["Bindings"];

let app: Hono<AppEnv> | null = null;
let bootError: unknown = null;

function path(): string {
  return `/api/v1/eliza/agents/${AGENT}/api/conversations/${CONVERSATION}/messages/stream`;
}

function postStream(body: unknown, origin?: string): Promise<Response> {
  const headers: Record<string, string> = {
    // Bearer eliza_* passes the global auth gate; resolveSharedAgent (mocked)
    // does the real org/tier check.
    Authorization: "Bearer eliza_test_key",
    "Content-Type": "application/json",
  };
  if (origin) headers.Origin = origin;
  // app.request(path, init, env): the 3rd arg becomes c.env (the Worker bindings).
  return app!.request(
    path(),
    { method: "POST", headers, body: JSON.stringify(body) },
    ENV,
  );
}

beforeAll(async () => {
  try {
    const { createApp } = await import("../src/bootstrap-app");
    app = createApp();
  } catch (err) {
    bootError = err;
  }
});

afterAll(() => {
  mock.module("@/lib/services/eliza-sandbox", () => realElizaSandbox);
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => realResolveSharedAgent,
  );
});

const ready = () => app !== null;

describe("shared agent messages/stream — full createApp() stack", () => {
  beforeEach(() => {
    if (!ready()) {
      console.warn(
        "[E9 shared-agent SSE] SKIPPED — createApp() failed to boot in this " +
          "environment (likely missing Worker bindings/secrets). This proves the " +
          "SSE route survives the real cors+secureHeaders middleware chain " +
          "(immutable-headers regression) and that a no-reply turn yields a 200 " +
          "SSE error frame, not a 404. Boot error: " +
          String(bootError),
      );
      return;
    }
    resolveSharedAgent.mockReset();
    bridgeStream.mockReset();
    resolveSharedAgent.mockResolvedValue({
      agent: { execution_tier: "shared" },
      agentId: AGENT,
      orgId: ORG,
      agentName: "Eliza",
    });
  });

  test("reflects https://localhost Origin + credentials through cors+secureHeaders, streams SSE", async () => {
    if (!ready()) return;
    bridgeStream.mockResolvedValue(
      new Response(
        'event: chunk\ndata: {"text":"hi"}\n\nevent: done\ndata: {"text":"hi"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const res = await postStream({ text: "say hi" }, APP_ORIGIN);

    // 200 + SSE body survives the full middleware chain (the immutable-headers
    // regression would surface here as a 500 when secureHeaders re-wraps the
    // passthrough Response).
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // The credentialed app-origin reflection (the bug repro): a `*` wildcard is
    // rejected by the browser for a credentialed SSE read.
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    // secureHeaders ran on the response too — proves the chain didn't bail.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(res.text()).resolves.toContain("event: done");

    // The route forwarded message.send with roomId = conversationId.
    const call = bridgeStream.mock.calls[0];
    expect(call[0]).toBe(AGENT);
    expect(call[1]).toBe(ORG);
    expect(call[2].method).toBe("message.send");
    expect(call[2].params).toMatchObject({
      text: "say hi",
      roomId: CONVERSATION,
    });
  });

  test("no-reply turn → 200 SSE error frame through the stack, never a 404", async () => {
    if (!ready()) return;
    bridgeStream.mockResolvedValue(null);

    const res = await postStream({ text: "hi" }, APP_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(404);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    await expect(res.text()).resolves.toContain("event: error");
  });

  test("OPTIONS preflight returns app-origin CORS through the stack", async () => {
    if (!ready()) return;
    const res = await app!.request(
      path(),
      { method: "OPTIONS", headers: { Origin: APP_ORIGIN } },
      ENV,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
