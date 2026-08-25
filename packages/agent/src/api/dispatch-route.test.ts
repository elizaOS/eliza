/**
 * Unit coverage for the canonical plugin-route dispatcher. The suite drives
 * real route tables through both return-shape and legacy handler paths,
 * including matching order, authorization, request normalization, response
 * capture, and request-scoped host-context restoration.
 */

import { Buffer } from "node:buffer";
import {
  getRuntimeRouteHostContext,
  type IAgentRuntime,
  type Route,
  type RouteHandlerContext,
  type RouteRequest,
  type RouteResponse,
  setRuntimeRouteHostContext,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { type DispatchRouteArgs, dispatchRoute } from "./dispatch-route.ts";

function runtimeWithRoutes(routes: Route[]): IAgentRuntime {
  return { routes } as unknown as IAgentRuntime;
}

function dispatch(
  runtime: IAgentRuntime | null | undefined,
  overrides: Partial<Omit<DispatchRouteArgs, "runtime">> = {},
) {
  return dispatchRoute({
    runtime,
    method: "GET",
    path: "/api/items",
    headers: {},
    inProcess: false,
    isAuthorized: () => true,
    ...overrides,
  });
}

function privateRoute(
  path: string,
  routeHandler: (context: RouteHandlerContext) => Promise<{
    status: number;
    body?: unknown;
  }>,
): Route {
  return { type: "GET", path, routeHandler };
}

describe("dispatchRoute routing", () => {
  it("returns null when the runtime or route table is absent or empty", async () => {
    await expect(dispatch(null)).resolves.toBeNull();
    await expect(dispatch(undefined)).resolves.toBeNull();
    await expect(dispatch(runtimeWithRoutes([]))).resolves.toBeNull();
  });

  it("skips static, wrong-method, handlerless, and wrong-path routes", async () => {
    const routes: Route[] = [
      { type: "STATIC", path: "/api/items", filePath: "/tmp/items" },
      {
        type: "POST",
        path: "/api/items",
        routeHandler: async () => ({ status: 201 }),
      },
      { type: "GET", path: "/api/items" },
      privateRoute("/api/other", async () => ({ status: 200 })),
    ];

    await expect(dispatch(runtimeWithRoutes(routes))).resolves.toBeNull();
  });

  it("uses the first matching route when paths tie", async () => {
    const visited: string[] = [];
    const routes = [
      privateRoute("/api/items", async () => {
        visited.push("first");
        return { status: 200, body: "first" };
      }),
      privateRoute("/api/items", async () => {
        visited.push("second");
        return { status: 200, body: "second" };
      }),
    ];

    await expect(dispatch(runtimeWithRoutes(routes))).resolves.toMatchObject({
      body: "first",
    });
    expect(visited).toEqual(["first"]);
  });

  it("matches normalized paths and decodes named parameters", async () => {
    let receivedParams: Record<string, string> | undefined;
    const route = privateRoute("/api/items/:itemId/", async (context) => {
      receivedParams = context.params;
      return { status: 200 };
    });

    await expect(
      dispatch(runtimeWithRoutes([route]), {
        path: "//api/items/hello%20world//",
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(receivedParams).toEqual({ itemId: "hello world" });
  });

  it("captures and decodes a non-empty wildcard tail", async () => {
    let receivedParams: Record<string, string> | undefined;
    const route = privateRoute("/api/files/:path*", async (context) => {
      receivedParams = context.params;
      return { status: 200 };
    });

    await dispatch(runtimeWithRoutes([route]), {
      path: "/api/files/folder/a%20b.txt",
    });

    expect(receivedParams).toEqual({ path: "folder/a b.txt" });
    await expect(
      dispatch(runtimeWithRoutes([route]), { path: "/api/files" }),
    ).resolves.toBeNull();
  });

  it("preserves malformed percent escapes in named and wildcard parameters", async () => {
    const seen: Array<Record<string, string>> = [];
    const routes = [
      privateRoute("/api/named/:value", async (context) => {
        seen.push(context.params);
        return { status: 200 };
      }),
      privateRoute("/api/wild/:value*", async (context) => {
        seen.push(context.params);
        return { status: 200 };
      }),
    ];
    const runtime = runtimeWithRoutes(routes);

    await dispatch(runtime, { path: "/api/named/%E0%A4%A" });
    await dispatch(runtime, { path: "/api/wild/%E0%A4%A/tail" });

    expect(seen).toEqual([{ value: "%E0%A4%A" }, { value: "%E0%A4%A/tail" }]);
  });

  it("returns 401 for a matching private route before invoking its handler", async () => {
    let invoked = false;
    const route = privateRoute("/api/items", async () => {
      invoked = true;
      return { status: 200 };
    });

    await expect(
      dispatch(runtimeWithRoutes([route]), { isAuthorized: () => false }),
    ).resolves.toEqual({
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: { error: "Unauthorized" },
    });
    expect(invoked).toBe(false);
  });

  it("lets an explicitly public read route bypass central authorization", async () => {
    let authorizationChecks = 0;
    const route: Route = {
      type: "GET",
      path: "/api/items",
      public: true,
      name: "public-items",
      publicReason: "Test-only public read fixture.",
      routeHandler: async () => ({ status: 200, body: { ok: true } }),
    };

    await expect(
      dispatch(runtimeWithRoutes([route]), {
        isAuthorized: () => {
          authorizationChecks += 1;
          return false;
        },
      }),
    ).resolves.toMatchObject({ status: 200, body: { ok: true } });
    expect(authorizationChecks).toBe(0);
  });
});

describe("dispatchRoute return-shape handlers", () => {
  it("normalizes and forwards the complete canonical handler context", async () => {
    let received: RouteHandlerContext | undefined;
    const runtime = runtimeWithRoutes([
      {
        type: "POST",
        path: "/api/items/:itemId",
        routeHandler: async (context) => {
          received = context;
          return { status: 202, body: { accepted: true } };
        },
      },
    ]);

    const result = await dispatch(runtime, {
      method: "post",
      path: "/api/items/42",
      headers: { "X-Trace-ID": "trace-1", ACCEPT: "application/json" },
      query: { tag: ["a", "b"] },
      body: Buffer.from('{"name":"Ada"}', "utf8"),
      rawBody: '{"name":"Ada"}',
      inProcess: true,
      isTrustedLocal: () => true,
    });

    expect(result).toEqual({ status: 202, body: { accepted: true } });
    expect(received).toMatchObject({
      body: { name: "Ada" },
      rawBody: '{"name":"Ada"}',
      params: { itemId: "42" },
      query: { tag: ["a", "b"] },
      headers: {
        "x-trace-id": "trace-1",
        accept: "application/json",
      },
      method: "POST",
      path: "/api/items/42",
      runtime,
      inProcess: true,
      isTrustedLocal: true,
    });
    expect(received).not.toHaveProperty("accessContext");
  });

  it("prefers routeHandler when a route also declares a legacy handler", async () => {
    const invoked: string[] = [];
    const route: Route = {
      type: "GET",
      path: "/api/items",
      routeHandler: async () => {
        invoked.push("routeHandler");
        return { status: 204 };
      },
      handler: async () => {
        invoked.push("legacy");
      },
    };

    await expect(dispatch(runtimeWithRoutes([route]))).resolves.toEqual({
      status: 204,
    });
    expect(invoked).toEqual(["routeHandler"]);
  });

  it("installs host context only for the dispatch and restores the previous value", async () => {
    const runtime = runtimeWithRoutes([]);
    const previous = { config: { owner: "previous" } };
    const active = { config: { owner: "active" } };
    setRuntimeRouteHostContext(runtime, previous);
    runtime.routes.push(
      privateRoute("/api/items", async () => {
        expect(getRuntimeRouteHostContext(runtime)).toBe(active);
        return { status: 200 };
      }),
    );

    await dispatch(runtime, { hostContext: active });

    expect(getRuntimeRouteHostContext(runtime)).toBe(previous);
  });

  it("restores host context when the handler rejects", async () => {
    const runtime = runtimeWithRoutes([]);
    const active = { config: { owner: "active" } };
    runtime.routes.push(
      privateRoute("/api/items", async () => {
        expect(getRuntimeRouteHostContext(runtime)).toBe(active);
        throw new Error("route failed");
      }),
    );

    await expect(dispatch(runtime, { hostContext: active })).rejects.toThrow(
      "route failed",
    );
    expect(getRuntimeRouteHostContext(runtime)).toBeNull();
  });
});

describe("dispatchRoute legacy handlers", () => {
  it("provides the Express-shaped request and captures status, headers, and JSON", async () => {
    let requestSnapshot: unknown;
    const route: Route = {
      type: "POST",
      path: "/api/items/:itemId",
      handler: async (req, res) => {
        const incoming = req as RouteRequest & {
          get(name: string): string | undefined;
          protocol: string;
        };
        requestSnapshot = {
          body: incoming.body,
          rawBody: incoming.rawBody,
          params: incoming.params,
          query: incoming.query,
          method: incoming.method,
          path: incoming.path,
          url: incoming.url,
          protocol: incoming.protocol,
          trace: incoming.get("X-Trace-ID"),
        };
        res.setHeader?.("X-Result", ["one", "two"]);
        res.status(201).json({ created: req.params?.itemId });
      },
    };

    const result = await dispatch(runtimeWithRoutes([route]), {
      method: "POST",
      path: "/api/items/7",
      headers: { "X-Trace-ID": "trace-7" },
      query: { expand: "owner" },
      body: '{"enabled":true}',
    });

    expect(requestSnapshot).toEqual({
      body: { enabled: true },
      rawBody: '{"enabled":true}',
      params: { itemId: "7" },
      query: { expand: "owner" },
      method: "POST",
      path: "/api/items/7",
      url: "/api/items/7",
      protocol: "http",
      trace: "trace-7",
    });
    expect(result).toEqual({
      status: 201,
      headers: {
        "x-result": "one, two",
        "content-type": "application/json; charset=utf-8",
      },
      body: { created: "7" },
    });
  });

  it("streams the raw request body and captures mixed write chunk types", async () => {
    const dataChunks: Buffer[] = [];
    const route: Route = {
      type: "POST",
      path: "/api/items",
      handler: async (req, res) => {
        const readable = req as RouteRequest & AsyncIterable<Buffer>;
        for await (const chunk of readable) dataChunks.push(chunk);
        const response = res as RouteResponse & {
          write(chunk: unknown): boolean;
          end(chunk?: unknown): RouteResponse;
        };
        response.write("a");
        response.write(new Uint8Array([98]));
        response.write(3);
        response.write(null);
        response.end("z");
      },
    };

    const result = await dispatch(runtimeWithRoutes([route]), {
      method: "POST",
      body: { value: true },
    });

    expect(Buffer.concat(dataChunks).toString("utf8")).toBe('{"value":true}');
    expect(result).toMatchObject({ status: 200, body: "ab3z" });
  });

  it("translates pre-write Error and non-Error failures into structured 500s", async () => {
    const errorRoute: Route = {
      type: "GET",
      path: "/api/items",
      handler: async () => {
        throw new Error("legacy failed");
      },
    };
    const nonErrorRoute: Route = {
      type: "GET",
      path: "/api/items",
      handler: async () => {
        throw "legacy failed";
      },
    };

    await expect(
      dispatch(runtimeWithRoutes([errorRoute])),
    ).resolves.toMatchObject({ status: 500, body: { error: "legacy failed" } });
    await expect(
      dispatch(runtimeWithRoutes([nonErrorRoute])),
    ).resolves.toMatchObject({
      status: 500,
      body: { error: "Internal server error" },
    });
  });
});
