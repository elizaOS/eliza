/**
 * X relay route.
 *
 * Proxies local LifeOps X calls through Eliza Cloud so the desktop app can
 * stay credential-light while Cloud handles billing and provider access.
 *
 * The relay is intentionally thin: auth + proxy + 402 preservation only.
 *
 * Registered on the Eliza Cloud plugin route surface (see plugin.ts) alongside
 * the billing and relay-status handlers. The request body is read through the
 * shared cache-aware `readRequestBody` helper so the raw payload survives the
 * runtime plugin route system's JSON body pre-parse (`attachJsonBodyIfPresent`).
 */

import type http from "node:http";
import {
  type IAgentRuntime,
  type Service,
  readRequestBody,
  sendJson,
  sendJsonError,
} from "@elizaos/core";
import {
  isCloudAuthApiKeyService,
  normalizeCloudApiKey,
} from "../cloud/auth-service-types.js";
import { normalizeCloudSiteUrl } from "../cloud/base-url.js";
import { resolveCloudApiKey } from "../cloud/cloud-api-key.js";
import { validateCloudBaseUrl } from "../cloud/validate-url.js";
import type { CloudProxyConfigLike } from "../lib/config-like";

export interface XRelayRouteState {
  config: CloudProxyConfigLike;
  runtime?: IAgentRuntime | null;
}

const PROXY_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_048_576;
const X_RELAY_PATH_RE = /^\/api\/cloud\/x(\/.*)$/;

function resolveProxyApiKey(state: XRelayRouteState): string | null {
  const cloudAuth = state.runtime?.getService<Service>("CLOUD_AUTH");
  const runtimeApiKey =
    isCloudAuthApiKeyService(cloudAuth) && cloudAuth.isAuthenticated() === true
      ? normalizeCloudApiKey(cloudAuth.getApiKey?.())
      : null;
  return runtimeApiKey ?? resolveCloudApiKey(state.config, state.runtime);
}

function buildAuthHeaders(
  config: CloudProxyConfigLike,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const serviceKey = config.cloud?.serviceKey?.trim();
  if (serviceKey) {
    headers["X-Service-Key"] = serviceKey;
  }
  return headers;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  return response.json().catch(async () => ({
    success: response.ok,
    error: await response.text().catch(() => "X relay request failed"),
  }));
}

function buildUpstreamPath(pathname: string): string {
  const match = X_RELAY_PATH_RE.exec(pathname);
  if (!match) {
    throw new Error("Invalid X relay path");
  }
  return `/api/v1/x${match[1] ?? ""}`;
}

export async function handleXRelayRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: XRelayRouteState,
): Promise<boolean> {
  if (!pathname.startsWith("/api/cloud/x/")) {
    return false;
  }

  if (method !== "GET" && method !== "POST") {
    sendJsonError(res, "Unsupported X relay method", 405);
    return true;
  }

  const apiKey = resolveProxyApiKey(state);
  if (!apiKey) {
    sendJsonError(
      res,
      "Not connected to Eliza Cloud. Sign in to use X relays.",
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

  let body: string | undefined;
  if (method === "POST") {
    let rawBody: string | null;
    try {
      rawBody = await readRequestBody(req, { maxBytes: MAX_BODY_BYTES });
    } catch (error) {
      sendJsonError(
        res,
        error instanceof Error ? error.message : "Failed to read body",
        413,
      );
      return true;
    }
    body = rawBody && rawBody.length > 0 ? rawBody : undefined;
  }

  const fullUrl = new URL(req.url ?? pathname, "http://localhost");
  const upstreamUrl = `${baseUrl}${buildUpstreamPath(pathname)}${fullUrl.search}`;
  const upstreamResponse = await fetch(upstreamUrl, {
    method,
    headers: buildAuthHeaders(state.config, apiKey),
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  });

  if (upstreamResponse.status === 402) {
    const wwwAuth = upstreamResponse.headers.get("www-authenticate");
    const contentType = upstreamResponse.headers.get("content-type");
    const bodyText = await upstreamResponse.text().catch(() => "");
    if (wwwAuth) {
      res.setHeader("WWW-Authenticate", wwwAuth);
    }
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }
    res.statusCode = 402;
    res.end(bodyText);
    return true;
  }

  const payload = await readJsonResponse(upstreamResponse);
  sendJson(res, payload, upstreamResponse.status);
  return true;
}
