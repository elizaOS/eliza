/**
 * Shared-runtime agent SSE chat route:
 *   POST /api/v1/eliza/agents/:agentId/api/conversations/:conversationId/messages/stream
 *
 * A shared agent runs in-Worker (no agent server), so this route runs the same
 * billed turn the non-stream send uses (elizaSandboxService.bridgeStream → shared
 * branch) and returns its SSE reply body as-is — the route never awaits/buffers
 * res.body. NOTE: a shared-tier reply is a SINGLE pre-built SSE frame (the reply
 * string is fully materialized before bridgeStream wraps it), not token-by-token;
 * only DEDICATED (container) agents stream incrementally. The route forwarding is
 * a true pass-through regardless, which the multi-chunk test below proves. The
 * load-bearing invariants:
 *   - the route forwards message.send (text + roomId = conversationId) to bridgeStream;
 *   - the SSE body is returned as-is with text/event-stream headers;
 *   - chunks are forwarded incrementally — the route does not read the body to
 *     completion before responding;
 *   - it reflects the Eliza app WebView origin (https://localhost) + credentials so
 *     the native browser fetch can read the stream cross-origin;
 *   - a missing/empty stream degrades to an SSE `error` frame (200), not a 404.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { InsufficientCreditsError } from "@/lib/api/errors";
// Keep the real modules so afterAll can restore them — bun's `mock.module` is
// process-global, so a blanket `mock.restore()` here would strand sibling test
// files that import the full eliza-sandbox / resolve-shared-agent surface.
import * as realElizaSandbox from "@/lib/services/eliza-sandbox";
import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";

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

// Imported after the mocks so the route binds to our stubs.
const streamRoute = (
  await import(
    "../v1/eliza/agents/[agentId]/api/conversations/[conversationId]/messages/stream/route"
  )
).default;

// Restore the real modules so this file's process-global mocks don't strand later
// test files that use the full elizaSandboxService / resolveSharedAgent surface.
afterAll(() => {
  mock.module("@/lib/services/eliza-sandbox", () => realElizaSandbox);
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => realResolveSharedAgent,
  );
});

const AGENT = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const ORG = "org-1";

// The route is a sub-app whose handlers are registered at "/" (the generated
// router mounts it at its full path; agentId/conversationId are injected by the
// parent mount). With resolveSharedAgent mocked, the route reads agentId/orgId
// from the resolver result and conversationId falls back to r.agentId, so the
// standalone app can be driven at "/" without those params.
function postStream(body: unknown, origin?: string) {
  const headers: Record<string, string> = {
    Authorization: "Bearer user-api-key",
    "Content-Type": "application/json",
  };
  if (origin) headers.Origin = origin;
  return streamRoute.request("/", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("shared agent messages/stream", () => {
  beforeEach(() => {
    resolveSharedAgent.mockReset();
    bridgeStream.mockReset();
    resolveSharedAgent.mockResolvedValue({
      agent: {},
      agentId: AGENT,
      orgId: ORG,
      agentName: "Eliza",
    });
  });

  test("forwards message.send to bridgeStream and streams the SSE body through", async () => {
    bridgeStream.mockResolvedValue(
      new Response(
        'event: chunk\ndata: {"text":"hi"}\n\nevent: done\ndata: {"text":"hi"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const res = await postStream({ text: "say hi" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await expect(res.text()).resolves.toContain("event: done");

    const call = bridgeStream.mock.calls[0];
    expect(call[0]).toBe(AGENT);
    expect(call[1]).toBe(ORG);
    expect(call[2].method).toBe("message.send");
    expect(call[2].params).toMatchObject({ text: "say hi", roomId: AGENT });
  });

  test("forwards a multi-chunk body incrementally — the route never awaits/buffers res.body", async () => {
    // Prove the route's pass-through contract: it returns `upstream.body` as-is
    // and never reads it to completion. A dedicated-agent reply is a live
    // token-by-token upstream SSE socket; here we model that with a
    // ReadableStream we feed by hand and never close, then assert the route
    // surfaces frame #1 to the reader BEFORE frame #2 is enqueued. If the route
    // buffered (awaited res.text()/arrayBuffer()), this read would hang.
    let enqueue!: (s: string) => void;
    let closeStream!: () => void;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        enqueue = (s) => controller.enqueue(enc.encode(s));
        closeStream = () => controller.close();
      },
    });
    bridgeStream.mockResolvedValue(
      new Response(upstreamBody, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await postStream({ text: "stream please" });
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();

    enqueue('event: chunk\ndata: {"text":"to"}\n\n');
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(dec.decode(first.value)).toContain('"to"');

    // Only now produce the second frame. Reading it proves frame #1 reached the
    // client before frame #2 existed — i.e. true incremental forwarding.
    enqueue('event: chunk\ndata: {"text":"ken"}\n\n');
    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(dec.decode(second.value)).toContain('"ken"');

    closeStream();
    const end = await reader.read();
    expect(end.done).toBe(true);
  });

  test("reflects the app WebView origin + credentials for a credentialed SSE read", async () => {
    bridgeStream.mockResolvedValue(
      new Response('event: done\ndata: {"text":"ok"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await postStream({ text: "hi" }, "https://localhost");
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://localhost",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("empty text → 400 (not a stream)", async () => {
    const res = await postStream({ text: "  " });
    expect(res.status).toBe(400);
    expect(bridgeStream).not.toHaveBeenCalled();
  });

  test("no stream body → SSE error frame (200), never a 404", async () => {
    bridgeStream.mockResolvedValue(null);
    const res = await postStream({ text: "hi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await expect(res.text()).resolves.toContain("event: error");
  });

  // Insufficient credits is rejected before any SSE bytes exist (bridgeStream's
  // shared branch throws the typed 402), so the route answers with the same
  // canonical 402 JSON as the non-stream send — not an error frame buried in a
  // 200 stream the app would read as a transient turn failure.
  test("insufficient credits → non-retryable 402 JSON, not an SSE frame", async () => {
    bridgeStream.mockRejectedValue(
      new InsufficientCreditsError(
        "Insufficient credits. Required: $0.0500, Available: $0.0000",
      ),
    );

    const res = await postStream({ text: "hi" }, "https://localhost");

    expect(res.status).toBe(402);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://localhost",
    );
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Insufficient credits. Required: $0.0500, Available: $0.0000",
      code: "insufficient_credits",
      retryable: false,
    });
  });

  test("auth/tier failure surfaces the resolver error status", async () => {
    resolveSharedAgent.mockResolvedValue({
      error: "Not a shared-runtime agent",
      status: 404,
    });
    const res = await postStream({ text: "hi" });
    expect(res.status).toBe(404);
    expect(bridgeStream).not.toHaveBeenCalled();
  });

  test("OPTIONS preflight returns 204 with app-origin CORS", async () => {
    const res = await streamRoute.request("/", {
      method: "OPTIONS",
      headers: { Origin: "https://localhost" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://localhost",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
