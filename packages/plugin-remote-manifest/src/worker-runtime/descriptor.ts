/**
 * Build the {@link WorkerAnnouncePluginMessage.descriptor} payload from
 * the author's Plugin object.
 *
 * The descriptor is a JSON-safe copy of the Plugin where every function
 * value is replaced by a `{ rpc: true, id: <stable-id> }` tag. The host
 * uses the tags as the `target` in subsequent `worker-rpc` invocations.
 *
 * The mapping of `id → handler` is kept in a per-worker
 * {@link HandlerRegistry} so the dispatcher can resolve incoming
 * worker-rpc calls back to the live function.
 */

import type {
  JsonObject,
  JsonValue,
  PluginSurfaceKind,
  RemoteFunctionRef,
} from "../index.js";

/** Live handler registered by the descriptor builder. */
export type AnyHandler = (...args: unknown[]) => unknown;

/**
 * Shape a service class must satisfy to be exported from a remote-mode
 * plugin. Note the `static rpcMethods` opt-in: only methods named in
 * this array are reachable from the host. The host runtime synthesises
 * a `ServiceProxy` with exactly those methods, plus the standard
 * `start` / `stop` lifecycle. Constructors and other methods stay
 * private to the worker.
 */
export type RemoteServiceClass = {
  /** Identifier used by `runtime.getService(serviceType)`. */
  serviceType: string;
  /** Explicit allowlist of methods that can be invoked via host RPC. */
  rpcMethods: readonly string[];
  /** Optional human-readable description; passes through to the host. */
  capabilityDescription?: string;
  /** Factory; the bootstrap calls this to materialise the service. */
  start: (runtime: unknown) => Promise<RemoteServiceInstance>;
  /** Optional per-runtime teardown. */
  stopRuntime?: (runtime: unknown) => Promise<void>;
};

export interface RemoteServiceInstance {
  stop?: () => Promise<void> | void;
}

/** Mapping from rpc.id → live handler, plus its surface kind for routing. */
export interface HandlerRegistry {
  get(id: string): HandlerEntry | undefined;
  set(id: string, entry: HandlerEntry): void;
  clear(): void;
  readonly size: number;
}

export interface HandlerEntry {
  id: string;
  surface: PluginSurfaceKind;
  /** Surface-specific target name (action name, service.method, etc.). */
  target: string;
  handler: AnyHandler;
}

export function createHandlerRegistry(): HandlerRegistry {
  const inner = new Map<string, HandlerEntry>();
  return {
    get: (id) => inner.get(id),
    set: (id, entry) => {
      inner.set(id, entry);
    },
    clear: () => inner.clear(),
    get size() {
      return inner.size;
    },
  };
}

/** Plugin object as seen by the worker bootstrap (loose typing to avoid pulling in @elizaos/core internals here). */
export type WorkerPluginShape = {
  name: string;
  description?: string;
  mode?: "direct" | "remote";
  priority?: number;
  dependencies?: string[];
  config?: Record<string, JsonValue>;
  schema?: Record<string, JsonValue>;
  actions?: Array<{
    name: string;
    similes?: string[];
    description?: string;
    examples?: JsonValue;
    validate?: AnyHandler;
    handler: AnyHandler;
  }>;
  providers?: Array<{
    name: string;
    description?: string;
    dynamic?: boolean;
    position?: number;
    private?: boolean;
    get: AnyHandler;
  }>;
  services?: Array<RemoteServiceClass>;
  models?: Record<string, AnyHandler>;
  events?: Record<string, Array<AnyHandler>>;
  routes?: Array<{
    type?: string;
    name?: string;
    path: string;
    public?: boolean;
    publicReason?: string;
    isMultipart?: boolean;
    routeHandler?: AnyHandler;
  }>;
  views?: Array<JsonValue>;
  widgets?: Array<JsonValue>;
  componentTypes?: Array<JsonValue>;
  evaluators?: Array<{
    name: string;
    description?: string;
    validate?: AnyHandler;
    handler: AnyHandler;
  }>;
  init?: AnyHandler;
  [key: string]: unknown;
};

/**
 * Walk `plugin`, allocate a stable id for each function, register the
 * handler, and return a JSON descriptor with `{ rpc: true, id }` in
 * lieu of each function.
 */
/**
 * Lazy service-instance cache keyed by serviceType. The first method
 * invocation on a service triggers `service.start(runtime)`; subsequent
 * calls reuse the cached instance until the worker shuts down or the
 * service's stop() is called externally.
 */
const serviceInstances = new WeakMap<
  RemoteServiceClass,
  Promise<RemoteServiceInstance>
>();

async function serviceMethodTrampoline(
  service: RemoteServiceClass,
  method: string,
  args: unknown[],
): Promise<unknown> {
  let instancePromise = serviceInstances.get(service);
  if (!instancePromise) {
    // First call: bootstrap the service. The runtime arg is the
    // RuntimeProxyApi the dispatcher injects (see dispatch.ts).
    const [runtime] = args;
    instancePromise = service.start(runtime as unknown);
    serviceInstances.set(service, instancePromise);
  }
  const instance = await instancePromise;
  const fn = (instance as Record<string, unknown>)[method];
  if (typeof fn !== "function") {
    throw new Error(
      `Service ${service.serviceType} has no rpcMethod "${method}".`,
    );
  }
  // args[0] is runtime; args[1..] are the actual method args.
  return (fn as (...a: unknown[]) => unknown).apply(instance, args.slice(1));
}

export function buildAnnounceDescriptor(
  plugin: WorkerPluginShape,
  registry: HandlerRegistry,
): JsonObject {
  let counter = 0;
  const allocId = (kind: PluginSurfaceKind, target: string): string => {
    counter += 1;
    return `${kind}:${target}:${counter}`;
  };

  const refOf = (
    fn: AnyHandler,
    surface: PluginSurfaceKind,
    target: string,
  ): RemoteFunctionRef => {
    const id = allocId(surface, target);
    registry.set(id, { id, surface, target, handler: fn });
    return { rpc: true, id };
  };

  const descriptor: Record<string, JsonValue> = {
    name: plugin.name,
    mode: "remote",
  };
  if (plugin.description) descriptor.description = plugin.description;
  if (plugin.priority !== undefined) descriptor.priority = plugin.priority;
  if (plugin.dependencies) descriptor.dependencies = plugin.dependencies;
  if (plugin.config) descriptor.config = plugin.config as JsonValue;
  if (plugin.schema) descriptor.schema = plugin.schema as JsonValue;

  if (plugin.actions?.length) {
    descriptor.actions = plugin.actions.map((action) => {
      const entry: Record<string, JsonValue> = {
        name: action.name,
        handler: refOf(action.handler, "action", action.name) as JsonValue,
      };
      if (action.similes) entry.similes = action.similes;
      if (action.description) entry.description = action.description;
      if (action.examples !== undefined) entry.examples = action.examples;
      if (action.validate) {
        entry.validate = refOf(
          action.validate,
          "action",
          `${action.name}.validate`,
        ) as JsonValue;
      }
      return entry;
    });
  }

  if (plugin.providers?.length) {
    descriptor.providers = plugin.providers.map((provider) => {
      const entry: Record<string, JsonValue> = {
        name: provider.name,
        get: refOf(provider.get, "provider", provider.name) as JsonValue,
      };
      if (provider.description) entry.description = provider.description;
      if (provider.dynamic !== undefined) entry.dynamic = provider.dynamic;
      if (provider.position !== undefined) entry.position = provider.position;
      if (provider.private !== undefined) entry.private = provider.private;
      return entry;
    });
  }

  if (plugin.models) {
    const modelDescriptor: Record<string, JsonValue> = {};
    for (const [modelType, fn] of Object.entries(plugin.models)) {
      modelDescriptor[modelType] = refOf(fn, "model", modelType) as JsonValue;
    }
    descriptor.models = modelDescriptor;
  }

  if (plugin.events) {
    const eventDescriptor: Record<string, JsonValue> = {};
    for (const [eventName, handlers] of Object.entries(plugin.events)) {
      eventDescriptor[eventName] = handlers.map(
        (handler, index) =>
          refOf(handler, "event", `${eventName}#${index}`) as JsonValue,
      );
    }
    descriptor.events = eventDescriptor;
  }

  if (plugin.services?.length) {
    descriptor.services = plugin.services.map((service) => {
      const entry: Record<string, JsonValue> = {
        serviceType: service.serviceType,
        rpcMethods: service.rpcMethods,
      };
      if (service.capabilityDescription) {
        entry.capabilityDescription = service.capabilityDescription;
      }
      // Each rpcMethod becomes a registered handler keyed by the
      // service.method combo. The actual instance is started lazily
      // when the host first invokes a method (see dispatch.ts).
      for (const method of service.rpcMethods) {
        const target = `${service.serviceType}.${method}`;
        // Register a closure that defers to the service instance
        // resolved by dispatch.ts when this id is invoked. The handler
        // receives the runtime + method args.
        const handler: AnyHandler = async (...args: unknown[]) =>
          serviceMethodTrampoline(service, method, args);
        const id = allocId("service", target);
        registry.set(id, { id, surface: "service", target, handler });
        entry[`rpc:${method}`] = { rpc: true, id } as JsonValue;
      }
      return entry;
    });
  }

  if (plugin.evaluators?.length) {
    descriptor.evaluators = plugin.evaluators.map((evaluator) => {
      const entry: Record<string, JsonValue> = {
        name: evaluator.name,
        handler: refOf(
          evaluator.handler,
          "evaluator",
          evaluator.name,
        ) as JsonValue,
      };
      if (evaluator.description) entry.description = evaluator.description;
      if (evaluator.validate) {
        entry.validate = refOf(
          evaluator.validate,
          "evaluator",
          `${evaluator.name}.validate`,
        ) as JsonValue;
      }
      return entry;
    });
  }

  if (plugin.routes?.length) {
    descriptor.routes = plugin.routes.map((route) => {
      const entry: Record<string, JsonValue> = {
        path: route.path,
      };
      if (route.type) entry.type = route.type;
      if (route.name) entry.name = route.name;
      if (route.public !== undefined) entry.public = route.public;
      if (route.publicReason) entry.publicReason = route.publicReason;
      if (route.isMultipart !== undefined)
        entry.isMultipart = route.isMultipart;
      if (route.routeHandler) {
        entry.routeHandler = refOf(
          route.routeHandler,
          "route",
          `${route.type ?? "GET"} ${route.path}`,
        ) as JsonValue;
      }
      return entry;
    });
  }

  // JSON-only metadata fields: copy through unchanged.
  if (plugin.views) descriptor.views = plugin.views as JsonValue;
  if (plugin.widgets) descriptor.widgets = plugin.widgets as JsonValue;
  if (plugin.componentTypes) {
    descriptor.componentTypes = plugin.componentTypes as JsonValue;
  }

  return descriptor;
}
