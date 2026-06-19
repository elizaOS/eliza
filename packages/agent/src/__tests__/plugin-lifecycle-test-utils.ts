/**
 * Shared utilities for plugin lifecycle tests.
 *
 * Uses `AgentRuntime` from `@elizaos/core` directly — its constructor calls
 * `installRuntimePluginLifecycle`, so `unloadPlugin` and `reloadPlugin` are
 * always present without any additional setup.
 */

import type { Plugin } from "@elizaos/core";
import { AgentRuntime } from "@elizaos/core";

export type { Plugin };
export { AgentRuntime };

export interface LifecycleCycleMetrics {
  cycle: number;
  loadMs: number;
  unloadMs: number;
  actionCountBefore: number;
  actionCountAfter: number;
  providerCountBefore: number;
  providerCountAfter: number;
  evaluatorCountBefore: number;
  evaluatorCountAfter: number;
  routeCountBefore: number;
  routeCountAfter: number;
}

export type TestRuntime = AgentRuntime & {
  unloadPlugin: (name: string) => Promise<unknown>;
  reloadPlugin: (plugin: Plugin) => Promise<void>;
};

/**
 * Creates a minimal AgentRuntime suitable for plugin lifecycle testing.
 * No database adapter is registered, so adapter-owning plugins will throw
 * when unloaded without `allowAdapterUnload`.
 */
export function createTestRuntime(): TestRuntime {
  return new AgentRuntime({ logLevel: "fatal" }) as TestRuntime;
}

/**
 * Creates a minimal valid plugin for lifecycle testing.
 * The plugin has one action, one provider, and an optional dispose hook.
 */
export function createTestPlugin(overrides: Partial<Plugin> = {}): Plugin {
  const name = overrides.name ?? "test-lifecycle-plugin";
  return {
    name,
    description: "Minimal plugin for lifecycle testing",
    actions: [
      {
        name: `${name.toUpperCase()}_ACTION`,
        description: "A test action",
        examples: [],
        similes: [],
        validate: async () => true,
        handler: async () => ({ success: true, data: { ok: true } }),
      },
    ],
    providers: [
      {
        name: `${name.toUpperCase()}_PROVIDER`,
        description: "A test provider",
        get: async () => ({ text: "test-provider-output" }),
      },
    ],
    ...overrides,
  };
}

/**
 * Loads and unloads a plugin N times, recording per-cycle timing and
 * runtime component counts before/after each unload.
 *
 * The same plugin object is reused across cycles (simulating a reload).
 */
export async function cyclePlugin(
  runtime: TestRuntime,
  plugin: Plugin,
  cycles: number,
): Promise<LifecycleCycleMetrics[]> {
  const metrics: LifecycleCycleMetrics[] = [];

  for (let cycle = 1; cycle <= cycles; cycle++) {
    const loadStart = performance.now();
    await runtime.registerPlugin(plugin);
    const loadMs = performance.now() - loadStart;

    const actionCountBefore = runtime.actions.length;
    const providerCountBefore = runtime.providers.length;
    const evaluatorCountBefore = runtime.evaluators.length;
    const routeCountBefore = runtime.routes.length;

    const unloadStart = performance.now();
    await runtime.unloadPlugin(plugin.name);
    const unloadMs = performance.now() - unloadStart;

    metrics.push({
      cycle,
      loadMs,
      unloadMs,
      actionCountBefore,
      actionCountAfter: runtime.actions.length,
      providerCountBefore,
      providerCountAfter: runtime.providers.length,
      evaluatorCountBefore,
      evaluatorCountAfter: runtime.evaluators.length,
      routeCountBefore,
      routeCountAfter: runtime.routes.length,
    });
  }

  return metrics;
}
