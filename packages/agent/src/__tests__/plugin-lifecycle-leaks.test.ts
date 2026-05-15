/**
 * Plugin lifecycle leak tests.
 *
 * Verifies that loading and unloading plugins leaves the runtime in a clean
 * baseline state with no accumulated actions, providers, evaluators, or routes.
 * Also exercises dispose hooks and documents detectable vs. undetectable leak
 * patterns.
 */
import { describe, expect, it } from "vitest";
import type { Plugin } from "@elizaos/core";
import {
  createTestPlugin,
  createTestRuntime,
  cyclePlugin,
} from "./plugin-lifecycle-test-utils.ts";

// ---------------------------------------------------------------------------
// 1. Timer leak: documents that setInterval leaked in init() without clearInterval
//    in dispose() is NOT caught by the lifecycle system (the interval keeps
//    running), but the plugin still unloads correctly from the runtime's
//    perspective (no actions/providers/routes leak).
// ---------------------------------------------------------------------------
describe("timer leak — plugin forgets clearInterval in dispose", () => {
  it("plugin unloads cleanly from the runtime even when an interval leaks", async () => {
    const intervalIds: ReturnType<typeof setInterval>[] = [];

    const leakyPlugin: Plugin = {
      name: "timer-leak-plugin",
      description: "Registers an interval in init but never clears it",
      init: async () => {
        // Deliberately leaked interval — no dispose cleanup
        intervalIds.push(setInterval(() => {}, 10_000));
      },
      // No dispose hook — interval leaks
      actions: [
        {
          name: "TIMER_LEAK_ACTION",
          description: "action from leaky plugin",
          examples: [],
          similes: [],
          validate: async () => true,
          handler: async () => ({}),
        },
      ],
    };

    const runtime = createTestRuntime();
    await runtime.registerPlugin(leakyPlugin);

    expect(runtime.actions.some((a) => a.name === "TIMER_LEAK_ACTION")).toBe(
      true,
    );

    await runtime.unloadPlugin("timer-leak-plugin");

    // Runtime is clean — no action residue
    expect(runtime.actions.some((a) => a.name === "TIMER_LEAK_ACTION")).toBe(
      false,
    );

    // Clean up the leaked intervals so vitest exits cleanly
    for (const id of intervalIds) clearInterval(id);
  });

  it("a well-written plugin that clears its interval in dispose leaves no action residue", async () => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const cleanPlugin: Plugin = {
      name: "timer-clean-plugin",
      description: "Registers and clears an interval correctly",
      init: async () => {
        intervalId = setInterval(() => {}, 10_000);
      },
      dispose: async () => {
        if (intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
      },
      actions: [
        {
          name: "TIMER_CLEAN_ACTION",
          description: "action from clean plugin",
          examples: [],
          similes: [],
          validate: async () => true,
          handler: async () => ({}),
        },
      ],
    };

    const runtime = createTestRuntime();
    await runtime.registerPlugin(cleanPlugin);
    await runtime.unloadPlugin("timer-clean-plugin");

    expect(intervalId).toBeNull();
    expect(runtime.actions.some((a) => a.name === "TIMER_CLEAN_ACTION")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Event listener leak: runtime event handlers are tracked by the lifecycle
//    system and are removed on unload even without a dispose hook.
// ---------------------------------------------------------------------------
describe("event listener cleanup via lifecycle tracking", () => {
  it("event handlers registered via registerEvent are removed on unload", async () => {
    const calls: string[] = [];

    const pluginWithEvent: Plugin = {
      name: "event-listener-plugin",
      description: "Registers a runtime event handler",
      events: {
        MESSAGE_RECEIVED: [
          async () => {
            calls.push("handled");
          },
        ],
      },
    };

    const runtime = createTestRuntime();
    await runtime.registerPlugin(pluginWithEvent);

    // Event should be registered
    expect(runtime.events.MESSAGE_RECEIVED?.length).toBeGreaterThan(0);

    await runtime.unloadPlugin("event-listener-plugin");

    // Event handler should be removed
    const remaining = runtime.events.MESSAGE_RECEIVED ?? [];
    expect(remaining.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Clean plugin round-trip: 10 load/unload cycles with a well-written plugin.
//    Baseline counts must be restored after every unload.
// ---------------------------------------------------------------------------
describe("clean plugin round-trip (10 cycles)", () => {
  it("action, provider, evaluator, and route counts return to baseline each cycle", async () => {
    const runtime = createTestRuntime();
    const baselineActions = runtime.actions.length;
    const baselineProviders = runtime.providers.length;
    const baselineEvaluators = runtime.evaluators.length;
    const baselineRoutes = runtime.routes.length;

    const plugin = createTestPlugin();
    const metrics = await cyclePlugin(runtime, plugin, 10);

    expect(metrics).toHaveLength(10);
    for (const m of metrics) {
      expect(m.actionCountAfter).toBe(baselineActions);
      expect(m.providerCountAfter).toBe(baselineProviders);
      expect(m.evaluatorCountAfter).toBe(baselineEvaluators);
      expect(m.routeCountAfter).toBe(baselineRoutes);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Actions unregistered: after unload, plugin's actions are not in runtime.actions
// ---------------------------------------------------------------------------
describe("actions unregistered after unload", () => {
  it("plugin actions are not present in runtime.actions after unloadPlugin", async () => {
    const plugin = createTestPlugin({ name: "action-cleanup-plugin" });
    const runtime = createTestRuntime();

    await runtime.registerPlugin(plugin);

    const actionName = `ACTION-CLEANUP-PLUGIN_ACTION`;
    // Action might be named based on plugin name — use whatever was registered
    const registeredActionNames = runtime.actions.map((a) => a.name);
    expect(registeredActionNames.length).toBeGreaterThan(0);

    await runtime.unloadPlugin("action-cleanup-plugin");

    for (const name of registeredActionNames) {
      // The baseline runtime may re-register its own actions; only check
      // the plugin's action doesn't linger
      if (name.startsWith("ACTION_CLEANUP_PLUGIN")) {
        expect(runtime.actions.some((a) => a.name === name)).toBe(false);
      }
    }
  });

  it("the exact action name from the plugin is not in runtime.actions after unload", async () => {
    const action = {
      name: "MY_UNIQUE_PLUGIN_ACTION_12345",
      description: "unique action",
      examples: [] as never[],
      similes: [] as string[],
      validate: async () => true,
      handler: async () => ({}),
    };

    const plugin: Plugin = {
      name: "unique-action-plugin",
      description: "plugin with a uniquely named action",
      actions: [action],
    };

    const runtime = createTestRuntime();
    await runtime.registerPlugin(plugin);
    expect(runtime.actions.some((a) => a.name === action.name)).toBe(true);

    await runtime.unloadPlugin("unique-action-plugin");
    expect(runtime.actions.some((a) => a.name === action.name)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Routes removed after unload
// ---------------------------------------------------------------------------
describe("routes removed after unload", () => {
  it("plugin routes are not present in runtime.routes after unloadPlugin", async () => {
    const plugin: Plugin = {
      name: "route-plugin",
      description: "plugin that registers a route",
      routes: [
        {
          type: "GET",
          path: "/api/test-lifecycle-route",
          rawPath: true,
          handler: async (_req, res) => {
            res.json({ ok: true });
          },
        },
      ],
    };

    const runtime = createTestRuntime();
    const baselineRoutes = runtime.routes.length;

    await runtime.registerPlugin(plugin);
    expect(runtime.routes.length).toBe(baselineRoutes + 1);

    await runtime.unloadPlugin("route-plugin");
    expect(runtime.routes.length).toBe(baselineRoutes);
    expect(
      runtime.routes.some((r) => r.path === "/api/test-lifecycle-route"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Load → unload → reload stability: plugin works correctly on second load
// ---------------------------------------------------------------------------
describe("load-unload-load stability", () => {
  it("a plugin re-registered after unload works the same as the first load", async () => {
    const handlerCalls: number[] = [];

    const plugin: Plugin = {
      name: "stability-plugin",
      description: "Plugin for reload stability test",
      actions: [
        {
          name: "STABILITY_PING",
          description: "ping action",
          examples: [],
          similes: [],
          validate: async () => true,
          handler: async () => {
            handlerCalls.push(Date.now());
            return { pong: true };
          },
        },
      ],
    };

    const runtime = createTestRuntime();

    // First load
    await runtime.registerPlugin(plugin);
    const actionAfterFirstLoad = runtime.actions.find(
      (a) => a.name === "STABILITY_PING",
    );
    expect(actionAfterFirstLoad).toBeDefined();

    // Invoke the action
    const result1 = (await actionAfterFirstLoad?.handler?.(
      runtime as never,
      {} as never,
      {} as never,
    )) as { pong?: boolean } | undefined;
    expect(result1?.pong).toBe(true);

    // Unload
    await runtime.unloadPlugin("stability-plugin");
    expect(runtime.actions.some((a) => a.name === "STABILITY_PING")).toBe(
      false,
    );

    // Second load
    await runtime.registerPlugin(plugin);
    const actionAfterReload = runtime.actions.find(
      (a) => a.name === "STABILITY_PING",
    );
    expect(actionAfterReload).toBeDefined();

    const result2 = (await actionAfterReload?.handler?.(
      runtime as never,
      {} as never,
      {} as never,
    )) as { pong?: boolean } | undefined;
    expect(result2?.pong).toBe(true);

    expect(handlerCalls.length).toBe(2);
  });

  it("dispose hook is called on each unload across multiple cycles", async () => {
    const disposeCalls: number[] = [];

    const plugin: Plugin = {
      name: "dispose-tracking-plugin",
      description: "tracks dispose invocations",
      dispose: async () => {
        disposeCalls.push(Date.now());
      },
    };

    const runtime = createTestRuntime();
    const cycles = 5;
    for (let i = 0; i < cycles; i++) {
      await runtime.registerPlugin(plugin);
      await runtime.unloadPlugin("dispose-tracking-plugin");
    }

    expect(disposeCalls).toHaveLength(cycles);
  });
});

// ---------------------------------------------------------------------------
// 7. No residual ownership after unload
// ---------------------------------------------------------------------------
describe("plugin ownership tracking", () => {
  it("getPluginOwnership returns null after unload", async () => {
    const plugin = createTestPlugin({ name: "ownership-test-plugin" });
    const runtime = createTestRuntime();

    await runtime.registerPlugin(plugin);
    expect(typeof runtime.getPluginOwnership).toBe("function");
    expect(runtime.getPluginOwnership("ownership-test-plugin")).not.toBeNull();

    await runtime.unloadPlugin("ownership-test-plugin");
    expect(runtime.getPluginOwnership("ownership-test-plugin")).toBeNull();
  });

  it("getAllPluginOwnership does not include unloaded plugins", async () => {
    const plugin1 = createTestPlugin({ name: "owned-plugin-one" });
    const plugin2 = createTestPlugin({ name: "owned-plugin-two" });
    const runtime = createTestRuntime();

    await runtime.registerPlugin(plugin1);
    await runtime.registerPlugin(plugin2);

    const before = runtime
      .getAllPluginOwnership()
      .map((o) => o.pluginName);
    expect(before).toContain("owned-plugin-one");
    expect(before).toContain("owned-plugin-two");

    await runtime.unloadPlugin("owned-plugin-one");

    const after = runtime
      .getAllPluginOwnership()
      .map((o) => o.pluginName);
    expect(after).not.toContain("owned-plugin-one");
    expect(after).toContain("owned-plugin-two");
  });
});
