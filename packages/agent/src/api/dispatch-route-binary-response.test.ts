/**
 * Verifies lossless response finalization across the legacy route and native IPC boundary.
 */

import { Buffer } from "node:buffer";
import type { IAgentRuntime, Route } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { dispatchBufferedRequest } from "../../../../plugins/plugin-capacitor-bridge/src/android/dispatch.ts";
import { dispatchRoute } from "./dispatch-route.ts";

function runtimeWithHandler(
  handler: (response: {
    setHeader(name: string, value: string): void;
    end(body?: unknown): void;
  }) => void,
): IAgentRuntime {
  const route = {
    type: "GET",
    path: "/api/response",
    public: true,
    publicReason: "Test-only response finalization fixture.",
    handler: async (_request: unknown, response: unknown) => {
      handler(
        response as {
          setHeader(name: string, value: string): void;
          end(body?: unknown): void;
        },
      );
    },
  } as unknown as Route;
  return { routes: [route] } as unknown as IAgentRuntime;
}

async function dispatch(runtime: IAgentRuntime, inProcess = true) {
  return dispatchRoute({
    runtime,
    method: "GET",
    path: "/api/response",
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
      path: "/api/response",
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

  it("does not decode content-encoded text before the client handles it", async () => {
    const encoded = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00]);
    const runtime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "text/plain; charset=utf-8");
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
    const textRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "text/plain");
      response.end("plain text");
    });

    await expect(dispatch(jsonRuntime)).resolves.toMatchObject({
      body: { error: "bad request" },
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

  it("returns malformed JSON as raw text and empty responses as undefined", async () => {
    const invalidJsonRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "application/json");
      response.end("{not-json");
    });
    const emptyRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "audio/wav");
      response.end();
    });

    await expect(dispatch(invalidJsonRuntime)).resolves.toMatchObject({
      body: "{not-json",
    });
    await expect(dispatch(emptyRuntime)).resolves.toMatchObject({
      status: 200,
      body: undefined,
    });
  });
});
