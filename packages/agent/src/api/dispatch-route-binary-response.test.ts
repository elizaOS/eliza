/**
 * Verifies lossless response finalization across the legacy route and native IPC boundary.
 */

import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
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

  it("does not let a charset parameter reclassify binary media as text", async () => {
    const bytes = Buffer.from([0xff, 0x00, 0x80, 0x7f]);
    const runtime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "application/pdf; charset=utf-8");
      response.end(bytes);
    });

    const result = await dispatch(runtime);

    expect(Buffer.isBuffer(result?.body)).toBe(true);
    expect(result?.body).toEqual(bytes);
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

  it.each([
    "application/xml",
    "application/problem+xml",
    "application/javascript",
    "application/x-javascript",
    "application/x-www-form-urlencoded",
  ])("keeps %s responses textual", async (contentType) => {
    const runtime = runtimeWithHandler((response) => {
      response.setHeader("content-type", contentType);
      response.end("route text");
    });

    await expect(dispatch(runtime)).resolves.toMatchObject({
      body: "route text",
    });
  });

  it("keeps authorization ahead of response-body handling", async () => {
    const privateRoute = {
      type: "GET",
      path: "/api/private",
      handler: async () => {
        throw new Error("private handler must not execute");
      },
    } as unknown as Route;

    await expect(
      dispatchRoute({
        runtime: { routes: [privateRoute] } as unknown as IAgentRuntime,
        method: "GET",
        path: "/api/private",
        headers: {},
        inProcess: true,
        isAuthorized: () => false,
      }),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: "Unauthorized" },
    });
  });

  it("passes parsed request state through return-shape handlers", async () => {
    const route = {
      type: "POST",
      path: "/api/items/:id",
      routeHandler: async (context: {
        params: Record<string, string>;
        body: unknown;
        query: Record<string, string | string[]>;
      }) => ({
        status: 201,
        body: {
          id: context.params.id,
          body: context.body,
          query: context.query,
        },
      }),
    } as unknown as Route;

    await expect(
      dispatchRoute({
        runtime: { routes: [route] } as unknown as IAgentRuntime,
        method: "POST",
        path: "/api/items/item-1",
        query: { mode: "strict" },
        body: '{"name":"sample"}',
        headers: { "content-type": "application/json" },
        inProcess: true,
        isAuthorized: () => true,
      }),
    ).resolves.toEqual({
      status: 201,
      body: {
        id: "item-1",
        body: { name: "sample" },
        query: { mode: "strict" },
      },
    });
  });

  it("rejects malformed declared JSON and returns empty responses as undefined", async () => {
    const invalidJsonRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "application/json");
      response.end("{not-json");
    });
    const emptyRuntime = runtimeWithHandler((response) => {
      response.setHeader("content-type", "audio/wav");
      response.end();
    });

    await expect(dispatch(invalidJsonRuntime)).rejects.toMatchObject({
      name: "ElizaError",
      code: "ROUTE_RESPONSE_INVALID_JSON",
    });
    await expect(dispatch(emptyRuntime)).resolves.toMatchObject({
      status: 200,
      body: undefined,
    });
  });
});
