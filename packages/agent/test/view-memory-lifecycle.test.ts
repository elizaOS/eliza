/**
 * View registry memory lifecycle tests.
 *
 * Exercises the real `registerPluginViews` / `unregisterPluginViews` functions
 * from `views-registry.ts` and verifies:
 *   - each runtime registry stays bounded across repeated cycles,
 *   - views disappear from `listViews()` and `getView()` after unregister,
 *   - multiple concurrent plugins coexist and clean up independently,
 * * */

import {
  AgentRuntime,
  createCharacter,
  type Plugin,
  type ViewDeclaration,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getView,
  listViews,
  registerPluginViews,
  unregisterPluginViews as unregisterViews,
} from "../src/api/views-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Plugin with N views. Each view id is unique per plugin. */
function makePlugin(
  pluginName: string,
  viewCount: number,
  extra?: Partial<ViewDeclaration>,
): Plugin {
  const views: ViewDeclaration[] = Array.from(
    { length: viewCount },
    (_, i) => ({
      id: `${pluginName}.view${i}`,
      label: `${pluginName} View ${i}`,
      path: `/${pluginName}/view${i}`,
      ...extra,
    }),
  );
  return { name: pluginName, description: `Test plugin ${pluginName}`, views };
}

function requirePluginViews(plugin: Plugin): ViewDeclaration[] {
  if (!plugin.views) throw new Error(`Expected ${plugin.name} test views`);
  return plugin.views;
}

/** Collect all view ids currently in the registry that start with `prefix`. */
function viewsWithPrefix(prefix: string): string[] {
  return listViews(runtime, { developerMode: true })
    .map((e) => e.id)
    .filter((id) => id.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Cleanup between tests: unregister everything we registered so tests are
// independent with a fresh runtime registry.
// ---------------------------------------------------------------------------

import {
  closeRuntimeViewRegistry,
  type ViewInstallation,
} from "../src/api/view-installations.ts";

let runtime: AgentRuntime;
const registeredPlugins = new Map<string, ViewInstallation>();
function unregisterPluginViews(name: string): void {
  const lease = registeredPlugins.get(name);
  if (lease) unregisterViews(runtime, lease);
  registeredPlugins.delete(name);
}

beforeEach(() => {
  runtime = new AgentRuntime({
    character: createCharacter({ name: "View cycles" }),
    enableAutonomy: false,
  });
  registeredPlugins.clear();
});
afterEach(() => {
  closeRuntimeViewRegistry(runtime);
  registeredPlugins.clear();
});
async function register(plugin: Plugin): Promise<void> {
  const lease = await registerPluginViews(runtime, plugin, {
    indexEmbeddings: false,
  });
  registeredPlugins.set(plugin.name, lease);
}
function unregister(name: string): void {
  unregisterPluginViews(name);
}

// ---------------------------------------------------------------------------
// 1. Repeated register/unregister cycles — registry Map stays bounded
// ---------------------------------------------------------------------------

describe("repeated register/unregister cycles", () => {
  it("registry does not accumulate entries across 10 cycles (3 views per plugin)", async () => {
    const plugin = makePlugin("cycle-plugin", 3);

    for (let i = 0; i < 10; i++) {
      await register(plugin);
      const after = viewsWithPrefix("cycle-plugin.");
      expect(after).toHaveLength(3);

      unregister("cycle-plugin");
      const cleared = viewsWithPrefix("cycle-plugin.");
      expect(cleared).toHaveLength(0);
    }
  });

  it("re-registering after unregister yields exactly the original view ids", async () => {
    const plugin = makePlugin("bounded-plugin", 3);
    const expectedIds = requirePluginViews(plugin)
      .map((v) => v.id)
      .sort();

    for (let i = 0; i < 10; i++) {
      await register(plugin);
      const ids = viewsWithPrefix("bounded-plugin.").sort();
      expect(ids).toEqual(expectedIds);
      unregister("bounded-plugin");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Module cache isolation — views absent from listViews after unregister
// ---------------------------------------------------------------------------

describe("module cache isolation", () => {
  it("unregistered plugin views are absent from listViews()", async () => {
    const plugin = makePlugin("isolation-plugin", 2);

    await register(plugin);
    expect(viewsWithPrefix("isolation-plugin.")).toHaveLength(2);

    unregister("isolation-plugin");

    const allIds = listViews(runtime, { developerMode: true }).map((e) => e.id);
    for (const view of requirePluginViews(plugin)) {
      expect(allIds).not.toContain(view.id);
    }
  });

  it("views from other plugins remain after one plugin is unregistered", async () => {
    const pA = makePlugin("iso-plugin-a", 2);
    const pB = makePlugin("iso-plugin-b", 2);

    await register(pA);
    await register(pB);

    unregister("iso-plugin-a");

    expect(viewsWithPrefix("iso-plugin-a.")).toHaveLength(0);
    expect(viewsWithPrefix("iso-plugin-b.")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Bundle URL cleanup — getView() returns undefined after unregister
// ---------------------------------------------------------------------------

describe("bundle URL cleanup", () => {
  it("getView(id) returns undefined for all views after unregisterPluginViews", async () => {
    const plugin = makePlugin("bundle-plugin", 2, {
      bundlePath: "dist/views/main.js",
    });

    await register(plugin);

    for (const view of requirePluginViews(plugin)) {
      const entry = getView(runtime, view.id);
      // bundleUrl is present when bundlePath is set (no real pluginDir, so
      // available=false, but bundleUrl is still assigned from the path).
      expect(entry).toBeDefined();
      expect(entry?.bundleUrl).toBeDefined();
    }

    unregister("bundle-plugin");

    for (const view of requirePluginViews(plugin)) {
      expect(getView(runtime, view.id)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Multiple plugins simultaneously — count verification
// ---------------------------------------------------------------------------

describe("multiple plugins simultaneously", () => {
  it("5 plugins × 2 views = 10 plugin views; unregistering all returns to baseline", async () => {
    const plugins = Array.from({ length: 5 }, (_, i) =>
      makePlugin(`multi-plugin-${i}`, 2),
    );

    const baselineIds = new Set(
      listViews(runtime, { developerMode: true }).map((e) => e.id),
    );

    for (const p of plugins) {
      await register(p);
    }

    const afterRegistration = listViews(runtime, { developerMode: true });
    const pluginViewCount = afterRegistration.filter((e) =>
      e.id.startsWith("multi-plugin-"),
    ).length;
    expect(pluginViewCount).toBe(10);

    for (const p of plugins) {
      unregister(p.name);
    }

    const afterUnregister = listViews(runtime, { developerMode: true }).map(
      (e) => e.id,
    );
    // All multi-plugin views gone
    expect(
      afterUnregister.filter((id) => id.startsWith("multi-plugin-")),
    ).toHaveLength(0);
    // Baseline views (builtins) still present
    for (const id of baselineIds) {
      expect(afterUnregister).toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Idempotent unregister — double unregister is safe
// ---------------------------------------------------------------------------

describe("idempotent unregister", () => {
  it("calling unregisterPluginViews twice does not throw and leaves registry clean", async () => {
    const plugin = makePlugin("idempotent-plugin", 2);

    await register(plugin);
    expect(viewsWithPrefix("idempotent-plugin.")).toHaveLength(2);

    unregister("idempotent-plugin");
    expect(viewsWithPrefix("idempotent-plugin.")).toHaveLength(0);

    // Second call must not throw.
    expect(() => unregisterPluginViews("idempotent-plugin")).not.toThrow();
    expect(viewsWithPrefix("idempotent-plugin.")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Plugin with no views — registerPluginViews is a no-op
// ---------------------------------------------------------------------------

describe("plugin with no views", () => {
  it("registerPluginViews with an empty views array does not add entries", async () => {
    const plugin: Plugin = {
      name: "no-views-plugin",
      description: "Plugin declaring no views",
      views: [],
    };

    const before = listViews(runtime, { developerMode: true }).length;
    await registerPluginViews(runtime, plugin);
    const after = listViews(runtime, { developerMode: true }).length;

    expect(after).toBe(before);
  });

  it("registerPluginViews with views field absent does not add entries", async () => {
    const plugin: Plugin = {
      name: "absent-views-plugin",
      description: "Plugin with no views field",
    };

    const before = listViews(runtime, { developerMode: true }).length;
    await registerPluginViews(runtime, plugin);
    const after = listViews(runtime, { developerMode: true }).length;

    expect(after).toBe(before);
  });
});
