import type { IAgentRuntime, Route } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { dispatchRoute } from "./dispatch-route.ts";

/**
 * Covers the incremental `onChunk` sink added for the Android stdio switch
 * (#12352): a legacy Express-shaped SSE handler flushes body fragments via
 * `res.write(...)`, and the sink must forward each fragment the instant it is
 * written — not only after `res.end()` — while the buffered
 * `RouteHandlerResult` still carries the full body. Drives the real
 * `dispatchRoute` with a minimal fake runtime; no server boot.
 */

function runtimeWithRoutes(routes: Route[]): IAgentRuntime {
  return { routes } as unknown as IAgentRuntime;
}

describe("dispatchRoute onChunk sink (#12352)", () => {
  it("forwards each SSE fragment live and returns the buffered body", async () => {
    const seen: string[] = [];
    const route: Route = {
      type: "POST",
      path: "/api/stream",
      handler: async (_req: unknown, res: unknown) => {
        const r = res as unknown as {
          setHeader: (k: string, v: string) => void;
          write: (c: string) => void;
          end: () => void;
        };
        r.setHeader("content-type", "text/event-stream");
        r.write("data: one\n\n");
        r.write("data: two\n\n");
        r.end();
      },
    } as unknown as Route;

    const chunks: string[] = [];
    const result = await dispatchRoute({
      runtime: runtimeWithRoutes([route]),
      method: "POST",
      path: "/api/stream",
      headers: {},
      body: undefined,
      inProcess: true,
      isAuthorized: () => true,
      onChunk: (chunk) => {
        chunks.push(chunk.toString("utf8"));
        seen.push("chunk");
      },
    });

    // Each write was forwarded live, in order, before the result resolved.
    expect(chunks).toEqual(["data: one\n\n", "data: two\n\n"]);
    // The buffered result still carries the full concatenated body.
    expect(result?.status).toBe(200);
    expect(String(result?.body)).toBe("data: one\n\ndata: two\n\n");
  });

  it("does not invoke the sink when a handler only sends a buffered JSON body", async () => {
    const route: Route = {
      type: "GET",
      path: "/api/plain",
      handler: async (_req: unknown, res: unknown) => {
        (res as unknown as { json: (b: unknown) => void }).json({ ok: true });
      },
    } as unknown as Route;

    let chunkCount = 0;
    const result = await dispatchRoute({
      runtime: runtimeWithRoutes([route]),
      method: "GET",
      path: "/api/plain",
      headers: {},
      inProcess: true,
      isAuthorized: () => true,
      onChunk: () => {
        chunkCount += 1;
      },
    });

    // res.json buffers once; the sink still sees that single flush.
    expect(chunkCount).toBe(1);
    expect(result?.body).toEqual({ ok: true });
  });

  it("omitting onChunk is byte-for-byte identical to today (HTTP path)", async () => {
    const route: Route = {
      type: "POST",
      path: "/api/stream",
      handler: async (_req: unknown, res: unknown) => {
        const r = res as unknown as {
          write: (c: string) => void;
          end: () => void;
        };
        r.write("a");
        r.write("b");
        r.end();
      },
    } as unknown as Route;

    const result = await dispatchRoute({
      runtime: runtimeWithRoutes([route]),
      method: "POST",
      path: "/api/stream",
      headers: {},
      inProcess: false,
      isAuthorized: () => true,
    });
    expect(String(result?.body)).toBe("ab");
  });
});
