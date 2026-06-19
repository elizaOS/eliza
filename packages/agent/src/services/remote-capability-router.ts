import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type CapabilityAvailability,
  type CapabilityEnvironment,
  CapabilityError,
  type CapabilityName,
  type ElizaCapabilityRouter,
  type FileCapability,
  type FileListParams,
  type FileReadTextParams,
  type FileWriteTextParams,
  type GitCapability,
  type GitCommandRunParams,
  type GitDiffParams,
  type GitStatusParams,
  type IAgentRuntime,
  type JsonObject,
  type JsonValue,
  type LocalModelCapability,
  type LocalModelStatusParams,
  type PluginCallAppBridgeParams,
  type PluginCallRouteParams,
  type PluginCallServiceParams,
  type PluginEvaluatorPrepareParams,
  type PluginEvaluatorProcessParams,
  type PluginEvaluatorPromptParams,
  type PluginEvaluatorShouldRunParams,
  type PluginGetAssetParams,
  type PluginGetProviderParams,
  type PluginHandleEventParams,
  type PluginInvokeActionParams,
  type PluginInvokeModelParams,
  type PluginLifecycleCallParams,
  type PluginResponseHandlerEvaluatorEvaluateParams,
  type PluginResponseHandlerEvaluatorShouldRunParams,
  type PluginResponseHandlerFieldEvaluatorHandleParams,
  type PluginResponseHandlerFieldEvaluatorParseParams,
  type PluginResponseHandlerFieldEvaluatorShouldRunParams,
  type RemotePluginCapability,
  type RuntimeBrokerCapabilityMethod,
  RuntimeBrokerCapabilityRouter,
  Service,
  type TerminalCapability,
  type TerminalRunParams,
} from "@elizaos/core";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export type RemoteCapabilityEndpointConfig = {
  id: string;
  baseUrl: string;
  token?: string;
};

export type RemoteCapabilityRouterConfig = {
  enabled: boolean;
  baseUrl?: string;
  token?: string;
  endpoints?: RemoteCapabilityEndpointConfig[];
  environment: CapabilityEnvironment;
  requestTimeoutMs: number;
};

export class RemoteCapabilityRouterService
  extends Service
  implements ElizaCapabilityRouter
{
  static serviceType = CAPABILITY_ROUTER_SERVICE_TYPE;
  capabilityDescription =
    "Routes standard Eliza capabilities to a remote capability server.";

  readonly environment: CapabilityEnvironment;
  readonly fs: FileCapability;
  readonly pty: TerminalCapability;
  readonly git: GitCapability;
  readonly model: LocalModelCapability;
  readonly plugin: RemotePluginCapability;

  private readonly broker: RuntimeBrokerCapabilityRouter;
  private readonly endpoints: RemoteCapabilityEndpointConfig[];
  private readonly moduleEndpointById = new Map<
    string,
    RemoteCapabilityEndpointConfig
  >();

  constructor(
    runtime?: IAgentRuntime,
    private readonly routerConfig: RemoteCapabilityRouterConfig = runtime
      ? resolveRemoteCapabilityRouterConfig(runtime)
      : (undefined as never),
  ) {
    if (!runtime) {
      throw new CapabilityError({
        code: "CAPABILITY_UNAVAILABLE",
        message: "Remote capability router requires an agent runtime.",
      });
    }
    super(runtime);
    this.environment = routerConfig.environment;
    this.broker = new RuntimeBrokerCapabilityRouter({
      environment: routerConfig.environment,
      invokeRuntime: (method, params) => this.invoke(method, params),
    });
    this.endpoints = normalizeEndpoints(routerConfig);
    this.fs = this.broker.fs;
    this.pty = this.broker.pty;
    this.git = this.broker.git;
    this.model = this.broker.model;
    this.plugin = this.broker.plugin;
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const config = resolveRemoteCapabilityRouterConfig(runtime);
    if (!config.enabled || normalizeEndpoints(config).length === 0) {
      throw new CapabilityError({
        code: "CAPABILITY_UNAVAILABLE",
        message:
          "Remote capability router is not configured. Set ELIZA_CAPABILITY_ROUTER_URL to enable it.",
      });
    }
    return new RemoteCapabilityRouterService(runtime, config);
  }

  async stop(): Promise<void> {}

  getEndpointConfigs(): RemoteCapabilityEndpointConfig[] {
    return this.endpoints.map((endpoint) => ({ ...endpoint }));
  }

  async availability(): Promise<CapabilityAvailability> {
    if (this.endpoints.length === 0) {
      return unavailableAvailability(this.environment, "Missing remote URL.");
    }
    const results = await Promise.allSettled(
      this.endpoints.map((endpoint) =>
        this.requestJson(endpoint, "GET", "/v1/capabilities"),
      ),
    );
    const availability = results
      .map((result) => (result.status === "fulfilled" ? result.value : null))
      .filter(isCapabilityAvailability);
    if (availability.length > 0) {
      return mergeAvailability(this.environment, availability);
    }
    throw new CapabilityError({
      code: "CAPABILITY_REQUEST_FAILED",
      message: "No remote capability endpoints returned availability.",
      method: "availability",
    });
  }

  private async invoke(
    method: RuntimeBrokerCapabilityMethod,
    params?: JsonObject,
  ): Promise<JsonValue | undefined> {
    if (method === "plugin.modules.list") {
      return (await this.listRemotePluginModules(params)) as JsonValue;
    }
    if (isPluginModuleMethod(method)) {
      return await this.invokeRemotePluginMethod(method, params);
    }
    const result = await this.requestJson(
      this.requireEndpointForParams(method, params),
      "POST",
      "/v1/capabilities/invoke",
      {
        method,
        params: params ?? {},
      },
    );
    if (isRecord(result) && result.ok === false) {
      throw capabilityErrorFromRemote(method, result);
    }
    if (isRecord(result) && "result" in result) {
      return result.result as JsonValue;
    }
    return result;
  }

  private async requestJson(
    endpoint: RemoteCapabilityEndpointConfig,
    method: "GET" | "POST",
    path: string,
    body?: JsonObject,
  ): Promise<JsonValue | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.routerConfig.requestTimeoutMs,
    );
    try {
      const response = await fetch(new URL(path, endpoint.baseUrl), {
        method,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(endpoint.token
            ? { authorization: `Bearer ${endpoint.token}` }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text ? parseJson(text, path) : undefined;
      if (!response.ok) {
        throw new CapabilityError({
          code: "CAPABILITY_REQUEST_FAILED",
          message: `Remote capability request to ${endpoint.id} failed with HTTP ${response.status}.`,
          method: path,
          details: jsonDetails(parsed),
        });
      }
      return parsed;
    } catch (error) {
      if (error instanceof CapabilityError) throw error;
      throw new CapabilityError({
        code: "CAPABILITY_REQUEST_FAILED",
        message: error instanceof Error ? error.message : String(error),
        method: path,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private requirePrimaryEndpoint(): RemoteCapabilityEndpointConfig {
    const endpoint = this.endpoints[0];
    if (!endpoint) {
      throw new CapabilityError({
        code: "CAPABILITY_UNAVAILABLE",
        message: "Remote capability router URL is missing.",
      });
    }
    return endpoint;
  }

  private requireEndpointForParams(
    method: RuntimeBrokerCapabilityMethod,
    params?: JsonObject,
  ): RemoteCapabilityEndpointConfig {
    const endpointId =
      typeof params?.endpointId === "string" ? params.endpointId : "";
    if (!endpointId) return this.requirePrimaryEndpoint();
    const endpoint = this.endpoints.find((item) => item.id === endpointId);
    if (!endpoint) {
      throw new CapabilityError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `Remote capability endpoint "${endpointId}" is not configured.`,
        method,
        details: { endpointId },
      });
    }
    return endpoint;
  }

  private async listRemotePluginModules(
    params?: JsonObject,
  ): Promise<JsonValue | undefined> {
    const endpointId =
      typeof params?.endpointId === "string" ? params.endpointId : "";
    const endpoints = endpointId
      ? [this.requireEndpointForParams("plugin.modules.list", params)]
      : this.endpoints;
    const results = await Promise.all(
      endpoints.map(async (endpoint) => {
        const result = await this.requestJson(
          endpoint,
          "POST",
          "/v1/capabilities/invoke",
          {
            method: "plugin.modules.list",
            params: params ?? {},
          },
        );
        return {
          endpoint,
          modules: readRemotePluginModules(result, endpoint.id),
        };
      }),
    );
    this.moduleEndpointById.clear();
    const modules: JsonObject[] = [];
    for (const result of results) {
      for (const module of result.modules) {
        const moduleId = module.id;
        if (!isValidRemotePluginModuleId(moduleId)) {
          throw new CapabilityError({
            code: "CAPABILITY_DECODE_FAILED",
            message: `Remote endpoint ${result.endpoint.id} returned a plugin module with invalid id.`,
            capability: "plugin",
            method: "plugin.modules.list",
            details: module,
          });
        }
        const existingEndpoint = this.moduleEndpointById.get(moduleId);
        if (existingEndpoint) {
          throw new CapabilityError({
            code: "CAPABILITY_DECODE_FAILED",
            message: `Remote plugin module id collision for "${moduleId}" between ${existingEndpoint.id} and ${result.endpoint.id}.`,
            capability: "plugin",
            method: "plugin.modules.list",
          });
        }
        this.moduleEndpointById.set(moduleId, result.endpoint);
        modules.push(normalizeRemoteModuleManifest(module, result.endpoint));
      }
    }
    return { modules };
  }

  private async invokeRemotePluginMethod(
    method: RuntimeBrokerCapabilityMethod,
    params?: JsonObject,
  ): Promise<JsonValue | undefined> {
    const endpointId =
      typeof params?.endpointId === "string" ? params.endpointId : "";
    const moduleId =
      typeof params?.moduleId === "string" ? params.moduleId : "";
    const endpoint =
      (endpointId
        ? this.requireEndpointForParams(method, params)
        : undefined) ??
      this.moduleEndpointById.get(moduleId) ??
      this.requirePrimaryEndpoint();
    const result = await this.requestJson(
      endpoint,
      "POST",
      "/v1/capabilities/invoke",
      {
        method,
        params: params ?? {},
      },
    );
    if (isRecord(result) && result.ok === false) {
      throw capabilityErrorFromRemote(method, result);
    }
    if (isRecord(result) && "result" in result) {
      return result.result as JsonValue;
    }
    return result;
  }
}

export function resolveRemoteCapabilityRouterConfig(
  runtime?: Pick<IAgentRuntime, "getSetting"> | null,
): RemoteCapabilityRouterConfig {
  const get = (key: string) => {
    const setting = runtime?.getSetting?.(key);
    if (typeof setting === "string" && setting.trim()) return setting.trim();
    const env = process.env[key];
    return typeof env === "string" && env.trim() ? env.trim() : undefined;
  };
  const baseUrl =
    get("ELIZA_CAPABILITY_ROUTER_URL") ?? get("ELIZA_REMOTE_CAPABILITY_URL");
  const endpoints = parseEndpointList(
    get("ELIZA_CAPABILITY_ROUTER_URLS"),
    get("ELIZA_CAPABILITY_ROUTER_TOKEN"),
  );
  const enabled =
    parseBoolean(get("ELIZA_CAPABILITY_ROUTER_ENABLED")) ??
    parseBoolean(get("ELIZA_REMOTE_CAPABILITY_ENABLED")) ??
    (Boolean(baseUrl) || endpoints.length > 0);
  return {
    enabled,
    baseUrl: baseUrl ? stripTrailingSlash(baseUrl) : undefined,
    token:
      get("ELIZA_CAPABILITY_ROUTER_TOKEN") ??
      get("ELIZA_REMOTE_CAPABILITY_TOKEN"),
    ...(endpoints.length === 0 ? {} : { endpoints }),
    environment:
      parseEnvironment(get("ELIZA_CAPABILITY_ROUTER_ENVIRONMENT")) ?? "server",
    requestTimeoutMs:
      parsePositiveInteger(get("ELIZA_CAPABILITY_ROUTER_TIMEOUT_MS")) ??
      DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

export type RemoteCapabilityServer = {
  availability(): Promise<CapabilityAvailability>;
  invoke(
    method: RuntimeBrokerCapabilityMethod,
    params?: JsonObject,
  ): Promise<JsonValue | undefined>;
};

export type RemoteCapabilityFetchHandlerOptions = {
  token?: string;
};

export function createRemoteCapabilityFetchHandler(
  router: ElizaCapabilityRouter,
  options: RemoteCapabilityFetchHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    try {
      if (!isAuthorizedCapabilityRequest(request, options)) {
        return jsonResponse(401, {
          ok: false,
          error: {
            code: "CAPABILITY_UNAVAILABLE",
            message: "Capability router request is not authorized.",
          },
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        return jsonResponse(200, await router.availability());
      }
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/v1/capabilities/assets/")
      ) {
        return await serveRemotePluginAsset(router, url);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/capabilities/invoke"
      ) {
        const body = parseJson(await request.text(), url.pathname);
        if (!isRecord(body) || typeof body.method !== "string") {
          return jsonResponse(400, {
            ok: false,
            error: {
              code: "CAPABILITY_DECODE_FAILED",
              message: "Capability invoke body must include method.",
            },
          });
        }
        const method = body.method as RuntimeBrokerCapabilityMethod;
        const params = isRecord(body.params) ? body.params : {};
        const result = await invokeLocalRouter(router, method, params);
        return jsonResponse(200, {
          ok: true,
          ...(result === undefined ? {} : { result }),
        });
      }
      return jsonResponse(404, { ok: false, error: { message: "Not found." } });
    } catch (error) {
      const capabilityError =
        error instanceof CapabilityError
          ? error
          : new CapabilityError({
              code: "CAPABILITY_REQUEST_FAILED",
              message: error instanceof Error ? error.message : String(error),
            });
      return jsonResponse(500, {
        ok: false,
        error: capabilityError.toJSON(),
      });
    }
  };
}

async function serveRemotePluginAsset(
  router: ElizaCapabilityRouter,
  url: URL,
): Promise<Response> {
  const prefix = "/v1/capabilities/assets/";
  const remainder = url.pathname.slice(prefix.length);
  const slashIndex = remainder.indexOf("/");
  if (slashIndex <= 0 || slashIndex === remainder.length - 1) {
    return jsonResponse(400, {
      ok: false,
      error: {
        code: "CAPABILITY_DECODE_FAILED",
        message: "Capability asset URL must include module id and path.",
      },
    });
  }
  const moduleId = decodeURIComponent(remainder.slice(0, slashIndex));
  const assetPath = `/${remainder.slice(slashIndex + 1)}`;
  const asset = await router.plugin.getAsset({
    moduleId,
    path: assetPath,
  });
  return new Response(Buffer.from(asset.bodyBase64, "base64"), {
    status: 200,
    headers: {
      "content-type": asset.contentType,
      ...(asset.integrity === undefined
        ? {}
        : { "x-eliza-asset-integrity": asset.integrity }),
    },
  });
}

function isAuthorizedCapabilityRequest(
  request: Request,
  options: RemoteCapabilityFetchHandlerOptions,
): boolean {
  if (!options.token) return true;
  return request.headers.get("authorization") === `Bearer ${options.token}`;
}

async function invokeLocalRouter(
  router: ElizaCapabilityRouter,
  method: RuntimeBrokerCapabilityMethod,
  params: JsonObject,
): Promise<JsonValue | undefined> {
  switch (method) {
    case "fs.list":
      return (await router.fs.list(params as FileListParams)) as JsonValue;
    case "fs.readText":
      return (await router.fs.readText(
        params as FileReadTextParams,
      )) as JsonValue;
    case "fs.writeText":
      return (await router.fs.writeText(
        params as FileWriteTextParams,
      )) as JsonValue;
    case "pty.command.run":
      return (await router.pty.runCommand(
        params as TerminalRunParams,
      )) as JsonValue;
    case "git.status":
      return (await router.git.status(params as GitStatusParams)) as JsonValue;
    case "git.diff":
      return (await router.git.diff(params as GitDiffParams)) as JsonValue;
    case "git.command.run":
      return (await router.git.commandRun(
        params as GitCommandRunParams,
      )) as JsonValue;
    case "model.status":
      return (await router.model.status(
        params as LocalModelStatusParams,
      )) as JsonValue;
    case "plugin.modules.list":
      return (await router.plugin.listModules(params)) as JsonValue;
    case "plugin.action.invoke":
      return (await router.plugin.invokeAction(
        params as PluginInvokeActionParams,
      )) as JsonValue;
    case "plugin.provider.get":
      return (await router.plugin.getProvider(
        params as PluginGetProviderParams,
      )) as JsonValue;
    case "plugin.route.call":
      return (await router.plugin.callRoute(
        params as PluginCallRouteParams,
      )) as JsonValue;
    case "plugin.asset.get":
      return (await router.plugin.getAsset(
        params as PluginGetAssetParams,
      )) as JsonValue;
    case "plugin.evaluator.shouldRun":
      return (await router.plugin.shouldRunEvaluator(
        params as PluginEvaluatorShouldRunParams,
      )) as JsonValue;
    case "plugin.evaluator.prepare":
      return (await router.plugin.prepareEvaluator(
        params as PluginEvaluatorPrepareParams,
      )) as JsonValue;
    case "plugin.evaluator.prompt":
      return (await router.plugin.promptEvaluator(
        params as PluginEvaluatorPromptParams,
      )) as JsonValue;
    case "plugin.evaluator.process":
      return (await router.plugin.processEvaluator(
        params as PluginEvaluatorProcessParams,
      )) as JsonValue;
    case "plugin.responseHandlerEvaluator.shouldRun":
      return (await router.plugin.shouldRunResponseHandlerEvaluator(
        params as PluginResponseHandlerEvaluatorShouldRunParams,
      )) as JsonValue;
    case "plugin.responseHandlerEvaluator.evaluate":
      return (await router.plugin.evaluateResponseHandlerEvaluator(
        params as PluginResponseHandlerEvaluatorEvaluateParams,
      )) as JsonValue;
    case "plugin.responseHandlerFieldEvaluator.shouldRun":
      return (await router.plugin.shouldRunResponseHandlerFieldEvaluator(
        params as PluginResponseHandlerFieldEvaluatorShouldRunParams,
      )) as JsonValue;
    case "plugin.responseHandlerFieldEvaluator.parse":
      return (await router.plugin.parseResponseHandlerFieldEvaluator(
        params as PluginResponseHandlerFieldEvaluatorParseParams,
      )) as JsonValue;
    case "plugin.responseHandlerFieldEvaluator.handle":
      return (await router.plugin.handleResponseHandlerFieldEvaluator(
        params as PluginResponseHandlerFieldEvaluatorHandleParams,
      )) as JsonValue;
    case "plugin.lifecycle.call":
      return (await router.plugin.callLifecycle(
        params as PluginLifecycleCallParams,
      )) as JsonValue;
    case "plugin.event.handle":
      return (await router.plugin.handleEvent(
        params as PluginHandleEventParams,
      )) as JsonValue;
    case "plugin.model.invoke":
      return (await router.plugin.invokeModel(
        params as PluginInvokeModelParams,
      )) as JsonValue;
    case "plugin.service.call":
      return (await router.plugin.callService(
        params as PluginCallServiceParams,
      )) as JsonValue;
    case "plugin.appBridge.call":
      return (await router.plugin.callAppBridge(
        params as PluginCallAppBridgeParams,
      )) as JsonValue;
    default:
      throw new CapabilityError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `Unsupported capability method: ${method}`,
        method,
      });
  }
}

function capabilityErrorFromRemote(
  method: RuntimeBrokerCapabilityMethod,
  response: Record<string, unknown>,
): CapabilityError {
  const error = isRecord(response.error) ? response.error : response;
  return new CapabilityError({
    code:
      error.code === "CAPABILITY_UNAVAILABLE" ||
      error.code === "CAPABILITY_DECODE_FAILED" ||
      error.code === "CAPABILITY_REQUEST_FAILED"
        ? error.code
        : "CAPABILITY_REQUEST_FAILED",
    message:
      typeof error.message === "string"
        ? error.message
        : "Remote capability request failed.",
    capability:
      error.capability === "fs" ||
      error.capability === "pty" ||
      error.capability === "git" ||
      error.capability === "model" ||
      error.capability === "plugin"
        ? (error.capability as CapabilityName)
        : undefined,
    method:
      typeof error.method === "string" ? error.method : (method as string),
    details: isJsonValue(error.details) ? error.details : undefined,
  });
}

function isCapabilityAvailability(
  value: unknown,
): value is CapabilityAvailability {
  if (!isRecord(value) || typeof value.available !== "boolean") return false;
  if (
    value.environment !== "desktop" &&
    value.environment !== "node" &&
    value.environment !== "server" &&
    value.environment !== "browser" &&
    value.environment !== "mobile" &&
    value.environment !== "unknown"
  ) {
    return false;
  }
  const capabilities = value.capabilities;
  if (!isRecord(capabilities)) return false;
  return ["fs", "pty", "git", "model", "plugin"].every(
    (name) => typeof capabilities[name] === "boolean",
  );
}

function unavailableAvailability(
  environment: CapabilityEnvironment,
  reason: string,
): CapabilityAvailability {
  return {
    environment,
    available: false,
    capabilities: {
      fs: false,
      pty: false,
      git: false,
      model: false,
      plugin: false,
    },
    reason,
  };
}

function mergeAvailability(
  environment: CapabilityEnvironment,
  items: CapabilityAvailability[],
): CapabilityAvailability {
  return {
    environment,
    available: items.some((item) => item.available),
    capabilities: {
      fs: items.some((item) => item.capabilities.fs),
      pty: items.some((item) => item.capabilities.pty),
      git: items.some((item) => item.capabilities.git),
      model: items.some((item) => item.capabilities.model),
      plugin: items.some((item) => item.capabilities.plugin),
    },
    ...(items.every((item) => !item.available)
      ? { reason: "No configured remote capability endpoint is available." }
      : {}),
  };
}

function normalizeEndpoints(
  config: RemoteCapabilityRouterConfig,
): RemoteCapabilityEndpointConfig[] {
  const endpoints = [...(config.endpoints ?? [])];
  if (config.baseUrl) {
    endpoints.unshift({
      id: "primary",
      baseUrl: stripTrailingSlash(config.baseUrl),
      ...(config.token === undefined ? {} : { token: config.token }),
    });
  }
  const normalized: RemoteCapabilityEndpointConfig[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const endpoint of endpoints) {
    const next = normalizeEndpointConfig(endpoint);
    if (ids.has(next.id)) {
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote capability endpoint id "${next.id}" is configured more than once.`,
        method: "capability-router.configure",
      });
    }
    if (urls.has(next.baseUrl)) {
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote capability endpoint URL "${next.baseUrl}" is configured more than once.`,
        method: "capability-router.configure",
      });
    }
    ids.add(next.id);
    urls.add(next.baseUrl);
    normalized.push(next);
  }
  return normalized;
}

function normalizeEndpointConfig(
  endpoint: RemoteCapabilityEndpointConfig,
): RemoteCapabilityEndpointConfig {
  const id = endpoint.id.trim();
  if (!id) {
    throw new CapabilityError({
      code: "CAPABILITY_DECODE_FAILED",
      message: "Remote capability endpoint id must be a non-empty string.",
      method: "capability-router.configure",
    });
  }
  const baseUrl = normalizeEndpointBaseUrl(endpoint.baseUrl);
  return {
    id,
    baseUrl,
    ...(endpoint.token === undefined || !endpoint.token.trim()
      ? {}
      : { token: endpoint.token.trim() }),
  };
}

function normalizeEndpointBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    url.hash = "";
    url.search = "";
    return stripTrailingSlash(url.toString());
  } catch {
    throw new CapabilityError({
      code: "CAPABILITY_DECODE_FAILED",
      message:
        "Remote capability endpoint baseUrl must be an absolute http(s) URL.",
      method: "capability-router.configure",
    });
  }
}

function parseEndpointList(
  value: string | undefined,
  token?: string,
): RemoteCapabilityEndpointConfig[] {
  if (!value) return [];
  const parsed = tryParseEndpointJson(value, token);
  if (parsed) return parsed;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((baseUrl, index) => ({
      id: `remote-${index + 1}`,
      baseUrl: stripTrailingSlash(baseUrl),
      ...(token === undefined ? {} : { token }),
    }));
}

function tryParseEndpointJson(
  value: string,
  token?: string,
): RemoteCapabilityEndpointConfig[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const endpoints: RemoteCapabilityEndpointConfig[] = [];
    for (let index = 0; index < parsed.length; index += 1) {
      const item = parsed[index];
      if (typeof item === "string" && item.trim()) {
        endpoints.push({
          id: `remote-${index + 1}`,
          baseUrl: stripTrailingSlash(item.trim()),
          ...(token === undefined ? {} : { token }),
        });
      } else if (isRecord(item) && typeof item.baseUrl === "string") {
        endpoints.push({
          id:
            typeof item.id === "string" && item.id.trim()
              ? item.id.trim()
              : `remote-${index + 1}`,
          baseUrl: stripTrailingSlash(item.baseUrl.trim()),
          ...(typeof item.token === "string" && item.token.trim()
            ? { token: item.token.trim() }
            : token === undefined
              ? {}
              : { token }),
        });
      } else {
        return null;
      }
    }
    return endpoints;
  } catch {
    return null;
  }
}

function isPluginModuleMethod(method: RuntimeBrokerCapabilityMethod): boolean {
  return (
    method === "plugin.action.invoke" ||
    method === "plugin.provider.get" ||
    method === "plugin.route.call" ||
    method === "plugin.asset.get" ||
    method === "plugin.evaluator.shouldRun" ||
    method === "plugin.evaluator.prepare" ||
    method === "plugin.evaluator.prompt" ||
    method === "plugin.evaluator.process" ||
    method === "plugin.responseHandlerEvaluator.shouldRun" ||
    method === "plugin.responseHandlerEvaluator.evaluate" ||
    method === "plugin.responseHandlerFieldEvaluator.shouldRun" ||
    method === "plugin.responseHandlerFieldEvaluator.parse" ||
    method === "plugin.responseHandlerFieldEvaluator.handle" ||
    method === "plugin.lifecycle.call" ||
    method === "plugin.event.handle" ||
    method === "plugin.model.invoke" ||
    method === "plugin.service.call" ||
    method === "plugin.appBridge.call"
  );
}

function readRemotePluginModules(
  value: JsonValue | undefined,
  endpointId: string,
): JsonObject[] {
  const result =
    isRecord(value) && isRecord(value.result) ? value.result : value;
  if (!isRecord(result) || !Array.isArray(result.modules)) {
    throw new CapabilityError({
      code: "CAPABILITY_DECODE_FAILED",
      message: `Remote endpoint ${endpointId} returned an invalid plugin module list.`,
      capability: "plugin",
      method: "plugin.modules.list",
      details: jsonDetails(value),
    });
  }
  const modules: JsonObject[] = [];
  for (const module of result.modules) {
    if (!isRecord(module) || !isJsonValue(module)) {
      throw new CapabilityError({
        code: "CAPABILITY_DECODE_FAILED",
        message: `Remote endpoint ${endpointId} returned an invalid plugin module manifest.`,
        capability: "plugin",
        method: "plugin.modules.list",
      });
    }
    modules.push(module as JsonObject);
  }
  return modules;
}

function normalizeRemoteModuleManifest(
  module: JsonObject,
  endpoint: RemoteCapabilityEndpointConfig,
): JsonObject {
  const views = module.views;
  const moduleId = typeof module.id === "string" ? module.id : "";
  const withEndpoint = {
    ...module,
    capabilityEndpointId: endpoint.id,
  };
  if (!Array.isArray(views)) return withEndpoint;
  return {
    ...withEndpoint,
    views: views.map((view) => {
      if (!isRecord(view) || !isJsonValue(view)) return view;
      if (typeof view.bundleUrl === "string" && view.bundleUrl) {
        validateRemoteBundleUrl(view.bundleUrl);
        return view;
      }
      if (typeof view.bundlePath !== "string" || !view.bundlePath) return view;
      return {
        ...view,
        bundleUrl: remoteAssetUrl(endpoint, moduleId, view.bundlePath),
      };
    }),
  };
}

function validateRemoteBundleUrl(bundleUrl: string): void {
  try {
    const parsed = new URL(bundleUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
    if (parsed.username || parsed.password) {
      throw new Error("credentials are not allowed");
    }
  } catch {
    throw new CapabilityError({
      code: "CAPABILITY_DECODE_FAILED",
      message: `Remote plugin bundleUrl "${bundleUrl}" must be an absolute http(s) URL without embedded credentials.`,
      capability: "plugin",
      method: "plugin.modules.list",
    });
  }
}

function remoteAssetUrl(
  endpoint: RemoteCapabilityEndpointConfig,
  moduleId: string,
  assetPath: string,
): string {
  const normalizedAssetPath = normalizeRemoteAssetPath(assetPath);
  if (!endpoint.token) {
    return new URL(
      `/v1/capabilities/assets/${encodeURIComponent(moduleId)}/${normalizedAssetPath}`,
      endpoint.baseUrl,
    ).toString();
  }
  return `/api/capability-router/assets/${encodeURIComponent(endpoint.id)}/${encodeURIComponent(moduleId)}/${normalizedAssetPath}`;
}

function normalizeRemoteAssetPath(assetPath: string): string {
  const path = assetPath.trim();
  if (
    !path ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\") ||
    path.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path)
  ) {
    throw new CapabilityError({
      code: "CAPABILITY_DECODE_FAILED",
      message: `Remote plugin asset path "${assetPath}" must be a relative path without query, hash, or URL scheme.`,
      capability: "plugin",
      method: "plugin.modules.list",
    });
  }
  const segments = path.replace(/^\/+/, "").split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new CapabilityError({
      code: "CAPABILITY_DECODE_FAILED",
      message: `Remote plugin asset path "${assetPath}" must not contain empty, current-directory, or parent-directory segments.`,
      capability: "plugin",
      method: "plugin.modules.list",
    });
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function parseJson(text: string, method: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new CapabilityError({
      code: "CAPABILITY_DECODE_FAILED",
      message: "Remote capability response was not valid JSON.",
      method,
    });
  }
}

function jsonResponse(status: number, body: JsonValue): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonDetails(value: unknown): JsonValue | undefined {
  return isJsonValue(value) ? value : undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseEnvironment(
  value: string | undefined,
): CapabilityEnvironment | undefined {
  if (
    value === "desktop" ||
    value === "node" ||
    value === "server" ||
    value === "browser" ||
    value === "mobile" ||
    value === "unknown"
  ) {
    return value;
  }
  return undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isValidRemotePluginModuleId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value);
}
