import type http from "node:http";
import type { IAgentRuntime, Service } from "@elizaos/core";
import { normalizeCloudSiteUrl } from "@elizaos/plugin-elizacloud/cloud/base-url";
import { resolveCloudApiKey } from "@elizaos/plugin-elizacloud/cloud/cloud-api-key";
import { validateCloudBaseUrl } from "@elizaos/plugin-elizacloud/cloud/validate-url";
import type { CloudProxyConfigLike } from "../types/config-like.js";
import { sendJson, sendJsonError } from "@elizaos/shared";

export interface TravelProviderRelayRouteState {
  config: CloudProxyConfigLike;
  runtime?: IAgentRuntime | null;
}

const PROXY_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_048_576;
const TRAVEL_PROVIDER_PATH_RE =
  /^\/api\/cloud\/travel-providers\/([a-z0-9][a-z0-9-]*)(\/.*)$/;

interface CloudAuthApiKeyService {
  isAuthenticated: () => boolean;
  getApiKey?: () => string | undefined;
}

function normalizeCloudApiKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "[REDACTED]") return null;
  return trimmed;
}

function resolveProxyApiKey(
  state: TravelProviderRelayRouteState,
): string | null {
  const cloudAuth = state.runtime
    ? state.runtime.getService<Service & CloudAuthApiKeyService>("CLOUD_AUTH")
    : null;
  const runtimeApiKey =
    cloudAuth?.isAuthenticated() === true
      ? normalizeCloudApiKey(cloudAuth.getApiKey?.())
      : null;
  return runtimeApiKey ?? resolveCloudApiKey(state.config, state.runtime);
}

function buildAuthHeaders(
  config: CloudProxyConfigLike,
  apiKey: string,
): Record<string, string> {
  const serviceKey = config.cloud?.serviceKey?.trim();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (serviceKey) headers["X-Service-Key"] = serviceKey;
  return headers;
}

function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(
        chunks.length > 0 ? Buffer.concat(chunks).toString("utf-8") : undefined,
      ),
    );
    req.on("error", reject);
  });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  return response.json().catch(async () => ({
    success: response.ok,
    error: await response
      .text()
      .catch(() => "Travel-provider relay request failed"),
  }));
}

function parseTravelProviderPath(
  pathname: string,
): { provider: string; providerPath: string } | null {
  const match = TRAVEL_PROVIDER_PATH_RE.exec(pathname);
  if (!match) return null;
  const [, provider, providerPath] = match;
  return provider ? { provider, providerPath } : null;
}

function buildUpstreamPath(localPath: string): string {
  const parsed = parseTravelProviderPath(localPath);
  if (!parsed) {
    throw new Error("Invalid travel-provider relay path");
  }
  return `/api/v1/${parsed.provider}${parsed.providerPath}`;
}

const TRAVEL_PROVIDER_RELAY_ROUTES: ReadonlyArray<{
  method: "GET" | "POST";
  pattern: RegExp;
}> = [
  { method: "POST", pattern: /^\/offer-requests$/ },
  { method: "GET", pattern: /^\/offers\/[^/]+$/ },
  { method: "POST", pattern: /^\/orders$/ },
  { method: "GET", pattern: /^\/orders\/[^/]+$/ },
  { method: "POST", pattern: /^\/payments$/ },
];

function matchRoute(method: string, pathname: string): boolean {
  const parsed = parseTravelProviderPath(pathname);
  if (!parsed) return false;
  return TRAVEL_PROVIDER_RELAY_ROUTES.some(
    (route) =>
      route.method === method && route.pattern.test(parsed.providerPath),
  );
}

async function forward402(
  res: http.ServerResponse,
  upstream: Response,
): Promise<void> {
  const wwwAuth = upstream.headers.get("www-authenticate");
  const contentType =
    upstream.headers.get("content-type") ?? "application/json";
  const bodyText = await upstream.text();
  res.statusCode = 402;
  res.setHeader("Content-Type", contentType);
  if (wwwAuth) res.setHeader("WWW-Authenticate", wwwAuth);
  res.end(bodyText);
}

export async function handleTravelProviderRelayRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: TravelProviderRelayRouteState,
): Promise<boolean> {
  const parsed = parseTravelProviderPath(pathname);
  if (!parsed) return false;

  if (!matchRoute(method, pathname)) {
    sendJsonError(res, "Unknown travel-provider relay route", 404);
    return true;
  }

  const apiKey = resolveProxyApiKey(state);
  if (!apiKey) {
    sendJsonError(
      res,
      "Not connected to Eliza Cloud. Sign in to use travel search.",
      401,
    );
    return true;
  }

  const baseUrl = normalizeCloudSiteUrl(state.config.cloud?.baseUrl);
  const urlError = await validateCloudBaseUrl(baseUrl);
  if (urlError) {
    sendJsonError(res, urlError, 502);
    return true;
  }

  const headers = buildAuthHeaders(state.config, apiKey);
  let body: string | undefined;
  if (method === "POST") {
    try {
      body = await readBody(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to read body";
      sendJsonError(res, msg, 413);
      return true;
    }
  }

  const fullUrl = new URL(req.url ?? pathname, "http://localhost");
  const upstreamUrl = `${baseUrl}${buildUpstreamPath(pathname)}${fullUrl.search}`;
  const upstreamResponse = await fetch(upstreamUrl, {
    method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  });

  if (upstreamResponse.status === 402) {
    await forward402(res, upstreamResponse);
    return true;
  }

  const payload = await readJsonResponse(upstreamResponse);
  sendJson(res, payload, upstreamResponse.status);
  return true;
}
