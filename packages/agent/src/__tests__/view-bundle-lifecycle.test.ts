/**
 * View bundle lifecycle tests.
 *
 * Verifies that plugins declaring `views` properly contribute to and clean up
 * from a mock view registry on load/unload cycles. Tests use a lightweight
 * in-process registry to avoid depending on the full views-registry service.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViewDeclaration } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  getView,
  listViews,
  unregisterPluginViews,
} from "../api/views-registry.js";
import { installRuntimePluginLifecycle } from "../runtime/plugin-lifecycle.js";
import { createTestRuntime } from "./plugin-lifecycle-test-utils.ts";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const PLUGIN_VIEW_MANIFESTS = [
  "plugins/plugin-companion/src/plugin.ts",
  "plugins/plugin-contacts/src/plugin.ts",
  "plugins/plugin-hyperliquid-app/src/plugin.ts",
  "plugins/plugin-messages/src/plugin.ts",
  "plugins/app-model-tester/src/plugin.ts",
  "plugins/plugin-phone/src/plugin.ts",
  "plugins/plugin-polymarket-app/src/plugin.ts",
  "plugins/plugin-shopify-ui/src/plugin.ts",
  "plugins/plugin-steward-app/src/plugin.ts",
  "plugins/plugin-vincent/src/plugin.ts",
  "plugins/plugin-wallet-ui/src/plugin.ts",
  "plugins/plugin-2004scape/src/index.ts",
  "plugins/plugin-feed/src/index.ts",
  "plugins/plugin-app-control/src/index.ts",
  "plugins/plugin-clawville/src/index.ts",
  "plugins/plugin-defense-of-the-agents/src/index.ts",
  "plugins/plugin-hyperscape/src/index.ts",
  "plugins/plugin-scape/src/index.ts",
  "plugins/plugin-screenshare/src/index.ts",
  "plugins/plugin-task-coordinator/src/index.ts",
  "plugins/plugin-trajectory-logger/src/index.ts",
  "plugins/plugin-training/src/setup-routes.ts",
  "plugins/plugin-facewear/src/index.ts",
] as const;

function readManifest(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function viewObjects(source: string): string[] {
  const viewsStart = source.indexOf("views:");
  if (viewsStart === -1) return [];
  const arrayStart = source.indexOf("[", viewsStart);
  if (arrayStart === -1) return [];

  let depth = 0;
  let arrayEnd = -1;
  for (let index = arrayStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (depth === 0) {
      arrayEnd = index;
      break;
    }
  }
  if (arrayEnd === -1) return [];

  const viewsSource = source.slice(arrayStart + 1, arrayEnd);
  const objects: string[] = [];
  let objectStart = -1;
  depth = 0;
  for (let index = 0; index < viewsSource.length; index += 1) {
    const char = viewsSource[index];
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        objects.push(viewsSource.slice(objectStart, index + 1));
        objectStart = -1;
      }
    }
  }
  return objects.filter(
    (chunk) => chunk.includes("id:") && chunk.includes("componentExport:"),
  );
}

function stringField(source: string, field: string): string | null {
  const match = source.match(new RegExp(`${field}:\\s*"([^"]+)"`));
  return match?.[1] ?? null;
}

function productionViewDeclarations(manifestPath: string): ViewDeclaration[] {
  return viewObjects(readManifest(manifestPath))
    .map((object): ViewDeclaration | null => {
      const id = stringField(object, "id");
      const label = stringField(object, "label");
      const path = stringField(object, "path");
      const viewType = stringField(object, "viewType");
      const bundlePath = stringField(object, "bundlePath");
      const componentExport = stringField(object, "componentExport");
      if (!id || !label || !bundlePath || !componentExport) return null;
      return {
        id,
        label,
        ...(path === null ? {} : { path }),
        ...(viewType === "gui" || viewType === "tui" || viewType === "xr"
          ? { viewType }
          : {}),
        bundlePath,
        componentExport,
      } satisfies ViewDeclaration;
    })
    .filter((view): view is ViewDeclaration => view !== null);
}

/**
 * Minimal view registry that mirrors the contract used by the real
 * views-registry service: register on plugin load, remove on plugin unload.
 */
class MockViewRegistry {
  private entries = new Map<string, ViewDeclaration & { pluginName: string }>();

  register(pluginName: string, view: ViewDeclaration): void {
    this.entries.set(view.id, { ...view, pluginName });
  }

  unregisterByPlugin(pluginName: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.pluginName === pluginName) {
        this.entries.delete(id);
      }
    }
  }

  has(viewId: string): boolean {
    return this.entries.has(viewId);
  }

  getAll(): Array<ViewDeclaration & { pluginName: string }> {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }
}

function makeViewPlugin(
  pluginName: string,
  views: ViewDeclaration[],
  registry: MockViewRegistry,
): Plugin {
  return {
    name: pluginName,
    description: `Plugin contributing views: ${views.map((v) => v.id).join(", ")}`,
    init: async () => {
      for (const view of views) {
        registry.register(pluginName, view);
      }
    },
    dispose: async () => {
      registry.unregisterByPlugin(pluginName);
    },
    views,
  };
}

describe("view registry — register on load, remove on unload", () => {
  it("registering a plugin with views adds them to the view registry", async () => {
    const registry = new MockViewRegistry();
    const views: ViewDeclaration[] = [
      {
        id: "wallet.inventory",
        label: "Wallet Inventory",
        description: "User token inventory",
        path: "/wallet",
      },
    ];

    const plugin = makeViewPlugin("wallet-plugin", views, registry);
    const runtime = createTestRuntime();

    await runtime.registerPlugin(plugin);

    expect(registry.has("wallet.inventory")).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it("unregistering a plugin removes its views from the registry", async () => {
    const registry = new MockViewRegistry();
    const views: ViewDeclaration[] = [
      {
        id: "market.chart",
        label: "Market Chart",
        path: "/market",
      },
    ];

    const plugin = makeViewPlugin("market-plugin", views, registry);
    const runtime = createTestRuntime();

    await runtime.registerPlugin(plugin);
    expect(registry.has("market.chart")).toBe(true);

    await runtime.unloadPlugin("market-plugin");
    expect(registry.has("market.chart")).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("view registry does not retain stale entries after multiple load/unload cycles", async () => {
    const registry = new MockViewRegistry();
    const views: ViewDeclaration[] = [
      { id: "cycle.view", label: "Cycle View", path: "/cycle" },
    ];

    const plugin = makeViewPlugin("cycle-plugin", views, registry);
    const runtime = createTestRuntime();
    const cycles = 5;

    for (let i = 0; i < cycles; i++) {
      await runtime.registerPlugin(plugin);
      expect(registry.size()).toBe(1);

      await runtime.unloadPlugin("cycle-plugin");
      expect(registry.size()).toBe(0);
      expect(registry.has("cycle.view")).toBe(false);
    }
  });

  it("two plugins with different views coexist; unloading one does not affect the other", async () => {
    const registry = new MockViewRegistry();

    const pluginA = makeViewPlugin(
      "plugin-a",
      [{ id: "view.alpha", label: "Alpha", path: "/alpha" }],
      registry,
    );
    const pluginB = makeViewPlugin(
      "plugin-b",
      [{ id: "view.beta", label: "Beta", path: "/beta" }],
      registry,
    );

    const runtime = createTestRuntime();
    await runtime.registerPlugin(pluginA);
    await runtime.registerPlugin(pluginB);

    expect(registry.has("view.alpha")).toBe(true);
    expect(registry.has("view.beta")).toBe(true);

    await runtime.unloadPlugin("plugin-a");

    expect(registry.has("view.alpha")).toBe(false);
    expect(registry.has("view.beta")).toBe(true);
  });

  it("reloading a plugin after unload re-registers views without duplicates", async () => {
    const registry = new MockViewRegistry();
    const views: ViewDeclaration[] = [
      { id: "reload.view", label: "Reload View", path: "/reload" },
    ];

    const plugin = makeViewPlugin("reload-view-plugin", views, registry);
    const runtime = createTestRuntime();

    await runtime.registerPlugin(plugin);
    await runtime.unloadPlugin("reload-view-plugin");
    await runtime.registerPlugin(plugin);

    // Should be registered exactly once, not twice
    expect(registry.size()).toBe(1);
    expect(registry.has("reload.view")).toBe(true);
  });
});

describe("view bundle plugin — views field propagation through Plugin interface", () => {
  it("a plugin with views declared is registered and unloaded cleanly by the runtime", async () => {
    const runtime = createTestRuntime();

    const viewPlugin: Plugin = {
      name: "view-bundle-plugin",
      description: "Plugin with view declarations",
      views: [
        {
          id: "vb.dashboard",
          label: "Dashboard",
          bundlePath: "dist/views/dashboard.js",
          path: "/dashboard",
        },
      ],
      actions: [
        {
          name: "OPEN_DASHBOARD",
          description: "opens the dashboard view",
          examples: [],
          similes: [],
          validate: async () => true,
          handler: async () => ({ success: true, data: { opened: true } }),
        },
      ],
    };

    const baselineActions = runtime.actions.length;

    await runtime.registerPlugin(viewPlugin);
    expect(runtime.actions.some((a) => a.name === "OPEN_DASHBOARD")).toBe(true);

    await runtime.unloadPlugin("view-bundle-plugin");
    expect(runtime.actions.some((a) => a.name === "OPEN_DASHBOARD")).toBe(
      false,
    );
    expect(runtime.actions.length).toBe(baselineActions);
  });
});

describe("agent runtime view sync — real view registry", () => {
  it("loads and unloads every production view manifest without stale registry entries", async () => {
    const failures: string[] = [];

    for (const manifestPath of PLUGIN_VIEW_MANIFESTS) {
      const views = productionViewDeclarations(manifestPath);
      const pluginName = `production-lifecycle:${manifestPath}`;
      const runtime = createTestRuntime();
      installRuntimePluginLifecycle(runtime);
      const plugin: Plugin = {
        name: pluginName,
        description: `Production lifecycle coverage for ${manifestPath}`,
        views,
      };

      try {
        await runtime.registerPlugin(plugin);

        for (const view of views) {
          const viewType = view.viewType ?? "gui";
          const entry = getView(view.id, { viewType });
          if (
            entry?.pluginName !== pluginName ||
            entry.viewType !== viewType ||
            entry.componentExport !== view.componentExport
          ) {
            failures.push(
              `${manifestPath}:missing-after-load:${viewType}:${view.id}`,
            );
          }
        }

        await runtime.unloadPlugin(pluginName);

        for (const view of views) {
          const viewType = view.viewType ?? "gui";
          if (getView(view.id, { viewType }) !== undefined) {
            failures.push(
              `${manifestPath}:stale-after-unload:${viewType}:${view.id}`,
            );
          }
        }

        const stale = listViews({ developerMode: true }).filter(
          (view) => view.pluginName === pluginName,
        );
        if (stale.length > 0) {
          failures.push(
            `${manifestPath}:stale-plugin-entries:${stale
              .map((view) => `${view.viewType}:${view.id}`)
              .join(",")}`,
          );
        }
      } finally {
        unregisterPluginViews(pluginName);
      }
    }

    expect(failures).toEqual([]);
  });

  it("does not retain real registry entries across repeated runtime load/unload cycles", async () => {
    const pluginName = "runtime-view-cycle-plugin";
    const viewIdPrefix = "runtime-cycle.";
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);

    const plugin: Plugin = {
      name: pluginName,
      description: "Runtime repeated cycle view sync test plugin",
      views: [
        {
          id: "runtime-cycle.primary",
          label: "Runtime Cycle Primary",
          path: "/runtime-cycle/primary",
          bundlePath: "dist/views/primary.js",
        },
        {
          id: "runtime-cycle.secondary",
          label: "Runtime Cycle Secondary",
          path: "/runtime-cycle/secondary",
          bundlePath: "dist/views/secondary.js",
        },
      ],
    };

    const cycleViews = () =>
      listViews({ developerMode: true }).filter((view) =>
        view.id.startsWith(viewIdPrefix),
      );

    try {
      for (let cycle = 0; cycle < 8; cycle += 1) {
        await runtime.registerPlugin(plugin);

        expect(cycleViews()).toHaveLength(2);
        expect(getView("runtime-cycle.primary")).toMatchObject({
          id: "runtime-cycle.primary",
          pluginName,
        });
        expect(getView("runtime-cycle.secondary")).toMatchObject({
          id: "runtime-cycle.secondary",
          pluginName,
        });

        await runtime.unloadPlugin(pluginName);

        expect(getView("runtime-cycle.primary")).toBeUndefined();
        expect(getView("runtime-cycle.secondary")).toBeUndefined();
        expect(cycleViews()).toHaveLength(0);
      }
    } finally {
      unregisterPluginViews(pluginName);
    }
  });

  it("keeps real view registry bounded when lifecycle install is repeated across register/unload cycles", async () => {
    const pluginName = "runtime-view-repeat-install-plugin";
    const viewIdPrefix = "runtime-repeat.";
    const runtime = createTestRuntime();
    const plugin: Plugin = {
      name: pluginName,
      description: "Runtime repeated install view sync test plugin",
      views: [
        {
          id: "runtime-repeat.alpha",
          label: "Runtime Repeat Alpha",
          path: "/runtime-repeat/alpha",
          bundlePath: "dist/views/alpha.js",
        },
        {
          id: "runtime-repeat.beta",
          label: "Runtime Repeat Beta",
          path: "/runtime-repeat/beta",
          bundlePath: "dist/views/beta.js",
        },
      ],
    };
    const viewIds = plugin.views?.map((view) => view.id) ?? [];
    const repeatViews = () =>
      listViews({ developerMode: true }).filter((view) =>
        view.id.startsWith(viewIdPrefix),
      );

    try {
      for (let cycle = 0; cycle < 5; cycle += 1) {
        installRuntimePluginLifecycle(runtime);

        await runtime.registerPlugin(plugin);

        for (const id of viewIds) {
          expect(getView(id)).toMatchObject({ id, pluginName });
        }
        expect(repeatViews()).toHaveLength(viewIds.length);

        await runtime.unloadPlugin(pluginName);

        for (const id of viewIds) {
          expect(getView(id)).toBeUndefined();
        }
        expect(repeatViews()).toHaveLength(0);
      }
    } finally {
      unregisterPluginViews(pluginName);
    }
  });

  it("registers, unloads, and reloads plugin views through runtime lifecycle hooks", async () => {
    const pluginName = "runtime-view-sync-plugin";
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);

    const initialPlugin: Plugin = {
      name: pluginName,
      description: "Runtime view sync integration test plugin",
      views: [
        {
          id: "runtime-sync.primary",
          label: "Runtime Sync Primary",
          path: "/runtime-sync/primary",
          bundlePath: "dist/views/primary.js",
        },
        {
          id: "runtime-sync.secondary",
          label: "Runtime Sync Secondary",
          path: "/runtime-sync/secondary",
          bundlePath: "dist/views/secondary.js",
        },
      ],
    };

    const reloadedPlugin: Plugin = {
      ...initialPlugin,
      views: [
        {
          id: "runtime-sync.primary",
          label: "Runtime Sync Primary Reloaded",
          path: "/runtime-sync/primary-reloaded",
          bundlePath: "dist/views/primary-reloaded.js",
        },
        {
          id: "runtime-sync.tertiary",
          label: "Runtime Sync Tertiary",
          path: "/runtime-sync/tertiary",
          bundlePath: "dist/views/tertiary.js",
        },
      ],
    };

    try {
      await runtime.registerPlugin(initialPlugin);

      expect(getView("runtime-sync.primary")).toMatchObject({
        id: "runtime-sync.primary",
        pluginName,
        path: "/runtime-sync/primary",
      });
      expect(getView("runtime-sync.secondary")).toMatchObject({
        id: "runtime-sync.secondary",
        pluginName,
      });

      await runtime.reloadPlugin(reloadedPlugin);

      expect(getView("runtime-sync.secondary")).toBeUndefined();
      expect(getView("runtime-sync.primary")).toMatchObject({
        id: "runtime-sync.primary",
        pluginName,
        label: "Runtime Sync Primary Reloaded",
        path: "/runtime-sync/primary-reloaded",
      });
      expect(getView("runtime-sync.tertiary")).toMatchObject({
        id: "runtime-sync.tertiary",
        pluginName,
      });

      await runtime.unloadPlugin(pluginName);

      expect(getView("runtime-sync.primary")).toBeUndefined();
      expect(getView("runtime-sync.tertiary")).toBeUndefined();
    } finally {
      unregisterPluginViews(pluginName);
    }
  });

  it("cleans up and reloads every viewType variant for a shared logical view id", async () => {
    const pluginName = "runtime-view-variant-plugin";
    const viewId = "runtime-variant.dashboard";
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);

    const initialPlugin: Plugin = {
      name: pluginName,
      description: "Runtime view variant lifecycle test plugin",
      views: [
        {
          id: viewId,
          label: "Runtime Variant GUI",
          viewType: "gui",
          path: "/runtime-variant",
          bundlePath: "dist/views/gui.js",
        },
        {
          id: viewId,
          label: "Runtime Variant TUI",
          viewType: "tui",
          path: "/runtime-variant/tui",
          bundlePath: "dist/views/tui.js",
        },
        {
          id: viewId,
          label: "Runtime Variant XR",
          viewType: "xr",
          path: "/runtime-variant",
          bundlePath: "dist/views/xr.js",
        },
      ],
    };

    const reloadedPlugin: Plugin = {
      ...initialPlugin,
      views: [
        {
          id: viewId,
          label: "Runtime Variant GUI Reloaded",
          viewType: "gui",
          path: "/runtime-variant/reloaded",
          bundlePath: "dist/views/gui-reloaded.js",
        },
        {
          id: viewId,
          label: "Runtime Variant TUI Reloaded",
          viewType: "tui",
          path: "/runtime-variant/reloaded/tui",
          bundlePath: "dist/views/tui-reloaded.js",
        },
        {
          id: viewId,
          label: "Runtime Variant XR Reloaded",
          viewType: "xr",
          path: "/runtime-variant/reloaded",
          bundlePath: "dist/views/xr-reloaded.js",
        },
      ],
    };

    const expectVariant = (
      viewType: "gui" | "tui" | "xr",
      label: string,
      viewPath: string,
    ) => {
      expect(getView(viewId, { viewType })).toMatchObject({
        id: viewId,
        pluginName,
        viewType,
        label,
        path: viewPath,
      });
      expect(
        listViews({ developerMode: true, viewType }).filter(
          (view) => view.id === viewId,
        ),
      ).toHaveLength(1);
    };

    const expectNoVariants = () => {
      for (const viewType of ["gui", "tui", "xr"] as const) {
        expect(getView(viewId, { viewType })).toBeUndefined();
        expect(
          listViews({ developerMode: true, viewType }).filter(
            (view) => view.id === viewId,
          ),
        ).toHaveLength(0);
      }
    };

    try {
      await runtime.registerPlugin(initialPlugin);

      expectVariant("gui", "Runtime Variant GUI", "/runtime-variant");
      expectVariant("tui", "Runtime Variant TUI", "/runtime-variant/tui");
      expectVariant("xr", "Runtime Variant XR", "/runtime-variant");

      await runtime.reloadPlugin(reloadedPlugin);

      expectVariant(
        "gui",
        "Runtime Variant GUI Reloaded",
        "/runtime-variant/reloaded",
      );
      expectVariant(
        "tui",
        "Runtime Variant TUI Reloaded",
        "/runtime-variant/reloaded/tui",
      );
      expectVariant(
        "xr",
        "Runtime Variant XR Reloaded",
        "/runtime-variant/reloaded",
      );

      await runtime.unloadPlugin(pluginName);

      expectNoVariants();
    } finally {
      unregisterPluginViews(pluginName);
    }
  });
});
