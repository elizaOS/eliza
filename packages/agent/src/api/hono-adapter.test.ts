/**
 * Unit coverage for the Hono plugin-route adapter using real Hono requests and
 * the canonical route dispatcher. The suite verifies route mounting, request
 * context translation, authorization, failure handling, and response encoding.
 */

import type {
  AccessContext,
  IAgentRuntime,
  Route,
  RouteHandlerContext,
} from "@elizaos/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildHonoAppForRuntime, mountRoutesOnHono } from "./hono-adapter.ts";

function runtimeWith(routes: Route[]): IAgentRuntime {
  return { routes } as unknown as IAgentRuntime;
}

function privateRoute(
  type: Exclude<Route["type"], "STATIC">,
  path: string,
  routeHandler: (ctx: RouteHandlerContext) => Promise<{
    status: number;
    headers?: Record<string, string>;
    body?: unknown;
    stream?: AsyncIterable<string | Uint8Array>;
  }>,
): Route {
  return { type, path, routeHandler };
}

describe("hono-adapter", () => {
  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"] as const)(
    "mounts a %s route and dispatches its real request method",
    async (method) => {
      const path = `/api/method/${method.toLowerCase()}`;
      const app = buildHonoAppForRuntime(
        runtimeWith([
          privateRoute(method, path, async (ctx) => ({
            status: 200,
            body: { method: ctx.method, path: ctx.path },
          })),
        ]),
        { isAuthorized: () => true },
      );

      const response = await app.request(path, { method });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ method, path });
    },
  );

  it("does not mount static routes or entries without a handler", async () => {
    const app = buildHonoAppForRuntime(
      runtimeWith([
        { type: "STATIC", path: "/assets", filePath: "./assets" },
        { type: "GET", path: "/api/handlerless" },
      ]),
      { isAuthorized: () => true },
    );

    expect((await app.request("/assets")).status).toBe(404);
    expect((await app.request("/api/handlerless")).status).toBe(404);
  });

  it("preserves route order when method and path tie", async () => {
    const app = buildHonoAppForRuntime(
      runtimeWith([
        privateRoute("GET", "/api/tie", async () => ({
          status: 200,
          body: { owner: "first" },
        })),
        privateRoute("GET", "/api/tie", async () => ({
          status: 200,
          body: { owner: "second" },
        })),
      ]),
      { isAuthorized: () => true },
    );

    expect(await (await app.request("/api/tie")).json()).toEqual({
      owner: "first",
    });
  });

  it("translates wildcard paths and supplies decoded route params", async () => {
    const app = buildHonoAppForRuntime(
      runtimeWith([
        privateRoute("GET", "/api/files/:rest*", async (ctx) => ({
          status: 200,
          body: ctx.params,
        })),
      ]),
      { isAuthorized: () => true },
    );

    const response = await app.request("/api/files/one/two%20words");

    expect(await response.json()).toEqual({ rest: "one/two words" });
    expect((await app.request("/api/files")).status).toBe(404);
  });

  it("marshals JSON, raw body, repeated query values, and headers", async () => {
    const app = buildHonoAppForRuntime(
      runtimeWith([
        privateRoute("POST", "/api/inspect/:id", async (ctx) => ({
          status: 200,
          body: {
            body: ctx.body,
            rawBody: ctx.rawBody,
            params: ctx.params,
            query: ctx.query,
            headers: ctx.headers,
            inProcess: ctx.inProcess,
          },
        })),
      ]),
      { isAuthorized: () => true },
    );
    const rawBody = '{"ready":true}';

    const response = await app.request(
      "/api/inspect/item%2042?tag=one&tag=two&empty=",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Fixture": "present",
        },
        body: rawBody,
      },
    );
    const result = (await response.json()) as {
      body: unknown;
      rawBody: string;
      params: Record<string, string>;
      query: Record<string, string | string[]>;
      headers: Record<string, string>;
      inProcess: boolean;
    };

    expect(result.body).toEqual({ ready: true });
    expect(result.rawBody).toBe(rawBody);
    expect(result.params).toEqual({ id: "item 42" });
    expect(result.query).toEqual({ tag: ["one", "two"], empty: "" });
    expect(result.headers["x-fixture"]).toBe("present");
    expect(result.inProcess).toBe(false);
  });

  it.each([
    {
      name: "empty JSON",
      headers: { "content-type": "application/json" },
      body: "",
      expected: { body: null, rawBody: "" },
    },
    {
      name: "malformed JSON",
      headers: { "content-type": "application/json" },
      body: "{broken",
      expected: { body: "{broken", rawBody: "{broken" },
    },
    {
      name: "plain text",
      headers: { "content-type": "text/plain" },
      body: "hello",
      expected: { body: "hello", rawBody: "hello" },
    },
  ])(
    "preserves $name request semantics",
    async ({ headers, body, expected }) => {
      const app = buildHonoAppForRuntime(
        runtimeWith([
          privateRoute("POST", "/api/body", async (ctx) => ({
            status: 200,
            body: {
              body: ctx.body ?? null,
              rawBody: ctx.rawBody,
            },
          })),
        ]),
        { isAuthorized: () => true },
      );

      const response = await app.request("/api/body", {
        method: "POST",
        headers,
        body,
      });

      expect(await response.json()).toEqual(expected);
    },
  );

  it("enforces private-route authorization before invoking the handler", async () => {
    let invoked = false;
    const app = buildHonoAppForRuntime(
      runtimeWith([
        privateRoute("GET", "/api/private", async () => {
          invoked = true;
          return { status: 200, body: { ok: true } };
        }),
      ]),
      { isAuthorized: () => false },
    );

    const response = await app.request("/api/private");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(invoked).toBe(false);
  });

  it("resolves trusted-local and requester access context at the boundary", async () => {
    const accessContext = {
      entityId: "viewer-1",
    } as unknown as AccessContext;
    const app = buildHonoAppForRuntime(
      runtimeWith([
        privateRoute("GET", "/api/context", async (ctx) => ({
          status: 200,
          body: {
            trusted: ctx.isTrustedLocal,
            accessContext: ctx.accessContext,
          },
        })),
      ]),
      {
        isAuthorized: () => true,
        isTrustedLocal: () => true,
        resolveAccessContext: () => accessContext,
      },
    );

    expect(await (await app.request("/api/context")).json()).toEqual({
      trusted: true,
      accessContext,
    });
  });

  it.each([
    {
      path: "/api/null",
      status: 204,
      body: null,
      contentType: null,
      expectedBytes: new Uint8Array(),
    },
    {
      path: "/api/text",
      status: 202,
      body: "accepted",
      contentType: "text/plain; charset=utf-8",
      expectedBytes: new TextEncoder().encode("accepted"),
    },
    {
      path: "/api/binary",
      status: 200,
      body: new Uint8Array([0, 1, 255]),
      contentType: "application/octet-stream",
      expectedBytes: new Uint8Array([0, 1, 255]),
    },
  ])(
    "encodes $path responses with status and default content type",
    async ({ path, status, body, contentType, expectedBytes }) => {
      const app = buildHonoAppForRuntime(
        runtimeWith([
          privateRoute("GET", path, async () => ({ status, body })),
        ]),
        { isAuthorized: () => true },
      );

      const response = await app.request(path);

      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        expectedBytes,
      );
    },
  );

  it("serializes object responses and preserves explicit headers", async () => {
    const app = buildHonoAppForRuntime(
      runtimeWith([
        privateRoute("GET", "/api/object", async () => ({
          status: 203,
          headers: {
            "content-type": "application/problem+json",
            "x-adapter": "kept",
          },
          body: { ok: false },
        })),
      ]),
      { isAuthorized: () => true },
    );

    const response = await app.request("/api/object");

    expect(response.status).toBe(203);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(response.headers.get("x-adapter")).toBe("kept");
    expect(await response.json()).toEqual({ ok: false });
  });

  it("streams text and bytes through the mounted Hono response", async () => {
    async function* chunks(): AsyncGenerator<string | Uint8Array> {
      yield "one";
      yield new TextEncoder().encode("-two");
    }
    const app = new Hono();
    mountRoutesOnHono(
      app,
      runtimeWith([
        privateRoute("GET", "/api/stream", async () => ({
          status: 206,
          headers: { "content-type": "text/event-stream" },
          stream: chunks(),
        })),
      ]),
      { isAuthorized: () => true },
    );

    const response = await app.request("/api/stream");

    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe("one-two");
  });

  it.each([
    { thrown: new Error("route exploded"), expected: "route exploded" },
    { thrown: "not-an-error", expected: "Internal server error" },
  ])("translates a rejected handler into a JSON 500", async (fixture) => {
    const app = buildHonoAppForRuntime(
      runtimeWith([
        privateRoute("GET", "/api/failure", async () => {
          throw fixture.thrown;
        }),
      ]),
      { isAuthorized: () => true },
    );

    const response = await app.request("/api/failure");

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: fixture.expected });
  });
});
