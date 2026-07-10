/**
 * Byte-classification regression suite for the legacy-route response capture in
 * `dispatchRoute` (#15944 follow-up). Drives the real dispatcher against a real
 * `AgentRuntime` route table — no mock of the unit under test — and asserts the
 * RFC 9110 media-type-essence rules: parameters (`charset=…`) never reclassify
 * binary media as text, comparison is case-insensitive, non-identity
 * content-encoding forces byte passthrough, and a declared-JSON body that does
 * not parse fails typed instead of returning raw text as success.
 */

import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import {
  AgentRuntime,
  type Character,
  isElizaError,
  type Route,
  type RouteResponse,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { dispatchBufferedRequest } from "../../../../plugins/plugin-capacitor-bridge/src/android/dispatch.ts";
import { dispatchRoute } from "./dispatch-route.ts";

/**
 * The response surface the legacy shim actually provides. `RouteResponse`
 * types the conservative subset plugin authors may rely on; the shim also
 * accepts an optional chunk on `end` and exposes `write`, which legacy
 * Express-shaped handlers use. Narrowed via a runtime guard rather than a
 * cast so the fixture fails loudly if the shim contract regresses.
 */
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

const FIXTURE_PATH = "/api/response";

/** Real runtime whose route table serves the fixture handler. */
function runtimeWithHandler(
  handler: (response: ShimResponse) => void,
): AgentRuntime {
  const character: Character = { name: "dispatch-route-fixture" };
  const runtime = new AgentRuntime({ character });
  const route: Route = {
    type: "GET",
    path: FIXTURE_PATH,
    name: "dispatch-response-fixture",
    public: true,
    publicReason: "Test-only response finalization fixture.",
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

async function dispatch(runtime: AgentRuntime, inProcess = true) {
  return dispatchRoute({
    runtime,
    method: "GET",
    path: FIXTURE_PATH,
    headers: {},
    inProcess,
    isAuthorized: () => true,
  });
}

describe("dispatchRoute captured response finalization", () => {
  it("preserves invalid UTF-8 bytes through the Android buffered IPC envelope", async () => {
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0x80]);
    const runtime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "audio/wav");
      response.end(bytes);
    });

    const result = await dispatchBufferedRequest(runtime, dispatchRoute, {
      method: "GET",
      path: FIXTURE_PATH,
    });

    expect(result.bodyEncoding).toBe("base64");
    expect(Buffer.from(result.bodyBase64, "base64")).toEqual(bytes);
  });

  it.each([
    true,
    false,
  ])("keeps binary bodies as buffers when inProcess=%s", async (inProcess) => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    const runtime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "application/octet-stream");
      response.end(bytes);
    });

    const result = await dispatch(runtime, inProcess);

    expect(Buffer.isBuffer(result?.body)).toBe(true);
    expect(result?.body).toEqual(bytes);
  });

  it("does not let a charset parameter reclassify binary media as text", async () => {
    // The original substring classifier matched `charset` and decoded these
    // bytes as UTF-8, corrupting them through the base64 IPC envelope.
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0x80, 0x7f]);
    const runtime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "audio/wav; charset=utf-8");
      response.end(bytes);
    });

    const result = await dispatch(runtime);

    expect(Buffer.isBuffer(result?.body)).toBe(true);
    expect(result?.body).toEqual(bytes);
  });

  it("classifies mixed-case media types case-insensitively", async () => {
    // RFC 9110 §8.3: media types compare case-insensitively. Header values are
    // not case-normalized at capture, so the essence comparison must be.
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0x80]);
    const binaryRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "Audio/WAV; Charset=UTF-8");
      response.end(bytes);
    });
    const jsonRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "APPLICATION/JSON");
      response.end('{"ok":true}');
    });
    const suffixRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "Application/Problem+JSON");
      response.end('{"error":"bad request"}');
    });
    const textRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "TEXT/Plain");
      response.end("upper text");
    });

    const binaryResult = await dispatch(binaryRuntime);
    expect(Buffer.isBuffer(binaryResult?.body)).toBe(true);
    expect(binaryResult?.body).toEqual(bytes);

    await expect(dispatch(jsonRuntime)).resolves.toMatchObject({
      body: { ok: true },
    });
    await expect(dispatch(suffixRuntime)).resolves.toMatchObject({
      body: { error: "bad request" },
    });
    await expect(dispatch(textRuntime)).resolves.toMatchObject({
      body: "upper text",
    });
  });

  it("does not decode content-encoded text before the client handles it", async () => {
    const encoded = gzipSync("hello from the route");
    const runtime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.setHeader("content-encoding", "gzip");
      response.end(encoded);
    });

    const result = await dispatch(runtime);

    expect(Buffer.isBuffer(result?.body)).toBe(true);
    expect(result?.body).toEqual(encoded);
  });

  it("keeps gzip-encoded JSON as bytes rather than parsing compressed data", async () => {
    const encoded = gzipSync('{"compressed":true}');
    const runtime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("content-encoding", "gzip");
      response.end(encoded);
    });

    const result = await dispatch(runtime);

    expect(Buffer.isBuffer(result?.body)).toBe(true);
    expect(result?.body).toEqual(encoded);
  });

  it("preserves textual and JSON response compatibility", async () => {
    const jsonRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "application/problem+json");
      response.end('{"error":"bad request"}');
    });
    const xmlRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "image/svg+xml");
      response.end("<svg/>");
    });
    const textRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "text/plain");
      response.end("plain text");
    });

    await expect(dispatch(jsonRuntime)).resolves.toMatchObject({
      body: { error: "bad request" },
    });
    await expect(dispatch(xmlRuntime)).resolves.toMatchObject({
      body: "<svg/>",
    });
    await expect(dispatch(textRuntime)).resolves.toMatchObject({
      body: "plain text",
    });
  });

  it("treats absent content-type as textual UTF-8", async () => {
    const runtime = runtimeWithHandler((response) => {
      response.end("undeclared text");
    });

    await expect(dispatch(runtime)).resolves.toMatchObject({
      body: "undeclared text",
    });
  });

  it("keeps identity-encoded and empty content-type responses textual", async () => {
    const identityRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "text/plain");
      response.setHeader("content-encoding", "identity");
      response.end("identity text");
    });
    const emptyTypeRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "");
      response.end("empty type text");
    });

    await expect(dispatch(identityRuntime)).resolves.toMatchObject({
      body: "identity text",
    });
    await expect(dispatch(emptyTypeRuntime)).resolves.toMatchObject({
      body: "empty type text",
    });
  });

  it("throws typed ROUTE_RESPONSE_INVALID_JSON for malformed declared JSON", async () => {
    const invalidJsonRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end("{not-json");
    });

    const failure = await dispatch(invalidJsonRuntime).then(
      () => null,
      (err: unknown) => err,
    );
    if (!isElizaError(failure)) {
      throw new Error(
        `expected an ElizaError rejection, got ${String(failure)}`,
      );
    }
    expect(failure.code).toBe("ROUTE_RESPONSE_INVALID_JSON");
    expect(failure.cause).toBeInstanceOf(SyntaxError);
    expect(failure.context).toMatchObject({
      contentType: "application/json; charset=utf-8",
      status: 200,
    });
  });

  it("throws typed ROUTE_RESPONSE_INVALID_JSON for malformed structured-suffix JSON", async () => {
    const runtime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "application/problem+json");
      response.end("{broken");
    });

    const failure = await dispatch(runtime).then(
      () => null,
      (err: unknown) => err,
    );
    if (!isElizaError(failure)) {
      throw new Error(
        `expected an ElizaError rejection, got ${String(failure)}`,
      );
    }
    expect(failure.code).toBe("ROUTE_RESPONSE_INVALID_JSON");
  });

  it("returns empty responses as undefined with the handler status", async () => {
    const emptyRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "audio/wav");
      response.end();
    });

    await expect(dispatch(emptyRuntime)).resolves.toMatchObject({
      status: 200,
      body: undefined,
    });
  });
});
