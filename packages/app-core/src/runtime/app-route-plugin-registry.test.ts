/**
 * Covers the app-core app-route-plugin registry barrel: registering deferred
 * plugin route loaders, listing them in registration order with copy-on-list
 * semantics, and draining them onto a runtime route table — including path
 * normalization, idempotent re-drains, duplicate suppression against and within
 * a batch, no-route plugins, the optional-unavailable `Error.name` skip
 * contract, public-route intent enforcement, and fail-fast on unexpected loader
 * errors. Drives the real process-global registry through the re-exported
 * functions; no module mocks.
 */

import type { Plugin, Route } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  type AppRoutePluginLoader,
  type AppRoutePluginRegistryEntry,
  drainAppRoutePluginLoaders,
  listAppRoutePluginLoaders,
  registerAppRoutePluginLoader,
} from "./app-route-plugin-registry.ts";

let idCounter = 0;

function uniqueId(tag: string): string {
  idCounter += 1;
  return `app-route-registry-test:${tag}:${idCounter}`;
}

function pluginWithRoutes(
  name: string,
  routes: Route[],
): () => Promise<Plugin> {
  return async () => ({ name, description: `${name} test plugin`, routes });
}

/** The registry is process-global, so exact-content drains pass an explicit
 * loader list holding only this test's entries; the default-list path is
 * exercised separately with containment assertions. */
function loadersFor(...ids: string[]): AppRoutePluginRegistryEntry[] {
  return listAppRoutePluginLoaders().filter((e) => ids.includes(e.id));
}

describe("registerAppRoutePluginLoader + listAppRoutePluginLoaders", () => {
  it("stores a registered loader under its id and hands back the same function", () => {
    const id = uniqueId("roundtrip");
    const load: AppRoutePluginLoader = pluginWithRoutes(id, []);

    registerAppRoutePluginLoader(id, load);

    const entry = listAppRoutePluginLoaders().find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry?.load).toBe(load);
  });

  it("lists entries in first-registration order", () => {
    const start = listAppRoutePluginLoaders().length;
    const ids = [uniqueId("order-a"), uniqueId("order-b"), uniqueId("order-c")];
    for (const id of ids) {
      registerAppRoutePluginLoader(id, pluginWithRoutes(id, []));
    }

    const tail = listAppRoutePluginLoaders()
      .slice(start)
      .map((e) => e.id);
    expect(tail).toEqual(ids);
  });

  it("re-registering an id replaces the stored loader instead of appending", () => {
    const id = uniqueId("replace");
    const first: AppRoutePluginLoader = pluginWithRoutes(id, []);
    const second: AppRoutePluginLoader = pluginWithRoutes(id, []);

    registerAppRoutePluginLoader(id, first);
    registerAppRoutePluginLoader(id, second);

    const matches = listAppRoutePluginLoaders().filter((e) => e.id === id);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.load).toBe(second);
  });

  it("returns a fresh array on every call so callers cannot mutate the registry", () => {
    const before = listAppRoutePluginLoaders().length;
    const snapshotA = listAppRoutePluginLoaders();
    const snapshotB = listAppRoutePluginLoaders();

    expect(snapshotA).not.toBe(snapshotB);

    snapshotA.push({
      id: "mutated-copy",
      load: () => ({ name: "mutated-copy", description: "sentinel" }),
    });
    expect(listAppRoutePluginLoaders()).toHaveLength(before);
    expect(
      listAppRoutePluginLoaders().some((e) => e.id === "mutated-copy"),
    ).toBe(false);
  });
});

describe("drainAppRoutePluginLoaders", () => {
  it("drains the registered loaders onto a target table when called without an explicit list", async () => {
    const alpha = uniqueId("default-alpha");
    const bravo = uniqueId("default-bravo");
    registerAppRoutePluginLoader(
      alpha,
      pluginWithRoutes(alpha, [{ type: "GET", path: "/alpha", name: alpha }]),
    );
    registerAppRoutePluginLoader(bravo, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return {
        name: bravo,
        description: bravo,
        routes: [{ type: "GET", path: "/bravo", name: bravo }],
      };
    });

    const target: { routes: Route[] } = { routes: [] };
    await drainAppRoutePluginLoaders(target);

    const paths = target.routes.map((r) => r.path);
    expect(paths).toContain("/alpha");
    expect(paths).toContain("/bravo");
  });

  it("keeps newly added routes in registration order", async () => {
    const ids = [
      uniqueId("drain-order-a"),
      uniqueId("drain-order-b"),
      uniqueId("drain-order-c"),
    ];
    ids.forEach((id, index) => {
      registerAppRoutePluginLoader(
        id,
        pluginWithRoutes(id, [
          { type: "GET", path: `/ordered-${index}`, name: id },
        ]),
      );
    });

    const target: { routes: Route[] } = { routes: [] };
    await drainAppRoutePluginLoaders(target, loadersFor(...ids));

    expect(target.routes.map((r) => r.path)).toEqual([
      "/ordered-0",
      "/ordered-1",
      "/ordered-2",
    ]);
  });

  it("returns immediately when there are no loaders to drain", async () => {
    const seeded: Route[] = [{ type: "GET", path: "/seeded", name: "seed" }];
    const target: { routes: Route[] } = { routes: seeded };

    await drainAppRoutePluginLoaders(target, []);

    expect(target.routes).toEqual(seeded);
  });

  it("is idempotent: re-draining into the same table adds nothing", async () => {
    const id = uniqueId("idempotent");
    registerAppRoutePluginLoader(
      id,
      pluginWithRoutes(id, [
        { type: "GET", path: `/once-${id}`, name: id },
        { type: "POST", path: `/once-post-${id}`, name: id },
      ]),
    );

    const target: { routes: Route[] } = { routes: [] };
    await drainAppRoutePluginLoaders(target, loadersFor(id));
    const afterFirst = [...target.routes];
    await drainAppRoutePluginLoaders(target, loadersFor(id));

    expect(target.routes).toEqual(afterFirst);
    expect(target.routes).toHaveLength(2);
  });

  it("suppresses duplicates against routes already in the table and within one batch", async () => {
    const dupe = uniqueId("dupe");
    const other = uniqueId("other");
    registerAppRoutePluginLoader(
      dupe,
      pluginWithRoutes(dupe, [
        { type: "GET", path: "/shared", name: dupe },
        { type: "GET", path: "/fresh", name: dupe },
      ]),
    );
    registerAppRoutePluginLoader(
      other,
      pluginWithRoutes(other, [{ type: "GET", path: "/shared", name: other }]),
    );

    const target: { routes: Route[] } = {
      routes: [{ type: "GET", path: "/shared", name: "preexisting" }],
    };
    await drainAppRoutePluginLoaders(target, loadersFor(dupe, other));

    expect(target.routes.map((r) => r.path)).toEqual(["/shared", "/fresh"]);
    expect(target.routes.filter((r) => r.path === "/shared")).toHaveLength(1);
  });

  it("normalizes relative route paths to absolute while preserving the rest of the route", async () => {
    const id = uniqueId("normalize");
    const route: Route = {
      type: "GET",
      path: "relative",
      name: id,
      rawPath: true,
    };
    registerAppRoutePluginLoader(id, pluginWithRoutes(id, [route]));

    const target: { routes: Route[] } = { routes: [] };
    await drainAppRoutePluginLoaders(target, loadersFor(id));

    expect(target.routes).toHaveLength(1);
    expect(target.routes[0]).toEqual({
      type: "GET",
      path: "/relative",
      name: id,
      rawPath: true,
    });
  });

  it("skips plugins that contribute no routes without failing the drain", async () => {
    const empty = uniqueId("empty-routes");
    const routed = uniqueId("with-routes");
    registerAppRoutePluginLoader(empty, pluginWithRoutes(empty, []));
    registerAppRoutePluginLoader(
      routed,
      pluginWithRoutes(routed, [
        { type: "GET", path: "/routed", name: routed },
      ]),
    );

    const target: { routes: Route[] } = { routes: [] };
    await drainAppRoutePluginLoaders(target, loadersFor(empty, routed));

    expect(target.routes.map((r) => r.path)).toEqual(["/routed"]);
  });

  it("skips an intentionally-absent optional plugin by its Error.name contract and drains the rest", async () => {
    const ghost = uniqueId("ghost");
    const healthy = uniqueId("healthy");
    registerAppRoutePluginLoader(ghost, async () => {
      throw Object.assign(new Error("@elizaos/plugin-ghost is not installed"), {
        name: "OptionalAppRoutePluginUnavailableError",
        specifier: "@elizaos/plugin-ghost",
      });
    });
    registerAppRoutePluginLoader(
      healthy,
      pluginWithRoutes(healthy, [
        { type: "GET", path: "/healthy", name: healthy },
      ]),
    );

    const mine = listAppRoutePluginLoaders().filter(
      (e) => e.id === ghost || e.id === healthy,
    );
    const target: { routes: Route[] } = { routes: [] };

    await expect(
      drainAppRoutePluginLoaders(target, mine),
    ).resolves.toBeUndefined();

    expect(target.routes.map((r) => r.path)).toEqual(["/healthy"]);
  });

  it("propagates unexpected loader failures and leaves the table unregistered", async () => {
    const broken = uniqueId("broken");
    const fine = uniqueId("fine");
    registerAppRoutePluginLoader(broken, async () => {
      throw new TypeError("boom");
    });
    registerAppRoutePluginLoader(
      fine,
      pluginWithRoutes(fine, [
        { type: "GET", path: "/never-registered", name: fine },
      ]),
    );

    const mine = listAppRoutePluginLoaders().filter(
      (e) => e.id === broken || e.id === fine,
    );
    const target: { routes: Route[] } = { routes: [] };

    await expect(drainAppRoutePluginLoaders(target, mine)).rejects.toThrow(
      "boom",
    );
    expect(target.routes).toHaveLength(0);
  });

  it("rejects a public GET route that declares no publicReason", async () => {
    const id = uniqueId("public-no-reason");
    // The literal omits the compile-time-required `publicReason`; the point of
    // this case is that drain enforces the intent contract at runtime too.
    registerAppRoutePluginLoader(
      id,
      pluginWithRoutes(id, [
        { type: "GET", path: "/open", name: id, public: true },
      ] as unknown as Route[]),
    );

    const mine = listAppRoutePluginLoaders().filter((e) => e.id === id);
    const target: { routes: Route[] } = { routes: [] };

    await expect(drainAppRoutePluginLoaders(target, mine)).rejects.toThrow(
      /must declare publicReason/,
    );
    expect(target.routes).toHaveLength(0);
  });

  it("accepts a well-formed public GET route carrying its publicReason", async () => {
    const id = uniqueId("public-ok");
    registerAppRoutePluginLoader(
      id,
      pluginWithRoutes(id, [
        {
          type: "GET",
          path: "/healthz",
          name: id,
          public: true,
          publicReason: "liveness probe must be reachable unauthenticated",
        },
      ]),
    );

    const mine = listAppRoutePluginLoaders().filter((e) => e.id === id);
    const target: { routes: Route[] } = { routes: [] };

    await expect(
      drainAppRoutePluginLoaders(target, mine),
    ).resolves.toBeUndefined();

    expect(target.routes).toHaveLength(1);
    expect(target.routes[0]?.path).toBe("/healthz");
  });

  it("rejects a public write-method route that names no out-of-band auth", async () => {
    const id = uniqueId("public-write-no-auth");
    registerAppRoutePluginLoader(
      id,
      pluginWithRoutes(id, [
        {
          type: "POST",
          path: "/webhook",
          name: id,
          public: true,
          publicReason: "external service callback",
        },
      ]),
    );

    const mine = listAppRoutePluginLoaders().filter((e) => e.id === id);
    const target: { routes: Route[] } = { routes: [] };

    await expect(drainAppRoutePluginLoaders(target, mine)).rejects.toThrow(
      /must declare publicWrite/,
    );
    expect(target.routes).toHaveLength(0);
  });
});
