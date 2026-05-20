import type http from "node:http";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  CapabilityError,
  type ElizaCapabilityRouter,
  type IAgentRuntime,
  type JsonObject,
  type RouteHelpers,
  type RouteRequestMeta,
} from "@elizaos/core";
import {
  type ConnectCloudCapabilitySandboxOptions,
  type ConnectCloudCapabilitySandboxResult,
  connectCloudCapabilitySandbox,
} from "../services/remote-capability-cloud-sandbox.ts";
import {
  type ConnectRemoteCapabilityEndpointProviderOptions,
  type ConnectRemoteCapabilityEndpointProviderResult,
  connectRemoteCapabilityEndpointProvider,
  directRemoteCapabilityEndpointProvider,
  normalizeEndpointTrustPolicyOptions,
  type RemoteCapabilityEndpointProvider,
  type RemoteCapabilityEndpointTrustPolicyOptions,
} from "../services/remote-capability-endpoint-provider.ts";
import type { RemoteCapabilityEndpointConfig } from "../services/remote-capability-router.ts";
import {
  desktopCompanionCapabilityEndpointProvider,
  e2bCapabilityEndpointProvider,
  homeMachineCapabilityEndpointProvider,
  mobileCompanionCapabilityEndpointProvider,
  type UrlRemoteCapabilityEndpointProviderOptions,
} from "../services/remote-capability-url-endpoint-providers.ts";
import type {
  RemotePluginSyncResult,
  RemotePluginTrustPolicy,
} from "../services/remote-plugin-adapter.ts";
import {
  detectClientPlatform,
  isDynamicLoadingAllowed,
} from "./platform-detect.ts";

type JsonBodyReader = <T = Record<string, unknown>>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options?: { requireObject?: boolean },
) => Promise<T | null>;

export interface RemoteCapabilityRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  runtime: IAgentRuntime | null;
  config?: CapabilityRouterPersistConfig;
  readJsonBody: JsonBodyReader;
  saveConfig?: (config: CapabilityRouterPersistConfig) => void;
  persistConfigEnv?: (key: string, value: string) => Promise<void>;
  connectEndpointProvider?: <TOptions>(
    runtime: IAgentRuntime,
    options: ConnectRemoteCapabilityEndpointProviderOptions<TOptions>,
  ) => Promise<ConnectRemoteCapabilityEndpointProviderResult>;
  connectCloudSandbox?: (
    runtime: IAgentRuntime,
    options: ConnectCloudCapabilitySandboxOptions,
  ) => Promise<ConnectCloudCapabilitySandboxResult>;
}

type ConnectBody = {
  endpoint?: unknown;
  cloud?: unknown;
  provider?: unknown;
  unloadMissing?: unknown;
  persist?: unknown;
  requestTimeoutMs?: unknown;
  allowedModuleIds?: unknown;
  trustPolicy?: unknown;
};

type DirectEndpointBody = {
  id?: unknown;
  baseUrl?: unknown;
  token?: unknown;
};

type EndpointProviderMode =
  | "direct"
  | "e2b"
  | "home-machine"
  | "mobile-companion"
  | "desktop-companion";

type DirectEndpointProviderOptions = {
  endpoint: RemoteCapabilityEndpointConfig;
  allowedModuleIds?: string[];
  trustPolicy?: RemoteCapabilityEndpointTrustPolicyOptions;
};

type EndpointProviderOptions =
  | DirectEndpointProviderOptions
  | UrlRemoteCapabilityEndpointProviderOptions;

type CloudBody = {
  cloudApiBase?: unknown;
  authToken?: unknown;
  name?: unknown;
  bio?: unknown;
  endpointId?: unknown;
  token?: unknown;
  timeoutMs?: unknown;
  pollIntervalMs?: unknown;
  allowedModuleIds?: unknown;
  trustPolicy?: unknown;
};

export async function handleRemoteCapabilityRoutes(
  ctx: RemoteCapabilityRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, runtime, readJsonBody, json, error } =
    ctx;

  if (pathname.startsWith("/api/capability-router/assets/")) {
    if (!runtime) {
      error(res, "Agent runtime unavailable", 503);
      return true;
    }
    if (method !== "GET" && method !== "HEAD") {
      error(res, "Method not allowed", 405);
      return true;
    }
    if (!isDynamicLoadingAllowed(detectClientPlatform(req))) {
      error(
        res,
        "Dynamic capability asset loading is not permitted on this platform.",
        403,
      );
      return true;
    }
    try {
      await serveCapabilityRouterAssetProxy(ctx, runtime);
    } catch (err) {
      error(
        res,
        err instanceof Error ? err.message : "Failed to load remote asset.",
        err instanceof CapabilityError ? 502 : 400,
      );
    }
    return true;
  }

  if (pathname !== "/api/capability-router/connect") {
    return false;
  }

  if (method !== "POST") {
    error(res, "Method not allowed", 405);
    return true;
  }

  if (!runtime) {
    error(res, "Agent runtime unavailable", 503);
    return true;
  }

  const body = await readJsonBody<ConnectBody>(req, res, {
    requireObject: true,
  });
  if (body === null) {
    return true;
  }

  try {
    const unloadMissing =
      typeof body.unloadMissing === "boolean" ? body.unloadMissing : true;
    const persist = typeof body.persist === "boolean" ? body.persist : true;
    const allowedModuleIds = parseOptionalStringArray(
      body.allowedModuleIds,
      "allowedModuleIds",
    );
    const trustPolicy = parseOptionalEndpointTrustPolicy(
      body.trustPolicy,
      "trustPolicy",
    );
    const requestTimeoutMs = optionalPositiveInteger(
      body.requestTimeoutMs,
      "requestTimeoutMs",
    );
    if (requestTimeoutMs instanceof Error) {
      error(res, requestTimeoutMs.message, 400);
      return true;
    }
    if (body.endpoint !== undefined && body.cloud !== undefined) {
      error(
        res,
        "Request body must include only one of 'endpoint' or 'cloud'.",
        400,
      );
      return true;
    }

    if (body.endpoint !== undefined) {
      const providerMode = parseEndpointProviderMode(body.provider);
      const endpoint = parseDirectEndpoint(body.endpoint);
      const connectEndpointProvider =
        ctx.connectEndpointProvider ?? connectRemoteCapabilityEndpointProvider;
      const provider = getEndpointProvider(providerMode);
      const result = await connectEndpointProvider(runtime, {
        provider,
        provisionOptions: buildEndpointProvisionOptions(
          providerMode,
          endpoint,
          allowedModuleIds,
        ),
        unloadMissing,
        requestTimeoutMs: requestTimeoutMs ?? 60_000,
        ...(allowedModuleIds === undefined ? {} : { allowedModuleIds }),
        ...(trustPolicy === undefined ? {} : { trustPolicy }),
      });
      const persistedEndpoint = result.endpoint ?? endpoint;
      if (persist) {
        await persistEndpoint(
          ctx,
          persistedEndpoint,
          allowedModuleIds,
          trustPolicy,
          {
            mode: providerMode === "direct" ? "endpoint" : providerMode,
            provider: result.providerId,
            endpoint: persistedEndpoint,
            allowedModuleIds,
            sync: result.sync,
          },
        );
      }
      json(res, {
        success: true,
        mode: providerMode === "direct" ? "endpoint" : providerMode,
        ...(providerMode === "direct" ? {} : { provider: providerMode }),
        endpoint: redactEndpoint(persistedEndpoint),
        persisted: persist,
        sync: serializeSyncResult(result.sync),
      });
      return true;
    }

    if (body.cloud !== undefined) {
      const cloud = parseCloudOptions(body.cloud);
      if (trustPolicy !== undefined && cloud.trustPolicy !== undefined) {
        error(
          res,
          "Cloud requests must set trustPolicy either at the top level or inside 'cloud', not both.",
          400,
        );
        return true;
      }
      if (
        allowedModuleIds !== undefined &&
        cloud.allowedModuleIds !== undefined
      ) {
        error(
          res,
          "Cloud requests must set allowedModuleIds either at the top level or inside 'cloud', not both.",
          400,
        );
        return true;
      }
      const cloudAllowedModuleIds = allowedModuleIds ?? cloud.allowedModuleIds;
      const cloudTrustPolicy = trustPolicy ?? cloud.trustPolicy;
      const connectCloudSandbox =
        ctx.connectCloudSandbox ?? connectCloudCapabilitySandbox;
      const result = await connectCloudSandbox(runtime, {
        ...cloud,
        unloadMissing,
        ...(cloudAllowedModuleIds === undefined
          ? {}
          : { allowedModuleIds: cloudAllowedModuleIds }),
        ...(cloudTrustPolicy === undefined
          ? {}
          : { trustPolicy: cloudTrustPolicy }),
        requestTimeoutMs: requestTimeoutMs ?? 60_000,
      });
      if (persist) {
        await persistEndpoint(
          ctx,
          result.endpoint,
          cloudAllowedModuleIds,
          cloudTrustPolicy,
          {
            mode: "cloud",
            provider: result.providerId,
            endpoint: result.endpoint,
            allowedModuleIds: cloudAllowedModuleIds,
            sync: result.sync,
          },
        );
      }
      json(res, {
        success: true,
        mode: "cloud",
        agentId: result.agentId,
        ...(result.jobId === undefined ? {} : { jobId: result.jobId }),
        endpoint: redactEndpoint(result.endpoint),
        persisted: persist,
        sync: serializeSyncResult(result.sync),
      });
      return true;
    }

    error(res, "Request body must include either 'endpoint' or 'cloud'.", 400);
    return true;
  } catch (err) {
    error(
      res,
      err instanceof Error
        ? err.message
        : "Failed to connect capability router endpoint.",
      400,
    );
    return true;
  }
}

async function serveCapabilityRouterAssetProxy(
  ctx: RemoteCapabilityRouteContext,
  runtime: IAgentRuntime,
): Promise<void> {
  const { res, pathname, method } = ctx;
  const parsed = parseAssetProxyPath(pathname);
  const router = getRuntimeCapabilityRouter(runtime);
  const asset = await router.plugin.getAsset({
    endpointId: parsed.endpointId,
    moduleId: parsed.moduleId,
    path: parsed.assetPath,
  });
  const body = Buffer.from(asset.bodyBase64, "base64");
  const headers: Record<string, string | number> = {
    "Content-Type": asset.contentType,
    "Content-Length": body.byteLength,
    "Cache-Control": "no-cache",
    ...(asset.integrity === undefined
      ? {}
      : { "X-Eliza-Asset-Integrity": asset.integrity }),
  };
  const response = res as {
    writeHead?: (
      status: number,
      headers: Record<string, string | number>,
    ) => void;
    setHeader?: (name: string, value: string | number) => void;
    end?: (chunk?: unknown) => void;
  };
  if (typeof response.writeHead === "function") {
    response.writeHead(200, headers);
  } else if (typeof response.setHeader === "function") {
    for (const [key, value] of Object.entries(headers)) {
      response.setHeader(key, value);
    }
  }
  response.end?.(method === "HEAD" ? undefined : body);
}

function parseAssetProxyPath(pathname: string): {
  endpointId: string;
  moduleId: string;
  assetPath: string;
} {
  const prefix = "/api/capability-router/assets/";
  const remainder = pathname.slice(prefix.length);
  const [encodedEndpointId, encodedModuleId, ...assetParts] =
    remainder.split("/");
  if (!encodedEndpointId || !encodedModuleId || assetParts.length === 0) {
    throw new Error(
      "Capability asset URL must include endpoint id, module id, and path.",
    );
  }
  const endpointId = decodeURIComponent(encodedEndpointId);
  const moduleId = decodeURIComponent(encodedModuleId);
  const assetSegments = assetParts.map((part) => decodeURIComponent(part));
  const hasUnsafeSegment = assetSegments.some(
    (part) => !part || part === "." || part === ".." || part.includes("\\"),
  );
  const assetPath = `/${assetSegments.join("/")}`;
  if (!endpointId.trim() || !moduleId.trim() || assetPath === "/") {
    throw new Error(
      "Capability asset URL must include endpoint id, module id, and path.",
    );
  }
  if (hasUnsafeSegment) {
    throw new Error("Capability asset URL path is not valid.");
  }
  return { endpointId, moduleId, assetPath };
}

function getRuntimeCapabilityRouter(
  runtime: IAgentRuntime,
): ElizaCapabilityRouter {
  const router = runtime.getService?.(
    CAPABILITY_ROUTER_SERVICE_TYPE,
  ) as unknown as ElizaCapabilityRouter | null;
  if (!router) {
    throw new Error("Capability router service is not available.");
  }
  return router;
}

type CapabilityRouterPersistConfig = {
  env?: {
    vars?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function persistEndpoint(
  ctx: Pick<
    RemoteCapabilityRouteContext,
    "config" | "saveConfig" | "persistConfigEnv"
  >,
  endpoint: RemoteCapabilityEndpointConfig,
  allowedModuleIds?: string[],
  trustPolicy?: RemoteCapabilityEndpointTrustPolicyOptions,
  audit?: CapabilityRouterTrustAuditInput,
): Promise<void> {
  const config = ctx.config;
  const saveConfig = ctx.saveConfig;
  const persistConfigEnv = ctx.persistConfigEnv;
  if (!config || !saveConfig || !persistConfigEnv) {
    throw new Error(
      "Capability router endpoint persistence is unavailable in this runtime.",
    );
  }
  return persistEndpointInner(
    { config, saveConfig, persistConfigEnv },
    endpoint,
    allowedModuleIds,
    trustPolicy,
    audit,
  );
}

async function persistEndpointInner(
  ctx: {
    config: CapabilityRouterPersistConfig;
    saveConfig: (config: CapabilityRouterPersistConfig) => void;
    persistConfigEnv: (key: string, value: string) => Promise<void>;
  },
  endpoint: RemoteCapabilityEndpointConfig,
  allowedModuleIds?: string[],
  trustPolicy?: RemoteCapabilityEndpointTrustPolicyOptions,
  audit?: CapabilityRouterTrustAuditInput,
): Promise<void> {
  const env = ctx.config.env ?? {};
  const vars = { ...(env.vars ?? {}) };
  const endpoints = mergePersistedEndpoints(
    readPersistedEndpoints(
      process.env.ELIZA_CAPABILITY_ROUTER_URLS ??
        vars.ELIZA_CAPABILITY_ROUTER_URLS,
    ),
    endpoint,
  );
  const moduleAllowlists = mergePersistedModuleAllowlists(
    readPersistedModuleAllowlists(
      process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES ??
        vars.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES,
    ),
    endpoint.id,
    allowedModuleIds,
  );
  const persistedTrustPolicy = mergePersistedTrustPolicies(
    readPersistedTrustPolicies(
      process.env.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY ??
        vars.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY,
    ),
    endpoint.id,
    trustPolicy,
  );
  const sanitizedEndpoints = endpoints.map(
    ({ token: _token, ...item }) => item,
  );
  await ctx.persistConfigEnv("ELIZA_CAPABILITY_ROUTER_ENABLED", "true");
  await ctx.persistConfigEnv(
    "ELIZA_CAPABILITY_ROUTER_URLS",
    JSON.stringify(endpoints),
  );
  vars.ELIZA_CAPABILITY_ROUTER_ENABLED = "true";
  vars.ELIZA_CAPABILITY_ROUTER_URLS = JSON.stringify(sanitizedEndpoints);
  if (Object.keys(moduleAllowlists).length > 0) {
    vars.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES =
      JSON.stringify(moduleAllowlists);
  } else {
    delete vars.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
  }
  if (Object.keys(persistedTrustPolicy).length > 0) {
    await ctx.persistConfigEnv(
      "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY",
      JSON.stringify(persistedTrustPolicy),
    );
    vars.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY =
      JSON.stringify(persistedTrustPolicy);
  } else {
    delete vars.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY;
  }
  if (audit !== undefined) {
    vars.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT = JSON.stringify(
      appendTrustAuditRecord(
        readTrustAuditRecords(
          process.env.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT ??
            vars.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT,
        ),
        audit,
      ),
    );
  }
  ctx.config.env = {
    ...env,
    vars,
  };
  ctx.saveConfig(ctx.config);
}

type CapabilityRouterTrustAuditInput = {
  mode: string;
  provider: string;
  endpoint: RemoteCapabilityEndpointConfig;
  allowedModuleIds?: string[];
  sync: RemotePluginSyncResult;
};

type CapabilityRouterTrustAuditRecord = {
  recordedAt: string;
  mode: string;
  provider: string;
  endpoint: JsonObject;
  allowedModuleIds: string[];
  registered: string[];
  skipped: string[];
  unloaded: string[];
  trustDecisions: RemotePluginSyncResult["trustDecisions"];
};

function readTrustAuditRecords(
  value: string | undefined,
): CapabilityRouterTrustAuditRecord[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTrustAuditRecord);
  } catch {
    return [];
  }
}

function appendTrustAuditRecord(
  existing: CapabilityRouterTrustAuditRecord[],
  audit: CapabilityRouterTrustAuditInput,
): CapabilityRouterTrustAuditRecord[] {
  return [
    ...existing,
    {
      recordedAt: new Date().toISOString(),
      mode: audit.mode,
      provider: audit.provider,
      endpoint: redactEndpoint(audit.endpoint),
      allowedModuleIds: normalizeStringList(audit.allowedModuleIds ?? []),
      registered: audit.sync.registered.map((plugin) => plugin.name),
      skipped: [...audit.sync.skipped],
      unloaded: [...audit.sync.unloaded],
      trustDecisions: audit.sync.trustDecisions.map((decision) => ({
        ...decision,
      })),
    },
  ].slice(-50);
}

function isTrustAuditRecord(
  value: unknown,
): value is CapabilityRouterTrustAuditRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.recordedAt === "string" &&
    typeof record.mode === "string" &&
    typeof record.provider === "string" &&
    !!record.endpoint &&
    typeof record.endpoint === "object" &&
    Array.isArray(record.allowedModuleIds) &&
    Array.isArray(record.registered) &&
    Array.isArray(record.skipped) &&
    Array.isArray(record.unloaded) &&
    Array.isArray(record.trustDecisions)
  );
}

function readPersistedModuleAllowlists(
  value: string | undefined,
): Record<string, string[]> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string[]> = {};
    for (const [endpointId, moduleIds] of Object.entries(parsed)) {
      if (!endpointId.trim() || !Array.isArray(moduleIds)) continue;
      const normalized = normalizeStringList(moduleIds);
      if (normalized.length > 0) {
        result[endpointId.trim()] = normalized;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function mergePersistedModuleAllowlists(
  existing: Record<string, string[]>,
  endpointId: string,
  allowedModuleIds: string[] | undefined,
): Record<string, string[]> {
  const next = { ...existing };
  if (allowedModuleIds === undefined) {
    delete next[endpointId];
    return next;
  }
  const normalized = normalizeStringList(allowedModuleIds);
  if (normalized.length === 0) {
    delete next[endpointId];
  } else {
    next[endpointId] = normalized;
  }
  return next;
}

function readPersistedTrustPolicies(
  value: string | undefined,
): Record<string, RemoteCapabilityEndpointTrustPolicyOptions> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, RemoteCapabilityEndpointTrustPolicyOptions> =
      {};
    for (const [endpointId, candidate] of Object.entries(parsed)) {
      if (!endpointId.trim()) continue;
      const trustPolicy = parseOptionalEndpointTrustPolicy(
        candidate,
        `ELIZA_CAPABILITY_ROUTER_TRUST_POLICY.${endpointId}`,
      );
      if (trustPolicy && Object.keys(trustPolicy).length > 0) {
        result[endpointId.trim()] = trustPolicy;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function mergePersistedTrustPolicies(
  existing: Record<string, RemoteCapabilityEndpointTrustPolicyOptions>,
  endpointId: string,
  trustPolicy: RemoteCapabilityEndpointTrustPolicyOptions | undefined,
): Record<string, RemoteCapabilityEndpointTrustPolicyOptions> {
  const next = { ...existing };
  const normalized = normalizeEndpointTrustPolicyOptions(trustPolicy);
  if (Object.keys(normalized).length === 0) {
    delete next[endpointId];
  } else {
    next[endpointId] = normalized;
  }
  return next;
}

function readPersistedEndpoints(
  value: string | undefined,
): RemoteCapabilityEndpointConfig[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, index): RemoteCapabilityEndpointConfig | null => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return null;
        }
        const record = item as Record<string, unknown>;
        if (typeof record.baseUrl !== "string" || !record.baseUrl.trim()) {
          return null;
        }
        return {
          id:
            typeof record.id === "string" && record.id.trim()
              ? record.id.trim()
              : `remote-${index + 1}`,
          baseUrl: record.baseUrl.trim().replace(/\/+$/, ""),
          ...(typeof record.token === "string" && record.token.trim()
            ? { token: record.token.trim() }
            : {}),
        };
      })
      .filter(
        (endpoint): endpoint is RemoteCapabilityEndpointConfig =>
          endpoint !== null,
      );
  } catch {
    return [];
  }
}

function mergePersistedEndpoints(
  existing: RemoteCapabilityEndpointConfig[],
  next: RemoteCapabilityEndpointConfig,
): RemoteCapabilityEndpointConfig[] {
  const normalizedNext = {
    ...next,
    baseUrl: next.baseUrl.replace(/\/+$/, ""),
  };
  const byKey = new Map<string, RemoteCapabilityEndpointConfig>();
  for (const endpoint of existing) {
    const key = endpoint.id || endpoint.baseUrl;
    byKey.set(key, {
      ...endpoint,
      baseUrl: endpoint.baseUrl.replace(/\/+$/, ""),
    });
  }
  byKey.set(normalizedNext.id || normalizedNext.baseUrl, normalizedNext);
  return [...byKey.values()];
}

function parseDirectEndpoint(value: unknown): RemoteCapabilityEndpointConfig {
  const body = requireObject(value, "endpoint") as DirectEndpointBody;
  return {
    id: optionalNonEmptyString(body.id, "endpoint.id") ?? "default",
    baseUrl: requireHttpUrl(body.baseUrl, "endpoint.baseUrl"),
    ...optionalToken(body.token, "endpoint.token"),
  };
}

function parseEndpointProviderMode(value: unknown): EndpointProviderMode {
  if (value === undefined || value === null || value === "") return "direct";
  const provider = requireNonEmptyString(value, "provider");
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
    `provider must be one of direct, e2b, home-machine, mobile-companion, or desktop-companion.`,
  );
}

function getEndpointProvider(
  providerMode: EndpointProviderMode,
): RemoteCapabilityEndpointProvider<EndpointProviderOptions> {
  switch (providerMode) {
    case "direct":
      return directRemoteCapabilityEndpointProvider() as RemoteCapabilityEndpointProvider<EndpointProviderOptions>;
    case "e2b":
      return e2bCapabilityEndpointProvider as RemoteCapabilityEndpointProvider<EndpointProviderOptions>;
    case "home-machine":
      return homeMachineCapabilityEndpointProvider as RemoteCapabilityEndpointProvider<EndpointProviderOptions>;
    case "mobile-companion":
      return mobileCompanionCapabilityEndpointProvider as RemoteCapabilityEndpointProvider<EndpointProviderOptions>;
    case "desktop-companion":
      return desktopCompanionCapabilityEndpointProvider as RemoteCapabilityEndpointProvider<EndpointProviderOptions>;
  }
}

function buildEndpointProvisionOptions(
  providerMode: EndpointProviderMode,
  endpoint: RemoteCapabilityEndpointConfig,
  allowedModuleIds: string[] | undefined,
): EndpointProviderOptions {
  if (providerMode === "direct") {
    return {
      endpoint,
      ...(allowedModuleIds === undefined ? {} : { allowedModuleIds }),
    };
  }
  return {
    baseUrl: endpoint.baseUrl,
    endpointId: endpoint.id,
    ...(endpoint.token === undefined ? {} : { token: endpoint.token }),
    ...(allowedModuleIds === undefined ? {} : { allowedModuleIds }),
  };
}

function parseCloudOptions(
  value: unknown,
): Omit<
  ConnectCloudCapabilitySandboxOptions,
  "unloadMissing" | "requestTimeoutMs" | "fetch" | "onProgress"
> {
  const body = requireObject(value, "cloud") as CloudBody;
  const bio = parseOptionalStringArray(body.bio, "cloud.bio");
  const allowedModuleIds = parseOptionalStringArray(
    body.allowedModuleIds,
    "cloud.allowedModuleIds",
  );
  const endpointId = optionalNonEmptyString(
    body.endpointId,
    "cloud.endpointId",
  );
  const timeoutMs = optionalPositiveInteger(body.timeoutMs, "cloud.timeoutMs");
  if (timeoutMs instanceof Error) throw timeoutMs;
  const pollIntervalMs = optionalPositiveInteger(
    body.pollIntervalMs,
    "cloud.pollIntervalMs",
  );
  if (pollIntervalMs instanceof Error) throw pollIntervalMs;

  return {
    cloudApiBase: requireHttpUrl(body.cloudApiBase, "cloud.cloudApiBase"),
    authToken: requireNonEmptyString(body.authToken, "cloud.authToken"),
    name: requireNonEmptyString(body.name, "cloud.name"),
    ...(bio === undefined ? {} : { bio }),
    ...(endpointId === undefined ? {} : { endpointId }),
    ...optionalToken(body.token, "cloud.token"),
    ...(allowedModuleIds === undefined ? {} : { allowedModuleIds }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  };
}

function serializeSyncResult(sync: RemotePluginSyncResult): JsonObject {
  return {
    registered: sync.registered.map((plugin) => plugin.name),
    unloaded: sync.unloaded,
    skipped: sync.skipped,
    trustDecisions: sync.trustDecisions,
  };
}

function redactEndpoint(endpoint: RemoteCapabilityEndpointConfig): JsonObject {
  return {
    id: endpoint.id,
    baseUrl: endpoint.baseUrl,
    hasToken: typeof endpoint.token === "string" && endpoint.token.length > 0,
  };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field);
}

function requireHttpUrl(value: unknown, field: string): string {
  const text = requireNonEmptyString(value, field).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} must use http or https.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${field} must not include embedded credentials.`);
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function optionalToken(value: unknown, field: string): { token?: string } {
  const token = optionalNonEmptyString(value, field);
  return token === undefined ? {} : { token };
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
): number | undefined | Error {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function parseOptionalStringArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return normalizeStringList(value);
}

function parseOptionalEndpointTrustPolicy(
  value: unknown,
  field: string,
): RemoteCapabilityEndpointTrustPolicyOptions | undefined {
  if (value === undefined) return undefined;
  const body = requireObject(value, field);
  const allowedProvenanceIssuers = parseOptionalStringArray(
    body.allowedProvenanceIssuers,
    `${field}.allowedProvenanceIssuers`,
  );
  const trustedProvenancePublicKeys = parseOptionalStringRecord(
    body.trustedProvenancePublicKeys,
    `${field}.trustedProvenancePublicKeys`,
  );
  const trustPolicy = normalizeEndpointTrustPolicyOptions({
    ...(allowedProvenanceIssuers === undefined
      ? {}
      : { allowedProvenanceIssuers }),
    ...(trustedProvenancePublicKeys === undefined
      ? {}
      : { trustedProvenancePublicKeys }),
    ...optionalBooleanField(
      body.requireSignedProvenance,
      `${field}.requireSignedProvenance`,
      "requireSignedProvenance",
    ),
    ...optionalBooleanField(
      body.requireVerifiedProvenance,
      `${field}.requireVerifiedProvenance`,
      "requireVerifiedProvenance",
    ),
    ...optionalBooleanField(
      body.requireProvenanceDigestMatch,
      `${field}.requireProvenanceDigestMatch`,
      "requireProvenanceDigestMatch",
    ),
  });
  return Object.keys(trustPolicy).length === 0 ? undefined : trustPolicy;
}

function optionalBooleanField<TKey extends keyof RemotePluginTrustPolicy>(
  value: unknown,
  field: string,
  key: TKey,
): Partial<Pick<RemotePluginTrustPolicy, TKey>> {
  if (value === undefined) return {};
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value
    ? ({ [key]: true } as Partial<Pick<RemotePluginTrustPolicy, TKey>>)
    : {};
}

function parseOptionalStringRecord(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const body = requireObject(value, field);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(body)) {
    if (typeof entry !== "string") {
      throw new Error(`${field}.${key} must be a string.`);
    }
    const normalizedKey = key.trim();
    const normalizedValue = entry.trim();
    if (normalizedKey && normalizedValue) {
      result[normalizedKey] = normalizedValue;
    }
  }
  return result;
}

function normalizeStringList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
