/**
 * Regression tests for the Hono adapter's streaming branch.
 *
 * A `routeHandler` returning `{ status, headers, stream }` (the documented
 * SSE / long-response shape of `RouteHandlerResult`) must keep its status and
 * headers on the wire. The stream branch used to build the streamed Response
 * from a bare context — dropping `content-type: text/event-stream` (which
 * breaks EventSource clients) and collapsing every non-200 status to 200 —
 * while the non-stream branch preserved both.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildHonoAppForRuntime } from "./hono-adapter.ts";

function makeRuntime(): IAgentRuntime {
  async function* sse(): AsyncGenerator<Uint8Array | string> {
    yield "data: hello\n\n";
    yield new TextEncoder().encode("data: world\n\n");
  }
  return {
    routes: [
      {
        type: "GET",
        path: "/api/test-plugin/events",
        public: true,
        routeHandler: async () => ({
          status: 201,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "x-custom": "yes",
          },
          stream: sse(),
        }),
      },
      {
        type: "GET",
        path: "/api/test-plugin/plain",
        public: true,
        routeHandler: async () => ({
          status: 201,
          headers: { "x-custom": "yes" },
          body: { ok: true },
        }),
      },
    ],
  } as unknown as IAgentRuntime;
}

describe("hono-adapter streaming RouteHandlerResult", () => {
  it("preserves the handler's status and headers on a streamed response", async () => {
    const app = buildHonoAppForRuntime(makeRuntime(), {
      isAuthorized: () => true,
    });

    const res = await app.request("/api/test-plugin/events");

    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(await res.text()).toBe("data: hello\n\ndata: world\n\n");
  });

  it("keeps the non-stream branch behavior unchanged (control)", async () => {
    const app = buildHonoAppForRuntime(makeRuntime(), {
      isAuthorized: () => true,
    });

    const res = await app.request("/api/test-plugin/plain");

    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });
});
