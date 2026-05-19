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
  type RuntimeBrokerCapabilityMethod,
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

export type RemoteCapabilityEndpointConformanceRpcMethod = Exclude<
  Extract<RuntimeBrokerCapabilityMethod, `plugin.${string}`>,
  "plugin.modules.list"
>;

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
  moduleExercises: Array<{
    surface: RemoteCapabilityEndpointConformanceSurface;
    moduleId: string;
    target: string;
  }>;
  rpcCalls: Array<{
    method: RemoteCapabilityEndpointConformanceRpcMethod;
    surface: RemoteCapabilityEndpointConformanceSurface;
    moduleId: string;
    target: string;
  }>;
  actionResult?: PluginInvokeActionResult;
  providerResult?: PluginGetProviderResult;
  routeResult?: PluginCallRouteResult;
  assetResult?: Pick<
    PluginGetAssetResult,
    "path" | "contentType" | "integrity"
  > & {
    byteLength: number;
    manifestContentType?: string;
    manifestIntegrity?: string;
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
  const moduleExercises: RemoteCapabilityEndpointConformanceReport["moduleExercises"] =
    [];
  const report: RemoteCapabilityEndpointConformanceReport = {
    endpointId: options.endpoint.id,
    availability,
    moduleCount: modules.length,
    moduleIds: modules.map((module) => module.id),
    exercised,
    moduleExercises,
    rpcCalls: [],
  };

  const required = options.requiredSurfaces ?? DEFAULT_REQUIRED_SURFACES;
  const exerciseCounts = new Map(modules.map((module) => [module.id, 0]));
  if (required.includes("action")) {
    const target = findActionTarget(
      orderModulesByExercise(modules, exerciseCounts),
    );
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
    recordExercise(
      report,
      exerciseCounts,
      "action",
      "plugin.action.invoke",
      target.module.id,
      target.action.name,
    );
  }

  if (required.includes("provider")) {
    const target = findProviderTarget(
      orderModulesByExercise(modules, exerciseCounts),
    );
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
    recordExercise(
      report,
      exerciseCounts,
      "provider",
      "plugin.provider.get",
      target.module.id,
      target.provider.name,
    );
  }

  if (required.includes("route")) {
    const target = findRouteTarget(
      orderModulesByExercise(modules, exerciseCounts),
    );
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
    recordExercise(
      report,
      exerciseCounts,
      "route",
      "plugin.route.call",
      target.module.id,
      `${target.route.method} ${target.route.path}`,
    );
  }

  if (required.includes("viewAsset")) {
    const target = findViewAssetTarget(
      orderModulesByExercise(modules, exerciseCounts),
    );
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
    if (
      target.view.contentType !== undefined &&
      assetResult.contentType !== target.view.contentType
    ) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" returned a view asset content type that does not match its manifest.`,
      );
    }
    if (
      target.view.integrity !== undefined &&
      assetResult.integrity !== target.view.integrity
    ) {
      throw new Error(
        `Capability endpoint "${options.endpoint.id}" returned a view asset integrity value that does not match its manifest.`,
      );
    }
    report.assetResult = {
      path: assetResult.path,
      contentType: assetResult.contentType,
      ...(target.view.contentType
        ? { manifestContentType: target.view.contentType }
        : {}),
      ...(target.view.integrity
        ? { manifestIntegrity: target.view.integrity }
        : {}),
      ...(assetResult.integrity ? { integrity: assetResult.integrity } : {}),
      byteLength,
      sha256: createHash("sha256").update(assetBytes).digest("hex"),
    };
    recordExercise(
      report,
      exerciseCounts,
      "viewAsset",
      "plugin.asset.get",
      target.module.id,
      target.bundlePath,
    );
  }

  if (required.includes("model")) {
    const target = findModelTarget(
      orderModulesByExercise(modules, exerciseCounts),
    );
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
    recordExercise(
      report,
      exerciseCounts,
      "model",
      "plugin.model.invoke",
      target.module.id,
      target.model.modelType,
    );
  }

  if (required.includes("lifecycle")) {
    const target = findLifecycleTarget(
      orderModulesByExercise(modules, exerciseCounts),
    );
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
    recordExercise(
      report,
      exerciseCounts,
      "lifecycle",
      "plugin.lifecycle.call",
      target.module.id,
      target.hook,
    );
  }

  if (required.includes("event")) {
    const target = findEventTarget(
      orderModulesByExercise(modules, exerciseCounts),
    );
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
    recordExercise(
      report,
      exerciseCounts,
      "event",
      "plugin.event.handle",
      target.module.id,
      target.event.eventName,
    );
  }

  if (required.includes("service")) {
    const target = findServiceTarget(
      orderModulesByExercise(modules, exerciseCounts),
    );
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
    recordExercise(
      report,
      exerciseCounts,
      "service",
      "plugin.service.call",
      target.module.id,
      `${target.service.serviceType}.${target.method}`,
    );
  }

  if (required.includes("appBridge")) {
    const target = findAppBridgeTarget(
      orderModulesByExercise(modules, exerciseCounts),
    );
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
    recordExercise(
      report,
      exerciseCounts,
      "appBridge",
      "plugin.appBridge.call",
      target.module.id,
      target.hook,
    );
  }

  if (required.includes("evaluator")) {
    const target = findEvaluatorTarget(
      orderModulesByExercise(modules, exerciseCounts),
    );
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
    recordRpcCall(
      report,
      "evaluator",
      "plugin.evaluator.shouldRun",
      target.module.id,
      target.evaluator.name,
    );
    const prepare = await router.plugin.prepareEvaluator(common);
    recordRpcCall(
      report,
      "evaluator",
      "plugin.evaluator.prepare",
      target.module.id,
      target.evaluator.name,
    );
    const prompt = await router.plugin.promptEvaluator({
      ...common,
      ...(prepare.prepared === undefined ? {} : { prepared: prepare.prepared }),
    });
    recordRpcCall(
      report,
      "evaluator",
      "plugin.evaluator.prompt",
      target.module.id,
      target.evaluator.name,
    );
    const process = await router.plugin.processEvaluator({
      ...common,
      ...(prepare.prepared === undefined ? {} : { prepared: prepare.prepared }),
      output: { prompt: prompt.prompt },
    });
    report.evaluatorResult = { shouldRun, prepare, prompt, process };
    recordExercise(
      report,
      exerciseCounts,
      "evaluator",
      "plugin.evaluator.process",
      target.module.id,
      target.evaluator.name,
    );
  }

  if (required.includes("responseHandlerEvaluator")) {
    const target = findResponseHandlerEvaluatorTarget(
      orderModulesByExercise(modules, exerciseCounts),
    );
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
    recordRpcCall(
      report,
      "responseHandlerEvaluator",
      "plugin.responseHandlerEvaluator.shouldRun",
      target.module.id,
      target.evaluator.name,
    );
    const evaluate =
      await router.plugin.evaluateResponseHandlerEvaluator(common);
    report.responseHandlerEvaluatorResult = { shouldRun, evaluate };
    recordExercise(
      report,
      exerciseCounts,
      "responseHandlerEvaluator",
      "plugin.responseHandlerEvaluator.evaluate",
      target.module.id,
      target.evaluator.name,
    );
  }

  if (required.includes("responseHandlerFieldEvaluator")) {
    const target = findResponseHandlerFieldEvaluatorTarget(
      orderModulesByExercise(modules, exerciseCounts),
    );
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
    recordRpcCall(
      report,
      "responseHandlerFieldEvaluator",
      "plugin.responseHandlerFieldEvaluator.shouldRun",
      target.module.id,
      target.field.name,
    );
    const parse = await router.plugin.parseResponseHandlerFieldEvaluator({
      ...common,
      value: { raw: true },
    });
    recordRpcCall(
      report,
      "responseHandlerFieldEvaluator",
      "plugin.responseHandlerFieldEvaluator.parse",
      target.module.id,
      target.field.name,
    );
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
    recordExercise(
      report,
      exerciseCounts,
      "responseHandlerFieldEvaluator",
      "plugin.responseHandlerFieldEvaluator.handle",
      target.module.id,
      target.field.name,
    );
  }

  await exerciseUncoveredModules(
    router,
    options,
    report,
    modules,
    exerciseCounts,
  );

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
    if (!isValidRemotePluginModuleId(module.id) || !module.name) {
      throw new Error(
        `Capability endpoint "${endpointId}" returned a module with invalid id or missing name.`,
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

function isValidRemotePluginModuleId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value);
}

function orderModulesByExercise(
  modules: RemotePluginModuleManifest[],
  exerciseCounts: Map<string, number>,
): RemotePluginModuleManifest[] {
  return [...modules].sort((left, right) => {
    const countDelta =
      (exerciseCounts.get(left.id) ?? 0) - (exerciseCounts.get(right.id) ?? 0);
    if (countDelta !== 0) return countDelta;
    return modules.indexOf(left) - modules.indexOf(right);
  });
}

function recordExercise(
  report: RemoteCapabilityEndpointConformanceReport,
  exerciseCounts: Map<string, number>,
  surface: RemoteCapabilityEndpointConformanceSurface,
  method: RemoteCapabilityEndpointConformanceRpcMethod,
  moduleId: string,
  target: string,
  options: { summarize?: boolean } = {},
): void {
  if (options.summarize !== false) {
    report.exercised[surface] = `${moduleId}:${target}`;
  }
  report.moduleExercises.push({
    surface,
    moduleId,
    target: `${moduleId}:${target}`,
  });
  recordRpcCall(report, surface, method, moduleId, target);
  exerciseCounts.set(moduleId, (exerciseCounts.get(moduleId) ?? 0) + 1);
}

function recordRpcCall(
  report: RemoteCapabilityEndpointConformanceReport,
  surface: RemoteCapabilityEndpointConformanceSurface,
  method: RemoteCapabilityEndpointConformanceRpcMethod,
  moduleId: string,
  target: string,
): void {
  report.rpcCalls.push({
    method,
    surface,
    moduleId,
    target: `${moduleId}:${target}`,
  });
}

async function exerciseUncoveredModules(
  router: RemoteCapabilityRouterService,
  options: RemoteCapabilityEndpointConformanceOptions,
  report: RemoteCapabilityEndpointConformanceReport,
  modules: RemotePluginModuleManifest[],
  exerciseCounts: Map<string, number>,
): Promise<void> {
  for (const module of modules) {
    if ((exerciseCounts.get(module.id) ?? 0) > 0) continue;
    const action = module.actions?.[0];
    if (action) {
      await router.plugin.invokeAction({
        endpointId: options.endpoint.id,
        moduleId: module.id,
        action: action.name,
        content: options.actionContent ?? {
          text: "capability-router conformance action",
        },
      });
      recordExercise(
        report,
        exerciseCounts,
        "action",
        "plugin.action.invoke",
        module.id,
        action.name,
        { summarize: false },
      );
      continue;
    }
    const provider = module.providers?.[0];
    if (provider) {
      await router.plugin.getProvider({
        endpointId: options.endpoint.id,
        moduleId: module.id,
        provider: provider.name,
        state: {},
      });
      recordExercise(
        report,
        exerciseCounts,
        "provider",
        "plugin.provider.get",
        module.id,
        provider.name,
        { summarize: false },
      );
      continue;
    }
    const route = module.routes?.[0];
    if (route) {
      const result = await router.plugin.callRoute({
        endpointId: options.endpoint.id,
        moduleId: module.id,
        method: route.method,
        path: route.path,
        headers: {},
        body: options.routeBody ?? { conformance: true },
      });
      if (
        typeof result.status !== "number" ||
        result.status < 200 ||
        result.status > 299
      ) {
        throw new Error(
          `Capability endpoint "${options.endpoint.id}" returned a non-2xx route status.`,
        );
      }
      recordExercise(
        report,
        exerciseCounts,
        "route",
        "plugin.route.call",
        module.id,
        `${route.method} ${route.path}`,
        { summarize: false },
      );
      continue;
    }
    const view = module.views?.find((candidate) => candidate.bundlePath);
    if (view?.bundlePath) {
      const assetResult = await router.plugin.getAsset({
        endpointId: options.endpoint.id,
        moduleId: module.id,
        path: view.bundlePath,
      });
      const assetBytes = Buffer.from(assetResult.bodyBase64, "base64");
      if (assetBytes.byteLength === 0) {
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
      recordExercise(
        report,
        exerciseCounts,
        "viewAsset",
        "plugin.asset.get",
        module.id,
        view.bundlePath,
        { summarize: false },
      );
      continue;
    }
    const model = module.models?.[0];
    if (model) {
      await router.plugin.invokeModel({
        endpointId: options.endpoint.id,
        moduleId: module.id,
        modelType: model.modelType,
        params: { prompt: "capability-router conformance model" },
      });
      recordExercise(
        report,
        exerciseCounts,
        "model",
        "plugin.model.invoke",
        module.id,
        model.modelType,
        { summarize: false },
      );
      continue;
    }
    const hook = module.lifecycle?.hooks?.[0];
    if (hook) {
      await router.plugin.callLifecycle({
        endpointId: options.endpoint.id,
        moduleId: module.id,
        hook,
        context: { conformance: true },
      });
      recordExercise(
        report,
        exerciseCounts,
        "lifecycle",
        "plugin.lifecycle.call",
        module.id,
        hook,
        { summarize: false },
      );
      continue;
    }
    const event = module.events?.[0];
    if (event) {
      await router.plugin.handleEvent({
        endpointId: options.endpoint.id,
        moduleId: module.id,
        eventName: event.eventName,
        payload: { conformance: true },
      });
      recordExercise(
        report,
        exerciseCounts,
        "event",
        "plugin.event.handle",
        module.id,
        event.eventName,
        { summarize: false },
      );
      continue;
    }
    const service = module.services?.find(
      (candidate) => candidate.methods?.[0],
    );
    const method = service?.methods?.[0];
    if (service && method) {
      await router.plugin.callService({
        endpointId: options.endpoint.id,
        moduleId: module.id,
        serviceType: service.serviceType,
        method,
        args: [{ conformance: true }],
      });
      recordExercise(
        report,
        exerciseCounts,
        "service",
        "plugin.service.call",
        module.id,
        `${service.serviceType}.${method}`,
        { summarize: false },
      );
      continue;
    }
    const appBridgeHook = module.appBridge?.hooks?.[0];
    if (appBridgeHook) {
      await router.plugin.callAppBridge({
        endpointId: options.endpoint.id,
        moduleId: module.id,
        hook: appBridgeHook,
        context: {
          method: "GET",
          pathname: "/capability-router-conformance",
          path: "/capability-router-conformance",
          query: {},
          headers: {},
        },
      });
      recordExercise(
        report,
        exerciseCounts,
        "appBridge",
        "plugin.appBridge.call",
        module.id,
        appBridgeHook,
        { summarize: false },
      );
      continue;
    }
    const evaluator = module.evaluators?.[0];
    if (evaluator) {
      const common = {
        endpointId: options.endpoint.id,
        moduleId: module.id,
        evaluator: evaluator.name,
        message: { text: "capability-router conformance evaluator" },
        state: {},
        options: {},
      };
      await router.plugin.shouldRunEvaluator(common);
      recordRpcCall(
        report,
        "evaluator",
        "plugin.evaluator.shouldRun",
        module.id,
        evaluator.name,
      );
      const prepare = await router.plugin.prepareEvaluator(common);
      recordRpcCall(
        report,
        "evaluator",
        "plugin.evaluator.prepare",
        module.id,
        evaluator.name,
      );
      const prompt = await router.plugin.promptEvaluator({
        ...common,
        ...(prepare.prepared === undefined
          ? {}
          : { prepared: prepare.prepared }),
      });
      recordRpcCall(
        report,
        "evaluator",
        "plugin.evaluator.prompt",
        module.id,
        evaluator.name,
      );
      await router.plugin.processEvaluator({
        ...common,
        ...(prepare.prepared === undefined
          ? {}
          : { prepared: prepare.prepared }),
        output: { prompt: prompt.prompt },
      });
      recordExercise(
        report,
        exerciseCounts,
        "evaluator",
        "plugin.evaluator.process",
        module.id,
        evaluator.name,
        { summarize: false },
      );
      continue;
    }
    const responseEvaluator = module.responseHandlerEvaluators?.[0];
    if (responseEvaluator) {
      const common = {
        endpointId: options.endpoint.id,
        moduleId: module.id,
        evaluator: responseEvaluator.name,
        context: { conformance: true },
      };
      await router.plugin.shouldRunResponseHandlerEvaluator(common);
      recordRpcCall(
        report,
        "responseHandlerEvaluator",
        "plugin.responseHandlerEvaluator.shouldRun",
        module.id,
        responseEvaluator.name,
      );
      await router.plugin.evaluateResponseHandlerEvaluator(common);
      recordExercise(
        report,
        exerciseCounts,
        "responseHandlerEvaluator",
        "plugin.responseHandlerEvaluator.evaluate",
        module.id,
        responseEvaluator.name,
        { summarize: false },
      );
      continue;
    }
    const responseField = module.responseHandlerFieldEvaluators?.[0];
    if (responseField) {
      const common = {
        endpointId: options.endpoint.id,
        moduleId: module.id,
        field: responseField.name,
        context: { conformance: true },
      };
      await router.plugin.shouldRunResponseHandlerFieldEvaluator(common);
      recordRpcCall(
        report,
        "responseHandlerFieldEvaluator",
        "plugin.responseHandlerFieldEvaluator.shouldRun",
        module.id,
        responseField.name,
      );
      const parse = await router.plugin.parseResponseHandlerFieldEvaluator({
        ...common,
        value: { raw: true },
      });
      recordRpcCall(
        report,
        "responseHandlerFieldEvaluator",
        "plugin.responseHandlerFieldEvaluator.parse",
        module.id,
        responseField.name,
      );
      await router.plugin.handleResponseHandlerFieldEvaluator({
        ...common,
        value: { raw: true },
        ...(parse.value === undefined ||
        typeof parse.value !== "object" ||
        parse.value === null ||
        Array.isArray(parse.value)
          ? {}
          : { parsed: parse.value }),
      });
      recordExercise(
        report,
        exerciseCounts,
        "responseHandlerFieldEvaluator",
        "plugin.responseHandlerFieldEvaluator.handle",
        module.id,
        responseField.name,
        { summarize: false },
      );
      continue;
    }
    throw new Error(
      `Capability endpoint "${options.endpoint.id}" module "${module.id}" did not expose an exercisable remote plugin surface.`,
    );
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
