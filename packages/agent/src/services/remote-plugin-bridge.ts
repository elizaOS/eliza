/**
 * RemotePluginBridge — host-side wiring for a remote-mode plugin.
 *
 * Sits between a `RemotePluginHost`-managed worker (or any
 * `BridgeChannel`-shaped transport) and an `IAgentRuntime`. On
 * `worker-announce-plugin` it walks the descriptor, synthesises stub
 * Plugin contributions (actions, providers, events, models) whose
 * handlers proxy back to the worker over `worker-rpc`, and registers
 * the resulting Plugin with `runtime.registerPlugin(...)`.
 *
 * Inbound `host-rpc` messages from the worker are dispatched to the
 * real runtime (`getService`, `useModel`, `getMemory`, `emitEvent`,
 * `composeState`, etc.) and the result is shipped back as
 * `host-rpc-result`.
 *
 * P1 wires: actions, providers, events, models, evaluators, action callbacks.
 * Deferred: services, routes, views (P2), streaming model tokens (P2).
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  State,
  Validator,
} from "@elizaos/core";
import type {
  HostRpcMessage,
  HostRpcResultMessage,
  JsonObject,
  JsonValue,
  RemoteFunctionRef,
  RemotePluginWorkerMessage,
  WorkerActionCallbackMessage,
  WorkerAnnounceDynamicMessage,
  WorkerAnnouncePluginMessage,
  WorkerRpcMessage,
  WorkerRpcResultMessage,
} from "@elizaos/plugin-remote-manifest";
// ./error subpath, not the barrel: the barrel eagerly loads ./bootstrap's heavy
// runtime chain, which crashed agent boot in the cloud image.
import {
  fromWireError,
  toWireError,
} from "@elizaos/plugin-worker-runtime/error";

/** Transport contract the bridge talks to. */
export interface BridgeChannel {
  send(message: RemotePluginWorkerMessage): void;
  onMessage(handler: (message: RemotePluginWorkerMessage) => void): () => void;
  close(): void;
}

export interface RemotePluginBridgeOptions {
  channel: BridgeChannel;
  runtime: IAgentRuntime;
  /** Soft timeout per outbound worker-rpc, in ms. Defaults to 60s. */
  rpcTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** rpc-id → live handler function on the worker side. */
type RpcId = string;

/** What the bridge tracks per attached worker. */
interface AttachedState {
  pluginName: string | null;
  plugin: Plugin | null;
  pending: Map<number, PendingRequest>;
  actionCallbacks: Map<string, NonNullable<Parameters<Action["handler"]>[4]>>;
  nextRequestId: () => number;
  unsubscribe: (() => void) | undefined;
}

export class RemotePluginBridge {
  private readonly channel: BridgeChannel;
  private readonly runtime: IAgentRuntime;
  private readonly rpcTimeoutMs: number;
  private readonly state: AttachedState;

  constructor(options: RemotePluginBridgeOptions) {
    this.channel = options.channel;
    this.runtime = options.runtime;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 60_000;
    this.state = {
      pluginName: null,
      plugin: null,
      pending: new Map(),
      actionCallbacks: new Map(),
      nextRequestId: (() => {
        let n = 0;
        return () => {
          n = (n + 1) >>> 0;
          return n;
        };
      })(),
      unsubscribe: undefined,
    };
  }

  /** Begin listening for announce + host-rpc messages from the worker. */
  attach(): void {
    if (this.state.unsubscribe) return;
    this.state.unsubscribe = this.channel.onMessage((message) => {
      void this.onMessage(message);
    });
  }

  /** Tear down. Unloads the plugin from the runtime if registered. */
  async detach(): Promise<void> {
    this.state.unsubscribe?.();
    this.state.unsubscribe = undefined;
    const rejection = new Error("RemotePluginBridge detached.");
    for (const [, slot] of this.state.pending) {
      if (slot.timer) clearTimeout(slot.timer);
      slot.reject(rejection);
    }
    this.state.pending.clear();
    this.state.actionCallbacks.clear();
    if (this.state.pluginName) {
      await this.runtime.unloadPlugin(this.state.pluginName).catch(() => {
        // ignore unload failures during tear-down
      });
      this.state.pluginName = null;
    }
  }

  private async onMessage(message: RemotePluginWorkerMessage): Promise<void> {
    switch (message.type) {
      case "worker-announce-plugin":
        await this.handleAnnounce(message as WorkerAnnouncePluginMessage);
        return;
      case "worker-announce-dynamic":
        await this.handleDynamicAnnounce(
          message as WorkerAnnounceDynamicMessage,
        );
        return;
      case "worker-rpc-result":
        this.handleRpcResult(message as WorkerRpcResultMessage);
        return;
      case "worker-action-callback":
        await this.handleActionCallback(message as WorkerActionCallbackMessage);
        return;
      case "host-rpc":
        await this.handleHostRpc(message as HostRpcMessage);
        return;
      default:
        // init-complete, stream-chunk, stream-end, ready, event, etc.
        // not handled in P1; the broader RemotePluginHost owns these.
        return;
    }
  }

  private async handleAnnounce(
    message: WorkerAnnouncePluginMessage,
  ): Promise<void> {
    const plugin = this.materialisePlugin(message.descriptor);
    this.state.pluginName = plugin.name;
    this.state.plugin = plugin;
    await this.runtime.registerPlugin(plugin);
  }

  private async handleDynamicAnnounce(
    message: WorkerAnnounceDynamicMessage,
  ): Promise<void> {
    const registeredPlugin = this.state.plugin;
    if (!registeredPlugin || !this.state.pluginName) {
      throw new Error(
        "worker-announce-dynamic received before plugin announce",
      );
    }
    const dynamicPlugin = this.materialisePlugin(message.descriptor);
    if (dynamicPlugin.name !== this.state.pluginName) {
      throw new Error(
        `worker-announce-dynamic plugin mismatch: expected ${this.state.pluginName}, got ${dynamicPlugin.name}`,
      );
    }

    await this.applyDynamicContributions(registeredPlugin, dynamicPlugin);
  }

  private materialisePlugin(descriptor: JsonObject): Plugin {
    const name = String(descriptor.name ?? "");
    if (!name)
      throw new Error("worker-announce-plugin descriptor missing name");

    const plugin: Plugin = {
      name,
      description: String(descriptor.description ?? ""),
      mode: "remote",
    };
    if (descriptor.priority !== undefined) {
      plugin.priority = Number(descriptor.priority);
    }
    if (descriptor.dependencies) {
      plugin.dependencies = (descriptor.dependencies as string[]) ?? [];
    }

    this.attachFunctionContributions(plugin, descriptor);
    this.attachServiceContributions(plugin, descriptor);
    this.attachRouteContributions(plugin, descriptor);
    this.attachViewContributions(plugin, descriptor);

    return plugin;
  }

  private async applyDynamicContributions(
    registeredPlugin: Plugin,
    dynamicPlugin: Plugin,
  ): Promise<void> {
    if (dynamicPlugin.actions?.length) {
      registeredPlugin.actions = [
        ...(registeredPlugin.actions ?? []),
        ...dynamicPlugin.actions,
      ];
      for (const action of dynamicPlugin.actions) {
        this.runtime.registerAction(action);
      }
    }

    if (dynamicPlugin.providers?.length) {
      registeredPlugin.providers = [
        ...(registeredPlugin.providers ?? []),
        ...dynamicPlugin.providers,
      ];
      for (const provider of dynamicPlugin.providers) {
        this.runtime.registerProvider(provider);
      }
    }

    if (dynamicPlugin.evaluators?.length) {
      registeredPlugin.evaluators = [
        ...(registeredPlugin.evaluators ?? []),
        ...dynamicPlugin.evaluators,
      ];
      for (const evaluator of dynamicPlugin.evaluators) {
        this.runtime.registerEvaluator(evaluator);
      }
    }

    if (dynamicPlugin.models) {
      registeredPlugin.models = {
        ...(registeredPlugin.models ?? {}),
        ...dynamicPlugin.models,
      };
      for (const [modelType, handler] of Object.entries(dynamicPlugin.models)) {
        this.runtime.registerModel(
          modelType,
          handler as Parameters<IAgentRuntime["registerModel"]>[1],
          registeredPlugin.name,
          registeredPlugin.priority,
        );
      }
    }

    if (dynamicPlugin.events) {
      registeredPlugin.events = {
        ...(registeredPlugin.events ?? {}),
      } as NonNullable<Plugin["events"]>;
      for (const [eventName, handlers] of Object.entries(
        dynamicPlugin.events,
      )) {
        const existingHandlers =
          (registeredPlugin.events as Record<string, unknown[]>)[eventName] ??
          [];
        (registeredPlugin.events as Record<string, unknown[]>)[eventName] = [
          ...existingHandlers,
          ...handlers,
        ];
        const registerEvent = this.runtime.registerEvent as (
          event: string,
          handler: (params: unknown) => Promise<void>,
        ) => void;
        for (const handler of handlers) {
          registerEvent(
            eventName,
            handler as (params: unknown) => Promise<void>,
          );
        }
      }
    }

    if (dynamicPlugin.services?.length) {
      registeredPlugin.services = [
        ...(registeredPlugin.services ?? []),
        ...dynamicPlugin.services,
      ] as Plugin["services"];
      for (const service of dynamicPlugin.services) {
        await this.runtime.registerService(service);
      }
    }

    if (dynamicPlugin.routes?.length) {
      registeredPlugin.routes = [
        ...(registeredPlugin.routes ?? []),
        ...dynamicPlugin.routes,
      ];
      const runtimeRoutes = (this.runtime as { routes?: unknown[] }).routes;
      if (Array.isArray(runtimeRoutes)) {
        for (const route of dynamicPlugin.routes) {
          const rawPath = (route as { rawPath?: boolean }).rawPath === true;
          const routePath = route.path.startsWith("/")
            ? route.path
            : `/${route.path}`;
          runtimeRoutes.push({
            ...route,
            path: rawPath ? routePath : `/${registeredPlugin.name}${routePath}`,
          });
        }
      }
    }

    if (dynamicPlugin.views?.length) {
      registeredPlugin.views = [
        ...(registeredPlugin.views ?? []),
        ...dynamicPlugin.views,
      ] as Plugin["views"];
    }
    if (dynamicPlugin.widgets?.length) {
      registeredPlugin.widgets = [
        ...(registeredPlugin.widgets ?? []),
        ...dynamicPlugin.widgets,
      ] as Plugin["widgets"];
    }
    if (dynamicPlugin.componentTypes?.length) {
      registeredPlugin.componentTypes = [
        ...(registeredPlugin.componentTypes ?? []),
        ...dynamicPlugin.componentTypes,
      ] as Plugin["componentTypes"];
    }
  }

  private attachFunctionContributions(
    plugin: Plugin,
    descriptor: JsonObject,
  ): void {
    const actions = descriptor.actions as
      | Array<JsonObject & { name: string; handler: RemoteFunctionRef }>
      | undefined;
    if (actions?.length) {
      plugin.actions = actions.map((action) => this.makeActionStub(action));
    }

    const providers = descriptor.providers as
      | Array<JsonObject & { name: string; get: RemoteFunctionRef }>
      | undefined;
    if (providers?.length) {
      plugin.providers = providers.map((provider) =>
        this.makeProviderStub(provider),
      );
    }

    const events = descriptor.events as unknown as
      | Record<string, RemoteFunctionRef[]>
      | undefined;
    if (events) {
      const eventMap: NonNullable<Plugin["events"]> = {};
      for (const [eventName, refs] of Object.entries(events)) {
        const handlers = refs.map((ref) => this.makeEventHandlerStub(ref));
        (eventMap as Record<string, unknown[]>)[eventName] = handlers;
      }
      plugin.events = eventMap;
    }

    const models = descriptor.models as unknown as
      | Record<string, RemoteFunctionRef>
      | undefined;
    if (models) {
      const modelMap: NonNullable<Plugin["models"]> = {} as NonNullable<
        Plugin["models"]
      >;
      for (const [modelType, ref] of Object.entries(models)) {
        (modelMap as Record<string, unknown>)[modelType] =
          this.makeModelHandlerStub(ref);
      }
      plugin.models = modelMap;
    }
  }

  private attachServiceContributions(
    plugin: Plugin,
    descriptor: JsonObject,
  ): void {
    // Services: opt-in via `static rpcMethods`. The descriptor carries
    // one entry per service with the methods list and per-method rpc
    // ids; we synthesise a ServiceClass with dynamic methods.
    const services = descriptor.services as unknown as
      | Array<
          JsonObject & {
            serviceType: string;
            rpcMethods: string[];
            capabilityDescription?: string;
          }
        >
      | undefined;
    if (services?.length) {
      plugin.services = services.map((svc) =>
        this.makeServiceClassStub(svc),
      ) as Plugin["services"];
    }
  }

  private attachRouteContributions(
    plugin: Plugin,
    descriptor: JsonObject,
  ): void {
    // Routes: the agent's existing plugin-route lifecycle will pick
    // these up. Each routeHandler is wrapped to forward
    // RouteHandlerContext via worker-rpc and return RouteHandlerResult.
    const routes = descriptor.routes as unknown as
      | Array<JsonObject & { path: string; routeHandler?: RemoteFunctionRef }>
      | undefined;
    if (routes?.length) {
      plugin.routes = routes
        .map((r) => this.makeRouteStub(r))
        .filter((r): r is NonNullable<Plugin["routes"]>[number] => r !== null);
    }
  }

  private attachViewContributions(
    plugin: Plugin,
    descriptor: JsonObject,
  ): void {
    // Views/widgets/componentTypes are pure JSON metadata; pass them
    // through unchanged so the existing view registry serves the
    // remote plugin's bundle the same way it does direct plugins'.
    if (descriptor.views)
      plugin.views = descriptor.views as unknown as Plugin["views"];
    if (descriptor.widgets)
      plugin.widgets = descriptor.widgets as unknown as Plugin["widgets"];
    if (descriptor.componentTypes) {
      plugin.componentTypes =
        descriptor.componentTypes as unknown as Plugin["componentTypes"];
    }
  }

  private makeActionStub(
    descriptor: JsonObject & { name: string; handler: RemoteFunctionRef },
  ): Action {
    const name = descriptor.name;
    const similes = (descriptor.similes as string[] | undefined) ?? [];
    const description = String(descriptor.description ?? "");
    const examples =
      (descriptor.examples as unknown as Action["examples"]) ?? [];
    const validateRef = descriptor.validate as unknown as
      | RemoteFunctionRef
      | undefined;

    const handler: Action["handler"] = async (
      _runtime,
      message,
      state,
      options,
      callback,
      responses,
    ) => {
      let callbackId: string | undefined;
      if (callback) {
        callbackId = `action-callback:${this.state.nextRequestId()}`;
        this.state.actionCallbacks.set(callbackId, callback);
      }
      try {
        const result = await this.workerRpc<JsonValue>(
          "action",
          descriptor.handler.id,
          {
            message: this.normalize(message),
            state: this.normalize(state),
            options: this.normalize(options ?? null),
            responses: this.normalize(responses ?? null),
            ...(callbackId ? { callbackId } : {}),
          },
        );
        return result as unknown as ReturnType<Action["handler"]>;
      } finally {
        if (callbackId) {
          this.state.actionCallbacks.delete(callbackId);
        }
      }
    };

    const validate: Validator = validateRef
      ? async (_runtime, message, state) => {
          const result = await this.workerRpc<boolean>(
            "action",
            validateRef.id,
            {
              message: this.normalize(message),
              state: this.normalize(state ?? null),
            },
          );
          return Boolean(result);
        }
      : async () => true;

    const action: Action = {
      name,
      similes,
      description,
      examples,
      handler,
      validate,
    };
    return action;
  }

  private makeProviderStub(
    descriptor: JsonObject & { name: string; get: RemoteFunctionRef },
  ): Provider {
    const name = descriptor.name;
    const description = String(descriptor.description ?? "");
    const dynamic = descriptor.dynamic === true;
    const priv = descriptor.private === true;
    const position =
      typeof descriptor.position === "number" ? descriptor.position : undefined;

    const get: Provider["get"] = async (
      _runtime: IAgentRuntime,
      message: Memory,
      state: State,
    ): Promise<ProviderResult> => {
      const result = await this.workerRpc<JsonValue>(
        "provider",
        descriptor.get.id,
        {
          message: this.normalize(message),
          state: this.normalize(state),
        },
      );
      if (result && typeof result === "object" && !Array.isArray(result)) {
        return result as ProviderResult;
      }
      return { values: {}, data: {}, text: "" } as ProviderResult;
    };

    const provider: Provider = {
      name,
      description,
      get,
    };
    if (dynamic) provider.dynamic = true;
    if (priv) provider.private = true;
    if (position !== undefined) provider.position = position;
    return provider;
  }

  /**
   * Build a {@link ServiceClass} stub from a service descriptor. The
   * returned class has the announced serviceType and a static `start`
   * factory that constructs an instance whose declared rpcMethods
   * worker-rpc into the worker's service trampoline.
   *
   * Methods not in rpcMethods are absent — there is no way to reach
   * private worker methods from the host, which is the whole point of
   * the opt-in.
   */
  private makeServiceClassStub(descriptor: {
    serviceType: string;
    rpcMethods: string[];
    capabilityDescription?: string;
    [rpcKey: string]: unknown;
  }): unknown {
    const bridge = this;
    const serviceType = descriptor.serviceType;
    const description = descriptor.capabilityDescription ?? "";
    const methodIdMap = new Map<string, RpcId>();
    for (const method of descriptor.rpcMethods) {
      const ref = descriptor[`rpc:${method}`] as RemoteFunctionRef | undefined;
      if (ref?.rpc) methodIdMap.set(method, ref.id);
    }

    // Build the proxy class on the fly. The Service base class isn't
    // imported here to avoid pulling all of @elizaos/core into this
    // module; the runtime only needs the static fields it checks.
    class RemoteServiceProxy {
      static readonly serviceType = serviceType;
      static readonly capabilityDescription = description;
      readonly capabilityDescription = description;
      static async start(): Promise<RemoteServiceProxy> {
        const instance = new RemoteServiceProxy();
        return instance;
      }
      constructor() {
        for (const method of descriptor.rpcMethods) {
          const id = methodIdMap.get(method);
          if (!id) continue;
          (this as unknown as Record<string, unknown>)[method] = async (
            ...callArgs: unknown[]
          ) =>
            bridge.workerRpc("service", id, {
              args: callArgs.map((a) => bridge.normalize(a)),
            });
        }
      }
      async stop(): Promise<void> {
        // Stopping the proxy doesn't tear down the worker; the
        // RemotePluginHost owns the worker lifecycle.
      }
    }
    return RemoteServiceProxy;
  }

  /**
   * Build a route stub. The agent's plugin-route registration code
   * picks up `plugin.routes[i]` exactly as for direct plugins; the
   * `routeHandler` here forwards via worker-rpc.
   */
  private makeRouteStub(descriptor: {
    path: string;
    routeHandler?: RemoteFunctionRef;
    type?: unknown;
    name?: unknown;
    public?: unknown;
    isMultipart?: unknown;
  }): NonNullable<Plugin["routes"]>[number] | null {
    if (!descriptor.routeHandler) return null;
    const ref = descriptor.routeHandler;
    const routeHandler = async (ctx: unknown) =>
      this.workerRpc("route", ref.id, { ctx: this.normalize(ctx) });

    const route = {
      path: descriptor.path,
      ...(descriptor.type ? { type: descriptor.type as string } : {}),
      ...(descriptor.name ? { name: descriptor.name as string } : {}),
      ...(descriptor.public !== undefined
        ? { public: Boolean(descriptor.public) }
        : {}),
      ...(descriptor.isMultipart !== undefined
        ? { isMultipart: Boolean(descriptor.isMultipart) }
        : {}),
      routeHandler,
    } as unknown as NonNullable<Plugin["routes"]>[number];
    return route;
  }

  private makeEventHandlerStub(ref: RemoteFunctionRef) {
    return async (payload: unknown): Promise<void> => {
      await this.workerRpc<JsonValue>(
        "event",
        ref.id,
        this.normalize(payload as JsonValue),
      );
    };
  }

  private makeModelHandlerStub(ref: RemoteFunctionRef) {
    return async (
      _runtime: IAgentRuntime,
      params: JsonValue,
    ): Promise<JsonValue> => {
      return this.workerRpc<JsonValue>("model", ref.id, {
        params: this.normalize(params),
      });
    };
  }

  private workerRpc<T extends JsonValue>(
    surface: WorkerRpcMessage["surface"],
    target: RpcId,
    args: JsonValue,
  ): Promise<T> {
    const requestId = this.state.nextRequestId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.state.pending.delete(requestId)) {
          reject(
            new Error(
              `worker-rpc ${surface}:${target} timed out after ${this.rpcTimeoutMs}ms`,
            ),
          );
        }
      }, this.rpcTimeoutMs);
      this.state.pending.set(requestId, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      const envelope: WorkerRpcMessage = {
        type: "worker-rpc",
        requestId,
        surface,
        target,
        args,
      };
      this.channel.send(envelope);
    });
  }

  private handleRpcResult(message: WorkerRpcResultMessage): void {
    const slot = this.state.pending.get(message.requestId);
    if (!slot) return;
    this.state.pending.delete(message.requestId);
    if (slot.timer) clearTimeout(slot.timer);
    if (message.ok) {
      slot.resolve((message.payload ?? null) as JsonValue);
    } else {
      slot.reject(
        fromWireError(
          message.error ?? {
            name: "Error",
            message: "Unknown worker-rpc failure",
          },
          "remote worker",
        ),
      );
    }
  }

  private async handleActionCallback(
    message: WorkerActionCallbackMessage,
  ): Promise<void> {
    const callback = this.state.actionCallbacks.get(message.callbackId);
    if (!callback) return;
    await callback(message.payload as never);
  }

  private async handleHostRpc(message: HostRpcMessage): Promise<void> {
    const reply = (result: HostRpcResultMessage): void => {
      this.channel.send(result);
    };
    try {
      const payload = await this.dispatchRuntimeMethod(message);
      reply({
        type: "host-rpc-result",
        requestId: message.requestId,
        ok: true,
        payload,
      });
    } catch (error) {
      reply({
        type: "host-rpc-result",
        requestId: message.requestId,
        ok: false,
        error: toWireError(error),
      });
    }
  }

  private async dispatchRuntimeMethod(
    message: HostRpcMessage,
  ): Promise<JsonValue> {
    const args = (message.args ?? {}) as Record<string, JsonValue>;
    switch (message.method) {
      case "getService": {
        const serviceType = String(args.serviceType);
        const service = this.runtime.getService(serviceType);
        return service ? { available: true } : null;
      }
      case "useModel": {
        const modelType = String(args.modelType);
        const params = args.params as JsonValue;
        const result = await this.runtime.useModel(
          modelType as Parameters<IAgentRuntime["useModel"]>[0],
          params as Parameters<IAgentRuntime["useModel"]>[1],
        );
        return (result ?? null) as JsonValue;
      }
      case "getMemory": {
        const memoryId = String(args.memoryId);
        const memory = await this.runtime.getMemoryById(
          memoryId as Parameters<IAgentRuntime["getMemoryById"]>[0],
        );
        return (memory ?? null) as unknown as JsonValue;
      }
      case "createMemory": {
        const memory = args.memory as JsonValue;
        const tableName =
          typeof args.tableName === "string" ? args.tableName : undefined;
        const created = await this.runtime.createMemory(
          memory as unknown as Memory,
          tableName ?? "messages",
        );
        return String(created);
      }
      case "updateMemory": {
        await this.runtime.updateMemory(
          args.memory as unknown as Parameters<
            IAgentRuntime["updateMemory"]
          >[0],
        );
        return null;
      }
      case "emitEvent": {
        const eventName = String(args.name);
        const payload = args.payload as JsonValue;
        await this.runtime.emitEvent(
          eventName as Parameters<IAgentRuntime["emitEvent"]>[0],
          payload as unknown as Parameters<IAgentRuntime["emitEvent"]>[1],
        );
        return null;
      }
      case "getSetting": {
        const key = String(args.key);
        const value = this.runtime.getSetting(key);
        return (value ?? null) as JsonValue;
      }
      case "setSetting": {
        const key = String(args.key);
        const value = args.value;
        this.runtime.setSetting(
          key,
          value as Parameters<IAgentRuntime["setSetting"]>[1],
        );
        return null;
      }
      case "composeState": {
        const memory = args.message as unknown as Memory;
        const result = await this.runtime.composeState(memory);
        return (result ?? null) as unknown as JsonValue;
      }
      default:
        throw new Error(
          `Unsupported host-rpc method: ${message.method}. P1 supports getService, useModel, getMemory, createMemory, updateMemory, emitEvent, getSetting, setSetting, composeState.`,
        );
    }
  }

  private normalize(value: unknown): JsonValue {
    if (value === undefined) return null;
    try {
      return JSON.parse(JSON.stringify(value)) as JsonValue;
    } catch {
      return null;
    }
  }
}
