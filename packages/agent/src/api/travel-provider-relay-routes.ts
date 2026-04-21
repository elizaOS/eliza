/**
 * Travel-provider API relay — proxies the local app's provider-specific
 * travel calls through Eliza Cloud so upstream provider credentials are
 * never bundled with the desktop install and so each call can be metered
 * against the user's Cloud credit balance.
 *
 * Pattern mirrors `cloud-billing-routes.ts` (commandment 4 — BFF is
 * auth + proxy + usage write, nothing else):
 *
 *   1. Resolve the user's Eliza Cloud API key (runtime CLOUD_AUTH service
 *      first, then saved config).
 *   2. Forward the request to `${cloudBaseUrl}/api/v1/<provider>/...` with
 *      `Authorization: Bearer <apiKey>` + `X-Service-Key`.
 *   3. The Cloud-side use case performs the upstream provider call, writes
 *      a `usage_event`, deducts cost + creator markup from the user's
 *      credit balance, and returns the provider payload plus a typed
 *      `_meta.cost` envelope.
 *   4. The relay forwards the response unchanged. No business logic
 *      executes locally (commandment 2).
 *
 * x402 / HTTP 402 handling:
 *   The Cloud billing layer emits HTTP 402 with a `WWW-Authenticate:
 *   x402 ...` header (and a JSON body containing `paymentRequirements`)
 *   when the user's credit balance can't cover a metered call — see
 *   https://www.x402.org. This relay forwards 402 responses verbatim:
 *   status code, the `WWW-Authenticate` header, and the raw body. That
 *   lets the local travel adapter parse the payment requirements via
 *   `parseX402Response` and surface them to the user. We do not collapse
 *   the body to JSON in the 402 path because the spec allows
 *   non-JSON-typed payloads.
 *
 * Routes:
 *   POST /api/cloud/travel-providers/:provider/offer-requests
 *      → /api/v1/:provider/offer-requests
 *   GET  /api/cloud/travel-providers/:provider/offers/:id
 *      → /api/v1/:provider/offers/:id
 *   POST /api/cloud/travel-providers/:provider/orders
 *      → /api/v1/:provider/orders
 *   GET  /api/cloud/travel-providers/:provider/orders/:id
 *      → /api/v1/:provider/orders/:id
 *   POST /api/cloud/travel-providers/:provider/payments
 *      → /api/v1/:provider/payments
 */

import type http from "node:http";
import type { Service } from "@elizaos/core";
import { normalizeCloudSiteUrl } from "../cloud/base-url.js";
import { validateCloudBaseUrl } from "../cloud/validate-url.js";
import type { CloudProxyConfigLike } from "../types/config-like.js";
import { sendJson, sendJsonError } from "./http-helpers.js";
import { resolveCloudApiKey } from "./wallet-rpc.js";

interface TravelProviderRelayRuntime {
  getService<TService = unknown>(serviceType: string): TService | null;
}

export interface TravelProviderRelayRouteState {
  config: CloudProxyConfigLike;
  runtime?: TravelProviderRelayRuntime | null;
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
  if (!trimmed || trimmed.toUpperCase() === "[REDACTED]") {
    return null;
  }
  return trimmed;
}

function resolveProxyApiKey(state: TravelProviderRelayRouteState): string | null {
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
    error: await response
      .text()
      .catch(() => "Travel-provider relay request failed"),
  }));
}

/**
 * Map local relay path to upstream Cloud path. The upstream owns markup,
 * billing, and the actual provider call.
 */
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

function parseTravelProviderPath(
  pathname: string,
): { provider: string; providerPath: string } | null {
  const match = TRAVEL_PROVIDER_PATH_RE.exec(pathname);
  if (!match) {
    return null;
  }
  const [, provider, providerPath] = match;
  return provider ? { provider, providerPath } : null;
}

function matchRoute(method: string, pathname: string): boolean {
  const parsed = parseTravelProviderPath(pathname);
  if (!parsed) {
    return false;
  }
  return TRAVEL_PROVIDER_RELAY_ROUTES.some(
    (route) => route.method === method && route.pattern.test(parsed.providerPath),
  );
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

/**
 * Forward a Cloud-side 402 verbatim. We preserve `WWW-Authenticate`
 * (the x402 header form) and `Content-Type` so the local travel adapter's
 * `parseX402Response` can read whichever envelope the Cloud
 * billing layer chose to emit. The body is streamed as raw text — we
 * intentionally do NOT re-encode through `sendJson`.
 */
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
  if (wwwAuth) {
    res.setHeader("WWW-Authenticate", wwwAuth);
  }
  res.end(bodyText);
}
