/**
 * Layers the agent's plugin-ownership and view-registry bookkeeping over
 * @elizaos/core's base plugin lifecycle. installRuntimePluginLifecycle() wraps a
 * runtime's registerPlugin / registerAction / registerProvider / registerModel /
 * registerEvent / registerService / registerDatabaseAdapter (plus unload and
 * reload) so every component a plugin registers is attributed to its owning
 * plugin. That attribution enables clean teardown on unload, reload, or a failed
 * registration — stopping owned services, dropping owned models/events/routes/
 * send-handlers/components, and restoring the prior database adapter.
 *
 * When core already installed its own lifecycle, only installPluginViewSync()
 * goes on top: it syncs each plugin's declared views into the /api/views
 * registry and re-applies owner-tier provider role gating at registration and
 * reload time, so plugins hot-installed after boot (plugin manager, VFS) are
 * gated identically to boot plugins. Registered actions are also wrapped with the
 * lazily-built per-runtime tool-call cache.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentContext,
  AgentRuntime,
  IDatabaseAdapter,
  Plugin,
  PluginEventRegistration,
  PluginModelRegistration,
  PluginOwnership,
  PluginServiceRegistration,
  Service,
  ServiceTypeName,
} from "@elizaos/core";
import { resolveActionContexts, resolveProviderContexts } from "@elizaos/core";
import {
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.ts";
import { applyPluginRoleGating } from "./plugin-role-gating.ts";
import type { ToolCallCache } from "./tool-call-cache/index.ts";
import {
  createToolCallCacheFromConfig,
  type ToolCacheConfig,
  wrapActionWithCache,
} from "./tool-call-cache-wrapper.ts";
import {
  registerViewScopedActions,
  unregisterViewScopedActions,
} from "./view-scoped-actions.ts";

type ContextScoped = {
  contexts?: AgentContext[];
};

type RuntimeAction = NonNullable<Plugin["actions"]>[number] & ContextScoped;
type RuntimeProvider = NonNullable<Plugin["providers"]>[number] & ContextScoped;
type RuntimeEvaluator = NonNullable<Plugin["evaluators"]>[number];
type RuntimeRoute = NonNullable<Plugin["routes"]>[number];
type RuntimeServiceClass = NonNullable<Plugin["services"]>[number];
type RuntimeEventRegistration = PluginEventRegistration;
type RuntimeModelRegistration = PluginModelRegistration;
type RuntimeServiceRegistration = PluginServiceRegistration;

type RuntimeSendHandler = (
  runtime: unknown,
  target: unknown,
  content: unknown,
) => Promise<unknown>;

type PluginDisposeHook = (runtime: AgentRuntime) => Promise<void> | void;

type PluginApplyConfigHook = (
  config: Record<string, string>,
  runtime: AgentRuntime,
) => Promise<void> | void;

type RuntimePluginWithLifecycleHooks = Plugin &
  ContextScoped & {
    dispose?: PluginDisposeHook;
    applyConfig?: PluginApplyConfigHook;
  };

type RuntimeServiceRegistrationStatus =
  | "pending"
  | "registering"
  | "registered"
  | "failed";

type RuntimeServicePromiseHandler = {
  resolve: (service: Service) => void;
  reject: (error: Error) => void;
};

type RuntimeModelHandlerRecord = {
  handler: RuntimeModelRegistration["handler"];
  provider: string;
  priority?: number;
  registrationOrder?: number;
};

type RuntimePluginRegistrationCapture = {
  ownership: RuntimePluginOwnership;
  adapterBefore: AgentRuntime["adapter"] | null | undefined;
};

type RuntimePluginServiceStartCapture = {
  pluginName: string;
};

export type RuntimePluginOwnership = PluginOwnership;

type RuntimeWithPluginLifecycle = AgentRuntime & {
  __elizaPluginLifecycleInstalled?: boolean;
  __elizaPluginViewSyncInstalled?: boolean;
  __elizaPluginOwnership?: Map<string, RuntimePluginOwnership>;
  unloadPlugin?: (pluginName: string) => Promise<RuntimePluginOwnership | null>;
  reloadPlugin?: (plugin: Plugin) => Promise<void>;
  applyPluginConfig?: (
    pluginName: string,
    config: Record<string, string>,
  ) => Promise<boolean>;
  getPluginOwnership?: (pluginName: string) => RuntimePluginOwnership | null;
  getAllPluginOwnership?: () => RuntimePluginOwnership[];
};

type RuntimePrivateState = {
  serviceTypes: Map<ServiceTypeName, RuntimeServiceClass[]>;
  servicePromises: Map<ServiceTypeName, Promise<Service>>;
  servicePromiseHandlers: Map<ServiceTypeName, RuntimeServicePromiseHandler>;
  startingServices: Map<ServiceTypeName, Promise<Service | null>>;
  serviceRegistrationStatus: Map<
    ServiceTypeName,
    RuntimeServiceRegistrationStatus
  >;
  sendHandlers: Map<string, RuntimeSendHandler>;
  models: Map<string, RuntimeModelHandlerRecord[]>;
  _runServiceStart?: (
    key: ServiceTypeName,
    serviceType: string,
    serviceDef: RuntimeServiceClass,
  ) => Promise<Service | null>;
  registerSendHandler?: (source: string, handler: RuntimeSendHandler) => void;
};

const pluginRegistrationContext =
  new AsyncLocalStorage<RuntimePluginRegistrationCapture>();
const pluginServiceStartContext =
  new AsyncLocalStorage<RuntimePluginServiceStartCapture>();
const serviceClassOwners = new WeakMap<RuntimeServiceClass, string>();
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

function getRuntimePrivateState(runtime: AgentRuntime): RuntimePrivateState {
  return runtime as AgentRuntime & RuntimePrivateState;
}

function getPluginOwnershipStore(
  runtime: RuntimeWithPluginLifecycle,
): Map<string, RuntimePluginOwnership> {
  if (!runtime.__elizaPluginOwnership) {
    runtime.__elizaPluginOwnership = new Map();
  }
  return runtime.__elizaPluginOwnership;
}

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

function getOwnershipTarget(
  runtime: RuntimeWithPluginLifecycle,
  pluginName: string,
): RuntimePluginOwnership | null {
  const activeCapture = pluginRegistrationContext.getStore();
  if (activeCapture && activeCapture.ownership.pluginName === pluginName) {
    return activeCapture.ownership;
  }
  return getPluginOwnershipStore(runtime).get(pluginName) ?? null;
}

function pushUniqueRef<T extends object>(items: T[], item: T): void {
  if (!items.includes(item)) {
    items.push(item);
  }
}

function pushUniqueString(items: string[], value: string): void {
  if (!items.includes(value)) {
    items.push(value);
  }
}

function getPluginContexts(plugin: Plugin | undefined): string[] | undefined {
  const contexts = (plugin as ContextScoped | undefined)?.contexts;
  return Array.isArray(contexts) ? contexts : undefined;
}

function inheritPluginContexts<T extends ContextScoped>(
  component: T,
  pluginContexts: string[] | undefined,
): T {
  if (!pluginContexts?.length || (component.contexts?.length ?? 0) > 0) {
    return component;
  }

  return {
    ...component,
    contexts: [...pluginContexts],
  };
}

function applyEffectiveActionContexts(
  action: RuntimeAction,
  pluginContexts: string[] | undefined,
): RuntimeAction {
  const inherited = inheritPluginContexts(action, pluginContexts);
  if ((inherited.contexts?.length ?? 0) > 0) {
    return inherited;
  }

  return {
    ...inherited,
    contexts: [...resolveActionContexts(inherited)],
  };
}

function applyEffectiveProviderContexts(
  provider: RuntimeProvider,
  pluginContexts: string[] | undefined,
): RuntimeProvider {
  const inherited = inheritPluginContexts(provider, pluginContexts);
  if ((inherited.contexts?.length ?? 0) > 0) {
    return inherited;
  }

  return {
    ...inherited,
    contexts: [...resolveProviderContexts(inherited)],
  };
}

function pushUniqueEvent(
  items: RuntimeEventRegistration[],
  next: RuntimeEventRegistration,
): void {
  if (
    items.some(
      (existing) =>
        existing.eventName === next.eventName &&
        existing.handler === next.handler,
    )
  ) {
    return;
  }
  items.push(next);
}

function pushUniqueModel(
  items: RuntimeModelRegistration[],
  next: RuntimeModelRegistration,
): void {
  if (
    items.some(
      (existing) =>
        existing.modelType === next.modelType &&
        existing.handler === next.handler &&
        existing.provider === next.provider,
    )
  ) {
    return;
  }
  items.push(next);
}

function pushUniqueService(
  items: RuntimeServiceRegistration[],
  next: RuntimeServiceRegistration,
): void {
  if (
    items.some(
      (existing) =>
        existing.serviceType === next.serviceType &&
        existing.serviceClass === next.serviceClass,
    )
  ) {
    return;
  }
  items.push(next);
}

function snapshotPluginServiceClasses(
  runtime: AgentRuntime,
  plugin: Plugin,
): Map<ServiceTypeName, Set<RuntimeServiceClass>> {
  const privateState = getRuntimePrivateState(runtime);
  const snapshot = new Map<ServiceTypeName, Set<RuntimeServiceClass>>();
  for (const serviceClass of plugin.services ?? []) {
    const serviceType = serviceClass.serviceType as ServiceTypeName;
    snapshot.set(
      serviceType,
      new Set(privateState.serviceTypes.get(serviceType) ?? []),
    );
  }
  return snapshot;
}

function trackPluginServiceClasses(
  runtime: AgentRuntime,
  ownership: RuntimePluginOwnership,
  before: Map<ServiceTypeName, Set<RuntimeServiceClass>>,
): void {
  const privateState = getRuntimePrivateState(runtime);
  for (const serviceClass of ownership.plugin.services ?? []) {
    const serviceType = serviceClass.serviceType as ServiceTypeName;
    const previousClasses = before.get(serviceType);
    if (
      !previousClasses?.has(serviceClass) &&
      privateState.serviceTypes.get(serviceType)?.includes(serviceClass)
    ) {
      serviceClassOwners.set(serviceClass, ownership.pluginName);
      pushUniqueService(ownership.services, { serviceType, serviceClass });
    }
  }
}

function createEmptyOwnership(plugin: Plugin): RuntimePluginOwnership {
  return {
    pluginName: plugin.name,
    plugin,
    registeredPlugin: null,
    actions: [],
    providers: [],
    evaluators: [],
    routes: [],
    events: [],
    models: [],
    services: [],
    shortcuts: [],
    sendHandlerSources: [],
    hasAdapter: false,
    registeredAt: Date.now(),
  };
}

function removeArrayItemsByReference<T extends object>(
  items: T[],
  owned: T[],
): void {
  if (owned.length === 0 || items.length === 0) return;
  const ownedSet = new Set(owned);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const current = items[index];
    if (ownedSet.has(current)) {
      items.splice(index, 1);
    }
  }
}

async function stopOwnedServices(
  privateState: RuntimePrivateState,
  runtime: RuntimeWithPluginLifecycle,
  ownership: RuntimePluginOwnership,
): Promise<void> {
  if (ownership.services.length === 0) return;

  const serviceGroups = new Map<string, RuntimeServiceClass[]>();
  for (const ownedService of ownership.services) {
    const nextGroup = serviceGroups.get(ownedService.serviceType) ?? [];
    nextGroup.push(ownedService.serviceClass);
    serviceGroups.set(ownedService.serviceType, nextGroup);
  }

  for (const [serviceType, ownedClasses] of serviceGroups) {
    const key = serviceType as ServiceTypeName;
    const inFlightStart = privateState.startingServices.get(key);
    if (inFlightStart) {
      await inFlightStart.catch(() => null);
    }

    const currentClasses = privateState.serviceTypes.get(key) ?? [];
    if (currentClasses.length === 0) {
      continue;
    }

    const ownedClassSet = new Set(ownedClasses);
    const removalIndices: number[] = [];
    currentClasses.forEach((serviceClass, index) => {
      if (ownedClassSet.has(serviceClass)) {
        removalIndices.push(index);
      }
    });

    const instances = runtime.services.get(key) ?? [];
    for (const removalIndex of [...removalIndices].sort((a, b) => b - a)) {
      const instance = instances[removalIndex];
      if (instance && typeof instance.stop === "function") {
        await instance.stop();
      }
      instances.splice(removalIndex, 1);
    }

    for (const ownedClass of ownedClasses) {
      if (typeof ownedClass.stopRuntime === "function") {
        await ownedClass.stopRuntime(runtime);
      }
      serviceClassOwners.delete(ownedClass);
    }

    const remainingClasses = currentClasses.filter(
      (serviceClass) => !ownedClassSet.has(serviceClass),
    );
    if (remainingClasses.length > 0) {
      privateState.serviceTypes.set(key, remainingClasses);
    } else {
      privateState.serviceTypes.delete(key);
    }

    if (instances.length > 0) {
      runtime.services.set(key, instances);
      privateState.serviceRegistrationStatus.set(key, "registered");
    } else {
      runtime.services.delete(key);
      if (remainingClasses.length > 0) {
        privateState.serviceRegistrationStatus.set(key, "pending");
      } else {
        privateState.serviceRegistrationStatus.delete(key);
        privateState.servicePromises.delete(key);
        privateState.servicePromiseHandlers.delete(key);
      }
    }
  }
}

function removeOwnedModels(
  privateState: RuntimePrivateState,
  ownership: RuntimePluginOwnership,
): void {
  if (ownership.models.length === 0) return;

  const modelGroups = new Map<string, RuntimeModelRegistration[]>();
  for (const model of ownership.models) {
    const nextGroup = modelGroups.get(model.modelType) ?? [];
    nextGroup.push(model);
    modelGroups.set(model.modelType, nextGroup);
  }

  for (const [modelType, ownedModels] of modelGroups) {
    const currentModels = privateState.models.get(modelType);
    if (!currentModels || currentModels.length === 0) continue;
    const remainingModels = currentModels.filter(
      (candidate) =>
        !ownedModels.some(
          (owned) =>
            owned.handler === candidate.handler &&
            owned.provider === candidate.provider,
        ),
    );
    if (remainingModels.length > 0) {
      privateState.models.set(modelType, remainingModels);
    } else {
      privateState.models.delete(modelType);
    }
  }
}

function removeOwnedEvents(
  runtime: RuntimeWithPluginLifecycle,
  ownership: RuntimePluginOwnership,
): void {
  if (ownership.events.length === 0) return;

  const eventGroups = new Map<string, RuntimeEventRegistration["handler"][]>();
  for (const ownedEvent of ownership.events) {
    const nextGroup = eventGroups.get(ownedEvent.eventName) ?? [];
    nextGroup.push(ownedEvent.handler);
    eventGroups.set(ownedEvent.eventName, nextGroup);
  }

  for (const [eventName, ownedHandlers] of eventGroups) {
    const currentHandlers = runtime.events[eventName];
    if (!currentHandlers || currentHandlers.length === 0) continue;
    const ownedSet = new Set(ownedHandlers);
    const remainingHandlers = currentHandlers.filter(
      (handler) => !ownedSet.has(handler),
    );
    if (remainingHandlers.length > 0) {
      runtime.events[eventName] = remainingHandlers;
    } else {
      delete runtime.events[eventName];
    }
  }
}

function removeOwnedRoutes(
  runtime: RuntimeWithPluginLifecycle,
  ownership: RuntimePluginOwnership,
): void {
  if (ownership.routes.length === 0 || runtime.routes.length === 0) return;
  removeArrayItemsByReference(runtime.routes, ownership.routes);
}

function removeOwnedPlugins(
  runtime: RuntimeWithPluginLifecycle,
  ownership: RuntimePluginOwnership,
): void {
  if (runtime.plugins.length === 0) return;

  const pluginRefs = ownership.registeredPlugin
    ? [ownership.registeredPlugin]
    : [];

  if (pluginRefs.length > 0) {
    removeArrayItemsByReference(runtime.plugins, pluginRefs);
  }

  for (let index = runtime.plugins.length - 1; index >= 0; index -= 1) {
    if (runtime.plugins[index]?.name === ownership.pluginName) {
      runtime.plugins.splice(index, 1);
    }
  }
}

function removeOwnedSendHandlers(
  privateState: RuntimePrivateState,
  ownership: RuntimePluginOwnership,
): void {
  for (const source of ownership.sendHandlerSources) {
    privateState.sendHandlers.delete(source);
  }
}

function removeOwnedComponents(
  runtime: RuntimeWithPluginLifecycle,
  ownership: RuntimePluginOwnership,
): void {
  removeArrayItemsByReference(runtime.actions, ownership.actions);
  removeArrayItemsByReference(runtime.providers, ownership.providers);
  removeArrayItemsByReference(runtime.evaluators, ownership.evaluators);
}

async function restoreAdapterIfNeeded(
  runtime: RuntimeWithPluginLifecycle,
  ownership: RuntimePluginOwnership,
  adapterBefore: AgentRuntime["adapter"] | null | undefined,
): Promise<void> {
  if (!ownership.hasAdapter) return;
  if (runtime.adapter && runtime.adapter !== adapterBefore) {
    const currentAdapter = runtime.adapter as {
      close?: () => Promise<void>;
      stop?: () => Promise<void>;
    };
    if (typeof currentAdapter.close === "function") {
      await currentAdapter.close();
    } else if (typeof currentAdapter.stop === "function") {
      await currentAdapter.stop();
    }
  }

  runtime.adapter = (adapterBefore ?? null) as AgentRuntime["adapter"];
}

async function teardownPluginOwnership(
  runtime: RuntimeWithPluginLifecycle,
  ownership: RuntimePluginOwnership,
  options?: {
    allowAdapterUnload?: boolean;
    removeOwnership?: boolean;
    adapterBefore?: AgentRuntime["adapter"] | null | undefined;
  },
): Promise<void> {
  const privateState = getRuntimePrivateState(runtime);
  if (ownership.hasAdapter && !options?.allowAdapterUnload) {
    throw new Error(
      `Plugin "${ownership.pluginName}" provides a database adapter and requires a runtime reload`,
    );
  }

  const errors: Error[] = [];
  const lifecyclePlugin = ownership.registeredPlugin ?? ownership.plugin;
  const disposeHook = (lifecyclePlugin as RuntimePluginWithLifecycleHooks)
    .dispose;

  if (typeof disposeHook === "function") {
    try {
      await disposeHook(runtime);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  try {
    removeOwnedSendHandlers(privateState, ownership);
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }

  try {
    await stopOwnedServices(privateState, runtime, ownership);
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }

  try {
    removeOwnedEvents(runtime, ownership);
    removeOwnedRoutes(runtime, ownership);
    removeOwnedModels(privateState, ownership);
    removeOwnedComponents(runtime, ownership);
    removeOwnedPlugins(runtime, ownership);
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }

  if (ownership.hasAdapter && options?.allowAdapterUnload) {
    try {
      await restoreAdapterIfNeeded(runtime, ownership, options.adapterBefore);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (options?.removeOwnership !== false) {
    getPluginOwnershipStore(runtime).delete(ownership.pluginName);
  }

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Failed to fully tear down plugin "${ownership.pluginName}"`,
    );
  }
}

function trackRoutesAndPluginRef(
  runtime: RuntimeWithPluginLifecycle,
  ownership: RuntimePluginOwnership,
  pluginsBefore: Set<Plugin>,
  routesBefore: Set<RuntimeRoute>,
): void {
  for (const plugin of runtime.plugins) {
    if (!pluginsBefore.has(plugin) && plugin.name === ownership.pluginName) {
      ownership.registeredPlugin = plugin;
      break;
    }
  }

  for (const route of runtime.routes) {
    if (!routesBefore.has(route)) {
      pushUniqueRef(ownership.routes, route);
    }
  }
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
 * Lazily-built tool-call cache for this runtime. Built once per runtime on
 * first action registration so we can read the latest config and avoid
 * paying the disk-tier setup cost when the cache is disabled or unused.
 */
function getOrBuildToolCallCache(
  runtime: AgentRuntime,
): { cache: ToolCallCache; cfg: ToolCacheConfig | undefined } | null {
  const r = runtime as AgentRuntime & {
    __toolCallCache?: ToolCallCache | null;
    __toolCallCacheCfg?: ToolCacheConfig | undefined;
    __toolCallCacheBuilt?: boolean;
  };
  if (r.__toolCallCacheBuilt) {
    if (!r.__toolCallCache) return null;
    return { cache: r.__toolCallCache, cfg: r.__toolCallCacheCfg };
  }
  r.__toolCallCacheBuilt = true;

  const character = runtime.character as
    | { settings?: { tools?: { cache?: ToolCacheConfig } } }
    | undefined;
  const cfg: ToolCacheConfig | undefined = character?.settings?.tools?.cache;
  const cache = createToolCallCacheFromConfig(cfg);
  r.__toolCallCache = cache;
  r.__toolCallCacheCfg = cfg;
  if (!cache) return null;
  return { cache, cfg };
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
    const servicesBefore = snapshotPluginServiceClasses(runtime, plugin);
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
      const ownership = runtime.getPluginOwnership?.(plugin.name);
      if (ownership) {
        trackPluginServiceClasses(runtime, ownership, servicesBefore);
      }
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

export function installRuntimePluginLifecycle(runtime: AgentRuntime): void {
  const runtimeWithLifecycle = runtime as RuntimeWithPluginLifecycle;
  if (runtimeWithLifecycle.__elizaPluginLifecycleInstalled) {
    // The base lifecycle is already installed (by @elizaos/core from the
    // AgentRuntime constructor). It owns ownership tracking and the
    // registerPlugin/unload/reload wrappers but has no view-registry support,
    // so only the agent's view-sync layer needs to go on top.
    installPluginViewSync(runtimeWithLifecycle);
    return;
  }

  if (
    typeof runtime.registerPlugin !== "function" ||
    typeof runtime.registerAction !== "function" ||
    typeof runtime.registerProvider !== "function" ||
    typeof runtime.registerEvaluator !== "function" ||
    typeof runtime.registerModel !== "function" ||
    typeof runtime.registerEvent !== "function" ||
    typeof runtime.registerService !== "function"
  ) {
    return;
  }

  const privateState = getRuntimePrivateState(runtime);
  const originalRegisterPlugin = runtime.registerPlugin.bind(runtime);
  const originalRegisterAction = runtime.registerAction.bind(runtime);
  const originalRegisterProvider = runtime.registerProvider.bind(runtime);
  const originalRegisterEvaluator = runtime.registerEvaluator.bind(runtime);
  const originalRegisterModel = runtime.registerModel.bind(runtime);
  const originalRegisterEvent = runtime.registerEvent.bind(runtime);
  const originalRegisterService = runtime.registerService.bind(runtime);
  const originalRegisterDatabaseAdapter =
    typeof runtime.registerDatabaseAdapter === "function"
      ? runtime.registerDatabaseAdapter.bind(runtime)
      : null;
  const originalRegisterSendHandler =
    typeof privateState.registerSendHandler === "function"
      ? privateState.registerSendHandler.bind(runtime)
      : null;
  const originalRunServiceStart =
    typeof privateState._runServiceStart === "function"
      ? privateState._runServiceStart.bind(runtime)
      : null;

  runtime.registerAction = ((action: RuntimeAction) => {
    const capture = pluginRegistrationContext.getStore();
    const actionName =
      action &&
      typeof action === "object" &&
      "name" in action &&
      typeof action.name === "string"
        ? action.name
        : null;
    if (
      actionName &&
      runtime.actions.some(
        (existingAction) => existingAction.name === actionName,
      )
    ) {
      runtime.logger.debug(
        {
          src: "plugin-lifecycle",
          agentId: runtime.agentId,
          action: actionName,
          plugin: capture?.ownership.plugin?.name,
        },
        "Skipping duplicate action before runtime registration",
      );
      return;
    }
    const actionsBefore = runtime.actions.length;
    let effective = applyEffectiveActionContexts(
      action,
      getPluginContexts(capture?.ownership.plugin),
    );
    const toolCache = getOrBuildToolCallCache(runtime);
    if (toolCache) {
      effective = wrapActionWithCache(
        effective,
        toolCache.cache,
        toolCache.cfg,
      );
    }
    originalRegisterAction(effective);
    if (!capture || runtime.actions.length <= actionsBefore) return;
    for (const registeredAction of runtime.actions.slice(actionsBefore)) {
      pushUniqueRef(capture.ownership.actions, registeredAction);
    }
  }) as typeof runtime.registerAction;

  runtime.registerProvider = ((provider: RuntimeProvider) => {
    const capture = pluginRegistrationContext.getStore();
    const providersBefore = runtime.providers.length;
    originalRegisterProvider(
      applyEffectiveProviderContexts(
        provider,
        getPluginContexts(capture?.ownership.plugin),
      ),
    );
    if (!capture || runtime.providers.length <= providersBefore) return;
    for (const registeredProvider of runtime.providers.slice(providersBefore)) {
      pushUniqueRef(capture.ownership.providers, registeredProvider);
    }
  }) as typeof runtime.registerProvider;

  runtime.registerEvaluator = ((evaluator: RuntimeEvaluator) => {
    const capture = pluginRegistrationContext.getStore();
    const evaluatorsBefore = runtime.evaluators.length;
    originalRegisterEvaluator(evaluator);
    if (!capture || runtime.evaluators.length <= evaluatorsBefore) return;
    for (const registeredEvaluator of runtime.evaluators.slice(
      evaluatorsBefore,
    )) {
      pushUniqueRef(capture.ownership.evaluators, registeredEvaluator);
    }
  }) as typeof runtime.registerEvaluator;

  runtime.registerModel = ((modelType, handler, provider, priority) => {
    const capture = pluginRegistrationContext.getStore();
    const modelKey = String(modelType);
    const modelsBefore = privateState.models.get(modelKey)?.length ?? 0;
    originalRegisterModel(modelType, handler, provider, priority);
    if (!capture) return;
    const nextModels = privateState.models.get(modelKey) ?? [];
    for (const registeredModel of nextModels.slice(modelsBefore)) {
      pushUniqueModel(capture.ownership.models, {
        modelType: modelKey,
        handler: registeredModel.handler,
        provider: registeredModel.provider,
      });
    }
  }) as typeof runtime.registerModel;

  runtime.registerEvent = ((event: string, handler: unknown) => {
    const capture = pluginRegistrationContext.getStore();
    const handlersBefore = runtime.events[event]?.length ?? 0;
    originalRegisterEvent(event as never, handler as never);
    if (!capture) return;
    const nextHandlers = runtime.events[event] ?? [];
    for (const registeredHandler of nextHandlers.slice(handlersBefore)) {
      pushUniqueEvent(capture.ownership.events, {
        eventName: event,
        handler: registeredHandler,
      });
    }
  }) as typeof runtime.registerEvent;

  runtime.registerService = (async (serviceClass: RuntimeServiceClass) => {
    const capture = pluginRegistrationContext.getStore();
    const serviceType = serviceClass.serviceType as ServiceTypeName;
    const serviceTypesBefore =
      privateState.serviceTypes.get(serviceType)?.length ?? 0;
    await originalRegisterService(serviceClass);
    if (!capture) return;
    const nextClasses = privateState.serviceTypes.get(serviceType) ?? [];
    for (const registeredClass of nextClasses.slice(serviceTypesBefore)) {
      serviceClassOwners.set(registeredClass, capture.ownership.pluginName);
      pushUniqueService(capture.ownership.services, {
        serviceType,
        serviceClass: registeredClass,
      });
    }
  }) as typeof runtime.registerService;

  if (originalRegisterDatabaseAdapter) {
    runtime.registerDatabaseAdapter = ((adapter) => {
      const capture = pluginRegistrationContext.getStore();
      const adapterBefore = runtime.adapter;
      originalRegisterDatabaseAdapter(adapter);
      if (capture && runtime.adapter && runtime.adapter !== adapterBefore) {
        capture.ownership.hasAdapter = true;
      }
    }) as typeof runtime.registerDatabaseAdapter;
  }

  if (originalRegisterSendHandler) {
    privateState.registerSendHandler = ((source, handler) => {
      const hadSourceAlready = privateState.sendHandlers.has(source);
      originalRegisterSendHandler(source, handler);
      if (hadSourceAlready) return;

      const pluginName =
        pluginServiceStartContext.getStore()?.pluginName ??
        pluginRegistrationContext.getStore()?.ownership.pluginName;
      if (!pluginName) return;
      const ownership = getOwnershipTarget(runtimeWithLifecycle, pluginName);
      if (!ownership) return;
      pushUniqueString(ownership.sendHandlerSources, source);
    }) as typeof privateState.registerSendHandler;
  }

  if (originalRunServiceStart) {
    privateState._runServiceStart = (async (key, serviceType, serviceClass) => {
      const pluginName =
        serviceClassOwners.get(serviceClass) ??
        pluginRegistrationContext.getStore()?.ownership.pluginName;
      if (!pluginName) {
        return await originalRunServiceStart(key, serviceType, serviceClass);
      }
      return await pluginServiceStartContext.run(
        { pluginName },
        async () =>
          await originalRunServiceStart(key, serviceType, serviceClass),
      );
    }) as typeof privateState._runServiceStart;
  }

  const registerPluginOperation = async (plugin: Plugin): Promise<void> => {
    if (runtime.plugins.some((registered) => registered.name === plugin.name)) {
      await originalRegisterPlugin(plugin);
      return;
    }
    const pluginsBefore = new Set(runtime.plugins);
    const routesBefore = new Set(runtime.routes);
    const capture: RuntimePluginRegistrationCapture = {
      ownership: createEmptyOwnership(plugin),
      adapterBefore: runtime.adapter,
    };
    const servicesBefore = snapshotPluginServiceClasses(runtime, plugin);

    try {
      await migratePluginSchemasIfReady(runtime, plugin);
      if (
        runtime.plugins.some((registered) => registered.name === plugin.name)
      ) {
        await originalRegisterPlugin(plugin);
        return;
      }
      await pluginRegistrationContext.run(capture, async () => {
        await originalRegisterPlugin(plugin);
      });
      trackRoutesAndPluginRef(
        runtimeWithLifecycle,
        capture.ownership,
        pluginsBefore,
        routesBefore,
      );
      trackPluginServiceClasses(runtime, capture.ownership, servicesBefore);
      if (
        capture.ownership.registeredPlugin ||
        capture.ownership.actions.length > 0 ||
        capture.ownership.providers.length > 0 ||
        capture.ownership.evaluators.length > 0 ||
        capture.ownership.routes.length > 0 ||
        capture.ownership.events.length > 0 ||
        capture.ownership.models.length > 0 ||
        capture.ownership.services.length > 0 ||
        capture.ownership.sendHandlerSources.length > 0 ||
        capture.ownership.hasAdapter
      ) {
        getPluginOwnershipStore(runtimeWithLifecycle).set(
          capture.ownership.pluginName,
          capture.ownership,
        );
      }
      // Register any views declared by this plugin into the view registry.
      await registerPluginViews(plugin);
    } catch (error) {
      unregisterPluginViews(plugin.name);
      trackRoutesAndPluginRef(
        runtimeWithLifecycle,
        capture.ownership,
        pluginsBefore,
        routesBefore,
      );
      trackPluginServiceClasses(runtime, capture.ownership, servicesBefore);
      await teardownPluginOwnership(runtimeWithLifecycle, capture.ownership, {
        allowAdapterUnload: true,
        removeOwnership: true,
        adapterBefore: capture.adapterBefore,
      });
      throw error;
    }
  };
  runtime.registerPlugin = ((plugin: Plugin) =>
    registerPluginOnce(runtime, plugin.name, () =>
      registerPluginOperation(plugin),
    )) as typeof runtime.registerPlugin;

  const unloadPluginOperation = async (
    pluginName: string,
  ): Promise<RuntimePluginOwnership | null> => {
    const ownership =
      getPluginOwnershipStore(runtimeWithLifecycle).get(pluginName);
    if (!ownership) {
      return null;
    }
    unregisterPluginViews(pluginName);
    await teardownPluginOwnership(runtimeWithLifecycle, ownership, {
      removeOwnership: true,
    });
    return ownership;
  };
  runtimeWithLifecycle.unloadPlugin = (pluginName: string) =>
    enqueuePluginLifecycleMutation(runtime, pluginName, () =>
      unloadPluginOperation(pluginName),
    );

  runtimeWithLifecycle.reloadPlugin = (plugin: Plugin) =>
    enqueuePluginLifecycleMutation(runtime, plugin.name, async () => {
      await unloadPluginOperation(plugin.name);
      await registerPluginOperation(plugin);
    });

  runtimeWithLifecycle.applyPluginConfig = async (
    pluginName: string,
    config: Record<string, string>,
  ) => {
    const ownership =
      getPluginOwnershipStore(runtimeWithLifecycle).get(pluginName);
    if (!ownership) {
      return false;
    }
    const pluginWithHooks = (ownership.registeredPlugin ??
      ownership.plugin) as RuntimePluginWithLifecycleHooks;
    if (typeof pluginWithHooks.applyConfig !== "function") {
      return false;
    }
    await pluginWithHooks.applyConfig(config, runtime);
    return true;
  };

  runtimeWithLifecycle.getPluginOwnership = (pluginName: string) =>
    getPluginOwnershipStore(runtimeWithLifecycle).get(pluginName) ?? null;

  runtimeWithLifecycle.getAllPluginOwnership = () =>
    Array.from(getPluginOwnershipStore(runtimeWithLifecycle).values());

  runtimeWithLifecycle.__elizaPluginLifecycleInstalled = true;
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
