/**
 * Deterministic contracts for the lazy route-graph sharding (issue #22550).
 * Exercises the real generated mount table and both `routeShardKey`
 * implementations (runtime TypeScript and codegen mjs) without evaluating any
 * route module: dispatch equivalence is proven with stub Hono sub-apps.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
// @ts-expect-error - plain node script without type declarations.
import { routeShardKey as codegenRouteShardKey } from "./_generate-router.mjs";
import { ROUTE_MOUNTS, ROUTE_SHARD_KEYS } from "./_router.generated";
import { routeShardKey } from "./router-shards";

/** A concrete request path a mount pattern can match. */
function concretePathFor(mountPath: string): string {
  return mountPath
    .split("/")
    .map((segment) => {
      if (segment === ":*{.+}") return "alpha/beta";
      if (segment.startsWith(":")) return "concrete-value";
      return segment;
    })
    .join("/");
}

const REQUEST_SAMPLES: ReadonlyArray<readonly [string, string | null]> = [
  ["/", null],
  ["/steward/auth/providers", null],
  ["/api", null],
  ["/api/", null],
  ["/api/auth/cli-session/00000000-0000-4000-8000-000000000000", "auth"],
  ["/api/auth/cli-session/", "auth"],
  ["/api/v1", null],
  ["/api/v1/", null],
  ["/api/v1/chat/completions", "v1/chat"],
  ["/api/%61uth/cli-session/example", "auth"],
  ["/api/%76%31/%63hat/completions", "v1/chat"],
  ["/api/%zz", "%zz"],
  ["/api/v1/apps/123/chat", "v1/apps"],
  ["/api/.well-known/jwks.json", ".well-known"],
  ["/api/cron/agent-billing", "cron"],
  ["/api/no-such-family/whatever", "no-such-family"],
];

describe("routeShardKey", () => {
  test("resolves representative request paths", () => {
    for (const [path, expected] of REQUEST_SAMPLES) {
      expect(routeShardKey(path)).toBe(expected);
    }
  });

  test("treats param and splat shard positions as shared", () => {
    expect(routeShardKey("/api/:id/a2a")).toBeNull();
    expect(routeShardKey("/api/:*{.+}")).toBeNull();
    expect(routeShardKey("/api/v1/:id")).toBeNull();
    expect(routeShardKey("/api/v1/:*{.+}")).toBeNull();
  });

  test("matches the codegen implementation on every mount and sample path", () => {
    const paths = [
      ...ROUTE_MOUNTS.map((mount) => mount.path),
      ...REQUEST_SAMPLES.map(([path]) => path),
    ];
    for (const path of paths) {
      expect(routeShardKey(path)).toBe(codegenRouteShardKey(path));
    }
  });
});

describe("generated mount table", () => {
  test("stores the shard key routeShardKey derives from each mount path", () => {
    for (const mount of ROUTE_MOUNTS) {
      expect(mount.shard).toBe(routeShardKey(mount.path));
    }
  });

  test("ROUTE_SHARD_KEYS is the sorted set of non-null shards", () => {
    const expected = [
      ...new Set(
        ROUTE_MOUNTS.map((mount) => mount.shard).filter(
          (shard): shard is string => shard !== null,
        ),
      ),
    ].sort();
    expect([...ROUTE_SHARD_KEYS]).toEqual(expected);
  });

  test("every request a mount can match resolves to that mount's shard", () => {
    for (const mount of ROUTE_MOUNTS) {
      if (mount.shard === null) continue;
      expect(routeShardKey(concretePathFor(mount.path))).toBe(mount.shard);
    }
  });
});

describe("shard dispatch equivalence", () => {
  function stubApp(label: string): Hono {
    const app = new Hono();
    app.all("/", (c) => c.text(label));
    app.all("/*", (c) => c.text(label));
    return app;
  }

  function buildStubRouter(shard: string | null | "all"): Hono {
    const app = new Hono({ strict: false });
    for (const mount of ROUTE_MOUNTS) {
      if (shard !== "all" && mount.shard !== null && mount.shard !== shard) {
        continue;
      }
      app.route(mount.path, stubApp(mount.path));
    }
    app.notFound((c) => c.text("__not_found__", 404));
    return app;
  }

  test("a shard-filtered router matches the same route as the full router", async () => {
    const fullRouter = buildStubRouter("all");
    for (const mount of ROUTE_MOUNTS) {
      const requestPath = concretePathFor(mount.path);
      const shardRouter = buildStubRouter(routeShardKey(requestPath));
      const [full, sharded] = await Promise.all([
        fullRouter.request(requestPath),
        shardRouter.request(requestPath),
      ]);
      expect(sharded.status).toBe(full.status);
      expect(await sharded.text()).toBe(await full.text());
    }
  });

  test("unmatched paths 404 identically in shard and full routers", async () => {
    const fullRouter = buildStubRouter("all");
    for (const path of ["/api/never-mounted/x", "/api/v1/never-mounted/x"]) {
      const shardRouter = buildStubRouter(routeShardKey(path));
      expect((await shardRouter.request(path)).status).toBe(404);
      expect((await fullRouter.request(path)).status).toBe(404);
    }
  });

  test("encoded literal paths select the shard Hono actually matches", async () => {
    const fullRouter = buildStubRouter("all");
    for (const [path, expectedShard] of [
      ["/api/%61uth/cli-session/concrete-value", "auth"],
      ["/api/%76%31/%63hat/completions", "v1/chat"],
    ] as const) {
      const shardRouter = buildStubRouter(routeShardKey(path));
      expect(routeShardKey(path)).toBe(expectedShard);
      const [full, sharded] = await Promise.all([
        fullRouter.request(path),
        shardRouter.request(path),
      ]);
      expect(full.status).toBe(200);
      expect(sharded.status).toBe(full.status);
      expect(await sharded.text()).toBe(await full.text());
    }
  });
});
