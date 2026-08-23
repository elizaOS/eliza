/**
 * Unit coverage for the Node-to-Hono runtime route mount. The suite drives the
 * exported mount through real Node HTTP requests and real route handlers,
 * covering eligibility, boundary metadata, response streaming, and cache
 * invalidation without replacing the module under test with mocks.
 */

import { Buffer } from "node:buffer";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AccessContext,
  IAgentRuntime,
  Route,
  RouteHandlerContext,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetHonoMountCache,
  tryHandleHonoRuntimeRoute,
} from "./hono-mount.ts";

interface RequestOptions {
  method?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
}

interface HarnessOptions {
  isAuthorized?: () => boolean;
  isTrustedLocal?: () => boolean;
  accessContext?: () => AccessContext | undefined;
}

interface HarnessResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function runtimeWithRoutes(routes: Route[]): IAgentRuntime {
  return { routes } as unknown as IAgentRuntime;
}

async function withMountServer<T>(
  runtime: IAgentRuntime | null | undefined,
  options: HarnessOptions,
  run: (
    send: (path: string, options?: RequestOptions) => Promise<HarnessResponse>,
  ) => Promise<T>,
): Promise<T> {
  const server = createServer((req, res) => {
    void tryHandleHonoRuntimeRoute({
      req,
      res,
      runtime,
      isAuthorized: options.isAuthorized ?? (() => false),
      isTrustedLocal: options.isTrustedLocal,
      accessContext: options.accessContext,
    })
      .then((handled) => {
        if (!handled) {
          res.statusCode = 418;
          res.end("node fallback");
        }
      })
      .catch((error: unknown) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const send = async (
    path: string,
    requestOptions: RequestOptions = {},
  ): Promise<HarnessResponse> =>
    new Promise((resolve, reject) => {
      const body = requestOptions.body;
      const headers = { ...requestOptions.headers };
      if (body !== undefined && headers["content-length"] === undefined) {
        headers["content-length"] = String(Buffer.byteLength(body));
      }
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: requestOptions.method ?? "GET",
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });

  try {
    return await run(send);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function publicRoute(
  path: string,
  routeHandler: Route["routeHandler"],
  type: Route["type"] = "GET",
): Route {
  return {
    type,
    path,
    name: `fixture-${type.toLowerCase()}-${path}`,
    public: true,
    publicReason: "Hono mount unit-test fixture.",
    ...(type === "GET"
      ? {}
      : { publicWrite: "The test harness owns this fixture mutation." }),
    routeHandler,
  };
}

afterEach(() => {
  resetHonoMountCache();
});

describe("tryHandleHonoRuntimeRoute", () => {
  it.each([
    ["a null runtime", null],
    ["an undefined runtime", undefined],
    ["an empty route table", runtimeWithRoutes([])],
  ])("leaves %s to the Node fallback", async (_label, runtime) => {
    await withMountServer(runtime, {}, async (send) => {
      const response = await send("/api/example");

      expect(response.status).toBe(418);
      expect(response.body).toBe("node fallback");
    });
  });

  it("leaves static, method-mismatched, legacy, and path-mismatched routes unhandled", async () => {
    const routes: Route[] = [
      {
        type: "STATIC",
        path: "/static",
        name: "fixture-static",
        public: true,
        publicReason: "Hono mount unit-test fixture.",
      },
      publicRoute("/api/post-only", async () => ({ status: 200 }), "POST"),
      {
        type: "GET",
        path: "/api/legacy",
        name: "fixture-legacy",
        public: true,
        publicReason: "Hono mount unit-test fixture.",
        handler: async (_req, res) => {
          res.end();
        },
      },
      publicRoute("/api/exact", async () => ({ status: 200 })),
    ];

    await withMountServer(runtimeWithRoutes(routes), {}, async (send) => {
      for (const path of [
        "/static",
        "/api/post-only",
        "/api/legacy",
        "/api/other",
      ]) {
        const response = await send(path);
        expect(response.status, path).toBe(418);
        expect(response.body, path).toBe("node fallback");
      }
    });
  });

  it("translates JSON, repeated query values, headers, and trusted-local state", async () => {
    let observed: RouteHandlerContext | undefined;
    const route = publicRoute(
      "/api/items/:itemId",
      async (context) => {
        observed = context;
        return {
          status: 202,
          headers: { "x-route": "translated" },
          body: { accepted: true },
        };
      },
      "POST",
    );

    await withMountServer(
      runtimeWithRoutes([route]),
      { isTrustedLocal: () => true },
      async (send) => {
        const response = await send("/api/items/alpha?tag=one&tag=two&empty=", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-client": "fixture",
          },
          body: '{"count":2}',
        });

        expect(response.status).toBe(202);
        expect(response.headers["x-route"]).toBe("translated");
        expect(JSON.parse(response.body)).toEqual({ accepted: true });
        expect(observed).toMatchObject({
          body: { count: 2 },
          rawBody: '{"count":2}',
          params: { itemId: "alpha" },
          query: { tag: ["one", "two"], empty: "" },
          method: "POST",
          path: "/api/items/alpha",
          inProcess: false,
          isTrustedLocal: true,
        });
        expect(observed?.headers["x-client"]).toBe("fixture");
      },
    );
  });

  it("overwrites client-supplied internal boundary headers", async () => {
    let observed: RouteHandlerContext | undefined;
    const route = publicRoute("/api/context", async (context) => {
      observed = context;
      return { status: 200, body: { ok: true } };
    });
    const accessContext: AccessContext = {
      requesterEntityId: "00000000-0000-0000-0000-000000000001",
      worldId: "00000000-0000-0000-0000-000000000002",
      role: "ADMIN",
      isOwner: false,
      source: "unit-test",
    };

    await withMountServer(
      runtimeWithRoutes([route]),
      {
        isAuthorized: () => true,
        isTrustedLocal: () => false,
        accessContext: () => accessContext,
      },
      async (send) => {
        const response = await send("/api/context", {
          headers: {
            "x-eliza-internal-authorized": "0",
            "x-eliza-internal-trusted-local": "1",
            "x-eliza-internal-access-context": JSON.stringify({
              requesterEntityId: "attacker",
              role: "OWNER",
              isOwner: true,
            }),
          },
        });

        expect(response.status).toBe(200);
        expect(observed?.headers["x-eliza-internal-authorized"]).toBe("1");
        expect(observed?.headers["x-eliza-internal-trusted-local"]).toBe("0");
        expect(observed?.accessContext).toEqual(accessContext);
      },
    );
  });

  it("drops a client-supplied principal when the boundary resolves none", async () => {
    let observed: RouteHandlerContext | undefined;
    const route = publicRoute("/api/no-context", async (context) => {
      observed = context;
      return { status: 200, body: { ok: true } };
    });

    await withMountServer(
      runtimeWithRoutes([route]),
      { accessContext: () => undefined },
      async (send) => {
        const response = await send("/api/no-context", {
          headers: {
            "x-eliza-internal-access-context": JSON.stringify({
              requesterEntityId: "attacker",
              role: "OWNER",
            }),
          },
        });

        expect(response.status).toBe(200);
        expect(observed?.accessContext).toBeUndefined();
        expect(
          observed?.headers["x-eliza-internal-access-context"],
        ).toBeUndefined();
      },
    );
  });

  it("sanitizes malformed boundary fields instead of granting them", async () => {
    let observed: RouteHandlerContext | undefined;
    const route = publicRoute("/api/sanitized-context", async (context) => {
      observed = context;
      return { status: 200, body: { ok: true } };
    });
    const malformed = {
      requesterEntityId: "00000000-0000-0000-0000-000000000003",
      worldId: 42,
      role: "SUPERUSER",
      isOwner: "yes",
      source: false,
    } as unknown as AccessContext;

    await withMountServer(
      runtimeWithRoutes([route]),
      { accessContext: () => malformed },
      async (send) => {
        const response = await send("/api/sanitized-context");

        expect(response.status).toBe(200);
        expect(observed?.accessContext).toEqual({
          requesterEntityId: "00000000-0000-0000-0000-000000000003",
        });
      },
    );
  });

  it("enforces authorization for a protected runtime route", async () => {
    let calls = 0;
    const route: Route = {
      type: "GET",
      path: "/api/protected",
      name: "fixture-protected",
      routeHandler: async () => {
        calls += 1;
        return { status: 200, body: { secret: true } };
      },
    };
    const runtime = runtimeWithRoutes([route]);

    await withMountServer(
      runtime,
      { isAuthorized: () => false },
      async (send) => {
        const response = await send("/api/protected");
        expect(response.status).toBe(401);
        expect(JSON.parse(response.body)).toEqual({ error: "Unauthorized" });
      },
    );
    await withMountServer(
      runtime,
      { isAuthorized: () => true },
      async (send) => {
        const response = await send("/api/protected");
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ secret: true });
      },
    );
    expect(calls).toBe(1);
  });

  it("pipes a streamed response and preserves its status and headers", async () => {
    async function* chunks(): AsyncGenerator<string | Uint8Array> {
      yield "first:";
      yield new TextEncoder().encode("second");
    }
    const route = publicRoute("/api/stream", async () => ({
      status: 206,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-stream": "yes",
      },
      stream: chunks(),
    }));

    await withMountServer(runtimeWithRoutes([route]), {}, async (send) => {
      const response = await send("/api/stream");

      expect(response.status).toBe(206);
      expect(response.headers["x-stream"]).toBe("yes");
      expect(response.body).toBe("first:second");
    });
  });

  it("ends a response whose route result has no body", async () => {
    const route = publicRoute("/api/no-content", async () => ({
      status: 204,
      headers: { "x-empty": "yes" },
      body: null,
    }));

    await withMountServer(runtimeWithRoutes([route]), {}, async (send) => {
      const response = await send("/api/no-content");

      expect(response.status).toBe(204);
      expect(response.headers["x-empty"]).toBe("yes");
      expect(response.body).toBe("");
    });
  });

  it("does not reuse a cached Hono app across runtimes", async () => {
    const first = runtimeWithRoutes([
      publicRoute("/api/value", async () => ({
        status: 200,
        body: { runtime: "first" },
      })),
    ]);
    const second = runtimeWithRoutes([
      publicRoute("/api/value", async () => ({
        status: 200,
        body: { runtime: "second" },
      })),
    ]);

    await withMountServer(first, {}, async (send) => {
      expect(JSON.parse((await send("/api/value")).body)).toEqual({
        runtime: "first",
      });
    });
    await withMountServer(second, {}, async (send) => {
      expect(JSON.parse((await send("/api/value")).body)).toEqual({
        runtime: "second",
      });
    });
  });
});

describe("resetHonoMountCache", () => {
  it("rebuilds the Hono app after the same runtime gains a route", async () => {
    const routes: Route[] = [
      publicRoute("/api/first", async () => ({
        status: 200,
        body: { route: "first" },
      })),
    ];
    const runtime = runtimeWithRoutes(routes);

    await withMountServer(runtime, {}, async (send) => {
      expect((await send("/api/first")).status).toBe(200);

      routes.push(
        publicRoute("/api/second", async () => ({
          status: 200,
          body: { route: "second" },
        })),
      );
      const beforeReset = await send("/api/second");
      expect(beforeReset.status).toBe(404);

      resetHonoMountCache();
      const afterReset = await send("/api/second");
      expect(afterReset.status).toBe(200);
      expect(JSON.parse(afterReset.body)).toEqual({ route: "second" });
    });
  });
});
