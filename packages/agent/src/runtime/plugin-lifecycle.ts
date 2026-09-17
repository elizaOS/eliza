/** Host view/schema/role integration over core's single plugin lifecycle. */
import type {
  AgentRuntime,
  IDatabaseAdapter,
  Plugin,
  PluginOwnership,
} from "@elizaos/core";
import {
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.ts";
import { applyPluginRoleGating } from "./plugin-role-gating.ts";
import {
  registerViewScopedActions,
  unregisterViewScopedActions,
} from "./view-scoped-actions.ts";

export type RuntimePluginOwnership = PluginOwnership;

type RuntimeWithPluginLifecycle = AgentRuntime & {
  __elizaPluginViewSyncInstalled?: boolean;
};

const pluginMigrationQueues = new WeakMap<IDatabaseAdapter, Promise<void>>();

const pluginMigrationsInFlight = new WeakMap<
  IDatabaseAdapter,
  Map<string, Promise<void>>
>();

type PluginLifecycleLane = {
  tail: Promise<void>;
  joinableRegistration: Promise<void> | null;
  pendingOperations: number;
};

const pluginLifecycleLanes = new WeakMap<
  AgentRuntime,
  Map<string, PluginLifecycleLane>
>();

function getPluginLifecycleLane(
  runtime: AgentRuntime,
  pluginName: string,
): {
  lane: PluginLifecycleLane;
  lanes: Map<string, PluginLifecycleLane>;
} {
  let lanes = pluginLifecycleLanes.get(runtime);
  if (!lanes) {
    lanes = new Map();
    pluginLifecycleLanes.set(runtime, lanes);
  }
  let lane = lanes.get(pluginName);
  if (!lane) {
    lane = {
      tail: Promise.resolve(),
      joinableRegistration: null,
      pendingOperations: 0,
    };
    lanes.set(pluginName, lane);
  }
  return { lane, lanes };
}

function enqueuePluginLifecycleOperation<T>(
  runtime: AgentRuntime,
  pluginName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const { lane, lanes } = getPluginLifecycleLane(runtime, pluginName);
  lane.pendingOperations += 1;
  const result = lane.tail.then(operation);
  lane.tail = result.then(
    () => undefined,
    () => undefined,
  );
  void lane.tail.then(() => {
    lane.pendingOperations -= 1;
    if (lane.pendingOperations === 0 && lanes.get(pluginName) === lane) {
      lanes.delete(pluginName);
    }
    if (lanes.size === 0 && pluginLifecycleLanes.get(runtime) === lanes) {
      pluginLifecycleLanes.delete(runtime);
    }
  });
  return result;
}

function registerPluginOnce(
  runtime: AgentRuntime,
  pluginName: string,
  register: () => Promise<void>,
): Promise<void> {
  const { lane } = getPluginLifecycleLane(runtime, pluginName);
  if (lane.joinableRegistration) {
    return lane.joinableRegistration;
  }
  const registration = enqueuePluginLifecycleOperation(
    runtime,
    pluginName,
    register,
  );
  lane.joinableRegistration = registration;
  void registration.then(
    () => {
      if (lane.joinableRegistration === registration) {
        lane.joinableRegistration = null;
      }
    },
    () => {
      if (lane.joinableRegistration === registration) {
        lane.joinableRegistration = null;
      }
    },
  );
  return registration;
}

function enqueuePluginLifecycleMutation<T>(
  runtime: AgentRuntime,
  pluginName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const { lane } = getPluginLifecycleLane(runtime, pluginName);
  lane.joinableRegistration = null;
  return enqueuePluginLifecycleOperation(runtime, pluginName, operation);
}

async function migratePluginSchemasIfReady(
  runtime: AgentRuntime,
  plugin: Plugin,
): Promise<void> {
  if (!plugin.schema) {
    return;
  }

  const adapter = runtime.adapter;
  if (!adapter || typeof adapter.runPluginMigrations !== "function") {
    return;
  }
  const runPluginMigrations = adapter.runPluginMigrations.bind(adapter);

  if (typeof adapter.isReady === "function") {
    if (!(await adapter.isReady())) {
      runtime.logger.debug(
        {
          src: "plugin-lifecycle",
          agentId: runtime.agentId,
          plugin: plugin.name,
        },
        "Skipping plugin schema migration until database adapter is ready",
      );
      return;
    }
  }

  const isProduction = process.env.NODE_ENV === "production";
  const activeMigrations = pluginMigrationsInFlight.get(adapter);
  const existingMigration = activeMigrations?.get(plugin.name);
  if (existingMigration) {
    await existingMigration;
    return;
  }

  const previous = pluginMigrationQueues.get(adapter);
  // error-policy:J5 the registration that owns a failed migration observes its
  // rejection; the next registration only waits for that adapter's queue slot.
  const readyForTurn = previous
    ? previous.catch(() => undefined)
    : Promise.resolve();
  const turn = readyForTurn.then(() =>
    runPluginMigrations([{ name: plugin.name, schema: plugin.schema }], {
      verbose: !isProduction,
      force: process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS === "true",
      dryRun: false,
    }),
  );
  pluginMigrationQueues.set(adapter, turn);
  const migrationsByPlugin =
    activeMigrations ?? new Map<string, Promise<void>>();
  if (!activeMigrations) {
    pluginMigrationsInFlight.set(adapter, migrationsByPlugin);
  }
  migrationsByPlugin.set(plugin.name, turn);
  try {
    await turn;
  } finally {
    if (pluginMigrationQueues.get(adapter) === turn) {
      pluginMigrationQueues.delete(adapter);
    }
    if (migrationsByPlugin.get(plugin.name) === turn) {
      migrationsByPlugin.delete(plugin.name);
    }
    if (
      migrationsByPlugin.size === 0 &&
      pluginMigrationsInFlight.get(adapter) === migrationsByPlugin
    ) {
      pluginMigrationsInFlight.delete(adapter);
    }
  }
}

/**
 * Layer plugin view registration on top of an already-installed base plugin
 * lifecycle.
 *
 * `@elizaos/core` ships its own plugin lifecycle and installs it from the
 * `AgentRuntime` constructor, wrapping `registerPlugin`/`unloadPlugin`/
 * `reloadPlugin` for ownership bookkeeping. That base layer knows nothing about
 * the agent view registry, so on its own no plugin views ever reach the
 * registry that backs `/api/views`. Wrap those same methods once more so every
 * registration syncs the plugin's declared views, and every unload/reload
 * removes or refreshes them. This also covers plugins loaded dynamically after
 * boot (plugin manager, VFS), which a one-shot boot pass would miss.
 */
function installPluginViewSync(runtime: RuntimeWithPluginLifecycle): void {
  if (runtime.__elizaPluginViewSyncInstalled) {
    return;
  }
  runtime.__elizaPluginViewSyncInstalled = true;

  const baseRegisterPlugin = runtime.registerPlugin.bind(runtime);
  const baseUnloadPlugin = runtime.unloadPlugin?.bind(runtime);
  const registerPluginOperation = async (plugin: Plugin): Promise<void> => {
    if (runtime.plugins.some((registered) => registered.name === plugin.name)) {
      await baseRegisterPlugin(plugin);
      return;
    }
    let registeredHere = false;
    try {
      // #12087 Item 1: gate this plugin's sensitive providers (SECRETS_STATUS,
      // walletPortfolio, shellHistory, …) at the moment it registers, not via a
      // one-shot boot pass. Plugins hot-installed after boot (plugin manager, VFS)
      // went through registerPlugin but never the boot gating pass, so their
      // owner-tier providers were exposed to any sender. This runs inside the try,
      // so a gating failure fails closed — the plugin is unloaded, not left with
      // ungated providers. provider gating is idempotent, so boot plugins already
      // covered by the boot pass are unaffected.
      applyPluginRoleGating([plugin]);
      await migratePluginSchemasIfReady(runtime, plugin);
      if (
        runtime.plugins.some((registered) => registered.name === plugin.name)
      ) {
        await baseRegisterPlugin(plugin);
        return;
      }
      await baseRegisterPlugin(plugin);
      registeredHere = runtime.plugins.includes(plugin);
      await registerPluginViews(plugin);
      registerViewScopedActions(runtime, plugin.name, plugin.views ?? []);
    } catch (error) {
      unregisterPluginViews(plugin.name);
      unregisterViewScopedActions(runtime, plugin.name);
      if (baseUnloadPlugin && registeredHere) {
        await baseUnloadPlugin(plugin.name);
      }
      throw error;
    }
  };
  runtime.registerPlugin = ((plugin: Plugin) =>
    registerPluginOnce(runtime, plugin.name, () =>
      registerPluginOperation(plugin),
    )) as typeof runtime.registerPlugin;

  if (baseUnloadPlugin) {
    const unloadPluginOperation = async (pluginName: string) => {
      const ownership = await baseUnloadPlugin(pluginName);
      unregisterPluginViews(pluginName);
      unregisterViewScopedActions(runtime, pluginName);
      return ownership as RuntimePluginOwnership | null;
    };
    runtime.unloadPlugin = (pluginName: string) =>
      enqueuePluginLifecycleMutation(runtime, pluginName, () =>
        unloadPluginOperation(pluginName),
      );

    if (runtime.reloadPlugin) {
      runtime.reloadPlugin = (plugin: Plugin) =>
        enqueuePluginLifecycleMutation(runtime, plugin.name, async () => {
          await unloadPluginOperation(plugin.name);
          await registerPluginOperation(plugin);
        });
    }
  }
}

export function supportsRuntimePluginLifecycle(
  runtime: AgentRuntime | null,
): runtime is RuntimeWithPluginLifecycle {
  return Boolean(
    runtime &&
      typeof (runtime as RuntimeWithPluginLifecycle).unloadPlugin ===
        "function" &&
      typeof (runtime as RuntimeWithPluginLifecycle).reloadPlugin ===
        "function" &&
      typeof (runtime as RuntimeWithPluginLifecycle).getPluginOwnership ===
        "function",
  );
}

export function installRuntimePluginLifecycle(runtime: AgentRuntime): void {
  installPluginViewSync(runtime);
}
