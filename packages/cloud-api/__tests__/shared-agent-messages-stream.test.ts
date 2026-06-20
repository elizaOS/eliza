/**
 * Shared-runtime agent SSE chat route:
 *   POST /api/v1/eliza/agents/:agentId/api/conversations/:conversationId/messages/stream
 *
 * A shared agent runs in-Worker (no agent server), so this route runs the same
 * billed turn the non-stream send uses (elizaSandboxService.bridgeStream → shared
 * branch) and streams its SSE reply body straight through — never buffered. The
 * load-bearing invariants:
 *   - the route forwards message.send (text + roomId = conversationId) to bridgeStream;
 *   - the SSE body is returned as-is with text/event-stream headers;
 *   - it reflects the Eliza app WebView origin (https://localhost) + credentials so
 *     the native browser fetch can read the stream cross-origin;
 *   - a missing/empty stream degrades to an SSE `error` frame (200), not a 404.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

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
