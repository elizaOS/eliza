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
 * P1 wires: actions, providers, events, models, evaluators.
 * Deferred: services, routes, views (P2), action callbacks (P1 step 4
 * follow-up), streaming model tokens (P2).
 */

import { Service } from "@elizaos/core";
import type {
  Action,
  EventPayload,
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  ServiceClass,
  State,
} from "@elizaos/core";
import type {
  HostRpcMessage,
  HostRpcResultMessage,
  JsonObject,
  JsonValue,
  RemoteFunctionRef,
  RemotePluginWorkerMessage,
  WorkerAnnouncePluginMessage,
  WorkerRpcMessage,
  WorkerRpcResultMessage,
} from "@elizaos/plugin-remote-manifest";
import { fromWireError, toWireError } from "@elizaos/plugin-worker-runtime";

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
  pending: Map<number, PendingRequest>;
  nextRequestId: () => number;
  unsubscribe: (() => void) | undefined;
}

type ActionDescriptor = JsonObject & {
  name: string;
  handler: RemoteFunctionRef;
  validate?: RemoteFunctionRef;
};

type ProviderDescriptor = JsonObject & {
  name: string;
  get: RemoteFunctionRef;
};

type ServiceDescriptor = JsonObject & {
  serviceType: string;
  rpcMethods: string[];
  capabilityDescription?: string;
};

type RouteDescriptor = JsonObject & {
  path: string;
  routeHandler?: RemoteFunctionRef;
};

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRemoteFunctionRef(
  value: JsonValue | undefined,
): value is RemoteFunctionRef {
  return isJsonObject(value) && value.rpc === true && typeof value.id === "string";
}

function readObjectArray<T extends JsonObject>(
  value: JsonValue | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isJsonObject) as T[];
}

function readTypedJson<T>(value: JsonValue | undefined): T | undefined {
  if (value === undefined || value === null) return undefined;
  return value as T;
}

function readFunctionRefRecord(
  value: JsonValue | undefined,
): Record<string, RemoteFunctionRef> | undefined {
  if (!isJsonObject(value)) return undefined;
  const record: Record<string, RemoteFunctionRef> = {};
  for (const [key, ref] of Object.entries(value)) {
    if (isRemoteFunctionRef(ref)) record[key] = ref;
  }
  return record;
}

function readFunctionRefArrayRecord(
  value: JsonValue | undefined,
): Record<string, RemoteFunctionRef[]> | undefined {
  if (!isJsonObject(value)) return undefined;
  const record: Record<string, RemoteFunctionRef[]> = {};
  for (const [key, refs] of Object.entries(value)) {
    if (!Array.isArray(refs)) continue;
    record[key] = refs.filter(isRemoteFunctionRef);
  }
  return record;
}

function buildEventPayload(
  runtime: IAgentRuntime,
  payload: JsonValue | undefined,
): EventPayload {
  if (isJsonObject(payload)) {
    return { runtime, ...payload };
  }
  return Object.assign({ runtime }, { payload });
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
      pending: new Map(),
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
      case "worker-rpc-result":
        this.handleRpcResult(message as WorkerRpcResultMessage);
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
    await this.runtime.registerPlugin(plugin);
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

    const actions = readObjectArray<ActionDescriptor>(descriptor.actions);
    if (actions?.length) {
      plugin.actions = actions.map((action) => this.makeActionStub(action));
    }

    const providers = readObjectArray<ProviderDescriptor>(
      descriptor.providers,
    );
    if (providers?.length) {
      plugin.providers = providers.map((provider) =>
        this.makeProviderStub(provider),
      );
    }

    const events = readFunctionRefArrayRecord(descriptor.events);
    if (events) {
      const eventMap: NonNullable<Plugin["events"]> = {};
      for (const [eventName, refs] of Object.entries(events)) {
        const handlers = refs.map((ref) => this.makeEventHandlerStub(ref));
        (eventMap as Record<string, unknown[]>)[eventName] = handlers;
      }
      plugin.events = eventMap;
    }

    const models = readFunctionRefRecord(descriptor.models);
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

    // Services: opt-in via `static rpcMethods`. The descriptor carries
    // one entry per service with the methods list and per-method rpc
    // ids; we synthesise a ServiceClass with dynamic methods.
    const services = readObjectArray<ServiceDescriptor>(descriptor.services);
    if (services?.length) {
      plugin.services = services.map((svc) => this.makeServiceClassStub(svc));
    }

    // Routes: the agent's existing plugin-route lifecycle will pick
    // these up. Each routeHandler is wrapped to forward
    // RouteHandlerContext via worker-rpc and return RouteHandlerResult.
    const routes = readObjectArray<RouteDescriptor>(descriptor.routes);
    if (routes?.length) {
      plugin.routes = routes
        .map((r) => this.makeRouteStub(r))
        .filter((r): r is NonNullable<Plugin["routes"]>[number] => r !== null);
    }

    // Views/widgets/componentTypes are pure JSON metadata; pass them
    // through unchanged so the existing view registry serves the
    // remote plugin's bundle the same way it does direct plugins'.
    const views = readTypedJson<Plugin["views"]>(descriptor.views);
    if (views) plugin.views = views;
    const widgets = readTypedJson<Plugin["widgets"]>(descriptor.widgets);
    if (widgets) plugin.widgets = widgets;
    if (descriptor.componentTypes) {
      plugin.componentTypes = readTypedJson<Plugin["componentTypes"]>(
        descriptor.componentTypes,
      );
    }

    return plugin;
  }

  private makeActionStub(
    descriptor: ActionDescriptor,
  ): Action {
    const name = descriptor.name;
    const similes = (descriptor.similes as string[] | undefined) ?? [];
    const description = String(descriptor.description ?? "");
    const examples = readTypedJson<Action["examples"]>(descriptor.examples) ?? [];
    const validateRef = isRemoteFunctionRef(descriptor.validate)
      ? descriptor.validate
      : undefined;

    const handler: Action["handler"] = async (
      _runtime,
      message,
      state,
      options,
      _callback,
      responses,
    ) => {
      // P1: callback is stubbed on the worker side; pass undefined
      // through. Action handlers that need callback() to surface text
      // already typically rely on the orchestrator's progress channel
      // anyway. Real callback marshalling lands in P1 step 4.
      const result = await this.workerRpc<JsonValue>(
        "action",
        descriptor.handler.id,
        {
          message: this.normalize(message),
          state: this.normalize(state),
          options: this.normalize(options ?? null),
          responses: this.normalize(responses ?? null),
        },
      );
      return result as unknown as ReturnType<Action["handler"]>;
    };

    const validate: Action["validate"] = async (_runtime, message, state) => {
      if (!validateRef) return true;
      const result = await this.workerRpc<boolean>("action", validateRef.id, {
        message: this.normalize(message),
        state: this.normalize(state ?? null),
      });
      return Boolean(result);
    };

    const action: Action = {
      name,
      similes,
      description,
      examples,
      validate,
      handler,
    };
    return action;
  }

  private makeProviderStub(
    descriptor: ProviderDescriptor,
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
  private makeServiceClassStub(descriptor: ServiceDescriptor): ServiceClass {
    const bridge = this;
    const serviceType = descriptor.serviceType;
    const description = descriptor.capabilityDescription ?? "";
    const methodIdMap = new Map<string, RpcId>();
    for (const method of descriptor.rpcMethods) {
      const ref = descriptor[`rpc:${method}`];
      if (isRemoteFunctionRef(ref)) methodIdMap.set(method, ref.id);
    }

    class RemoteServiceProxy extends Service {
      static readonly serviceType = serviceType;
      static readonly capabilityDescription = description;
      readonly capabilityDescription = description;
      static async start(runtime: IAgentRuntime): Promise<Service> {
        return new RemoteServiceProxy(runtime);
      }

      constructor(runtime?: IAgentRuntime) {
        super(runtime);
        for (const method of descriptor.rpcMethods) {
          const id = methodIdMap.get(method);
          if (!id) continue;
          Object.defineProperty(this, method, {
            configurable: false,
            enumerable: false,
            value: async (...callArgs: unknown[]) =>
              bridge.workerRpc("service", id, {
                args: callArgs.map((a) => bridge.normalize(a)),
              }),
          });
        }
      }

      async stop(): Promise<void> {
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
        await this.runtime.emitEvent(
          eventName,
          buildEventPayload(this.runtime, args.payload),
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
