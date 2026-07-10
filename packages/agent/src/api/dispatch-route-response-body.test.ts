/**
 * Verifies that the legacy route shim preserves response-wire bytes while
 * decoding only unencoded textual media into structured handler results.
 */

import { gzipSync } from "node:zlib";
import type { IAgentRuntime, Route } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { dispatchRoute } from "./dispatch-route.ts";

function runtimeWithBody(
  body: Buffer | string,
  headers: Record<string, string>,
): IAgentRuntime {
  const route: Route = {
    type: "GET",
    path: "/api/body",
    public: true,
    publicReason: "Synthetic response-body transport fixture.",
    handler: async (_req: unknown, res: unknown) => {
      const response = res as {
        setHeader: (name: string, value: string) => void;
        end: (chunk: Buffer | string) => void;
      };
      for (const [name, value] of Object.entries(headers)) {
        response.setHeader(name, value);
      }
      response.end(body);
    },
  } as unknown as Route;
  return { routes: [route] } as unknown as IAgentRuntime;
}

async function dispatch(
  body: Buffer | string,
  headers: Record<string, string>,
) {
  return dispatchRoute({
    runtime: runtimeWithBody(body, headers),
    method: "GET",
    path: "/api/body",
    headers: {},
    inProcess: true,
    isAuthorized: () => true,
  });
}

describe("dispatchRoute legacy response bodies", () => {
  it("preserves arbitrary audio bytes", async () => {
    const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0x80, 0x57]);
    const result = await dispatch(wav, { "content-type": "audio/wav" });

    expect(Buffer.isBuffer(result?.body)).toBe(true);
    expect(result?.body).toEqual(wav);
  });

  it("preserves compressed text until the receiving transport decodes it", async () => {
    const compressed = gzipSync("hello from the route");
    const result = await dispatch(compressed, {
      "content-type": "text/plain; charset=utf-8",
      "content-encoding": "gzip",
    });

    expect(result?.body).toEqual(compressed);
  });

  it("parses JSON media types with parameters and structured suffixes", async () => {
    const standard = await dispatch('{"ok":true}', {
      "content-type": "application/json; charset=utf-8",
    });
    const vendor = await dispatch('{"ok":true}', {
      "content-type": "application/vnd.eliza+json",
    });

    expect(standard?.body).toEqual({ ok: true });
    expect(vendor?.body).toEqual({ ok: true });
  });

  it("rejects malformed JSON instead of fabricating a text success", async () => {
    await expect(
      dispatch("not-json", { "content-type": "application/json" }),
    ).rejects.toMatchObject({
      name: "ElizaError",
      code: "ROUTE_RESPONSE_INVALID_JSON",
    });
  });

  it("keeps authorization ahead of response-body handling", async () => {
    const privateRoute: Route = {
      type: "GET",
      path: "/api/private",
      handler: async () => {
        throw new Error("private handler must not execute");
      },
    } as unknown as Route;

    const result = await dispatchRoute({
      runtime: { routes: [privateRoute] } as unknown as IAgentRuntime,
      method: "GET",
      path: "/api/private",
      headers: {},
      inProcess: true,
      isAuthorized: () => false,
    });

    expect(result).toMatchObject({
      status: 401,
      body: { error: "Unauthorized" },
    });
  });

  it("passes parsed request state through return-shape handlers", async () => {
    const route: Route = {
      type: "POST",
      path: "/api/items/:id",
      routeHandler: async (ctx) => ({
        status: 201,
        body: {
          id: ctx.params.id,
          body: ctx.body,
          query: ctx.query,
        },
      }),
    } as Route;

    const result = await dispatchRoute({
      runtime: { routes: [route] } as unknown as IAgentRuntime,
      method: "POST",
      path: "/api/items/item-1",
      query: { mode: "strict" },
      body: '{"name":"sample"}',
      headers: { "content-type": "application/json" },
      inProcess: true,
      isAuthorized: () => true,
    });

    expect(result).toEqual({
      status: 201,
      body: {
        id: "item-1",
        body: { name: "sample" },
        query: { mode: "strict" },
      },
    });
  });
});
