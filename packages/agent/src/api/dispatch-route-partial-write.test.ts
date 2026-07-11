/**
 * Failure-observability suite for a legacy route handler that throws after
 * writing part (or all) of its response. `dispatchRoute` used to return the
 * captured bytes as a healthy result, masking the failure at every transport.
 * These tests drive the real dispatcher, the real Hono adapter, and the real
 * NDJSON stdio-bridge kernel (the Android/iOS/Electrobun IPC transport) and
 * prove each CALLER observes the typed `ROUTE_HANDLER_PARTIAL_WRITE_FAILURE` —
 * while chunks already streamed before the failure stay delivered.
 */

import { Buffer } from "node:buffer";
import {
  AgentRuntime,
  type Character,
  isElizaError,
  type Route,
  type RouteResponse,
} from "@elizaos/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  dispatchBufferedRequest,
  dispatchStreamingRequest,
} from "../../../../plugins/plugin-capacitor-bridge/src/android/dispatch.ts";
import {
  createStdioBridge,
  type StdioBridgeResponseFrame,
} from "../../../../plugins/plugin-capacitor-bridge/src/shared/stdio-bridge.ts";
import { dispatchRoute } from "./dispatch-route.ts";
import { mountRoutesOnHono } from "./hono-adapter.ts";

/** Shim surface the legacy handler drives; see dispatch-route-binary-response.test.ts. */
interface ShimResponse extends RouteResponse {
  setHeader(name: string, value: string | string[]): RouteResponse;
  write(chunk: unknown): boolean;
  end(chunk?: unknown): RouteResponse;
}

function isShimResponse(res: RouteResponse): res is ShimResponse {
  const candidate = res as Partial<
    Record<"setHeader" | "write" | "end", unknown>
  >;
  return (
    typeof candidate.setHeader === "function" &&
    typeof candidate.write === "function" &&
    typeof candidate.end === "function"
  );
}

const FIXTURE_PATH = "/api/partial";

function runtimeWithHandler(
  handler: (response: ShimResponse) => void,
): AgentRuntime {
  const character: Character = { name: "partial-write-fixture" };
  const runtime = new AgentRuntime({ character });
  const route: Route = {
    type: "GET",
    path: FIXTURE_PATH,
    name: "partial-write-fixture",
    public: true,
    publicReason: "Test-only partial-write failure fixture.",
    handler: async (_req, res) => {
      if (!isShimResponse(res)) {
        throw new Error(
          "legacy shim response no longer exposes setHeader/write/end",
        );
      }
      handler(res);
    },
  };
  runtime.routes.push(route);
  return runtime;
}

function dispatchArgs(
  runtime: AgentRuntime,
  onChunk?: (chunk: Buffer) => void,
) {
  return {
    runtime,
    method: "GET",
    path: FIXTURE_PATH,
    headers: {},
    inProcess: true,
    isAuthorized: () => true,
    ...(onChunk ? { onChunk } : {}),
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

describe("dispatchRoute partial-write failure — direct caller", () => {
  it("rejects typed when the handler throws after streaming a chunk, keeping delivered chunks", async () => {
    const delivered: Buffer[] = [];
    const runtime = runtimeWithHandler((res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write("data: token-1\n\n");
      throw new Error("model backend fell over mid-stream");
    });

    const failure = await rejectionOf(
      dispatchRoute(dispatchArgs(runtime, (chunk) => delivered.push(chunk))),
    );

    if (!isElizaError(failure)) {
      throw new Error(
        `expected an ElizaError rejection, got ${String(failure)}`,
      );
    }
    expect(failure.code).toBe("ROUTE_HANDLER_PARTIAL_WRITE_FAILURE");
    expect(failure.cause).toBeInstanceOf(Error);
    expect(failure.context).toMatchObject({
      method: "GET",
      path: FIXTURE_PATH,
      ended: false,
    });
    expect(failure.context?.partialBodyBytes).toBe(
      Buffer.byteLength("data: token-1\n\n"),
    );
    // Chunks flushed before the failure were already forwarded to the
    // streaming sink — the failure does not retract prior delivery.
    expect(Buffer.concat(delivered).toString("utf8")).toBe("data: token-1\n\n");
  });

  it("rejects typed when the handler ends the response and then throws", async () => {
    const runtime = runtimeWithHandler((res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
      throw new Error("post-response bookkeeping failed");
    });

    const failure = await rejectionOf(dispatchRoute(dispatchArgs(runtime)));

    if (!isElizaError(failure)) {
      throw new Error(
        `expected an ElizaError rejection, got ${String(failure)}`,
      );
    }
    expect(failure.code).toBe("ROUTE_HANDLER_PARTIAL_WRITE_FAILURE");
    expect(failure.context).toMatchObject({ ended: true });
    expect(failure.context?.partialBodyBase64Prefix).toBe(
      Buffer.from('{"ok":true}', "utf8").toString("base64"),
    );
  });

  it("still translates a handler that throws before any write into a structured 500", async () => {
    const runtime = runtimeWithHandler(() => {
      throw new Error("nothing was written");
    });

    await expect(dispatchRoute(dispatchArgs(runtime))).resolves.toMatchObject({
      status: 500,
      body: { error: "nothing was written" },
    });
  });
});

describe("dispatchRoute partial-write failure — HTTP boundary (Hono adapter)", () => {
  it("surfaces as a 500 to the HTTP caller instead of a truncated 200", async () => {
    const runtime = runtimeWithHandler((res) => {
      res.write("partial body");
      throw new Error("disk vanished mid-write");
    });
    const app = new Hono();
    mountRoutesOnHono(app, runtime, { isAuthorized: () => true });

    const response = await app.request(FIXTURE_PATH);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      error: "legacy route handler threw after writing its response",
    });
  });

  it("surfaces malformed declared JSON as a 500 to the HTTP caller", async () => {
    const runtime = runtimeWithHandler((res) => {
      res.setHeader("content-type", "application/json");
      res.end("{not-json");
    });
    const app = new Hono();
    mountRoutesOnHono(app, runtime, { isAuthorized: () => true });

    const response = await app.request(FIXTURE_PATH);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      error: "legacy route declared JSON but body is malformed",
    });
  });
});

describe("dispatchRoute partial-write failure — stdio-bridge IPC boundary", () => {
  // The same kernel serves the Android UDS, the iOS stdio pipe, and the
  // Electrobun local-agent child; an `{ok:false}` frame is what the desktop
  // LocalAgentStdioDispatcher translates into a rejected renderer RPC.
  function bridgeFor(runtime: AgentRuntime) {
    const frames: StdioBridgeResponseFrame[] = [];
    const bridge = createStdioBridge({
      request: async () =>
        dispatchBufferedRequest(runtime, dispatchRoute, {
          method: "GET",
          path: FIXTURE_PATH,
        }),
      requestStream: async (_frame, sink) =>
        dispatchStreamingRequest(
          runtime,
          dispatchRoute,
          { method: "GET", path: FIXTURE_PATH },
          sink,
        ),
      writeFrame: (frame) => {
        frames.push(frame);
      },
    });
    return { bridge, frames };
  }

  it("buffered request surfaces {ok:false} with the typed failure message", async () => {
    const runtime = runtimeWithHandler((res) => {
      res.write("partial body");
      throw new Error("disk vanished mid-write");
    });
    const { bridge, frames } = bridgeFor(runtime);

    await bridge.handleLine(
      JSON.stringify({ id: 7, method: "http_request", payload: {} }),
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      id: 7,
      ok: false,
      error: "legacy route handler threw after writing its response",
    });
  });

  it("buffered request surfaces {ok:false} for malformed declared JSON", async () => {
    const runtime = runtimeWithHandler((res) => {
      res.setHeader("content-type", "application/json");
      res.end("{not-json");
    });
    const { bridge, frames } = bridgeFor(runtime);

    await bridge.handleLine(
      JSON.stringify({ id: 8, method: "http_request", payload: {} }),
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      id: 8,
      ok: false,
      error: "legacy route declared JSON but body is malformed",
    });
  });

  it("streaming request delivers flushed chunks, then terminates with an error frame", async () => {
    const runtime = runtimeWithHandler((res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write("data: token-1\n\n");
      throw new Error("model backend fell over mid-stream");
    });
    const { bridge, frames } = bridgeFor(runtime);

    await bridge.handleLine(
      JSON.stringify({
        id: 9,
        method: "http_request_stream",
        stream: true,
        payload: {},
      }),
    );

    // Head and the pre-failure chunk were delivered; the terminal frame is an
    // error, not a clean complete — the WebView/renderer consumer sees the
    // stream fail rather than silently end.
    expect(frames.map((frame) => frame.stream)).toEqual([
      "response",
      "chunk",
      "complete",
    ]);
    const chunkFrame = frames[1];
    if (typeof chunkFrame.dataBase64 !== "string") {
      throw new Error("expected a base64 chunk frame before the failure");
    }
    expect(Buffer.from(chunkFrame.dataBase64, "base64").toString("utf8")).toBe(
      "data: token-1\n\n",
    );
    expect(frames[2]).toMatchObject({
      stream: "complete",
      error: "legacy route handler threw after writing its response",
    });
  });
});
