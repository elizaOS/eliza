import { createHash } from "node:crypto";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type CapabilityAvailability,
  type IAgentRuntime,
  type JsonValue,
  type PluginCallAppBridgeResult,
  type PluginCallRouteResult,
  type PluginCallServiceResult,
  type PluginEvaluatorPrepareResult,
  type PluginEvaluatorProcessResult,
  type PluginEvaluatorPromptResult,
  type PluginEvaluatorShouldRunResult,
  type PluginGetAssetResult,
  type PluginGetProviderResult,
  type PluginHandleEventResult,
  type PluginInvokeActionResult,
  type PluginInvokeModelResult,
  type PluginLifecycleCallResult,
  type PluginListModulesResult,
  type PluginResponseHandlerEvaluatorEvaluateResult,
  type PluginResponseHandlerEvaluatorShouldRunResult,
  type PluginResponseHandlerFieldEvaluatorHandleResult,
  type PluginResponseHandlerFieldEvaluatorParseResult,
  type PluginResponseHandlerFieldEvaluatorShouldRunResult,
  type RemotePluginModuleManifest,
  type UUID,
} from "@elizaos/core";
import {
  type RemoteCapabilityEndpointConfig,
  RemoteCapabilityRouterService,
} from "./remote-capability-router.ts";

export type RemoteCapabilityEndpointConformanceSurface =
  | "action"
  | "provider"
  | "route"
  | "viewAsset"
  | "model"
  | "lifecycle"
  | "event"
  | "service"
  | "appBridge"
  | "evaluator"
  | "responseHandlerEvaluator"
  | "responseHandlerFieldEvaluator";

export type RemoteCapabilityEndpointConformanceOptions = {
  endpoint: RemoteCapabilityEndpointConfig;
  requestTimeoutMs?: number;
  requiredSurfaces?: readonly RemoteCapabilityEndpointConformanceSurface[];
  actionContent?: Record<string, JsonValue>;
  routeBody?: JsonValue;
};

export type RemoteCapabilityEndpointConformanceReport = {
  endpointId: string;
  availability: CapabilityAvailability;
  moduleCount: number;
  moduleIds: string[];
  exercised: Partial<
    Record<RemoteCapabilityEndpointConformanceSurface, string>
  >;
  actionResult?: PluginInvokeActionResult;
  providerResult?: PluginGetProviderResult;
  routeResult?: PluginCallRouteResult;
  assetResult?: Pick<
    PluginGetAssetResult,
    "path" | "contentType" | "integrity"
  > & {
    byteLength: number;
    sha256: string;
  };
  modelResult?: PluginInvokeModelResult;
  lifecycleResult?: PluginLifecycleCallResult;
  eventResult?: PluginHandleEventResult;
  serviceResult?: PluginCallServiceResult;
  appBridgeResult?: PluginCallAppBridgeResult;
  evaluatorResult?: {
    shouldRun: PluginEvaluatorShouldRunResult;
    prepare: PluginEvaluatorPrepareResult;
    prompt: PluginEvaluatorPromptResult;
    process: PluginEvaluatorProcessResult;
  };
  responseHandlerEvaluatorResult?: {
    shouldRun: PluginResponseHandlerEvaluatorShouldRunResult;
    evaluate: PluginResponseHandlerEvaluatorEvaluateResult;
  };
  responseHandlerFieldEvaluatorResult?: {
    shouldRun: PluginResponseHandlerFieldEvaluatorShouldRunResult;
    parse: PluginResponseHandlerFieldEvaluatorParseResult;
    handle: PluginResponseHandlerFieldEvaluatorHandleResult;
  };
};

const DEFAULT_REQUIRED_SURFACES: readonly RemoteCapabilityEndpointConformanceSurface[] =
  [
    "action",
    "provider",
    "route",
    "viewAsset",
    "model",
    "lifecycle",
    "event",
    "service",
    "appBridge",
    "evaluator",
    "responseHandlerEvaluator",
    "responseHandlerFieldEvaluator",
  ];

export async function assertRemoteCapabilityEndpointConformance(
  options: RemoteCapabilityEndpointConformanceOptions,
): Promise<RemoteCapabilityEndpointConformanceReport> {
  const router = new RemoteCapabilityRouterService(makeConformanceRuntime(), {
    enabled: true,
    environment: "server",
    requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
    endpoints: [options.endpoint],
  });
  const availability = await router.availability();
  if (!availability.available || !availability.capabilities.plugin) {
    throw new Error(
      `Capability endpoint "${options.endpoint.id}" must report available plugin capability.`,
    );
  }

  const moduleResult = await router.plugin.listModules({
    endpointId: options.endpoint.id,
  });
  assertModuleList(options.endpoint.id, moduleResult);
  const modules = moduleResult.modules;
  const exercised: RemoteCapabilityEndpointConformanceReport["exercised"] = {};
  const report: RemoteCapabilityEndpointConformanceReport = {
    endpointId: options.endpoint.id,
    availability,
    moduleCount: modules.length,
    moduleIds: modules.map((module) => module.id),
    exercised,
  };

  const required = options.requiredSurfaces ?? DEFAULT_REQUIRED_SURFACES;
  if (required.includes("action")) {
    const target = findActionTarget(modules);
    if (!target) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" did not expose a remote action.`,
      );
    }
    report.actionResult = await router.plugin.invokeAction({
      endpointId: options.endpoint.id,
      moduleId: target.module.id,
      action: target.action.name,
      content: options.actionContent ?? {
        text: "capability-router conformance action",
      },
    });
    exercised.action = `${target.module.id}:${target.action.name}`;
  }

  if (required.includes("provider")) {
    const target = findProviderTarget(modules);
    if (!target) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" did not expose a remote provider.`,
      );
    }
    report.providerResult = await router.plugin.getProvider({
      endpointId: options.endpoint.id,
      moduleId: target.module.id,
      provider: target.provider.name,
      state: {},
    });
    exercised.provider = `${target.module.id}:${target.provider.name}`;
  }

  if (required.includes("route")) {
    const target = findRouteTarget(modules);
    if (!target) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" did not expose a remote route.`,
      );
    }
    report.routeResult = await router.plugin.callRoute({
      endpointId: options.endpoint.id,
      moduleId: target.module.id,
      method: target.route.method,
      path: target.route.path,
      headers: {},
      body: options.routeBody ?? { conformance: true },
    });
    if (
      typeof report.routeResult.status !== "number" ||
      report.routeResult.status < 200 ||
      report.routeResult.status > 299
    ) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" returned a non-2xx route status.`,
      );
    }
    exercised.route = `${target.module.id}:${target.route.method} ${target.route.path}`;
  }

  if (required.includes("viewAsset")) {
    const target = findViewAssetTarget(modules);
    if (!target) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" did not expose a remote view bundle asset.`,
      );
    }
    const assetResult = await router.plugin.getAsset({
      endpointId: options.endpoint.id,
      moduleId: target.module.id,
      path: target.bundlePath,
    });
    const assetBytes = Buffer.from(assetResult.bodyBase64, "base64");
    const byteLength = assetBytes.byteLength;
    if (byteLength === 0) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" returned an empty view asset.`,
      );
    }
    if (!/\.(?:js|mjs)$/i.test(assetResult.path)) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" returned a non-JavaScript view asset path.`,
      );
    }
    if (!/(?:java|ecma)script/i.test(assetResult.contentType)) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" returned a non-JavaScript view asset content type.`,
      );
    }
    report.assetResult = {
      path: assetResult.path,
      contentType: assetResult.contentType,
      ...(assetResult.integrity ? { integrity: assetResult.integrity } : {}),
      byteLength,
      sha256: createHash("sha256").update(assetBytes).digest("hex"),
    };
    exercised.viewAsset = `${target.module.id}:${target.bundlePath}`;
  }

  if (required.includes("model")) {
    const target = findModelTarget(modules);
    if (!target) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" did not expose a remote model.`,
      );
    }
    report.modelResult = await router.plugin.invokeModel({
      endpointId: options.endpoint.id,
      moduleId: target.module.id,
      modelType: target.model.modelType,
      params: { prompt: "capability-router conformance model" },
    });
    exercised.model = `${target.module.id}:${target.model.modelType}`;
  }

  if (required.includes("lifecycle")) {
    const target = findLifecycleTarget(modules);
    if (!target) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" did not expose a remote lifecycle hook.`,
      );
    }
    report.lifecycleResult = await router.plugin.callLifecycle({
      endpointId: options.endpoint.id,
      moduleId: target.module.id,
      hook: target.hook,
      context: { conformance: true },
    });
    exercised.lifecycle = `${target.module.id}:${target.hook}`;
  }

  if (required.includes("event")) {
    const target = findEventTarget(modules);
    if (!target) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" did not expose a remote event handler.`,
      );
    }
    report.eventResult = await router.plugin.handleEvent({
      endpointId: options.endpoint.id,
      moduleId: target.module.id,
      eventName: target.event.eventName,
      payload: { conformance: true },
    });
    exercised.event = `${target.module.id}:${target.event.eventName}`;
  }

  if (required.includes("service")) {
    const target = findServiceTarget(modules);
    if (!target) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" did not expose a remote service method.`,
      );
    }
    report.serviceResult = await router.plugin.callService({
      endpointId: options.endpoint.id,
      moduleId: target.module.id,
      serviceType: target.service.serviceType,
      method: target.method,
      args: [{ conformance: true }],
    });
    exercised.service = `${target.module.id}:${target.service.serviceType}.${target.method}`;
  }

  if (required.includes("appBridge")) {
    const target = findAppBridgeTarget(modules);
    if (!target) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" did not expose a remote app bridge hook.`,
      );
    }
    report.appBridgeResult = await router.plugin.callAppBridge({
      endpointId: options.endpoint.id,
      moduleId: target.module.id,
      hook: target.hook,
      context: {
        method: "GET",
        pathname: "/capability-router-conformance",
        path: "/capability-router-conformance",
        query: {},
        headers: {},
      },
    });
    exercised.appBridge = `${target.module.id}:${target.hook}`;
  }

  if (required.includes("evaluator")) {
    const target = findEvaluatorTarget(modules);
    if (!target) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" did not expose a remote evaluator.`,
      );
    }
    const common = {
      endpointId: options.endpoint.id,
      moduleId: target.module.id,
      evaluator: target.evaluator.name,
      message: { text: "capability-router conformance evaluator" },
      state: {},
      options: {},
    };
    const shouldRun = await router.plugin.shouldRunEvaluator(common);
    const prepare = await router.plugin.prepareEvaluator(common);
    const prompt = await router.plugin.promptEvaluator({
      ...common,
      ...(prepare.prepared === undefined ? {} : { prepared: prepare.prepared }),
    });
    const process = await router.plugin.processEvaluator({
      ...common,
      ...(prepare.prepared === undefined ? {} : { prepared: prepare.prepared }),
      output: { prompt: prompt.prompt },
    });
    report.evaluatorResult = { shouldRun, prepare, prompt, process };
    exercised.evaluator = `${target.module.id}:${target.evaluator.name}`;
  }

  if (required.includes("responseHandlerEvaluator")) {
    const target = findResponseHandlerEvaluatorTarget(modules);
    if (!target) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" did not expose a remote response-handler evaluator.`,
      );
    }
    const common = {
      endpointId: options.endpoint.id,
      moduleId: target.module.id,
      evaluator: target.evaluator.name,
      context: { conformance: true },
    };
    const shouldRun =
      await router.plugin.shouldRunResponseHandlerEvaluator(common);
    const evaluate =
      await router.plugin.evaluateResponseHandlerEvaluator(common);
    report.responseHandlerEvaluatorResult = { shouldRun, evaluate };
    exercised.responseHandlerEvaluator = `${target.module.id}:${target.evaluator.name}`;
  }

  if (required.includes("responseHandlerFieldEvaluator")) {
    const target = findResponseHandlerFieldEvaluatorTarget(modules);
    if (!target) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" did not expose a remote response-handler field evaluator.`,
      );
    }
    const common = {
      endpointId: options.endpoint.id,
      moduleId: target.module.id,
      field: target.field.name,
      context: { conformance: true },
    };
    const shouldRun =
      await router.plugin.shouldRunResponseHandlerFieldEvaluator(common);
    const parse = await router.plugin.parseResponseHandlerFieldEvaluator({
      ...common,
      value: { raw: true },
    });
    const handle = await router.plugin.handleResponseHandlerFieldEvaluator({
      ...common,
      value: { raw: true },
      ...(parse.value === undefined ||
      typeof parse.value !== "object" ||
      parse.value === null ||
      Array.isArray(parse.value)
        ? {}
        : { parsed: parse.value }),
    });
    report.responseHandlerFieldEvaluatorResult = { shouldRun, parse, handle };
    exercised.responseHandlerFieldEvaluator = `${target.module.id}:${target.field.name}`;
  }

  return report;
}

function assertModuleList(
  endpointId: string,
  result: PluginListModulesResult,
): asserts result is { modules: RemotePluginModuleManifest[] } {
  if (!Array.isArray(result.modules) || result.modules.length === 0) {
    throw new Error(
      `Capability endpoint "${endpointId}" must expose at least one plugin module.`,
    );
  }
  const seen = new Set<string>();
  for (const module of result.modules) {
    if (!module.id || !module.name) {
      throw new Error(
        `Capability endpoint "${endpointId}" returned a module without id or name.`,
      );
    }
    if (seen.has(module.id)) {
      throw new Error(
        `Capability endpoint "${endpointId}" returned duplicate module id "${module.id}".`,
      );
    }
    seen.add(module.id);
  }
}

function findActionTarget(modules: RemotePluginModuleManifest[]) {
  for (const module of modules) {
    const action = module.actions?.[0];
    if (action) return { module, action };
  }
  return null;
}

function findProviderTarget(modules: RemotePluginModuleManifest[]) {
  for (const module of modules) {
    const provider = module.providers?.[0];
    if (provider) return { module, provider };
  }
  return null;
}

function findRouteTarget(modules: RemotePluginModuleManifest[]) {
  for (const module of modules) {
    const route = module.routes?.[0];
    if (route) return { module, route };
  }
  return null;
}

function findViewAssetTarget(modules: RemotePluginModuleManifest[]) {
  for (const module of modules) {
    const view = module.views?.find((candidate) => candidate.bundlePath);
    if (view?.bundlePath) return { module, view, bundlePath: view.bundlePath };
  }
  return null;
}

function findModelTarget(modules: RemotePluginModuleManifest[]) {
  for (const module of modules) {
    const model = module.models?.[0];
    if (model) return { module, model };
  }
  return null;
}

function findLifecycleTarget(modules: RemotePluginModuleManifest[]) {
  for (const module of modules) {
    const hook = module.lifecycle?.hooks?.[0];
    if (hook) return { module, hook };
  }
  return null;
}

function findEventTarget(modules: RemotePluginModuleManifest[]) {
  for (const module of modules) {
    const event = module.events?.[0];
    if (event) return { module, event };
  }
  return null;
}

function findServiceTarget(modules: RemotePluginModuleManifest[]) {
  for (const module of modules) {
    const service = module.services?.find(
      (candidate) => candidate.methods?.[0],
    );
    const method = service?.methods?.[0];
    if (service && method) return { module, service, method };
  }
  return null;
}

function findAppBridgeTarget(modules: RemotePluginModuleManifest[]) {
  for (const module of modules) {
    const hook = module.appBridge?.hooks?.[0];
    if (hook) return { module, hook };
  }
  return null;
}

function findEvaluatorTarget(modules: RemotePluginModuleManifest[]) {
  for (const module of modules) {
    const evaluator = module.evaluators?.[0];
    if (evaluator) return { module, evaluator };
  }
  return null;
}

function findResponseHandlerEvaluatorTarget(
  modules: RemotePluginModuleManifest[],
) {
  for (const module of modules) {
    const evaluator = module.responseHandlerEvaluators?.[0];
    if (evaluator) return { module, evaluator };
  }
  return null;
}

function findResponseHandlerFieldEvaluatorTarget(
  modules: RemotePluginModuleManifest[],
) {
  for (const module of modules) {
    const field = module.responseHandlerFieldEvaluators?.[0];
    if (field) return { module, field };
  }
  return null;
}

function makeConformanceRuntime(): IAgentRuntime {
  return {
    agentId: "66666666-6666-6666-6666-666666666666" as UUID,
    character: { name: "Remote Capability Conformance" },
    services: new Map(),
    getService: () => null,
    getServicesByType: () => [],
    hasService: (serviceType: string) =>
      serviceType === CAPABILITY_ROUTER_SERVICE_TYPE,
  } as Partial<IAgentRuntime> as IAgentRuntime;
}
