/**
 * Registers the `capability-router` CLI command group for wiring remote
 * capability-router plugin endpoints into a running agent. `connect` POSTs a
 * connect payload to the agent's `/api/capability-router/connect` route — for a
 * direct/provider endpoint or an Eliza Cloud-provisioned one; the exported
 * `buildCapabilityRouterConnectPayload` shapes and validates that body.
 * `conformance` drives an endpoint through the plugin protocol (actions,
 * providers, routes, view assets, models, lifecycle/event/service/app-bridge
 * hooks, and the evaluator families) via `runCapabilityRouterConformance`,
 * returning an exercised-surface report. Remaining helpers normalize/validate
 * options and parse capability-invoke responses.
 */
import { theme } from "@elizaos/shared";
import type { Command } from "commander";

const DEFAULT_AGENT_API_BASE = "http://127.0.0.1:31337";

export type CapabilityRouterEndpointProvider =
  | "direct"
  | "e2b"
  | "home-machine"
  | "mobile-companion"
  | "desktop-companion";

export type CapabilityRouterConnectOptions = {
  provider?: CapabilityRouterEndpointProvider;
  id?: string;
  token?: string;
  allowedModule?: string[];
  persist?: boolean;
  requestTimeoutMs?: string;
  cloud?: boolean;
  cloudApiBase?: string;
  cloudAuthToken?: string;
  cloudName?: string;
  cloudBio?: string[];
  cloudEndpointId?: string;
  cloudToken?: string;
  cloudTimeoutMs?: string;
  cloudPollIntervalMs?: string;
};

export type CapabilityRouterConformanceOptions = {
  token?: string;
  requestTimeoutMs?: string;
  require?: string[];
};

export type CapabilityRouterConformanceSurface =
  | "action"
  | "provider"
  | "route"
  | "view-asset"
  | "model"
  | "lifecycle"
  | "event"
  | "service"
  | "app-bridge"
  | "evaluator"
  | "response-handler-evaluator"
  | "response-handler-field-evaluator";

export function registerCapabilityRouterCommand(program: Command) {
  const capabilityRouter = program
    .command("capability-router")
    .description("Connect remote capability-router plugin endpoints");

  capabilityRouter
    .command("connect [baseUrl]")
    .description(
      "Connect a remote plugin endpoint or provision a Cloud endpoint",
    )
    .option(
      "--provider <provider>",
      "Endpoint provider: direct, e2b, home-machine, mobile-companion, desktop-companion",
      "direct",
    )
    .option("--id <id>", "Endpoint id for direct/provider connects")
    .option(
      "--token <token>",
      "Bearer token for direct/provider endpoint calls",
    )
    .option(
      "--allowed-module <moduleId>",
      "Restrict sync to a remote module id; repeatable",
      collectValues,
      [],
    )
    .option("--no-persist", "Do not persist the connected endpoint")
    .option(
      "--request-timeout-ms <ms>",
      "Capability-router RPC request timeout in milliseconds",
    )
    .option("--cloud", "Provision an Eliza Cloud capability endpoint")
    .option(
      "--cloud-api-base <url>",
      "Eliza Cloud API base URL",
      "https://api.elizacloud.ai",
    )
    .option("--cloud-auth-token <token>", "Eliza Cloud API token")
    .option("--cloud-name <name>", "Name for the provisioned Cloud agent")
    .option(
      "--cloud-bio <line>",
      "Bio line for the provisioned Cloud agent; repeatable",
      collectValues,
      [],
    )
    .option("--cloud-endpoint-id <id>", "Endpoint id for the Cloud endpoint")
    .option("--cloud-token <token>", "Override endpoint bearer token")
    .option("--cloud-timeout-ms <ms>", "Cloud provisioning timeout")
    .option("--cloud-poll-interval-ms <ms>", "Cloud provisioning poll interval")
    .option(
      "--api-base <url>",
      "Running agent API base URL",
      process.env.ELIZA_AGENT_API_BASE ?? DEFAULT_AGENT_API_BASE,
    )
    .action(
      async (
        baseUrl: string | undefined,
        opts: CapabilityRouterConnectOptions & { apiBase: string },
      ) => {
        const payload = buildCapabilityRouterConnectPayload(baseUrl, opts);
        const endpoint = `${normalizeApiBase(opts.apiBase)}/api/capability-router/connect`;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const text = await response.text();
        let body: unknown = text;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            // keep raw text for errors
          }
        }
        if (!response.ok) {
          const message =
            body && typeof body === "object" && "error" in body
              ? String((body as { error?: unknown }).error)
              : text || `HTTP ${response.status}`;
          throw new Error(`Capability-router connect failed: ${message}`);
        }
        console.log(theme.success("Connected capability-router endpoint."));
        console.log(JSON.stringify(body, null, 2));
      },
    );

  capabilityRouter
    .command("conformance <baseUrl>")
    .description(
      "Validate a remote endpoint against the capability-router plugin protocol",
    )
    .option("--token <token>", "Bearer token for endpoint calls")
    .option(
      "--request-timeout-ms <ms>",
      "Capability-router RPC request timeout in milliseconds",
    )
    .option(
      "--require <surface>",
      "Required surface: action, provider, route, view-asset, model, lifecycle, event, service, app-bridge, evaluator, response-handler-evaluator, response-handler-field-evaluator; repeatable",
      collectValues,
      [],
    )
    .action(
      async (baseUrl: string, opts: CapabilityRouterConformanceOptions) => {
        const report = await runCapabilityRouterConformance(baseUrl, opts);
        console.log(theme.success("Capability-router endpoint conforms."));
        console.log(JSON.stringify(report, null, 2));
      },
    );
}

export async function runCapabilityRouterConformance(
  baseUrl: string,
  opts: CapabilityRouterConformanceOptions = {},
): Promise<Record<string, unknown>> {
  const endpoint = normalizeApiBase(requireNonEmpty(baseUrl, "baseUrl"));
  const requestTimeoutMs =
    parseOptionalPositiveInteger(opts.requestTimeoutMs, "requestTimeoutMs") ??
    60_000;
  const requiredSurfaces = normalizeConformanceSurfaces(opts.require);

  const availability = await requestCapabilityJson(
    endpoint,
    "GET",
    "/v1/capabilities",
    undefined,
    opts.token,
    requestTimeoutMs,
  );
  if (!isCapabilityAvailability(availability)) {
    throw new Error("Capability availability response is not valid.");
  }
  if (!availability.available || availability.capabilities.plugin !== true) {
    throw new Error(
      "Capability endpoint must report available plugin capability.",
    );
  }

  const moduleResult = await invokeCapability(
    endpoint,
    "plugin.modules.list",
    {},
    opts.token,
    requestTimeoutMs,
  );
  const modules = readConformanceModules(moduleResult);
  const report: Record<string, unknown> = {
    baseUrl: endpoint,
    moduleCount: modules.length,
    moduleIds: modules.map((module) => module.id),
    exercised: {},
  };
  const exercised = report.exercised as Record<string, string>;

  if (requiredSurfaces.includes("action")) {
    const target = modules.find((module) => module.actions[0]);
    if (!target) throw new Error("Endpoint did not expose a remote action.");
    const action = target.actions[0];
    await invokeCapability(
      endpoint,
      "plugin.action.invoke",
      {
        moduleId: target.id,
        action: action.name,
        content: { text: "capability-router conformance action" },
      },
      opts.token,
      requestTimeoutMs,
    );
    exercised.action = `${target.id}:${action.name}`;
  }

  if (requiredSurfaces.includes("provider")) {
    const target = modules.find((module) => module.providers[0]);
    if (!target) throw new Error("Endpoint did not expose a remote provider.");
    const provider = target.providers[0];
    await invokeCapability(
      endpoint,
      "plugin.provider.get",
      { moduleId: target.id, provider: provider.name, state: {} },
      opts.token,
      requestTimeoutMs,
    );
    exercised.provider = `${target.id}:${provider.name}`;
  }

  if (requiredSurfaces.includes("route")) {
    const target = modules.find((module) => module.routes[0]);
    if (!target) throw new Error("Endpoint did not expose a remote route.");
    const route = target.routes[0];
    const result = await invokeCapability(
      endpoint,
      "plugin.route.call",
      {
        moduleId: target.id,
        method: route.method,
        path: route.path,
        headers: {},
        body: { conformance: true },
      },
      opts.token,
      requestTimeoutMs,
    );
    const status = readRouteStatus(result);
    report.routeStatus = status;
    exercised.route = `${target.id}:${route.method} ${route.path}`;
  }

  if (requiredSurfaces.includes("view-asset")) {
    const target = modules.find((module) =>
      module.views.find((view) => view.bundlePath),
    );
    if (!target) {
      throw new Error("Endpoint did not expose a remote view bundle asset.");
    }
    const view = target.views.find((candidate) => candidate.bundlePath);
    if (!view?.bundlePath) {
      throw new Error("Endpoint view bundle asset path is missing.");
    }
    const result = await invokeCapability(
      endpoint,
      "plugin.asset.get",
      { moduleId: target.id, path: view.bundlePath },
      opts.token,
      requestTimeoutMs,
    );
    const asset = readAssetResult(result);
    report.asset = {
      path: asset.path,
      contentType: asset.contentType,
      byteLength: Buffer.from(asset.bodyBase64, "base64").byteLength,
    };
    exercised.viewAsset = `${target.id}:${view.bundlePath}`;
  }

  if (requiredSurfaces.includes("model")) {
    const target = modules.find((module) => module.models[0]);
    if (!target) throw new Error("Endpoint did not expose a remote model.");
    const model = target.models[0];
    await invokeCapability(
      endpoint,
      "plugin.model.invoke",
      {
        moduleId: target.id,
        modelType: model.modelType,
        params: { prompt: "capability-router conformance model" },
      },
      opts.token,
      requestTimeoutMs,
    );
    exercised.model = `${target.id}:${model.modelType}`;
  }

  if (requiredSurfaces.includes("lifecycle")) {
    const target = modules.find((module) => module.lifecycleHooks[0]);
    if (!target) {
      throw new Error("Endpoint did not expose a remote lifecycle hook.");
    }
    const hook = target.lifecycleHooks[0];
    await invokeCapability(
      endpoint,
      "plugin.lifecycle.call",
      { moduleId: target.id, hook, context: { conformance: true } },
      opts.token,
      requestTimeoutMs,
    );
    exercised.lifecycle = `${target.id}:${hook}`;
  }

  if (requiredSurfaces.includes("event")) {
    const target = modules.find((module) => module.events[0]);
    if (!target) {
      throw new Error("Endpoint did not expose a remote event handler.");
    }
    const event = target.events[0];
    await invokeCapability(
      endpoint,
      "plugin.event.handle",
      {
        moduleId: target.id,
        eventName: event.eventName,
        payload: { conformance: true },
      },
      opts.token,
      requestTimeoutMs,
    );
    exercised.event = `${target.id}:${event.eventName}`;
  }

  if (requiredSurfaces.includes("service")) {
    const target = modules.find((module) =>
      module.services.find((service) => service.methods[0]),
    );
    if (!target) {
      throw new Error("Endpoint did not expose a remote service method.");
    }
    const service = target.services.find((candidate) => candidate.methods[0]);
    const method = service?.methods[0];
    if (!service || !method) {
      throw new Error("Endpoint remote service method is missing.");
    }
    await invokeCapability(
      endpoint,
      "plugin.service.call",
      {
        moduleId: target.id,
        serviceType: service.serviceType,
        method,
        args: [{ conformance: true }],
      },
      opts.token,
      requestTimeoutMs,
    );
    exercised.service = `${target.id}:${service.serviceType}.${method}`;
  }

  if (requiredSurfaces.includes("app-bridge")) {
    const target = modules.find((module) => module.appBridgeHooks[0]);
    if (!target) {
      throw new Error("Endpoint did not expose a remote app bridge hook.");
    }
    const hook = target.appBridgeHooks[0];
    await invokeCapability(
      endpoint,
      "plugin.appBridge.call",
      {
        moduleId: target.id,
        hook,
        context: {
          method: "GET",
          pathname: "/capability-router-conformance",
          path: "/capability-router-conformance",
          query: {},
          headers: {},
        },
      },
      opts.token,
      requestTimeoutMs,
    );
    exercised.appBridge = `${target.id}:${hook}`;
  }

  if (requiredSurfaces.includes("evaluator")) {
    const target = modules.find((module) => module.evaluators[0]);
    if (!target) throw new Error("Endpoint did not expose a remote evaluator.");
    const evaluator = target.evaluators[0];
    const common = {
      moduleId: target.id,
      evaluator: evaluator.name,
      message: { text: "capability-router conformance evaluator" },
      state: {},
      options: {},
    };
    await invokeCapability(
      endpoint,
      "plugin.evaluator.shouldRun",
      common,
      opts.token,
      requestTimeoutMs,
    );
    const prepare = await invokeCapability(
      endpoint,
      "plugin.evaluator.prepare",
      common,
      opts.token,
      requestTimeoutMs,
    );
    const prepared = isRecord(prepare) ? prepare.prepared : undefined;
    await invokeCapability(
      endpoint,
      "plugin.evaluator.prompt",
      { ...common, ...(prepared === undefined ? {} : { prepared }) },
      opts.token,
      requestTimeoutMs,
    );
    await invokeCapability(
      endpoint,
      "plugin.evaluator.process",
      {
        ...common,
        ...(prepared === undefined ? {} : { prepared }),
        output: { conformance: true },
      },
      opts.token,
      requestTimeoutMs,
    );
    exercised.evaluator = `${target.id}:${evaluator.name}`;
  }

  if (requiredSurfaces.includes("response-handler-evaluator")) {
    const target = modules.find(
      (module) => module.responseHandlerEvaluators[0],
    );
    if (!target) {
      throw new Error(
        "Endpoint did not expose a remote response-handler evaluator.",
      );
    }
    const evaluator = target.responseHandlerEvaluators[0];
    const common = {
      moduleId: target.id,
      evaluator: evaluator.name,
      context: { conformance: true },
    };
    await invokeCapability(
      endpoint,
      "plugin.responseHandlerEvaluator.shouldRun",
      common,
      opts.token,
      requestTimeoutMs,
    );
    await invokeCapability(
      endpoint,
      "plugin.responseHandlerEvaluator.evaluate",
      common,
      opts.token,
      requestTimeoutMs,
    );
    exercised.responseHandlerEvaluator = `${target.id}:${evaluator.name}`;
  }

  if (requiredSurfaces.includes("response-handler-field-evaluator")) {
    const target = modules.find(
      (module) => module.responseHandlerFieldEvaluators[0],
    );
    if (!target) {
      throw new Error(
        "Endpoint did not expose a remote response-handler field evaluator.",
      );
    }
    const field = target.responseHandlerFieldEvaluators[0];
    const common = {
      moduleId: target.id,
      field: field.name,
      context: { conformance: true },
    };
    await invokeCapability(
      endpoint,
      "plugin.responseHandlerFieldEvaluator.shouldRun",
      common,
      opts.token,
      requestTimeoutMs,
    );
    const parse = await invokeCapability(
      endpoint,
      "plugin.responseHandlerFieldEvaluator.parse",
      { ...common, value: { raw: true } },
      opts.token,
      requestTimeoutMs,
    );
    const parsed = isRecord(parse) ? parse.value : undefined;
    await invokeCapability(
      endpoint,
      "plugin.responseHandlerFieldEvaluator.handle",
      {
        ...common,
        value: { raw: true },
        ...(isRecord(parsed) ? { parsed } : {}),
      },
      opts.token,
      requestTimeoutMs,
    );
    exercised.responseHandlerFieldEvaluator = `${target.id}:${field.name}`;
  }

  return report;
}

export function buildCapabilityRouterConnectPayload(
  baseUrl: string | undefined,
  opts: CapabilityRouterConnectOptions,
): Record<string, unknown> {
  const allowedModuleIds = normalizeStringList(opts.allowedModule);
  const requestTimeoutMs = parseOptionalPositiveInteger(
    opts.requestTimeoutMs,
    "requestTimeoutMs",
  );
  const persist = opts.persist !== false;
  const common = {
    ...(allowedModuleIds.length === 0 ? {} : { allowedModuleIds }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(persist ? {} : { persist: false }),
  };

  if (opts.cloud) {
    return {
      ...common,
      cloud: {
        cloudApiBase: requireNonEmpty(opts.cloudApiBase, "cloudApiBase"),
        authToken: requireNonEmpty(opts.cloudAuthToken, "cloudAuthToken"),
        name: requireNonEmpty(opts.cloudName, "cloudName"),
        ...optionalStringList(opts.cloudBio, "bio"),
        ...optionalString(opts.cloudEndpointId, "endpointId"),
        ...optionalString(opts.cloudToken, "token"),
        ...optionalPositiveInteger(opts.cloudTimeoutMs, "timeoutMs"),
        ...optionalPositiveInteger(opts.cloudPollIntervalMs, "pollIntervalMs"),
      },
    };
  }

  const provider = normalizeProvider(opts.provider);
  return {
    ...common,
    ...(provider === "direct" ? {} : { provider }),
    endpoint: {
      baseUrl: requireNonEmpty(baseUrl, "baseUrl"),
      ...optionalString(opts.id, "id"),
      ...optionalString(opts.token, "token"),
    },
  };
}

function normalizeApiBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizeProvider(
  value: CapabilityRouterConnectOptions["provider"],
): CapabilityRouterEndpointProvider {
  const provider = value ?? "direct";
  if (
    provider === "direct" ||
    provider === "e2b" ||
    provider === "home-machine" ||
    provider === "mobile-companion" ||
    provider === "desktop-companion"
  ) {
    return provider;
  }
  throw new Error(
    "provider must be one of direct, e2b, home-machine, mobile-companion, or desktop-companion.",
  );
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function normalizeConformanceSurfaces(
  value: string[] | undefined,
): CapabilityRouterConformanceSurface[] {
  const values = normalizeStringList(value);
  const surfaces =
    values.length === 0
      ? [
          "action",
          "provider",
          "route",
          "view-asset",
          "model",
          "lifecycle",
          "event",
          "service",
          "app-bridge",
          "evaluator",
          "response-handler-evaluator",
          "response-handler-field-evaluator",
        ]
      : values;
  return surfaces.map((surface) => {
    if (
      surface === "action" ||
      surface === "provider" ||
      surface === "route" ||
      surface === "view-asset" ||
      surface === "model" ||
      surface === "lifecycle" ||
      surface === "event" ||
      surface === "service" ||
      surface === "app-bridge" ||
      surface === "evaluator" ||
      surface === "response-handler-evaluator" ||
      surface === "response-handler-field-evaluator"
    ) {
      return surface;
    }
    throw new Error(
      "require must be one of action, provider, route, view-asset, model, lifecycle, event, service, app-bridge, evaluator, response-handler-evaluator, or response-handler-field-evaluator.",
    );
  });
}

function normalizeStringList(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
}

function optionalStringList(
  value: string[] | undefined,
  key: string,
): Record<string, string[]> {
  const values = normalizeStringList(value);
  return values.length === 0 ? {} : { [key]: values };
}

function optionalString(
  value: string | undefined,
  key: string,
): Record<string, string> {
  const trimmed = value?.trim();
  return trimmed ? { [key]: trimmed } : {};
}

function optionalPositiveInteger(
  value: string | undefined,
  key: string,
): Record<string, number> {
  const parsed = parseOptionalPositiveInteger(value, key);
  return parsed === undefined ? {} : { [key]: parsed };
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  key: string,
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return parsed;
}

function requireNonEmpty(value: string | undefined, key: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${key} is required.`);
  }
  return trimmed;
}

async function requestCapabilityJson(
  baseUrl: string,
  method: "GET" | "POST",
  path: string,
  body: Record<string, unknown> | undefined,
  token: string | undefined,
  requestTimeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      throw new Error(
        `Capability request failed with HTTP ${response.status}: ${text}`,
      );
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function invokeCapability(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>,
  token: string | undefined,
  requestTimeoutMs: number,
): Promise<unknown> {
  const response = await requestCapabilityJson(
    baseUrl,
    "POST",
    "/v1/capabilities/invoke",
    { method, params },
    token,
    requestTimeoutMs,
  );
  if (!isRecord(response)) {
    throw new Error(`Capability invoke ${method} did not return an object.`);
  }
  if (response.ok === false) {
    throw new Error(
      `Capability invoke ${method} failed: ${JSON.stringify(response.error)}`,
    );
  }
  return "result" in response ? response.result : response;
}

type ConformanceModule = {
  id: string;
  name: string;
  actions: Array<{ name: string }>;
  providers: Array<{ name: string }>;
  routes: Array<{ method: string; path: string }>;
  views: Array<{ bundlePath?: string }>;
  models: Array<{ modelType: string }>;
  lifecycleHooks: string[];
  events: Array<{ eventName: string }>;
  services: Array<{ serviceType: string; methods: string[] }>;
  appBridgeHooks: string[];
  evaluators: Array<{ name: string }>;
  responseHandlerEvaluators: Array<{ name: string }>;
  responseHandlerFieldEvaluators: Array<{ name: string }>;
};

function readConformanceModules(value: unknown): ConformanceModule[] {
  if (!isRecord(value) || !Array.isArray(value.modules)) {
    throw new Error("plugin.modules.list result must include modules.");
  }
  if (value.modules.length === 0) {
    throw new Error("Endpoint must expose at least one remote plugin module.");
  }
  const seen = new Set<string>();
  return value.modules.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
      throw new Error("Remote plugin module id is required.");
    }
    if (seen.has(item.id)) {
      throw new Error(`Remote plugin module id "${item.id}" is duplicated.`);
    }
    seen.add(item.id);
    if (typeof item.name !== "string" || !item.name.trim()) {
      throw new Error("Remote plugin module name is required.");
    }
    return {
      id: item.id,
      name: item.name,
      actions: readNamedList(item.actions),
      providers: readNamedList(item.providers),
      routes: readRouteList(item.routes),
      views: readViewList(item.views),
      models: readModelList(item.models),
      lifecycleHooks: readLifecycleHooks(item.lifecycle),
      events: readEventList(item.events),
      services: readServiceList(item.services),
      appBridgeHooks: readAppBridgeHooks(item.appBridge),
      evaluators: readNamedList(item.evaluators),
      responseHandlerEvaluators: readNamedList(item.responseHandlerEvaluators),
      responseHandlerFieldEvaluators: readNamedList(
        item.responseHandlerFieldEvaluators,
      ),
    };
  });
}

function readNamedList(value: unknown): Array<{ name: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter((item) => typeof item.name === "string" && item.name.trim())
    .map((item) => ({ name: item.name as string }));
}

function readRouteList(
  value: unknown,
): Array<{ method: string; path: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter(
      (item) =>
        typeof item.method === "string" &&
        item.method.trim() &&
        typeof item.path === "string" &&
        item.path.trim(),
    )
    .map((item) => ({
      method: item.method as string,
      path: item.path as string,
    }));
}

function readViewList(value: unknown): Array<{ bundlePath?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => ({
      ...(typeof item.bundlePath === "string" && item.bundlePath.trim()
        ? { bundlePath: item.bundlePath }
        : {}),
    }));
}

function readModelList(value: unknown): Array<{ modelType: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter(
      (item) => typeof item.modelType === "string" && item.modelType.trim(),
    )
    .map((item) => ({ modelType: item.modelType as string }));
}

function readLifecycleHooks(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return [];
  return value.hooks.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

function readEventList(value: unknown): Array<{ eventName: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter(
      (item) => typeof item.eventName === "string" && item.eventName.trim(),
    )
    .map((item) => ({ eventName: item.eventName as string }));
}

function readServiceList(
  value: unknown,
): Array<{ serviceType: string; methods: string[] }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter(
      (item) => typeof item.serviceType === "string" && item.serviceType.trim(),
    )
    .map((item) => ({
      serviceType: item.serviceType as string,
      methods: Array.isArray(item.methods)
        ? item.methods.filter(
            (method): method is string =>
              typeof method === "string" && method.trim().length > 0,
          )
        : [],
    }));
}

function readAppBridgeHooks(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return [];
  return value.hooks.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

function readRouteStatus(value: unknown): number {
  if (!isRecord(value) || typeof value.status !== "number") {
    throw new Error("plugin.route.call result must include numeric status.");
  }
  if (value.status < 100 || value.status > 599) {
    throw new Error("plugin.route.call result status must be an HTTP status.");
  }
  return value.status;
}

function readAssetResult(value: unknown): {
  path: string;
  contentType: string;
  bodyBase64: string;
} {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.contentType !== "string" ||
    typeof value.bodyBase64 !== "string"
  ) {
    throw new Error(
      "plugin.asset.get result must include path, contentType, and bodyBase64.",
    );
  }
  const byteLength = Buffer.from(value.bodyBase64, "base64").byteLength;
  if (byteLength === 0) {
    throw new Error("plugin.asset.get result must include a nonempty asset.");
  }
  return {
    path: value.path,
    contentType: value.contentType,
    bodyBase64: value.bodyBase64,
  };
}

function isCapabilityAvailability(value: unknown): value is {
  available: boolean;
  capabilities: { plugin?: boolean };
} {
  return (
    isRecord(value) &&
    typeof value.available === "boolean" &&
    isRecord(value.capabilities)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
