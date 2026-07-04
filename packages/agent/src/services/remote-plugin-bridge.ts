/**
 * RemotePluginBridge — host-side wiring for a remote-mode plugin.
 *
 * Sits between a `RemotePluginHost`-managed worker (or any
 * `BridgeChannel`-shaped transport) and an `IAgentRuntime`. On
 * `worker-announce-plugin` it walks the descriptor, synthesises proxy
 * Plugin contributions (actions, providers, events, models) whose
 * handlers proxy back to the worker over `worker-rpc`, and registers
 * the resulting Plugin with `runtime.registerPlugin(...)`.
 *
 * Inbound `host-rpc` messages from the worker are dispatched to the
 * real runtime (`getService`, `useModel`, `getMemory`, `emitEvent`,
 * `composeState`, etc.) and the result is shipped back as
 * `host-rpc-result`.
 *
 * Wired: actions, providers, events, models, evaluators, action callbacks,
 * services, routes, and views. Streaming model token forwarding remains a
 * separate bridge capability.
 */

import type {
  Action,
  ActionResult,
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
  RemotePluginWorkerMessage,
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
  type WireError,
} from "@elizaos/plugin-remote-manifest/worker-runtime/error";
import * as z from "zod";

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
) as z.ZodType<JsonValue>;

const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

const WireErrorSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    stack: z.string().optional(),
    cause: JsonValueSchema.optional(),
    code: z.string().optional(),
  })
  .passthrough() as z.ZodType<WireError>;

const MemorySchema = z
  .object({
    entityId: z.string(),
    roomId: z.string(),
    content: JsonObjectSchema,
  })
  .catchall(JsonValueSchema) as z.ZodType<Memory>;

const UpdateMemorySchema = z
  .object({
    id: z.string(),
    content: JsonObjectSchema.optional(),
  })
  .catchall(JsonValueSchema) as z.ZodType<
  Parameters<IAgentRuntime["updateMemory"]>[0]
>;

const ActionResultSchema = z
  .object({
    success: z.boolean(),
    text: z.string().optional(),
    userFacingText: z.string().optional(),
    verifiedUserFacing: z.boolean().optional(),
    values: JsonObjectSchema.optional(),
    data: JsonObjectSchema.optional(),
    error: z.union([z.string(), WireErrorSchema]).optional(),
    continueChain: z.boolean().optional(),
  })
  .catchall(JsonValueSchema);

const ActionHandlerWireResultSchema = z.union([ActionResultSchema, z.null()]);

const RouteTypeSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "STATIC",
]);

const RouteHandlerResultSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()).optional(),
  body: JsonValueSchema.optional(),
});

const HostRpcArgsSchema = {
  getService: z.object({ serviceType: z.string() }).passthrough(),
  useModel: z
    .object({ modelType: z.string(), params: JsonValueSchema })
    .passthrough(),
  getMemory: z.object({ memoryId: z.string() }).passthrough(),
  createMemory: z
    .object({
      memory: MemorySchema,
      tableName: z.string().optional(),
    })
    .passthrough(),
  updateMemory: z.object({ memory: UpdateMemorySchema }).passthrough(),
  emitEvent: z
    .object({
      name: z.string(),
      payload: JsonObjectSchema.optional(),
    })
    .passthrough(),
  getSetting: z.object({ key: z.string() }).passthrough(),
  setSetting: z
    .object({
      key: z.string(),
      value: JsonValueSchema,
    })
    .passthrough(),
  composeState: z.object({ message: MemorySchema }).passthrough(),
} as const;

/**
 * Envelope-level validation for the worker→host RPC messages this bridge
 * dispatches. The producer stamps a numeric `requestId` (see
 * `nextRequestId`); a message that reaches a handler without its required
 * fields is a protocol violation that must surface rather than be silently
 * dropped (an rpc-result with no `requestId` would otherwise no-op against the
 * pending map). Malformed *payloads* (vs. malformed envelopes) are still
 * validated downstream and answered with a graceful `ok: false` result, so this
 * gate intentionally checks only the envelope shape.
 */
const RequestIdSchema = z.union([z.string(), z.number()]);
const HandledWorkerEnvelopeSchemas: Partial<
  Record<RemotePluginWorkerMessage["type"], z.ZodTypeAny>
> = {
  "worker-rpc-result": z
    .object({
      type: z.literal("worker-rpc-result"),
      requestId: RequestIdSchema,
      ok: z.boolean(),
    })
    .passthrough(),
  "host-rpc": z
    .object({
      type: z.literal("host-rpc"),
      requestId: RequestIdSchema,
      method: z.string(),
    })
    .passthrough(),
};

function toActionResult(
  value: z.infer<typeof ActionHandlerWireResultSchema>,
): ActionResult | undefined {
  if (value === null) return undefined;
  return {
    ...value,
    ...(typeof value.error === "object" && value.error !== null
      ? { error: fromWireError(value.error, "remote worker action") }
      : {}),
  };
}

/**
 * Schema for the announce/dynamic descriptor the worker emits via
 * {@link buildAnnounceDescriptor}
 * (packages/plugin-remote-manifest/src/worker-runtime/descriptor.ts).
 *
 * The descriptor is untrusted JSON crossing the host↔worker RPC boundary, so
 * it is parsed once at ingress instead of being blind-cast field by field.
 *
 * Object schemas are intentionally passthrough (extra keys pass through): the
 * producer only writes a field when it is present, the metadata surfaces
 * (`views`/`widgets`/`componentTypes`) are author-defined JSON, and the
 * service entries carry dynamic `rpc:<method>` keys. The schema validates the
 * *container shape* (array vs record vs object) and the fields the bridge
 * actually reads; everything else is preserved verbatim. Functions are
 * replaced on the wire by {@link RemoteFunctionRef} (`{ rpc: true, id }`).
 */
const RemoteFunctionRefSchema = z
  .object({
    rpc: z.literal(true),
    id: z.string(),
  })
  .passthrough();

const ActionDescriptorSchema = z
  .object({
    name: z.string(),
    handler: RemoteFunctionRefSchema,
    similes: z.array(z.string()).optional(),
    description: z.string().optional(),
    examples: z.unknown().optional(),
    validate: RemoteFunctionRefSchema.optional(),
  })
  .passthrough();

const ProviderDescriptorSchema = z
  .object({
    name: z.string(),
    get: RemoteFunctionRefSchema,
    description: z.string().optional(),
    dynamic: z.boolean().optional(),
    position: z.number().optional(),
    private: z.boolean().optional(),
  })
  .passthrough();

const ServiceDescriptorSchema = z
  .object({
    serviceType: z.string(),
    rpcMethods: z.array(z.string()),
    capabilityDescription: z.string().optional(),
  })
  .passthrough();

const RouteDescriptorSchema = z
  .object({
    path: z.string(),
    routeHandler: RemoteFunctionRefSchema.optional(),
    type: RouteTypeSchema.optional(),
    name: z.string().optional(),
    public: z.boolean().optional(),
    publicReason: z.string().optional(),
    isMultipart: z.boolean().optional(),
  })
  .passthrough();

const RemotePluginDescriptorSchema = z
  .object({
    name: z.string().optional(),
    description: z.unknown().optional(),
    priority: z.unknown().optional(),
    dependencies: z.array(z.string()).optional(),
    actions: z.array(ActionDescriptorSchema).optional(),
    providers: z.array(ProviderDescriptorSchema).optional(),
    events: z.record(z.string(), z.array(RemoteFunctionRefSchema)).optional(),
    models: z.record(z.string(), RemoteFunctionRefSchema).optional(),
    services: z.array(ServiceDescriptorSchema).optional(),
    routes: z.array(RouteDescriptorSchema).optional(),
    views: z.array(z.unknown()).optional(),
    widgets: z.array(z.unknown()).optional(),
    componentTypes: z.array(z.unknown()).optional(),
  })
  .passthrough();

type RemotePluginDescriptor = z.infer<typeof RemotePluginDescriptorSchema>;
type ActionDescriptor = z.infer<typeof ActionDescriptorSchema>;
type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;
type ServiceDescriptor = z.infer<typeof ServiceDescriptorSchema>;
type RouteDescriptor = z.infer<typeof RouteDescriptorSchema>;
type ParsedFunctionRef = z.infer<typeof RemoteFunctionRefSchema>;

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

interface WorkerActionCallbackEnvelope {
  type: "worker-action-callback";
  callbackId: string;
  payload: JsonValue;
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

function isWorkerActionCallbackEnvelope(
  message: RemotePluginWorkerMessage,
): message is RemotePluginWorkerMessage & WorkerActionCallbackEnvelope {
  const candidate = message as { type?: unknown };
  return candidate.type === "worker-action-callback";
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
    // Keep this staged callback envelope source-typed here so the bridge does
    // not depend on ignored plugin-remote-manifest dist declarations being
    // regenerated before every workspace typecheck.
    if (isWorkerActionCallbackEnvelope(message)) {
      await this.handleActionCallback(message);
      return;
    }

    const envelopeSchema = HandledWorkerEnvelopeSchemas[message.type];
    if (envelopeSchema && !envelopeSchema.safeParse(message).success) {
      throw new Error(`Invalid remote plugin worker message: ${message.type}`);
    }

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

  private materialisePlugin(rawDescriptor: JsonObject): Plugin {
    const descriptor = RemotePluginDescriptorSchema.parse(rawDescriptor);
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
      plugin.dependencies = descriptor.dependencies;
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
    descriptor: RemotePluginDescriptor,
  ): void {
    if (descriptor.actions?.length) {
      plugin.actions = descriptor.actions.map((action) =>
        this.makeActionProxy(action),
      );
    }

    if (descriptor.providers?.length) {
      plugin.providers = descriptor.providers.map((provider) =>
        this.makeProviderProxy(provider),
      );
    }

    if (descriptor.events) {
      const eventMap: NonNullable<Plugin["events"]> = {};
      for (const [eventName, refs] of Object.entries(descriptor.events)) {
        const handlers = refs.map((ref) => this.makeEventHandlerProxy(ref));
        (eventMap as Record<string, unknown[]>)[eventName] = handlers;
      }
      plugin.events = eventMap;
    }

    if (descriptor.models) {
      const modelMap: NonNullable<Plugin["models"]> = {} as NonNullable<
        Plugin["models"]
      >;
      for (const [modelType, ref] of Object.entries(descriptor.models)) {
        (modelMap as Record<string, unknown>)[modelType] =
          this.makeModelHandlerProxy(ref);
      }
      plugin.models = modelMap;
    }
  }

  private attachServiceContributions(
    plugin: Plugin,
    descriptor: RemotePluginDescriptor,
  ): void {
    // Services: opt-in via `static rpcMethods`. The descriptor carries
    // one entry per service with the methods list and per-method rpc
    // ids; we synthesise a ServiceClass with dynamic methods.
    if (descriptor.services?.length) {
      plugin.services = descriptor.services.map((svc) =>
        this.makeServiceClassProxy(svc),
      ) as Plugin["services"];
    }
  }

  private attachRouteContributions(
    plugin: Plugin,
    descriptor: RemotePluginDescriptor,
  ): void {
    // Routes: the agent's existing plugin-route lifecycle will pick
    // these up. Each routeHandler is wrapped to forward
    // RouteHandlerContext via worker-rpc and return RouteHandlerResult.
    if (descriptor.routes?.length) {
      plugin.routes = descriptor.routes
        .map((r) => this.makeRouteProxy(r))
        .filter((r): r is NonNullable<Plugin["routes"]>[number] => r !== null);
    }
  }

  private attachViewContributions(
    plugin: Plugin,
    descriptor: RemotePluginDescriptor,
  ): void {
    // Views/widgets/componentTypes are pure JSON metadata; pass them
    // through unchanged so the existing view registry serves the
    // remote plugin's bundle the same way it does direct plugins'.
    if (descriptor.views) plugin.views = descriptor.views as Plugin["views"];
    if (descriptor.widgets)
      plugin.widgets = descriptor.widgets as Plugin["widgets"];
    if (descriptor.componentTypes) {
      plugin.componentTypes =
        descriptor.componentTypes as Plugin["componentTypes"];
    }
  }

  private makeActionProxy(descriptor: ActionDescriptor): Action {
    const name = descriptor.name;
    const similes = descriptor.similes ?? [];
    const description = String(descriptor.description ?? "");
    const examples = (descriptor.examples as Action["examples"]) ?? [];
    const validateRef = descriptor.validate;

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
        const parsed = ActionHandlerWireResultSchema.parse(result);
        return toActionResult(parsed);
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

  private makeProviderProxy(descriptor: ProviderDescriptor): Provider {
    const name = descriptor.name;
    const description = String(descriptor.description ?? "");
    const dynamic = descriptor.dynamic === true;
    const priv = descriptor.private === true;
    const position = descriptor.position;

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
      throw new Error(
        `Remote provider ${name} returned invalid ProviderResult`,
      );
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
   * Build a {@link ServiceClass} proxy from a service descriptor. The
   * returned class has the announced serviceType and a static `start`
   * factory that constructs an instance whose declared rpcMethods
   * worker-rpc into the worker's service trampoline.
   *
   * Methods not in rpcMethods are absent — there is no way to reach
   * private worker methods from the host, which is the whole point of
   * the opt-in.
   */
  private makeServiceClassProxy(descriptor: ServiceDescriptor): unknown {
    const bridge = this;
    const serviceType = descriptor.serviceType;
    const description = descriptor.capabilityDescription ?? "";
    const methodIdMap = new Map<string, RpcId>();
    for (const method of descriptor.rpcMethods) {
      const ref = RemoteFunctionRefSchema.safeParse(
        descriptor[`rpc:${method}`],
      );
      if (ref.success) methodIdMap.set(method, ref.data.id);
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
          Reflect.set(this, method, async (...callArgs: unknown[]) =>
            bridge.workerRpc("service", id, {
              args: callArgs.map((a) => bridge.normalize(a)),
            }),
          );
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
   * Build a route proxy. The agent's plugin-route registration code
   * picks up `plugin.routes[i]` exactly as for direct plugins; the
   * `routeHandler` here forwards via worker-rpc.
   */
  private makeRouteProxy(
    descriptor: RouteDescriptor,
  ): NonNullable<Plugin["routes"]>[number] | null {
    if (!descriptor.routeHandler) return null;
    const ref = descriptor.routeHandler;
    const routeHandler = async (ctx: unknown) =>
      RouteHandlerResultSchema.parse(
        await this.workerRpc("route", ref.id, { ctx: this.normalize(ctx) }),
      );

    const routeBase = {
      path: descriptor.path,
      type: descriptor.type ?? "GET",
      ...(descriptor.isMultipart !== undefined
        ? { isMultipart: descriptor.isMultipart }
        : {}),
      routeHandler,
    };
    if (descriptor.public === true) {
      if (!descriptor.name) {
        throw new Error(
          `[RemotePluginBridge] public route ${descriptor.path} must declare a name`,
        );
      }
      if (!descriptor.publicReason?.trim()) {
        throw new Error(
          `[RemotePluginBridge] public route ${descriptor.path} must declare publicReason`,
        );
      }
      return {
        ...routeBase,
        public: true,
        name: descriptor.name,
        publicReason: descriptor.publicReason,
      };
    }
    return {
      ...routeBase,
      ...(descriptor.name ? { name: descriptor.name } : {}),
      ...(descriptor.public === false ? { public: false } : {}),
    };
  }

  private makeEventHandlerProxy(ref: ParsedFunctionRef) {
    return async (payload: unknown): Promise<void> => {
      await this.workerRpc<JsonValue>(
        "event",
        ref.id,
        this.normalize(payload as JsonValue),
      );
    };
  }

  private makeModelHandlerProxy(ref: ParsedFunctionRef) {
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
    message: WorkerActionCallbackEnvelope,
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
    switch (message.method) {
      case "getService": {
        const args = HostRpcArgsSchema.getService.parse(message.args);
        const serviceType = args.serviceType;
        const service = this.runtime.getService(serviceType);
        return service ? { available: true } : null;
      }
      case "useModel": {
        const args = HostRpcArgsSchema.useModel.parse(message.args);
        const result = await this.runtime.useModel(
          args.modelType as Parameters<IAgentRuntime["useModel"]>[0],
          args.params as Parameters<IAgentRuntime["useModel"]>[1],
        );
        return (result ?? null) as JsonValue;
      }
      case "getMemory": {
        const args = HostRpcArgsSchema.getMemory.parse(message.args);
        const memory = await this.runtime.getMemoryById(
          args.memoryId as Parameters<IAgentRuntime["getMemoryById"]>[0],
        );
        return JSON.parse(JSON.stringify(memory ?? null)) as JsonValue;
      }
      case "createMemory": {
        const args = HostRpcArgsSchema.createMemory.parse(message.args);
        const created = await this.runtime.createMemory(
          args.memory,
          args.tableName ?? "messages",
        );
        return String(created);
      }
      case "updateMemory": {
        const args = HostRpcArgsSchema.updateMemory.parse(message.args);
        await this.runtime.updateMemory(args.memory);
        return null;
      }
      case "emitEvent": {
        const args = HostRpcArgsSchema.emitEvent.parse(message.args);
        await this.runtime.emitEvent(args.name, {
          ...(args.payload ?? {}),
          runtime: this.runtime,
        });
        return null;
      }
      case "getSetting": {
        const args = HostRpcArgsSchema.getSetting.parse(message.args);
        const value = this.runtime.getSetting(args.key);
        return (value ?? null) as JsonValue;
      }
      case "setSetting": {
        const args = HostRpcArgsSchema.setSetting.parse(message.args);
        this.runtime.setSetting(
          args.key,
          args.value as Parameters<IAgentRuntime["setSetting"]>[1],
        );
        return null;
      }
      case "composeState": {
        const args = HostRpcArgsSchema.composeState.parse(message.args);
        const result = await this.runtime.composeState(args.message);
        return JSON.parse(JSON.stringify(result ?? null)) as JsonValue;
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
