/**
 * E9 — shared-agent SSE chat route through the REAL global middleware chain.
 *
 * The sibling unit test (`shared-agent-messages-stream.test.ts`) drives the route
 * leaf in ISOLATION at "/", so it never runs the global chain that
 * `bootstrap-app.ts`'s `createApp()` wraps around every route — which is exactly
 * where the load-bearing regression lives:
 *
 *   IMMUTABLE-HEADERS BUG. The route returns `new Response(upstream.body,
 *   { headers: STREAM_HEADERS })`. `secureHeaders` (registered right after
 *   `corsMiddleware`) then MUTATES `c.res`'s headers. If the CORS layer hadn't
 *   already touched `c.res` (forcing Hono to re-wrap the handler response with a
 *   fresh MUTABLE Headers), that secureHeaders write throws "Can't modify
 *   immutable headers" and the whole request 500s. A credentialed app-origin
 *   request (`https://localhost`) is the real reproduction: it must be reflected
 *   WITH credentials (a `*` wildcard is rejected by the browser for a credentialed
 *   SSE read) AND survive secureHeaders.
 *
 * This builds a minimal Hono app that replicates `createApp()`'s EXACT global
 * chain — the real `corsMiddleware`, the same `secureHeaders` config, the
 * no-store cache pass, and the real `authMiddleware` — then mounts ONLY the
 * stream route at its real codegen path. So the route runs behind the genuine
 * chain, but without booting the full `mountRoutes()` tree (hundreds of modules).
 *
 * Only the two DATA seams are mocked (`resolveSharedAgent` → a seeded shared
 * sandbox; `bridgeStream` → an SSE Response) because a live shared turn needs
 * Postgres + a provisioned org/agent. A `Bearer eliza_*` key passes the real
 * auth gate (programmatic auth); the per-route resolver — mocked — does the real
 * org/tier check. No DB, no Worker; runs in plain `bun test`.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { corsMiddleware } from "@/lib/cors/cloud-api-hono-cors";
// Keep the real modules so afterAll can restore them — bun's `mock.module` is
// process-global.
import * as realElizaSandbox from "@/lib/services/eliza-sandbox";
import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";
import type { AppEnv } from "@/types/cloud-worker-env";
import { authMiddleware } from "../src/middleware/auth";

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

const streamRoute = (
  await import(
    "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/stream/route"
  )
).default;

afterAll(() => {
  mock.module("@/lib/services/eliza-sandbox", () => realElizaSandbox);
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => realResolveSharedAgent,
  );
});

const AGENT = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const CONVERSATION = "11111111-2222-4333-8444-555555555555";
const ORG = "org-e9";
const APP_ORIGIN = "https://localhost";
const MOUNT =
  "/api/v1/eliza/agents/:agentId/api/conversations/:conversationId/messages/stream";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

/**
 * Mirror `createApp()`'s global chain (bootstrap-app.ts) around the one route, so
 * the route runs behind the real cors + secureHeaders + no-store + auth stack.
 */
function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });
  app.use("*", corsMiddleware);
  app.use(
    "*",
    secureHeaders({
      xContentTypeOptions: "nosniff",
      strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
      crossOriginResourcePolicy: "cross-origin",
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
    }),
  );
  app.use("*", async (c, next) => {
    await next();
    const headers = c.res.headers;
    if (
      !headers.has("Cache-Control") &&
      headers.get("Content-Type")?.includes("application/json")
    ) {
      headers.set("Cache-Control", "no-store");
    }
  });
  app.use("*", authMiddleware);
  app.route(MOUNT, streamRoute);
  return app;
}

const app = buildApp();

function path(): string {
  return `/api/v1/eliza/agents/${AGENT}/api/conversations/${CONVERSATION}/messages/stream`;
}

async function postStream(body: unknown, origin?: string): Promise<Response> {
  const headers: Record<string, string> = {
    // Bearer eliza_* passes the global auth gate; resolveSharedAgent (mocked)
    // does the real org/tier check.
    Authorization: "Bearer eliza_test_key",
    "Content-Type": "application/json",
  };
  if (origin) headers.Origin = origin;
  return app.request(
    path(),
    { method: "POST", headers, body: JSON.stringify(body) },
    ENV,
  );
}

describe("shared agent messages/stream — real global middleware chain", () => {
  beforeEach(() => {
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
    bridgeStream.mockResolvedValue(
      new Response(
        'event: chunk\ndata: {"text":"hi"}\n\nevent: done\ndata: {"text":"hi"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const res = await postStream({ text: "say hi" }, APP_ORIGIN);

    // 200 + SSE body survives the chain — the immutable-headers regression would
    // surface here as a 500 when secureHeaders re-wraps the passthrough Response.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // The credentialed app-origin reflection (the bug repro).
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    // secureHeaders ran on the streamed response too — proves the chain didn't bail.
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
    bridgeStream.mockResolvedValue(null);

    const res = await postStream({ text: "hi" }, APP_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.status).not.toBe(404);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    await expect(res.text()).resolves.toContain("event: error");
  });

  test("OPTIONS preflight returns app-origin CORS through the stack", async () => {
    const res = await app.request(
      path(),
      { method: "OPTIONS", headers: { Origin: APP_ORIGIN } },
      ENV,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
