import type http from "node:http";
import type {
  IAgentRuntime,
  JsonObject,
  RouteHelpers,
  RouteRequestMeta,
} from "@elizaos/core";
import {
  type ConnectCloudCapabilitySandboxOptions,
  type ConnectCloudCapabilitySandboxResult,
  connectCloudCapabilitySandbox,
  installRemoteCapabilityEndpoint,
} from "../services/remote-capability-cloud-sandbox.ts";
import type {
  RemoteCapabilityEndpointConfig,
  RemoteCapabilityRouterConfig,
} from "../services/remote-capability-router.ts";
import {
  type RemotePluginSyncResult,
  syncRemoteCapabilityPlugins,
} from "../services/remote-plugin-adapter.ts";

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
  installEndpoint?: (
    runtime: IAgentRuntime,
    config: RemoteCapabilityRouterConfig,
  ) => unknown;
  syncPlugins?: (
    runtime: IAgentRuntime,
    options: { unloadMissing?: boolean },
  ) => Promise<RemotePluginSyncResult>;
  connectCloudSandbox?: (
    runtime: IAgentRuntime,
    options: ConnectCloudCapabilitySandboxOptions,
  ) => Promise<ConnectCloudCapabilitySandboxResult>;
}

type ConnectBody = {
  endpoint?: unknown;
  cloud?: unknown;
  unloadMissing?: unknown;
  persist?: unknown;
  requestTimeoutMs?: unknown;
};

type DirectEndpointBody = {
  id?: unknown;
  baseUrl?: unknown;
  token?: unknown;
};

type CloudBody = {
  cloudApiBase?: unknown;
  authToken?: unknown;
  name?: unknown;
  bio?: unknown;
  endpointId?: unknown;
  token?: unknown;
  timeoutMs?: unknown;
  pollIntervalMs?: unknown;
};

export async function handleRemoteCapabilityRoutes(
  ctx: RemoteCapabilityRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, runtime, readJsonBody, json, error } =
    ctx;

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

  const unloadMissing =
    typeof body.unloadMissing === "boolean" ? body.unloadMissing : true;
  const persist = typeof body.persist === "boolean" ? body.persist : true;
  const requestTimeoutMs = optionalPositiveInteger(
    body.requestTimeoutMs,
    "requestTimeoutMs",
  );
  if (requestTimeoutMs instanceof Error) {
    error(res, requestTimeoutMs.message, 400);
    return true;
  }

  try {
    if (body.endpoint !== undefined) {
      const endpoint = parseDirectEndpoint(body.endpoint);
      const installEndpoint =
        ctx.installEndpoint ?? installRemoteCapabilityEndpoint;
      installEndpoint(runtime, {
        enabled: true,
        endpoints: [endpoint],
        environment: "server",
        requestTimeoutMs: requestTimeoutMs ?? 60_000,
      });
      const sync = await (ctx.syncPlugins ?? syncRemoteCapabilityPlugins)(
        runtime,
        { unloadMissing },
      );
      if (persist) {
        await persistEndpoint(ctx, endpoint);
      }
      json(res, {
        success: true,
        mode: "endpoint",
        endpoint: redactEndpoint(endpoint),
        persisted: persist,
        sync: serializeSyncResult(sync),
      });
      return true;
    }

    if (body.cloud !== undefined) {
      const cloud = parseCloudOptions(body.cloud);
      const connectCloudSandbox =
        ctx.connectCloudSandbox ?? connectCloudCapabilitySandbox;
      const result = await connectCloudSandbox(runtime, {
        ...cloud,
        unloadMissing,
        requestTimeoutMs: requestTimeoutMs ?? 60_000,
      });
      if (persist) {
        await persistEndpoint(ctx, result.endpoint);
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
  );
}

async function persistEndpointInner(
  ctx: {
    config: CapabilityRouterPersistConfig;
    saveConfig: (config: CapabilityRouterPersistConfig) => void;
    persistConfigEnv: (key: string, value: string) => Promise<void>;
  },
  endpoint: RemoteCapabilityEndpointConfig,
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
  ctx.config.env = {
    ...env,
    vars,
  };
  ctx.saveConfig(ctx.config);
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

function parseCloudOptions(
  value: unknown,
): Omit<
  ConnectCloudCapabilitySandboxOptions,
  "unloadMissing" | "requestTimeoutMs" | "fetch" | "onProgress"
> {
  const body = requireObject(value, "cloud") as CloudBody;
  const bio = parseOptionalStringArray(body.bio, "cloud.bio");
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
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  };
}

function serializeSyncResult(sync: RemotePluginSyncResult): JsonObject {
  return {
    registered: sync.registered.map((plugin) => plugin.name),
    unloaded: sync.unloaded,
    skipped: sync.skipped,
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
  return value;
}
