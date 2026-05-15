/**
 * View bundle lifecycle tests.
 *
 * Verifies that plugins declaring `views` properly contribute to and clean up
 * from a mock view registry on load/unload cycles. Tests use a lightweight
 * in-process registry to avoid depending on the full views-registry service.
 */
import { describe, expect, it } from "vitest";
import type { Plugin, ViewDeclaration } from "@elizaos/core";
import { createTestRuntime } from "./plugin-lifecycle-test-utils.ts";

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
          handler: async () => ({ opened: true }),
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
