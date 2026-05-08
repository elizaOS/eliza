/**
 * X relay route.
 *
 * Proxies local LifeOps X calls through Eliza Cloud so the desktop app can
 * stay credential-light while Cloud handles billing and provider access.
 *
 * The relay is intentionally thin: auth + proxy + 402 preservation only.
 */

import type http from "node:http";
import type { Service } from "@elizaos/core";
import { normalizeCloudSiteUrl } from "@elizaos/plugin-elizacloud/cloud/base-url";
import { resolveCloudApiKey } from "@elizaos/plugin-elizacloud/cloud/cloud-api-key";
import { validateCloudBaseUrl } from "@elizaos/plugin-elizacloud/cloud/validate-url";
import type { ElizaConfig } from "../config/config.js";
import type { CloudProxyConfigLike } from "../types/config-like.js";
import { sendJson, sendJsonError } from "./http-helpers.js";

interface XRelayRuntime {
  getService(serviceType: string): Service | null;
  getSetting?: (key: string) => unknown;
  character?: {
    secrets?: Record<string, unknown>;
  } | null;
  cloud?: ElizaConfig["cloud"];
}

export interface XRelayRouteState {
  config: CloudProxyConfigLike;
  runtime?: XRelayRuntime | null;
}

const PROXY_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_048_576;
const X_RELAY_PATH_RE = /^\/api\/cloud\/x(\/.*)$/;

interface CloudAuthApiKeyService {
  isAuthenticated: () => boolean;
  getApiKey?: () => string | undefined;
}

function isCloudAuthApiKeyService(
  value: Service | null,
): value is Service & CloudAuthApiKeyService {
  return (
    value !== null &&
    typeof (value as Partial<CloudAuthApiKeyService>).isAuthenticated ===
      "function"
  );
}

function normalizeCloudApiKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "[REDACTED]") {
    return null;
  }
  return trimmed;
}

function resolveProxyApiKey(state: XRelayRouteState): string | null {
  const cloudAuth = state.runtime
    ? state.runtime.getService("CLOUD_AUTH")
    : null;
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
    try {
      body = await readBody(req);
    } catch (error) {
      sendJsonError(
        res,
        error instanceof Error ? error.message : "Failed to read body",
        413,
      );
      return true;
    }
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
