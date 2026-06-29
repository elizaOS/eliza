/**
 * The worker entrypoint. Imports the author's Plugin module, walks its
 * surfaces, announces them to the host, then enters the dispatch loop.
 *
 * Author-side plugin code looks like a normal direct-mode Plugin:
 *
 * ```ts
 * // worker.ts
 * import { bootstrap } from "@elizaos/plugin-worker-runtime";
 * import { pluginFooRemote } from "./plugin";
 * bootstrap(pluginFooRemote);
 * ```
 *
 * `bootstrap()` returns a `Promise<void>` that resolves when the worker
 * has finished announcing and is ready to dispatch. It does not block
 * the event loop afterwards — the channel keeps the worker alive.
 */

import type {
  JsonObject,
  JsonValue,
  RemotePluginWorkerMessage,
  WorkerAnnounceDynamicMessage,
  WorkerAnnouncePluginMessage,
  WorkerInitCompleteMessage,
  WorkerRpcMessage,
} from "../index.js";
import {
  buildAnnounceDescriptor,
  createHandlerRegistry,
  type WorkerPluginShape,
} from "./descriptor.js";
import { createWorkerRpcDispatcher } from "./dispatch.js";
import {
  createDefaultChannel,
  createRequestIdAllocator,
  type WorkerChannel,
} from "./envelope.js";
import { toWireError } from "./error.js";
import { buildRuntimeProxyApi, RuntimeProxy } from "./runtime-proxy.js";

/** Options accepted by {@link bootstrap}. */
export interface BootstrapOptions {
  /** Override the message transport. Defaults to a Worker channel. */
  channel?: WorkerChannel;
  /** Override the host-rpc timeout. Default: no timeout. */
  runtimeRpcTimeoutMs?: number;
  /** Optional plugin config map passed to `plugin.init` if present. */
  initConfig?: Record<string, string>;
}

type SurfaceSnapshot = {
  actions: Set<unknown>;
  providers: Set<unknown>;
  services: Set<unknown>;
  routes: Set<unknown>;
  evaluators: Set<unknown>;
  views: Set<unknown>;
  widgets: Set<unknown>;
  componentTypes: Set<unknown>;
  modelKeys: Set<string>;
  events: Map<string, Set<unknown>>;
};

function snapshotPluginSurfaces(plugin: WorkerPluginShape): SurfaceSnapshot {
  return {
    actions: new Set(plugin.actions ?? []),
    providers: new Set(plugin.providers ?? []),
    services: new Set(plugin.services ?? []),
    routes: new Set(plugin.routes ?? []),
    evaluators: new Set(plugin.evaluators ?? []),
    views: new Set(plugin.views ?? []),
    widgets: new Set(plugin.widgets ?? []),
    componentTypes: new Set(plugin.componentTypes ?? []),
    modelKeys: new Set(Object.keys(plugin.models ?? {})),
    events: new Map(
      Object.entries(plugin.events ?? {}).map(([eventName, handlers]) => [
        eventName,
        new Set(handlers),
      ]),
    ),
  };
}

function appended<T>(items: T[] | undefined, seen: Set<unknown>): T[] {
  return (items ?? []).filter((item) => !seen.has(item));
}

function buildDynamicPluginShape(
  plugin: WorkerPluginShape,
  snapshot: SurfaceSnapshot,
): WorkerPluginShape | null {
  const dynamic: WorkerPluginShape = { name: plugin.name };
  let hasDynamicSurface = false;

  const addArray = (key: string, value: unknown) => {
    if (Array.isArray(value) && value.length > 0) {
      (dynamic as Record<string, unknown>)[key] = value;
      hasDynamicSurface = true;
    }
  };

  addArray("actions", appended(plugin.actions, snapshot.actions));
  addArray("providers", appended(plugin.providers, snapshot.providers));
  addArray("services", appended(plugin.services, snapshot.services));
  addArray("routes", appended(plugin.routes, snapshot.routes));
  addArray("evaluators", appended(plugin.evaluators, snapshot.evaluators));
  addArray("views", appended(plugin.views, snapshot.views));
  addArray("widgets", appended(plugin.widgets, snapshot.widgets));
  addArray(
    "componentTypes",
    appended(plugin.componentTypes, snapshot.componentTypes),
  );

  const models = Object.fromEntries(
    Object.entries(plugin.models ?? {}).filter(
      ([modelType]) => !snapshot.modelKeys.has(modelType),
    ),
  );
  if (Object.keys(models).length > 0) {
    dynamic.models = models;
    hasDynamicSurface = true;
  }

  const events: NonNullable<WorkerPluginShape["events"]> = {};
  for (const [eventName, handlers] of Object.entries(plugin.events ?? {})) {
    const existingHandlers = snapshot.events.get(eventName) ?? new Set();
    const dynamicHandlers = handlers.filter(
      (handler) => !existingHandlers.has(handler),
    );
    if (dynamicHandlers.length > 0) {
      events[eventName] = dynamicHandlers;
    }
  }
  if (Object.keys(events).length > 0) {
    dynamic.events = events;
    hasDynamicSurface = true;
  }

  return hasDynamicSurface ? dynamic : null;
}

/**
 * Bootstrap the remote-mode plugin.
 *
 * @param plugin   The author's Plugin object. The bootstrap walks every
 *                 surface (`actions`, `providers`, …) and announces the
 *                 contributions to the host. After `init-complete` the
 *                 worker is in steady-state dispatch mode.
 * @param options  Transport overrides for testing.
 */
export async function bootstrap(
  plugin: WorkerPluginShape,
  options: BootstrapOptions = {},
): Promise<void> {
  const channel = options.channel ?? createDefaultChannel();
  const allocRequestId = createRequestIdAllocator();
  const registry = createHandlerRegistry();
  const proxy = new RuntimeProxy({
    channel,
    allocRequestId,
    ...(options.runtimeRpcTimeoutMs !== undefined
      ? { defaultTimeoutMs: options.runtimeRpcTimeoutMs }
      : {}),
  });
  proxy.attach();
  let dynamicEventCounter = 0;
  const runtimeApi = buildRuntimeProxyApi(proxy, {
    registerDynamicEventHandler: (name, handler) => {
      dynamicEventCounter += 1;
      const id = `event:${name}.dynamic:${dynamicEventCounter}`;
      registry.set(id, {
        id,
        surface: "event",
        target: `${name}#dynamic:${dynamicEventCounter}`,
        handler: (payload: unknown) => handler(payload as JsonValue),
      });
      return { rpc: true, id };
    },
  });

  const dispatchRpc = createWorkerRpcDispatcher(registry, {
    runtime: runtimeApi,
    channel,
  });

  channel.onMessage((message) => {
    if (message.type === "worker-rpc") {
      void dispatchRpc(message as WorkerRpcMessage);
    }
  });

  // Build + send the announce payload.
  const descriptor: JsonObject = buildAnnounceDescriptor(plugin, registry);
  const announce: WorkerAnnouncePluginMessage = {
    type: "worker-announce-plugin",
    descriptor,
  };
  channel.send(announce);

  const surfaceSnapshot = snapshotPluginSurfaces(plugin);

  // Run author init (if any). If init appends plugin surfaces, report the
  // delta before init-complete so the host can register those contributions.
  if (typeof plugin.init === "function") {
    try {
      await (plugin.init as (config: unknown, runtime: unknown) => unknown)(
        options.initConfig ?? {},
        runtimeApi,
      );
    } catch (error) {
      channel.send({
        type: "event",
        name: "plugin.init.failed",
        payload: {
          error: JSON.parse(JSON.stringify(toWireError(error))) as JsonValue,
        },
      } as RemotePluginWorkerMessage);
      throw error;
    }
  }

  const dynamicPlugin = buildDynamicPluginShape(plugin, surfaceSnapshot);
  if (dynamicPlugin) {
    const dynamicAnnounce: WorkerAnnounceDynamicMessage = {
      type: "worker-announce-dynamic",
      descriptor: buildAnnounceDescriptor(dynamicPlugin, registry),
    };
    channel.send(dynamicAnnounce);
  }

  const initComplete: WorkerInitCompleteMessage = { type: "init-complete" };
  channel.send(initComplete);
}
