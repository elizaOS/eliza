import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

import {
  type AppPackageRouteContext,
  CAPABILITY_ROUTER_SERVICE_TYPE,
  CapabilityError,
  type ElizaCapabilityRouter,
  getCapabilityRouter,
  type IAgentRuntime,
  type JsonObject,
  type JsonValue,
  type ModelTypeName,
  type Plugin,
  type PluginAppBridge,
  type PluginCallRouteParams,
  type PluginCallServiceParams,
  type PluginInvokeActionParams,
  type PluginWidgetDeclaration,
  type ProviderResult,
  type RegisteredEvaluator,
  type RemotePluginModuleManifest,
  type ResponseHandlerEvaluator,
  type ResponseHandlerFieldEffect,
  type ResponseHandlerFieldEvaluator,
  type Route,
  type RouteHandlerContext,
  type RuntimeEventStorage,
  Service,
  type ServiceClass,
  type ViewDeclaration,
} from "@elizaos/core";
import { packageNameToAppRouteSlug } from "@elizaos/shared";
import {
  type AppRouteModule,
  hasRuntimeAppRouteModule,
  registerRuntimeAppRouteModule,
  unregisterRuntimeAppRouteModule,
} from "./app-package-modules.ts";
import {
  RemoteCapabilityRouterService,
  resolveRemoteCapabilityRouterConfig,
} from "./remote-capability-router.ts";

export type RemotePluginAdapterOptions = {
  modules?: RemotePluginModuleManifest[];
  reloadExisting?: boolean;
  trustPolicy?: RemotePluginTrustPolicy;
  unloadMissingEndpointIds?: string[];
};

export type RemotePluginBootstrapOptions = RemotePluginAdapterOptions & {
  registerRouterService?: boolean;
  unloadMissing?: boolean;
};

export type RemotePluginTrustPolicy = {
  allowedEndpointIds?: string[];
  allowedModuleIds?: string[];
  allowedProvenanceIssuers?: string[];
  trustedProvenancePublicKeys?: Record<string, string>;
  requireEndpointId?: boolean;
  requireSignedProvenance?: boolean;
  requireVerifiedProvenance?: boolean;
  requireProvenanceDigestMatch?: boolean;
};

export type RemotePluginTrustDecision = {
  moduleId: string;
  pluginName: string;
  endpointId?: string;
  trusted: boolean;
  reason:
    | "no-policy"
    | "allowed"
    | "missing-endpoint-id"
    | "endpoint-not-allowed"
    | "module-not-allowed"
    | "missing-provenance"
    | "provenance-issuer-not-allowed"
    | "missing-provenance-public-key"
    | "invalid-provenance-signature"
    | "invalid-provenance-digest";
  provenanceIssuer?: string;
};

export type RemotePluginSyncResult = {
  registered: Plugin[];
  unloaded: string[];
  skipped: string[];
  trustDecisions: RemotePluginTrustDecision[];
};

export async function registerRemoteCapabilityPlugins(
  runtime: IAgentRuntime,
  options: RemotePluginAdapterOptions = {},
): Promise<Plugin[]> {
  const router = requireCapabilityRouter(runtime);
  const modules =
    options.modules ?? (await router.plugin.listModules()).modules;
  evaluateRemotePluginTrustPolicy(modules, options.trustPolicy);
  validateRemotePluginNameCollisions(runtime, modules, options);
  validateRemotePluginComponentCollisions(runtime, modules, options);
  validateRemotePluginServiceCollisions(runtime, modules, options);
  validateRemotePluginModelCollisions(runtime, modules, options);
  validateRemotePluginRouteDeclarations(modules);
  validateRemotePluginRouteCollisions(runtime, modules, options);
  validateRemotePluginViewCollisions(runtime, modules, options);
  validateRemotePluginWidgetCollisions(runtime, modules, options);
  validateRemotePluginNavTabCollisions(runtime, modules, options);
  validateRemotePluginAppBridgeIdentifierCollisions(runtime, modules, options);
  const plugins = modules
    .map((module) => createRemoteCapabilityPlugin(module))
    .filter((plugin) => shouldRegisterPlugin(runtime, plugin, options));
  for (const plugin of plugins) {
    if (options.reloadExisting) {
      await runtime.reloadPlugin(plugin);
    } else {
      await runtime.registerPlugin(plugin);
    }
  }
  return plugins;
}

export async function bootstrapRemoteCapabilityPlugins(
  runtime: IAgentRuntime,
  options: RemotePluginBootstrapOptions = {},
): Promise<RemotePluginSyncResult> {
  const router = await ensureConfiguredCapabilityRouter(runtime, options);
  if (!router) {
    return { registered: [], unloaded: [], skipped: [], trustDecisions: [] };
  }
  return await syncRemoteCapabilityPlugins(runtime, {
    ...options,
    trustPolicy:
      options.trustPolicy ?? resolveConfiguredRemotePluginTrustPolicy(runtime),
    modules: options.modules ?? (await router.plugin.listModules()).modules,
  });
}

export async function syncRemoteCapabilityPlugins(
  runtime: IAgentRuntime,
  options: RemotePluginAdapterOptions & { unloadMissing?: boolean } = {},
): Promise<RemotePluginSyncResult> {
  const router = requireCapabilityRouter(runtime);
  const modules =
    options.modules ?? (await router.plugin.listModules()).modules;
  const trustDecisions = evaluateRemotePluginTrustPolicy(
    modules,
    options.trustPolicy,
  );
  validateRemotePluginNameCollisions(runtime, modules, options);
  validateRemotePluginComponentCollisions(runtime, modules, options);
  validateRemotePluginServiceCollisions(runtime, modules, options);
  validateRemotePluginModelCollisions(runtime, modules, options);
  validateRemotePluginRouteDeclarations(modules);
  validateRemotePluginRouteCollisions(runtime, modules, options);
  validateRemotePluginViewCollisions(runtime, modules, options);
  validateRemotePluginWidgetCollisions(runtime, modules, options);
  validateRemotePluginNavTabCollisions(runtime, modules, options);
  validateRemotePluginAppBridgeIdentifierCollisions(runtime, modules, options);
  const nextPlugins = modules.map((module) =>
    createRemoteCapabilityPlugin(module),
  );
  const nextPluginNames = new Set(nextPlugins.map((plugin) => plugin.name));
  const registered: Plugin[] = [];
  const skipped: string[] = [];

  for (const plugin of nextPlugins) {
    if (!shouldRegisterPlugin(runtime, plugin, options)) {
      skipped.push(plugin.name);
      continue;
    }
    if (options.reloadExisting) {
      await runtime.reloadPlugin(plugin);
    } else {
      await runtime.registerPlugin(plugin);
    }
    registered.push(plugin);
  }

  const unloaded: string[] = [];
  if (options.unloadMissing) {
    const unloadEndpointIds =
      options.unloadMissingEndpointIds === undefined
        ? undefined
        : new Set(options.unloadMissingEndpointIds);
    for (const pluginName of getRegisteredRemoteCapabilityPluginNames(
      runtime,
      unloadEndpointIds,
    )) {
      if (nextPluginNames.has(pluginName)) continue;
      const ownership = await runtime.unloadPlugin(pluginName);
      if (ownership) {
        unloaded.push(pluginName);
      }
    }
  }

  return { registered, unloaded, skipped, trustDecisions };
}

export function createRemoteCapabilityPlugin(
  module: RemotePluginModuleManifest,
): Plugin {
  const endpointId = remoteModuleEndpointId(module);
  const services = (module.services ?? []).map((service) =>
    createRemoteServiceClass(module.id, endpointId, service),
  );
  const routes = (module.routes ?? []).map((route): Route => {
    const baseRoute = {
      type: route.method,
      path: route.path,
      rawPath: true,
      ...(route.description === undefined
        ? {}
        : { description: route.description }),
      routeHandler: async (ctx: RouteHandlerContext) => {
        const result = await requireCapabilityRouter(
          ctx.runtime,
        ).plugin.callRoute({
          ...endpointSelection(endpointId),
          moduleId: module.id,
          method: ctx.method,
          path: ctx.path,
          body: toJsonValue(ctx.body),
          query: ctx.query,
          headers: sanitizeForwardedRouteHeaders(ctx.headers),
        } satisfies PluginCallRouteParams);
        return {
          status: result.status,
          ...(result.headers === undefined
            ? {}
            : { headers: sanitizeRemoteRouteResponseHeaders(result.headers) }),
          ...(result.body === undefined ? {} : { body: result.body }),
        };
      },
    };
    if (route.public) {
      return {
        ...baseRoute,
        public: true,
        name: route.name ?? `${module.name}:${route.path}`,
      };
    }
    return {
      ...baseRoute,
      ...(route.name === undefined ? {} : { name: route.name }),
    };
  });

  const views = (module.views ?? []).map(
    (view): ViewDeclaration => ({
      id: view.id,
      label: view.label,
      viewType: view.viewType === "tui" ? "tui" : "gui",
      ...(view.bundleUrl === undefined ? {} : { bundleUrl: view.bundleUrl }),
      ...(view.bundleUrl !== undefined || view.bundlePath === undefined
        ? {}
        : { bundlePath: view.bundlePath }),
    }),
  );
  const evaluators = (module.evaluators ?? []).map(
    (evaluator): RegisteredEvaluator => ({
      name: evaluator.name,
      description: evaluator.description,
      similes: evaluator.similes,
      priority: evaluator.priority,
      providers: evaluator.providers,
      schema: evaluator.schema,
      modelType: evaluator.modelType,
      shouldRun: async ({ runtime, message, state, options }) =>
        (
          await requireCapabilityRouter(runtime).plugin.shouldRunEvaluator({
            ...endpointSelection(endpointId),
            moduleId: module.id,
            evaluator: evaluator.name,
            message: toJsonObject(message),
            state: toJsonObject(state),
            options: toJsonObject(options),
          })
        ).shouldRun,
      ...(evaluator.hasPrepare
        ? {
            prepare: async ({ runtime, message, state, options }) =>
              (
                await requireCapabilityRouter(runtime).plugin.prepareEvaluator({
                  ...endpointSelection(endpointId),
                  moduleId: module.id,
                  evaluator: evaluator.name,
                  message: toJsonObject(message),
                  state: toJsonObject(state),
                  options: toJsonObject(options),
                })
              ).prepared,
          }
        : {}),
      prompt: () => evaluator.prompt,
      ...(evaluator.hasProcessor
        ? {
            processors: [
              {
                name: `${evaluator.name}:remote`,
                process: async ({
                  runtime,
                  message,
                  state,
                  options,
                  prepared,
                  output,
                }) =>
                  (
                    await requireCapabilityRouter(
                      runtime,
                    ).plugin.processEvaluator({
                      ...endpointSelection(endpointId),
                      moduleId: module.id,
                      evaluator: evaluator.name,
                      message: toJsonObject(message),
                      state: toJsonObject(state),
                      options: toJsonObject(options),
                      prepared: toJsonValue(prepared),
                      output: toJsonValue(output),
                    })
                  ).result as never,
              },
            ],
          }
        : {}),
    }),
  );
  const responseHandlerEvaluators = (
    module.responseHandlerEvaluators ?? []
  ).map(
    (evaluator): ResponseHandlerEvaluator => ({
      name: evaluator.name,
      description: evaluator.description,
      priority: evaluator.priority,
      shouldRun: async (context) =>
        (
          await requireCapabilityRouter(
            context.runtime,
          ).plugin.shouldRunResponseHandlerEvaluator({
            ...endpointSelection(endpointId),
            moduleId: module.id,
            evaluator: evaluator.name,
            context: responseHandlerContextToJsonObject(context),
          })
        ).shouldRun,
      evaluate: async (context) =>
        (
          await requireCapabilityRouter(
            context.runtime,
          ).plugin.evaluateResponseHandlerEvaluator({
            ...endpointSelection(endpointId),
            moduleId: module.id,
            evaluator: evaluator.name,
            context: responseHandlerContextToJsonObject(context),
          })
        ).patch as never,
    }),
  );
  const responseHandlerFieldEvaluators = (
    module.responseHandlerFieldEvaluators ?? []
  ).map(
    (field): ResponseHandlerFieldEvaluator => ({
      name: field.name,
      description: field.description,
      priority: field.priority,
      schema: field.schema,
      shouldRun: async (context) =>
        (
          await requireCapabilityRouter(
            context.runtime,
          ).plugin.shouldRunResponseHandlerFieldEvaluator({
            ...endpointSelection(endpointId),
            moduleId: module.id,
            field: field.name,
            context: responseHandlerFieldContextToJsonObject(context),
          })
        ).shouldRun,
      ...(field.hasParse
        ? {
            parse: async (value, context) => {
              const result = await requireCapabilityRouter(
                context.runtime,
              ).plugin.parseResponseHandlerFieldEvaluator({
                ...endpointSelection(endpointId),
                moduleId: module.id,
                field: field.name,
                value: toJsonValue(value),
                context: responseHandlerFieldContextToJsonObject(context),
              });
              if (result.softFail) return null;
              return result.value;
            },
          }
        : {}),
      ...(field.hasHandle
        ? {
            handle: async (context) => {
              const result = await requireCapabilityRouter(
                context.runtime,
              ).plugin.handleResponseHandlerFieldEvaluator({
                ...endpointSelection(endpointId),
                moduleId: module.id,
                field: field.name,
                value: toJsonValue(context.value),
                parsed: toJsonObject(context.parsed),
                context: responseHandlerFieldContextToJsonObject(context),
              });
              return responseHandlerFieldEffectFromJson(result.effect);
            },
          }
        : {}),
    }),
  );
  const events = (module.events ?? []).reduce<RuntimeEventStorage>(
    (accumulator, event) => {
      const handlers = accumulator[event.eventName] ?? [];
      handlers.push(async (payload) => {
        await requireCapabilityRouter(payload.runtime).plugin.handleEvent({
          ...endpointSelection(endpointId),
          moduleId: module.id,
          eventName: event.eventName,
          payload: eventPayloadToJsonObject(payload),
        });
      });
      accumulator[event.eventName] = handlers;
      return accumulator;
    },
    {},
  );
  const models = (module.models ?? []).reduce<
    NonNullable<Plugin["models"]> &
      Record<
        string,
        (runtime: IAgentRuntime, params: unknown) => Promise<never>
      >
  >((accumulator, model) => {
    accumulator[model.modelType as ModelTypeName] = async (_runtime, params) =>
      (
        await requireCapabilityRouter(_runtime).plugin.invokeModel({
          ...endpointSelection(endpointId),
          moduleId: module.id,
          modelType: model.modelType,
          params: toJsonValue(params),
        })
      ).result as never;
    return accumulator;
  }, {});
  const widgets = (module.widgets ?? []).map(
    (widget): PluginWidgetDeclaration => ({
      id: widget.id,
      pluginId: widget.pluginId ?? module.name,
      slot: widget.slot,
      label: widget.label,
      ...(widget.icon === undefined ? {} : { icon: widget.icon }),
      ...(widget.order === undefined ? {} : { order: widget.order }),
      ...(widget.defaultEnabled === undefined
        ? {}
        : { defaultEnabled: widget.defaultEnabled }),
      ...(widget.navGroup === undefined ? {} : { navGroup: widget.navGroup }),
      ...(widget.developerOnly === undefined
        ? {}
        : { developerOnly: widget.developerOnly }),
      ...(widget.componentExport === undefined
        ? {}
        : { componentExport: widget.componentExport }),
    }),
  );
  const appBridge =
    module.appBridge === undefined
      ? undefined
      : createRemoteAppBridge(module.id, endpointId, module.appBridge.hooks);
  const lifecycleHooks = new Set(module.lifecycle?.hooks ?? []);

  return {
    name: module.name,
    description:
      module.description ?? `Remote capability plugin module ${module.name}`,
    ...(module.contexts === undefined ? {} : { contexts: module.contexts }),
    ...(module.schema === undefined ? {} : { schema: module.schema }),
    actions: (module.actions ?? []).map((action) => ({
      name: action.name,
      description: action.description,
      descriptionCompressed: action.descriptionCompressed,
      similes: action.similes,
      validate: async (runtime) => Boolean(getCapabilityRouter(runtime)),
      handler: async (runtime, message, _state, options, callback) => {
        const result = await requireCapabilityRouter(
          runtime,
        ).plugin.invokeAction({
          ...endpointSelection(endpointId),
          moduleId: module.id,
          action: action.name,
          content: toJsonObject(message.content),
          options: toJsonObject(options),
        } satisfies PluginInvokeActionParams);

        if (result.text) {
          await callback?.(
            {
              text: result.text,
              actions: result.actions,
            },
            action.name,
          );
        }

        return {
          success: true,
          text: result.text,
          values: result.values,
          data: result.data,
        };
      },
    })),
    providers: (module.providers ?? []).map((provider) => ({
      name: provider.name,
      description: provider.description,
      descriptionCompressed: provider.descriptionCompressed,
      dynamic: provider.dynamic,
      private: provider.private,
      get: async (runtime, _message, state): Promise<ProviderResult> =>
        await requireCapabilityRouter(runtime).plugin.getProvider({
          ...endpointSelection(endpointId),
          moduleId: module.id,
          provider: provider.name,
          state: toJsonObject(state),
        }),
    })),
    evaluators,
    ...(responseHandlerEvaluators.length === 0
      ? {}
      : { responseHandlerEvaluators }),
    ...(responseHandlerFieldEvaluators.length === 0
      ? {}
      : { responseHandlerFieldEvaluators }),
    ...(module.events?.length ? { events } : {}),
    ...(module.models?.length ? { models } : {}),
    ...remotePluginPriority(module),
    ...(widgets.length === 0 ? {} : { widgets }),
    ...(module.app === undefined ? {} : { app: module.app }),
    ...(appBridge === undefined
      ? {}
      : {
          appBridge,
        }),
    ...(appBridge !== undefined || lifecycleHooks.has("init")
      ? {
          init: async (
            config: Record<string, string>,
            runtime: IAgentRuntime,
          ) => {
            if (appBridge !== undefined) {
              for (const identifier of remoteAppBridgeIdentifiers(module)) {
                registerRuntimeAppRouteModule(identifier, appBridge);
              }
            }
            if (lifecycleHooks.has("init")) {
              await callRemoteLifecycle(
                runtime,
                module.id,
                endpointId,
                "init",
                {
                  config,
                },
              );
            }
          },
        }
      : {}),
    ...(appBridge !== undefined || lifecycleHooks.has("dispose")
      ? {
          dispose: async (runtime: IAgentRuntime) => {
            try {
              if (lifecycleHooks.has("dispose")) {
                await callRemoteLifecycle(
                  runtime,
                  module.id,
                  endpointId,
                  "dispose",
                );
              }
            } finally {
              if (appBridge !== undefined) {
                for (const identifier of remoteAppBridgeIdentifiers(module)) {
                  unregisterRuntimeAppRouteModule(identifier);
                }
              }
            }
          },
        }
      : {}),
    ...(lifecycleHooks.has("applyConfig")
      ? {
          applyConfig: async (
            config: Record<string, string>,
            runtime: IAgentRuntime,
          ) => {
            await callRemoteLifecycle(
              runtime,
              module.id,
              endpointId,
              "applyConfig",
              { config },
            );
          },
        }
      : {}),
    routes,
    ...(services.length === 0 ? {} : { services }),
    ...(module.componentTypes === undefined
      ? {}
      : { componentTypes: module.componentTypes }),
    views,
    config: {
      ...(module.config ?? {}),
      remoteCapabilityModuleId: module.id,
      ...(endpointId === undefined
        ? {}
        : { remoteCapabilityEndpointId: endpointId }),
      remoteCapabilityVersion: module.version ?? null,
    },
  };
}

function createRemoteAppBridge(
  moduleId: string,
  endpointId: string | undefined,
  hooks: string[],
): PluginAppBridge & AppRouteModule {
  const bridge: PluginAppBridge & AppRouteModule = {};
  const hookSet = new Set(hooks);
  const call = async (
    runtime: IAgentRuntime | null | undefined,
    hook: string,
    ctx: unknown,
  ) =>
    await requireCapabilityRouterFromNullable(runtime).plugin.callAppBridge({
      ...endpointSelection(endpointId),
      moduleId,
      hook: hook as never,
      context: appBridgeContextToJsonObject(ctx),
    });

  if (hookSet.has("prepareLaunch")) {
    bridge.prepareLaunch = async (ctx) =>
      (await call(ctx.runtime, "prepareLaunch", ctx)).result as never;
  }
  if (hookSet.has("resolveViewerAuthMessage")) {
    bridge.resolveViewerAuthMessage = async (ctx) =>
      (await call(ctx.runtime, "resolveViewerAuthMessage", ctx))
        .result as never;
  }
  if (hookSet.has("ensureRuntimeReady")) {
    bridge.ensureRuntimeReady = async (ctx) => {
      await call(ctx.runtime, "ensureRuntimeReady", ctx);
    };
  }
  if (hookSet.has("collectLaunchDiagnostics")) {
    bridge.collectLaunchDiagnostics = async (ctx) =>
      ((await call(ctx.runtime, "collectLaunchDiagnostics", ctx)).result ??
        []) as never;
  }
  if (hookSet.has("resolveLaunchSession")) {
    bridge.resolveLaunchSession = async (ctx) =>
      (await call(ctx.runtime, "resolveLaunchSession", ctx)).result as never;
  }
  if (hookSet.has("refreshRunSession")) {
    bridge.refreshRunSession = async (ctx) =>
      (await call(ctx.runtime, "refreshRunSession", ctx)).result as never;
  }
  if (hookSet.has("stopRun")) {
    bridge.stopRun = async (ctx: unknown) => {
      const runtime =
        ctx && typeof ctx === "object" && "runtime" in ctx
          ? (ctx as { runtime?: IAgentRuntime | null }).runtime
          : null;
      await call(runtime, "stopRun", ctx);
    };
  }
  if (hookSet.has("handleAppRoutes")) {
    bridge.handleAppRoutes = async (ctx) =>
      await callRemoteAppRoutes(moduleId, endpointId, ctx);
  }
  return bridge;
}

function createRemoteServiceClass(
  moduleId: string,
  endpointId: string | undefined,
  service: NonNullable<RemotePluginModuleManifest["services"]>[number],
): ServiceClass {
  const methodNames = new Set(service.methods ?? []);

  class RemoteCapabilityService extends Service {
    static serviceType = service.serviceType;
    capabilityDescription =
      service.capabilityDescription ??
      `Remote capability service ${service.serviceType}`;
    config = service.config;

    static async start(runtime: IAgentRuntime): Promise<Service> {
      return new RemoteCapabilityService(runtime);
    }

    async stop(): Promise<void> {
      if (!methodNames.has("stop")) return;
      await this.callRemote("stop", []);
    }

    async callRemote(
      method: string,
      args: unknown[],
    ): Promise<JsonValue | undefined> {
      const jsonArgs = args.map((arg) => toJsonValue(arg) ?? null);
      const result = await requireCapabilityRouter(
        this.runtime,
      ).plugin.callService({
        ...endpointSelection(endpointId),
        moduleId,
        serviceType: service.serviceType,
        method,
        args: jsonArgs,
      } satisfies PluginCallServiceParams);
      return result.result;
    }
  }

  for (const method of methodNames) {
    if (method === "stop" || method === "constructor") continue;
    Object.defineProperty(RemoteCapabilityService.prototype, method, {
      configurable: true,
      value: async function remoteServiceMethod(
        this: RemoteCapabilityService,
        ...args: unknown[]
      ) {
        return await this.callRemote(method, args);
      },
    });
  }

  return RemoteCapabilityService;
}

async function callRemoteLifecycle(
  runtime: IAgentRuntime,
  moduleId: string,
  endpointId: string | undefined,
  hook: "init" | "dispose" | "applyConfig",
  options: { config?: Record<string, string> } = {},
): Promise<void> {
  await requireCapabilityRouter(runtime).plugin.callLifecycle({
    ...endpointSelection(endpointId),
    moduleId,
    hook,
    ...(options.config === undefined ? {} : { config: options.config }),
  });
}

async function callRemoteAppRoutes(
  moduleId: string,
  endpointId: string | undefined,
  ctx: AppPackageRouteContext,
): Promise<boolean> {
  const body = shouldReadRouteBody(ctx.method)
    ? await ctx.readJsonBody<Record<string, JsonValue>>()
    : undefined;
  const result = (
    await requireCapabilityRouterFromNullable(
      ctx.runtime as IAgentRuntime | null | undefined,
    ).plugin.callAppBridge({
      ...endpointSelection(endpointId),
      moduleId,
      hook: "handleAppRoutes",
      context: {
        method: ctx.method,
        pathname: ctx.pathname,
        path: ctx.url.pathname,
        query: routeQueryToJsonObject(ctx.url),
        headers: routeHeadersToJsonObject(
          sanitizeForwardedRouteHeaders(ctx.req.headers),
        ),
        ...(body === undefined ? {} : { body: toJsonValue(body) ?? null }),
      },
    })
  ).result;

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }

  const response = result as JsonObject;
  if (response.handled !== true) {
    return false;
  }

  const headers = sanitizeRemoteRouteResponseHeaders(
    toStringRecord(response.headers),
  );
  for (const [key, value] of Object.entries(headers)) {
    ctx.res.setHeader(key, value);
  }
  const status =
    typeof response.status === "number" && Number.isInteger(response.status)
      ? response.status
      : 200;
  const responseBody = response.body;
  if (
    responseBody !== undefined &&
    responseBody !== null &&
    typeof responseBody === "object"
  ) {
    ctx.json(ctx.res, responseBody, status);
    return true;
  }
  ctx.res.statusCode = status;
  ctx.res.end(responseBody === undefined ? "" : String(responseBody));
  return true;
}

function remoteAppBridgeIdentifiers(
  module: RemotePluginModuleManifest,
): string[] {
  return Array.from(
    new Set(
      [module.name, module.app?.runtimePlugin, module.app?.displayName].filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      ),
    ),
  );
}

function maxModelPriority(
  module: RemotePluginModuleManifest,
): number | undefined {
  const priorities = (module.models ?? [])
    .map((model) => model.priority)
    .filter((priority): priority is number => typeof priority === "number");
  if (priorities.length === 0) return undefined;
  return Math.max(...priorities);
}

function remotePluginPriority(
  module: RemotePluginModuleManifest,
): { priority: number } | Record<string, never> {
  const priority = module.priority ?? maxModelPriority(module);
  return priority === undefined ? {} : { priority };
}

function remoteModuleEndpointId(
  module: RemotePluginModuleManifest,
): string | undefined {
  return typeof module.capabilityEndpointId === "string" &&
    module.capabilityEndpointId.trim().length > 0
    ? module.capabilityEndpointId
    : undefined;
}

function endpointSelection(endpointId: string | undefined): {
  endpointId?: string;
} {
  return endpointId === undefined ? {} : { endpointId };
}

function shouldRegisterPlugin(
  runtime: IAgentRuntime,
  plugin: Plugin,
  options: Pick<RemotePluginAdapterOptions, "reloadExisting">,
): boolean {
  if (options.reloadExisting) return true;
  return !runtime.plugins?.some((existing) => existing.name === plugin.name);
}

function validateRemotePluginNameCollisions(
  runtime: IAgentRuntime,
  modules: RemotePluginModuleManifest[],
  options: Pick<RemotePluginAdapterOptions, "reloadExisting">,
): void {
  const seen = new Map<string, string>();
  for (const module of modules) {
    const existingModuleId = seen.get(module.name);
    if (existingModuleId) {
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote plugin name collision for "${module.name}" between modules "${existingModuleId}" and "${module.id}".`,
        capability: "plugin",
        method: "plugin.modules.list",
      });
    }
    seen.set(module.name, module.id);
  }

  if (options.reloadExisting) return;

  const remotePluginNames = new Set(
    getRegisteredRemoteCapabilityPluginNames(runtime),
  );
  for (const module of modules) {
    const existing = runtime.plugins?.find(
      (plugin) => plugin.name === module.name,
    );
    if (existing && !remotePluginNames.has(existing.name)) {
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote plugin "${module.id}" would collide with local plugin "${module.name}".`,
        capability: "plugin",
        method: "plugin.modules.list",
      });
    }
  }
}

function evaluateRemotePluginTrustPolicy(
  modules: RemotePluginModuleManifest[],
  policy: RemotePluginTrustPolicy | undefined,
): RemotePluginTrustDecision[] {
  if (!policy) {
    return modules.map((module) => ({
      moduleId: module.id,
      pluginName: module.name,
      ...(remoteModuleEndpointId(module) === undefined
        ? {}
        : { endpointId: remoteModuleEndpointId(module) }),
      trusted: true,
      reason: "no-policy",
    }));
  }
  const allowedEndpointIds =
    policy.allowedEndpointIds === undefined
      ? null
      : new Set(policy.allowedEndpointIds);
  const allowedModuleIds =
    policy.allowedModuleIds === undefined
      ? null
      : new Set(policy.allowedModuleIds);
  const allowedProvenanceIssuers =
    policy.allowedProvenanceIssuers === undefined
      ? null
      : new Set(policy.allowedProvenanceIssuers);

  const decisions: RemotePluginTrustDecision[] = [];
  for (const module of modules) {
    const endpointId = remoteModuleEndpointId(module);
    const provenanceIssuer =
      typeof module.provenance?.issuer === "string"
        ? module.provenance.issuer
        : undefined;
    if (policy.requireEndpointId && endpointId === undefined) {
      const decision = trustDecision(
        module,
        endpointId,
        false,
        "missing-endpoint-id",
      );
      decisions.push(decision);
      throw new CapabilityError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `Remote plugin "${module.id}" does not declare a trusted capability endpoint id.`,
        capability: "plugin",
        method: "plugin.modules.list",
        details: { trustDecision: decision },
      });
    }
    if (
      allowedEndpointIds &&
      (endpointId === undefined || !allowedEndpointIds.has(endpointId))
    ) {
      const decision = trustDecision(
        module,
        endpointId,
        false,
        "endpoint-not-allowed",
      );
      decisions.push(decision);
      throw new CapabilityError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `Remote plugin "${module.id}" comes from untrusted capability endpoint "${endpointId ?? "unknown"}".`,
        capability: "plugin",
        method: "plugin.modules.list",
        details: { trustDecision: decision },
      });
    }
    if (allowedModuleIds && !allowedModuleIds.has(module.id)) {
      const decision = trustDecision(
        module,
        endpointId,
        false,
        "module-not-allowed",
      );
      decisions.push(decision);
      throw new CapabilityError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `Remote plugin module "${module.id}" is not trusted for registration.`,
        capability: "plugin",
        method: "plugin.modules.list",
        details: { trustDecision: decision },
      });
    }
    if (policy.requireSignedProvenance && module.provenance === undefined) {
      const decision = trustDecision(
        module,
        endpointId,
        false,
        "missing-provenance",
      );
      decisions.push(decision);
      throw new CapabilityError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `Remote plugin module "${module.id}" does not include signed provenance.`,
        capability: "plugin",
        method: "plugin.modules.list",
        details: { trustDecision: decision },
      });
    }
    if (
      allowedProvenanceIssuers &&
      (provenanceIssuer === undefined ||
        !allowedProvenanceIssuers.has(provenanceIssuer))
    ) {
      const decision = trustDecision(
        module,
        endpointId,
        false,
        "provenance-issuer-not-allowed",
      );
      decisions.push(decision);
      throw new CapabilityError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `Remote plugin module "${module.id}" provenance issuer "${provenanceIssuer ?? "unknown"}" is not trusted for registration.`,
        capability: "plugin",
        method: "plugin.modules.list",
        details: { trustDecision: decision },
      });
    }
    if (policy.requireVerifiedProvenance) {
      if (module.provenance === undefined) {
        const decision = trustDecision(
          module,
          endpointId,
          false,
          "missing-provenance",
        );
        decisions.push(decision);
        throw new CapabilityError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `Remote plugin module "${module.id}" does not include signed provenance.`,
          capability: "plugin",
          method: "plugin.modules.list",
          details: { trustDecision: decision },
        });
      }
      const publicKey =
        policy.trustedProvenancePublicKeys?.[module.provenance.issuer];
      if (!publicKey) {
        const decision = trustDecision(
          module,
          endpointId,
          false,
          "missing-provenance-public-key",
        );
        decisions.push(decision);
        throw new CapabilityError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `Remote plugin module "${module.id}" provenance issuer "${module.provenance.issuer}" has no trusted verification key.`,
          capability: "plugin",
          method: "plugin.modules.list",
          details: { trustDecision: decision },
        });
      }
      if (!verifyRemotePluginModuleProvenance(module, publicKey)) {
        const decision = trustDecision(
          module,
          endpointId,
          false,
          "invalid-provenance-signature",
        );
        decisions.push(decision);
        throw new CapabilityError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `Remote plugin module "${module.id}" provenance signature is invalid.`,
          capability: "plugin",
          method: "plugin.modules.list",
          details: { trustDecision: decision },
        });
      }
    }
    if (policy.requireProvenanceDigestMatch) {
      if (module.provenance === undefined) {
        const decision = trustDecision(
          module,
          endpointId,
          false,
          "missing-provenance",
        );
        decisions.push(decision);
        throw new CapabilityError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `Remote plugin module "${module.id}" does not include signed provenance.`,
          capability: "plugin",
          method: "plugin.modules.list",
          details: { trustDecision: decision },
        });
      }
      if (!remotePluginModuleProvenanceDigestMatches(module)) {
        const decision = trustDecision(
          module,
          endpointId,
          false,
          "invalid-provenance-digest",
        );
        decisions.push(decision);
        throw new CapabilityError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `Remote plugin module "${module.id}" provenance digest does not match module contents.`,
          capability: "plugin",
          method: "plugin.modules.list",
          details: { trustDecision: decision },
        });
      }
    }
    decisions.push(trustDecision(module, endpointId, true, "allowed"));
  }
  return decisions;
}

function verifyRemotePluginModuleProvenance(
  module: RemotePluginModuleManifest,
  publicKeyPem: string,
): boolean {
  const provenance = module.provenance;
  if (!provenance) return false;
  if (provenance.signatureAlgorithm.toLowerCase() !== "ed25519") {
    return false;
  }
  try {
    return verifySignature(
      null,
      Buffer.from(remotePluginModuleProvenancePayload(provenance), "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(provenance.signature, "base64"),
    );
  } catch {
    return false;
  }
}

function remotePluginModuleProvenancePayload(
  provenance: NonNullable<RemotePluginModuleManifest["provenance"]>,
): string {
  return [
    `issuer:${provenance.issuer}`,
    `subject:${provenance.subject}`,
    `digestSha256:${provenance.digestSha256.toLowerCase()}`,
  ].join("\n");
}

function remotePluginModuleProvenanceDigestMatches(
  module: RemotePluginModuleManifest,
): boolean {
  const provenance = module.provenance;
  if (!provenance) return false;
  return (
    hashRemotePluginModuleForProvenance(module) ===
    provenance.digestSha256.toLowerCase()
  );
}

function hashRemotePluginModuleForProvenance(
  module: RemotePluginModuleManifest,
): string {
  return createHash("sha256")
    .update(canonicalJsonForRemotePluginProvenance(module), "utf8")
    .digest("hex");
}

function canonicalJsonForRemotePluginProvenance(
  module: RemotePluginModuleManifest,
): string {
  const { capabilityEndpointId: _endpointId, provenance: _provenance, ...rest } =
    module;
  return JSON.stringify(canonicalizeForRemotePluginProvenance(rest));
}

function canonicalizeForRemotePluginProvenance(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeForRemotePluginProvenance(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [
          key,
          canonicalizeForRemotePluginProvenance(entry),
        ]),
    );
  }
  return value;
}

function trustDecision(
  module: RemotePluginModuleManifest,
  endpointId: string | undefined,
  trusted: boolean,
  reason: RemotePluginTrustDecision["reason"],
): RemotePluginTrustDecision {
  return {
    moduleId: module.id,
    pluginName: module.name,
    ...(endpointId === undefined ? {} : { endpointId }),
    ...(module.provenance?.issuer === undefined
      ? {}
      : { provenanceIssuer: module.provenance.issuer }),
    trusted,
    reason,
  };
}

function resolveConfiguredRemotePluginTrustPolicy(
  runtime: IAgentRuntime,
): RemotePluginTrustPolicy | undefined {
  const routerConfig = resolveRemoteCapabilityRouterConfig(runtime);
  const endpointIds = configuredEndpointIds(routerConfig);
  if (endpointIds.length === 0) return undefined;
  const allowedModuleIds = configuredAllowedModuleIds(runtime, endpointIds);
  return {
    allowedEndpointIds: endpointIds,
    ...(allowedModuleIds.length === 0 ? {} : { allowedModuleIds }),
    requireEndpointId: true,
  };
}

function configuredEndpointIds(config: {
  baseUrl?: string;
  endpoints?: Array<{ id: string }>;
}): string[] {
  const ids = new Set<string>();
  if (config.baseUrl) ids.add("primary");
  for (const endpoint of config.endpoints ?? []) {
    if (endpoint.id.trim()) ids.add(endpoint.id.trim());
  }
  return [...ids];
}

function configuredAllowedModuleIds(
  runtime: IAgentRuntime,
  endpointIds: string[],
): string[] {
  const configured = runtime.getSetting?.(
    "ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES",
  );
  const raw =
    typeof configured === "string" && configured.trim()
      ? configured
      : process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return uniqueStrings(parsed);
    }
    if (!parsed || typeof parsed !== "object") return [];
    const modules = new Set<string>();
    for (const endpointId of endpointIds) {
      const value = (parsed as Record<string, unknown>)[endpointId];
      for (const moduleId of uniqueStrings(value)) {
        modules.add(moduleId);
      }
    }
    return [...modules];
  } catch {
    return [];
  }
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function validateRemotePluginComponentCollisions(
  runtime: IAgentRuntime,
  modules: RemotePluginModuleManifest[],
  options: Pick<RemotePluginAdapterOptions, "reloadExisting">,
): void {
  validateNamedRemoteComponents({
    runtime,
    modules,
    options,
    kind: "action",
    existingNames: runtime.actions?.map((action) => action.name) ?? [],
    existingRemoteOwners: getRegisteredRemoteCapabilityComponentOwners(
      runtime,
      "actions",
      (action) => action.name,
    ),
    namesForModule: (module) =>
      (module.actions ?? []).map((action) => action.name),
  });
  validateNamedRemoteComponents({
    runtime,
    modules,
    options,
    kind: "provider",
    existingNames: runtime.providers?.map((provider) => provider.name) ?? [],
    existingRemoteOwners: getRegisteredRemoteCapabilityComponentOwners(
      runtime,
      "providers",
      (provider) => provider.name,
    ),
    namesForModule: (module) =>
      (module.providers ?? []).map((provider) => provider.name),
  });
  validateNamedRemoteComponents({
    runtime,
    modules,
    options,
    kind: "evaluator",
    existingNames: runtime.evaluators?.map((evaluator) => evaluator.name) ?? [],
    existingRemoteOwners: getRegisteredRemoteCapabilityComponentOwners(
      runtime,
      "evaluators",
      (evaluator) => evaluator.name,
    ),
    namesForModule: (module) =>
      (module.evaluators ?? []).map((evaluator) => evaluator.name),
  });
  validateNamedRemoteComponents({
    runtime,
    modules,
    options,
    kind: "response-handler evaluator",
    existingNames:
      runtime.responseHandlerEvaluators?.map((evaluator) => evaluator.name) ??
      [],
    existingRemoteOwners: getRegisteredRemoteCapabilityComponentOwners(
      runtime,
      "responseHandlerEvaluators",
      (evaluator) => evaluator.name,
    ),
    namesForModule: (module) =>
      (module.responseHandlerEvaluators ?? []).map(
        (evaluator) => evaluator.name,
      ),
  });
  validateNamedRemoteComponents({
    runtime,
    modules,
    options,
    kind: "response-handler field evaluator",
    existingNames:
      runtime.responseHandlerFieldEvaluators?.map(
        (evaluator) => evaluator.name,
      ) ?? [],
    existingRemoteOwners: getRegisteredRemoteCapabilityComponentOwners(
      runtime,
      "responseHandlerFieldEvaluators",
      (evaluator) => evaluator.name,
    ),
    namesForModule: (module) =>
      (module.responseHandlerFieldEvaluators ?? []).map(
        (evaluator) => evaluator.name,
      ),
  });
}

function validateNamedRemoteComponents(args: {
  runtime: IAgentRuntime;
  modules: RemotePluginModuleManifest[];
  options: Pick<RemotePluginAdapterOptions, "reloadExisting">;
  kind:
    | "action"
    | "provider"
    | "evaluator"
    | "response-handler evaluator"
    | "response-handler field evaluator";
  existingNames: string[];
  existingRemoteOwners: Map<string, string>;
  namesForModule: (module: RemotePluginModuleManifest) => string[];
}): void {
  const seen = new Map<string, string>();
  for (const module of args.modules) {
    for (const name of args.namesForModule(module)) {
      const existingModuleId = seen.get(name);
      if (existingModuleId) {
        throw new CapabilityError({
          code: "CAPABILITY_DECODE_FAILED",
          message: `Remote ${args.kind} name collision for "${name}" between modules "${existingModuleId}" and "${module.id}".`,
          capability: "plugin",
          method: "plugin.modules.list",
        });
      }
      seen.set(name, module.id);
    }
  }

  if (args.options.reloadExisting) return;

  for (const module of args.modules) {
    for (const name of args.namesForModule(module)) {
      const existingRemoteModuleId = args.existingRemoteOwners.get(name);
      if (existingRemoteModuleId && existingRemoteModuleId !== module.id) {
        throw new CapabilityError({
          code: "CAPABILITY_DECODE_FAILED",
          message: `Remote ${args.kind} name collision for "${name}" between registered module "${existingRemoteModuleId}" and module "${module.id}".`,
          capability: "plugin",
          method: "plugin.modules.list",
        });
      }
      if (existingRemoteModuleId === module.id) continue;
      if (!args.existingNames.includes(name)) continue;
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote plugin "${module.id}" ${args.kind} "${name}" would collide with an existing runtime ${args.kind}.`,
        capability: "plugin",
        method: "plugin.modules.list",
      });
    }
  }
}

function validateRemotePluginServiceCollisions(
  runtime: IAgentRuntime,
  modules: RemotePluginModuleManifest[],
  options: Pick<RemotePluginAdapterOptions, "reloadExisting">,
): void {
  const seen = new Map<string, string>();
  for (const module of modules) {
    for (const service of module.services ?? []) {
      const existingModuleId = seen.get(service.serviceType);
      if (existingModuleId) {
        throw new CapabilityError({
          code: "CAPABILITY_DECODE_FAILED",
          message: `Remote service type collision for "${service.serviceType}" between modules "${existingModuleId}" and "${module.id}".`,
          capability: "plugin",
          method: "plugin.modules.list",
        });
      }
      seen.set(service.serviceType, module.id);
    }
  }

  if (options.reloadExisting) return;

  const registeredRemoteServiceTypes = new Set(
    getRegisteredRemoteCapabilityServiceTypes(runtime),
  );
  for (const module of modules) {
    for (const service of module.services ?? []) {
      if (!runtime.hasService?.(service.serviceType)) continue;
      if (registeredRemoteServiceTypes.has(service.serviceType)) continue;
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote plugin "${module.id}" service "${service.serviceType}" would collide with an existing runtime service.`,
        capability: "plugin",
        method: "plugin.modules.list",
      });
    }
  }
}

function validateRemotePluginModelCollisions(
  runtime: IAgentRuntime,
  modules: RemotePluginModuleManifest[],
  options: Pick<RemotePluginAdapterOptions, "reloadExisting">,
): void {
  const seen = new Map<string, string>();
  for (const module of modules) {
    for (const model of module.models ?? []) {
      const existingModuleId = seen.get(model.modelType);
      if (existingModuleId) {
        throw new CapabilityError({
          code: "CAPABILITY_DECODE_FAILED",
          message:
            existingModuleId === module.id
              ? `Remote plugin "${module.id}" declares model "${model.modelType}" more than once.`
              : `Remote model collision for "${model.modelType}" between modules "${existingModuleId}" and "${module.id}".`,
          capability: "plugin",
          method: "plugin.modules.list",
        });
      }
      seen.set(model.modelType, module.id);
    }
  }

  if (options.reloadExisting) return;

  const existingRemoteOwners =
    getRegisteredRemoteCapabilityModelOwners(runtime);
  const localModelTypes = getLocalRuntimeModelTypes(runtime);
  for (const module of modules) {
    for (const model of module.models ?? []) {
      const existingRemoteModuleId = existingRemoteOwners.get(model.modelType);
      if (existingRemoteModuleId && existingRemoteModuleId !== module.id) {
        throw new CapabilityError({
          code: "CAPABILITY_DECODE_FAILED",
          message: `Remote model collision for "${model.modelType}" between registered module "${existingRemoteModuleId}" and module "${module.id}".`,
          capability: "plugin",
          method: "plugin.modules.list",
        });
      }
      if (existingRemoteModuleId === module.id) continue;
      if (!localModelTypes.has(model.modelType)) continue;
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote plugin "${module.id}" model "${model.modelType}" would collide with an existing runtime model.`,
        capability: "plugin",
        method: "plugin.modules.list",
      });
    }
  }
}

function validateRemotePluginRouteDeclarations(
  modules: RemotePluginModuleManifest[],
): void {
  for (const module of modules) {
    for (const route of module.routes ?? []) {
      if (route.method !== "STATIC") continue;
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote plugin "${module.id}" route "${route.path}" uses STATIC, which is not supported by the remote plugin adapter. Use plugin assets or a dynamic HTTP route instead.`,
        capability: "plugin",
        method: "plugin.modules.list",
      });
    }
  }
}

function validateRemotePluginRouteCollisions(
  runtime: IAgentRuntime,
  modules: RemotePluginModuleManifest[],
  options: Pick<RemotePluginAdapterOptions, "reloadExisting">,
): void {
  const seen = new Map<string, string>();
  for (const module of modules) {
    for (const route of module.routes ?? []) {
      const key = routeCollisionKey(route.method, route.path);
      const existingModuleId = seen.get(key);
      if (existingModuleId) {
        throw new CapabilityError({
          code: "CAPABILITY_DECODE_FAILED",
          message: `Remote route collision for "${key}" between modules "${existingModuleId}" and "${module.id}".`,
          capability: "plugin",
          method: "plugin.modules.list",
        });
      }
      seen.set(key, module.id);
    }
  }

  if (options.reloadExisting) return;

  const registeredRemoteRouteKeys = new Set(
    getRegisteredRemoteCapabilityRoutes(runtime).map((route) =>
      routeCollisionKey(route.type, route.path),
    ),
  );
  for (const module of modules) {
    for (const route of module.routes ?? []) {
      const key = routeCollisionKey(route.method, route.path);
      const existing = runtime.routes?.find(
        (runtimeRoute) =>
          routeCollisionKey(runtimeRoute.type, runtimeRoute.path) === key,
      );
      if (!existing) continue;
      if (registeredRemoteRouteKeys.has(key)) continue;
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote plugin "${module.id}" route "${key}" would collide with an existing runtime route.`,
        capability: "plugin",
        method: "plugin.modules.list",
      });
    }
  }
}

function validateRemotePluginViewCollisions(
  runtime: IAgentRuntime,
  modules: RemotePluginModuleManifest[],
  options: Pick<RemotePluginAdapterOptions, "reloadExisting">,
): void {
  const seen = new Map<string, string>();
  for (const module of modules) {
    for (const view of module.views ?? []) {
      const key = viewCollisionKey(view);
      const existingModuleId = seen.get(key);
      if (existingModuleId) {
        throw new CapabilityError({
          code: "CAPABILITY_DECODE_FAILED",
          message: `Remote view collision for "${key}" between modules "${existingModuleId}" and "${module.id}".`,
          capability: "plugin",
          method: "plugin.modules.list",
        });
      }
      seen.set(key, module.id);
    }
  }

  if (options.reloadExisting) return;

  const registeredRemoteViewKeys = new Set(
    getRegisteredRemoteCapabilityViews(runtime).map(viewCollisionKey),
  );
  for (const module of modules) {
    for (const view of module.views ?? []) {
      const key = viewCollisionKey(view);
      const existing = (runtime.plugins ?? [])
        .filter((plugin) => {
          const config = plugin.config as Record<string, unknown> | undefined;
          return typeof config?.remoteCapabilityModuleId !== "string";
        })
        .flatMap((plugin) => plugin.views ?? [])
        .find((runtimeView) => viewCollisionKey(runtimeView) === key);
      if (!existing) continue;
      if (registeredRemoteViewKeys.has(key)) continue;
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote plugin "${module.id}" view "${key}" would collide with an existing runtime view.`,
        capability: "plugin",
        method: "plugin.modules.list",
      });
    }
  }
}

function validateRemotePluginWidgetCollisions(
  runtime: IAgentRuntime,
  modules: RemotePluginModuleManifest[],
  options: Pick<RemotePluginAdapterOptions, "reloadExisting">,
): void {
  const seen = new Map<string, string>();
  for (const module of modules) {
    for (const widget of module.widgets ?? []) {
      const key = widgetCollisionKey(module, widget);
      const existingModuleId = seen.get(key);
      if (existingModuleId) {
        throw new CapabilityError({
          code: "CAPABILITY_DECODE_FAILED",
          message: `Remote widget collision for "${key}" between modules "${existingModuleId}" and "${module.id}".`,
          capability: "plugin",
          method: "plugin.modules.list",
        });
      }
      seen.set(key, module.id);
    }
  }

  if (options.reloadExisting) return;

  const registeredRemoteWidgetKeys = new Set(
    getRegisteredRemoteCapabilityWidgets(runtime).map(widgetDeclarationKey),
  );
  for (const module of modules) {
    for (const widget of module.widgets ?? []) {
      const key = widgetCollisionKey(module, widget);
      const existing = (runtime.plugins ?? [])
        .filter((plugin) => {
          const config = plugin.config as Record<string, unknown> | undefined;
          return typeof config?.remoteCapabilityModuleId !== "string";
        })
        .flatMap((plugin) => plugin.widgets ?? [])
        .find((runtimeWidget) => widgetDeclarationKey(runtimeWidget) === key);
      if (!existing) continue;
      if (registeredRemoteWidgetKeys.has(key)) continue;
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote plugin "${module.id}" widget "${key}" would collide with an existing runtime widget.`,
        capability: "plugin",
        method: "plugin.modules.list",
      });
    }
  }
}

function validateRemotePluginNavTabCollisions(
  runtime: IAgentRuntime,
  modules: RemotePluginModuleManifest[],
  options: Pick<RemotePluginAdapterOptions, "reloadExisting">,
): void {
  const seen = new Map<string, string>();
  for (const module of modules) {
    for (const navTab of module.app?.navTabs ?? []) {
      const key = navTab.id;
      const existingModuleId = seen.get(key);
      if (existingModuleId) {
        throw new CapabilityError({
          code: "CAPABILITY_DECODE_FAILED",
          message: `Remote app nav tab collision for "${key}" between modules "${existingModuleId}" and "${module.id}".`,
          capability: "plugin",
          method: "plugin.modules.list",
        });
      }
      seen.set(key, module.id);
    }
  }

  if (options.reloadExisting) return;

  const registeredRemoteNavTabKeys = new Set(
    getRegisteredRemoteCapabilityNavTabs(runtime).map((navTab) => navTab.id),
  );
  for (const module of modules) {
    for (const navTab of module.app?.navTabs ?? []) {
      const key = navTab.id;
      const existing = (runtime.plugins ?? [])
        .filter((plugin) => {
          const config = plugin.config as Record<string, unknown> | undefined;
          return typeof config?.remoteCapabilityModuleId !== "string";
        })
        .flatMap((plugin) => plugin.app?.navTabs ?? [])
        .find((runtimeNavTab) => runtimeNavTab.id === key);
      if (!existing) continue;
      if (registeredRemoteNavTabKeys.has(key)) continue;
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote plugin "${module.id}" app nav tab "${key}" would collide with an existing runtime app nav tab.`,
        capability: "plugin",
        method: "plugin.modules.list",
      });
    }
  }
}

function validateRemotePluginAppBridgeIdentifierCollisions(
  runtime: IAgentRuntime,
  modules: RemotePluginModuleManifest[],
  options: Pick<RemotePluginAdapterOptions, "reloadExisting">,
): void {
  const seen = new Map<string, { moduleId: string; identifier: string }>();
  for (const module of modules) {
    if (module.appBridge === undefined) continue;
    for (const identifier of remoteAppBridgeIdentifiers(module)) {
      const key = appBridgeIdentifierKey(identifier);
      const existing = seen.get(key);
      if (existing) {
        throw new CapabilityError({
          code: "CAPABILITY_DECODE_FAILED",
          message: `Remote app bridge identifier collision for "${key}" between modules "${existing.moduleId}" (${existing.identifier}) and "${module.id}" (${identifier}).`,
          capability: "plugin",
          method: "plugin.modules.list",
        });
      }
      seen.set(key, { moduleId: module.id, identifier });
    }
  }

  if (options.reloadExisting) return;

  const registeredRemoteBridgeKeys = new Set(
    getRegisteredRemoteCapabilityAppBridgeKeys(runtime),
  );
  for (const module of modules) {
    if (module.appBridge === undefined) continue;
    for (const identifier of remoteAppBridgeIdentifiers(module)) {
      const key = appBridgeIdentifierKey(identifier);
      if (!hasRuntimeAppRouteModule(identifier)) continue;
      if (registeredRemoteBridgeKeys.has(key)) continue;
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote plugin "${module.id}" app bridge route key "${key}" would collide with an existing runtime app route module.`,
        capability: "plugin",
        method: "plugin.modules.list",
      });
    }
  }
}

function routeCollisionKey(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${normalizeRoutePath(routePath)}`;
}

function normalizeRoutePath(routePath: string): string {
  return routePath.startsWith("/") ? routePath : `/${routePath}`;
}

function viewCollisionKey(
  view: Pick<ViewDeclaration, "id" | "viewType">,
): string {
  return `${view.viewType === "tui" ? "tui" : "gui"}:${view.id}`;
}

function widgetCollisionKey(
  module: RemotePluginModuleManifest,
  widget: NonNullable<RemotePluginModuleManifest["widgets"]>[number],
): string {
  return `${widget.pluginId ?? module.name}/${widget.id}`;
}

function widgetDeclarationKey(widget: PluginWidgetDeclaration): string {
  return `${widget.pluginId}/${widget.id}`;
}

function appBridgeIdentifierKey(identifier: string): string {
  return packageNameToAppRouteSlug(identifier) ?? identifier;
}

async function ensureConfiguredCapabilityRouter(
  runtime: IAgentRuntime,
  options: Pick<RemotePluginBootstrapOptions, "registerRouterService">,
): Promise<ElizaCapabilityRouter | null> {
  const existing = getCapabilityRouter(runtime);
  if (existing) return existing;

  const config = resolveRemoteCapabilityRouterConfig(runtime);
  if (!config.enabled || (!config.baseUrl && !config.endpoints?.length)) {
    return null;
  }

  if (options.registerRouterService !== false) {
    if (!runtime.hasService(CAPABILITY_ROUTER_SERVICE_TYPE)) {
      await runtime.registerService(RemoteCapabilityRouterService);
    }
    const service = await runtime.getServiceLoadPromise(
      CAPABILITY_ROUTER_SERVICE_TYPE,
    );
    const router = getCapabilityRouter({
      getService: () => service,
    });
    if (router) return router;
  }

  return requireCapabilityRouter(runtime);
}

function getRegisteredRemoteCapabilityRoutes(runtime: IAgentRuntime): Route[] {
  return (runtime.getAllPluginOwnership?.() ?? [])
    .filter((item) => {
      const config = item.plugin.config as Record<string, unknown> | undefined;
      return typeof config?.remoteCapabilityModuleId === "string";
    })
    .flatMap((item) => item.routes);
}

function getRegisteredRemoteCapabilityViews(
  runtime: IAgentRuntime,
): NonNullable<Plugin["views"]> {
  const views: NonNullable<Plugin["views"]> = [];
  for (const item of runtime.getAllPluginOwnership?.() ?? []) {
    const config = item.plugin.config as Record<string, unknown> | undefined;
    if (typeof config?.remoteCapabilityModuleId === "string") {
      views.push(...(item.plugin.views ?? []));
    }
  }
  for (const plugin of runtime.plugins ?? []) {
    const config = plugin.config as Record<string, unknown> | undefined;
    if (typeof config?.remoteCapabilityModuleId === "string") {
      views.push(...(plugin.views ?? []));
    }
  }
  return views;
}

function getRegisteredRemoteCapabilityWidgets(
  runtime: IAgentRuntime,
): NonNullable<Plugin["widgets"]> {
  const widgets: NonNullable<Plugin["widgets"]> = [];
  for (const item of runtime.getAllPluginOwnership?.() ?? []) {
    const config = item.plugin.config as Record<string, unknown> | undefined;
    if (typeof config?.remoteCapabilityModuleId === "string") {
      widgets.push(...(item.plugin.widgets ?? []));
    }
  }
  for (const plugin of runtime.plugins ?? []) {
    const config = plugin.config as Record<string, unknown> | undefined;
    if (typeof config?.remoteCapabilityModuleId === "string") {
      widgets.push(...(plugin.widgets ?? []));
    }
  }
  return widgets;
}

function getRegisteredRemoteCapabilityNavTabs(
  runtime: IAgentRuntime,
): NonNullable<NonNullable<Plugin["app"]>["navTabs"]> {
  const navTabs: NonNullable<NonNullable<Plugin["app"]>["navTabs"]> = [];
  for (const item of runtime.getAllPluginOwnership?.() ?? []) {
    const config = item.plugin.config as Record<string, unknown> | undefined;
    if (typeof config?.remoteCapabilityModuleId === "string") {
      navTabs.push(...(item.plugin.app?.navTabs ?? []));
    }
  }
  for (const plugin of runtime.plugins ?? []) {
    const config = plugin.config as Record<string, unknown> | undefined;
    if (typeof config?.remoteCapabilityModuleId === "string") {
      navTabs.push(...(plugin.app?.navTabs ?? []));
    }
  }
  return navTabs;
}

function getRegisteredRemoteCapabilityAppBridgeKeys(
  runtime: IAgentRuntime,
): string[] {
  const keys = new Set<string>();
  for (const item of runtime.getAllPluginOwnership?.() ?? []) {
    const moduleId = remotePluginModuleId(item.plugin);
    if (!moduleId || item.plugin.appBridge === undefined) continue;
    for (const identifier of remoteAppBridgeIdentifiersForPlugin(item.plugin)) {
      keys.add(appBridgeIdentifierKey(identifier));
    }
  }
  for (const plugin of runtime.plugins ?? []) {
    const moduleId = remotePluginModuleId(plugin);
    if (!moduleId || plugin.appBridge === undefined) continue;
    for (const identifier of remoteAppBridgeIdentifiersForPlugin(plugin)) {
      keys.add(appBridgeIdentifierKey(identifier));
    }
  }
  return [...keys];
}

function getRegisteredRemoteCapabilityComponentOwners<
  K extends
    | "actions"
    | "providers"
    | "evaluators"
    | "responseHandlerEvaluators"
    | "responseHandlerFieldEvaluators",
>(
  runtime: IAgentRuntime,
  field: K,
  nameForComponent: (component: NonNullable<Plugin[K]>[number]) => string,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const item of runtime.getAllPluginOwnership?.() ?? []) {
    const moduleId = remotePluginModuleId(item.plugin);
    if (!moduleId) continue;
    for (const component of item.plugin[field] ?? []) {
      owners.set(nameForComponent(component), moduleId);
    }
  }
  for (const plugin of runtime.plugins ?? []) {
    const moduleId = remotePluginModuleId(plugin);
    if (!moduleId) continue;
    for (const component of plugin[field] ?? []) {
      owners.set(nameForComponent(component), moduleId);
    }
  }
  return owners;
}

function getRegisteredRemoteCapabilityModelOwners(
  runtime: IAgentRuntime,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const item of runtime.getAllPluginOwnership?.() ?? []) {
    const moduleId = remotePluginModuleId(item.plugin);
    if (!moduleId) continue;
    for (const model of item.models ?? []) {
      owners.set(model.modelType, moduleId);
    }
    for (const modelType of Object.keys(item.plugin.models ?? {})) {
      owners.set(modelType, moduleId);
    }
  }
  for (const plugin of runtime.plugins ?? []) {
    const moduleId = remotePluginModuleId(plugin);
    if (!moduleId) continue;
    for (const modelType of Object.keys(plugin.models ?? {})) {
      owners.set(modelType, moduleId);
    }
  }
  return owners;
}

function getLocalRuntimeModelTypes(runtime: IAgentRuntime): Set<string> {
  const modelTypes = new Set<string>();
  for (const item of runtime.getAllPluginOwnership?.() ?? []) {
    if (remotePluginModuleId(item.plugin)) continue;
    for (const model of item.models ?? []) {
      modelTypes.add(model.modelType);
    }
    for (const modelType of Object.keys(item.plugin.models ?? {})) {
      modelTypes.add(modelType);
    }
  }
  for (const plugin of runtime.plugins ?? []) {
    if (remotePluginModuleId(plugin)) continue;
    for (const modelType of Object.keys(plugin.models ?? {})) {
      modelTypes.add(modelType);
    }
  }
  return modelTypes;
}

function remotePluginModuleId(plugin: Plugin): string | null {
  const config = plugin.config as Record<string, unknown> | undefined;
  return typeof config?.remoteCapabilityModuleId === "string"
    ? config.remoteCapabilityModuleId
    : null;
}

function remoteAppBridgeIdentifiersForPlugin(plugin: Plugin): string[] {
  return [plugin.name, packageNameToAppRouteSlug(plugin.name)].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function getRegisteredRemoteCapabilityServiceTypes(
  runtime: IAgentRuntime,
): string[] {
  return (runtime.getAllPluginOwnership?.() ?? [])
    .filter((item) => {
      const config = item.plugin.config as Record<string, unknown> | undefined;
      return typeof config?.remoteCapabilityModuleId === "string";
    })
    .flatMap((item) => item.services.map((service) => service.serviceType));
}

function getRegisteredRemoteCapabilityPluginNames(
  runtime: IAgentRuntime,
  endpointIds?: Set<string>,
): string[] {
  const ownership = runtime.getAllPluginOwnership?.() ?? [];
  const names = new Set<string>();
  for (const item of ownership) {
    const config = item.plugin.config as Record<string, unknown> | undefined;
    if (
      typeof config?.remoteCapabilityModuleId === "string" &&
      remotePluginEndpointMatches(config, endpointIds)
    ) {
      names.add(item.pluginName);
    }
  }
  for (const plugin of runtime.plugins ?? []) {
    const config = plugin.config as Record<string, unknown> | undefined;
    if (
      typeof config?.remoteCapabilityModuleId === "string" &&
      remotePluginEndpointMatches(config, endpointIds)
    ) {
      names.add(plugin.name);
    }
  }
  return [...names];
}

function remotePluginEndpointMatches(
  config: Record<string, unknown>,
  endpointIds: Set<string> | undefined,
): boolean {
  if (endpointIds === undefined) return true;
  return (
    typeof config.remoteCapabilityEndpointId === "string" &&
    endpointIds.has(config.remoteCapabilityEndpointId)
  );
}

function requireCapabilityRouter(
  runtime: IAgentRuntime,
): ElizaCapabilityRouter {
  const router = getCapabilityRouter(runtime);
  if (!router) {
    throw new CapabilityError({
      code: "CAPABILITY_UNAVAILABLE",
      message: `Runtime does not have ${CAPABILITY_ROUTER_SERVICE_TYPE} service.`,
      capability: "plugin",
    });
  }
  return router;
}

function requireCapabilityRouterFromNullable(
  runtime: IAgentRuntime | null | undefined,
): ElizaCapabilityRouter {
  if (!runtime) {
    throw new CapabilityError({
      code: "CAPABILITY_UNAVAILABLE",
      message: `Runtime does not have ${CAPABILITY_ROUTER_SERVICE_TYPE} service.`,
      capability: "plugin",
    });
  }
  return requireCapabilityRouter(runtime);
}

function toJsonObject(value: unknown): JsonObject | undefined {
  const json = toJsonValue(value);
  if (json && typeof json === "object" && !Array.isArray(json)) {
    return json;
  }
  return undefined;
}

function eventPayloadToJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const { runtime: _runtime, ...serializable } = value as Record<
    string,
    unknown
  >;
  return toJsonObject(serializable);
}

function appBridgeContextToJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const { runtime: _runtime, ...serializable } = value as Record<
    string,
    unknown
  >;
  return toJsonObject(serializable);
}

function responseHandlerContextToJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const context = value as Record<string, unknown>;
  return (
    toJsonObject({
      message: context.message,
      state: context.state,
      messageHandler: context.messageHandler,
      availableContexts: context.availableContexts,
    }) ?? {}
  );
}

function responseHandlerFieldContextToJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const context = value as Record<string, unknown>;
  return (
    toJsonObject({
      message: context.message,
      state: context.state,
      senderRole: context.senderRole,
    }) ?? {}
  );
}

function responseHandlerFieldEffectFromJson(
  effect:
    | {
        patch?: JsonObject;
        preempt?: {
          mode: "ack-and-stop" | "ignore" | "direct-reply";
          reason: string;
        };
        debug?: string[];
      }
    | undefined,
): ResponseHandlerFieldEffect | undefined {
  if (!effect) return undefined;
  return {
    ...(effect.patch === undefined
      ? {}
      : {
          mutateResult: (result) => {
            Object.assign(result, effect.patch);
          },
        }),
    ...(effect.preempt === undefined ? {} : { preempt: effect.preempt }),
    ...(effect.debug === undefined ? {} : { debug: effect.debug }),
  };
}

function shouldReadRouteBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

function routeQueryToJsonObject(url: URL): JsonObject {
  const query: JsonObject = {};
  for (const [key, value] of url.searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }
  return query;
}

function routeHeadersToJsonObject(
  headers: AppPackageRouteContext["req"]["headers"],
): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value;
    }
  }
  return result;
}

const SENSITIVE_FORWARDED_ROUTE_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-eliza-agent-token",
]);

function sanitizeForwardedRouteHeaders<
  T extends Record<string, string | string[] | undefined>,
>(headers: T | undefined): T {
  const result: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (SENSITIVE_FORWARDED_ROUTE_HEADERS.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result as T;
}

function sanitizeRemoteRouteResponseHeaders<
  T extends Record<string, string | undefined>,
>(headers: T): T {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_FORWARDED_ROUTE_HEADERS.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result as T;
}

function toStringRecord(value: JsonValue | undefined): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      result[key] = String(entry);
    }
  }
  return result;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
}
