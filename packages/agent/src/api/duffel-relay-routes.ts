/**
 * Duffel travel API relay — proxies the local agent's Duffel calls through
 * Eliza Cloud so the upstream Duffel API key is never bundled with the
 * desktop install and so each call is metered against the user's Cloud
 * credit balance with a creator markup.
 *
 * Pattern mirrors `cloud-billing-routes.ts` (commandment 4 — BFF is
 * auth + proxy + usage write, nothing else):
 *
 *   1. Resolve the user's Eliza Cloud API key (runtime CLOUD_AUTH service
 *      first, then saved config).
 *   2. Forward the request to `${cloudBaseUrl}/api/v1/duffel/...` with
 *      `Authorization: Bearer <apiKey>` + `X-Service-Key`.
 *   3. The Cloud-side use case performs the upstream Duffel call, writes
 *      a `usage_event`, deducts cost + creator markup from the user's
 *      credit balance, and returns the Duffel payload plus a typed
 *      `_meta.cost` envelope.
 *   4. The relay forwards the response unchanged. No business logic
 *      executes locally (commandment 2).
 *
 * Routes:
 *   POST /api/cloud/duffel/offer-requests   -> /api/v1/duffel/offer-requests
 *   GET  /api/cloud/duffel/offers/:id       -> /api/v1/duffel/offers/:id
 *   POST /api/cloud/duffel/orders           -> /api/v1/duffel/orders
 *   GET  /api/cloud/duffel/orders/:id       -> /api/v1/duffel/orders/:id
 *   POST /api/cloud/duffel/payments         -> /api/v1/duffel/payments
 */

import type http from "node:http";
import type { AgentRuntime, Service } from "@elizaos/core";
import { normalizeCloudSiteUrl } from "../cloud/base-url.js";
import { validateCloudBaseUrl } from "../cloud/validate-url.js";
import type { CloudProxyConfigLike } from "../types/config-like.js";
import { sendJson, sendJsonError } from "./http-helpers.js";
import { resolveCloudApiKey } from "./wallet-rpc.js";

export interface DuffelRelayRouteState {
  config: CloudProxyConfigLike;
  runtime?: AgentRuntime | null;
}

const PROXY_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_048_576;

interface CloudAuthApiKeyService {
  isAuthenticated: () => boolean;
  getApiKey?: () => string | undefined;
}

function normalizeCloudApiKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "[REDACTED]") {
    return null;
  }
  return trimmed;
}

function resolveProxyApiKey(state: DuffelRelayRouteState): string | null {
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
    error: await response.text().catch(() => "Duffel relay request failed"),
  }));
}

function buildUpstreamPath(localPath: string): string {
  return localPath.replace("/api/cloud/duffel", "/api/v1/duffel");
}

const DUFFEL_RELAY_ROUTES: ReadonlyArray<{
  method: "GET" | "POST";
  pattern: RegExp;
}> = [
  { method: "POST", pattern: /^\/api\/cloud\/duffel\/offer-requests$/ },
  { method: "GET", pattern: /^\/api\/cloud\/duffel\/offers\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/cloud\/duffel\/orders$/ },
  { method: "GET", pattern: /^\/api\/cloud\/duffel\/orders\/[^/]+$/ },
  { method: "POST", pattern: /^\/api\/cloud\/duffel\/payments$/ },
];

function matchRoute(method: string, pathname: string): boolean {
  return DUFFEL_RELAY_ROUTES.some(
    (route) => route.method === method && route.pattern.test(pathname),
  );
}

export async function handleDuffelRelayRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: DuffelRelayRouteState,
): Promise<boolean> {
  if (!pathname.startsWith("/api/cloud/duffel/")) return false;

  if (!matchRoute(method, pathname)) {
    sendJsonError(res, "Unknown duffel relay route", 404);
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

  const payload = await readJsonResponse(upstreamResponse);
  sendJson(res, payload, upstreamResponse.status);
  return true;
}
