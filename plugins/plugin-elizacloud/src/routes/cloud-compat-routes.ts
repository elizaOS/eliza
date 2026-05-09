import type http from "node:http";
import type { AgentRuntime, Service } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { normalizeCloudSiteUrl } from "../cloud/base-url.js";
import { resolveCloudApiKey } from "../cloud/cloud-api-key.js";
import { validateCloudBaseUrl } from "../cloud/validate-url.js";
import type { CloudProxyConfigLike } from "../lib/config-like";
import { sendJson, sendJsonError } from "../lib/http";

export interface CloudCompatRouteState {
  config: CloudProxyConfigLike;
  runtime?: AgentRuntime | null;
}

const PROXY_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576;
const JSON_CONTENT_TYPE_RE = /\b(?:application\/json|[^;\s]+\+json)\b/i;

interface CloudAuthApiKeyService {
  isAuthenticated: () => boolean;
  getApiKey?: () => string | undefined;
}

export function resolveCloudBaseUrl(config: CloudProxyConfigLike): string {
  return normalizeCloudSiteUrl(config.cloud?.baseUrl);
}

function normalizeCloudApiKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "[REDACTED]") {
    return null;
  }
  return trimmed;
}

function resolveProxyApiKey(state: CloudCompatRouteState): string | null {
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
  apiKeyOverride?: string | null,
): Record<string, string> {
  const serviceKey = config.cloud?.serviceKey?.trim();
  const apiKey =
    normalizeCloudApiKey(apiKeyOverride) ?? resolveCloudApiKey(config);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (serviceKey) {
    headers["X-Service-Key"] = serviceKey;
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
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

async function fetchUpstream(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  });

  if (res.status >= 300 && res.status < 400) {
    throw Object.assign(new Error("redirect"), { code: "REDIRECT" });
  }

  return res;
}

function summarizeUpstreamBody(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return "";
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
}

function isResourceCompatPath(pathname: string): boolean {
  return pathname.split("/").filter(Boolean).length >= 5;
}

function sendUpstreamNotFound(
  res: http.ServerResponse,
  pathname: string,
  upstreamBody?: unknown,
): void {
  if (isResourceCompatPath(pathname)) {
    sendJson(
      res,
      upstreamBody ?? {
        success: false,
        error: "Eliza Cloud returned 404 for this API route.",
        code: "CLOUD_ROUTE_NOT_FOUND",
      },
      404,
    );
    return;
  }

  sendJson(
    res,
    {
      success: false,
      error: "This Cloud feature is not available yet.",
      code: "CLOUD_NOT_READY",
    },
    404,
  );
}

async function parseUpstreamJsonResponse(
  upstreamRes: Response,
  method: string,
): Promise<
  | { kind: "head" }
  | { kind: "empty" }
  | { kind: "json"; body: unknown }
  | { kind: "invalid-json"; bodyText: string }
  | { kind: "non-json"; bodyText: string }
> {
  if (method === "HEAD") {
    return { kind: "head" };
  }

  const bodyText = await upstreamRes.text();
  if (bodyText.trim().length === 0) {
    return { kind: "empty" };
  }

  const contentType = upstreamRes.headers.get("content-type");
  const expectsJson = JSON_CONTENT_TYPE_RE.test(contentType ?? "");

  if (!expectsJson && !/^\s*[[{]/.test(bodyText)) {
    return { kind: "non-json", bodyText };
  }

  try {
    return { kind: "json", body: JSON.parse(bodyText) };
  } catch {
    return expectsJson
      ? { kind: "invalid-json", bodyText }
      : { kind: "non-json", bodyText };
  }
}

function handleUpstreamError(error: unknown, res: http.ServerResponse): void {
  if (error instanceof Error) {
    const errorCode = (error as { code?: string }).code;
    if (errorCode === "REDIRECT") {
      sendJsonError(res, "Eliza Cloud returned an unexpected redirect.", 502);
      return;
    }
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      sendJsonError(res, "Eliza Cloud request timed out.", 504);
      return;
    }
    if (error.message === "Request body too large") {
      sendJsonError(res, error.message, 413);
      return;
    }
    sendJsonError(
      res,
      `Failed to reach Eliza Cloud: ${error.message || "Unknown error"}`,
      502,
    );
    return;
  }

  sendJsonError(res, "Failed to reach Eliza Cloud.", 502);
}

/** Paths under /api/cloud/v1/ are forwarded directly as /api/v1/ on the cloud backend. */
const CLOUD_V1_PREFIX = "/api/cloud/v1/";

export async function handleCloudCompatRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: CloudCompatRouteState,
): Promise<boolean> {
  const isCompatRoute = pathname.startsWith("/api/cloud/compat/");
  const isV1Route = pathname.startsWith(CLOUD_V1_PREFIX);
  if (!isCompatRoute && !isV1Route) return false;

  const apiKey = resolveProxyApiKey(state);
  if (!apiKey) {
    sendJsonError(
      res,
      "Not connected to Eliza Cloud. Please log in first.",
      401,
    );
    return true;
  }

  const baseUrl = resolveCloudBaseUrl(state.config);
  const urlError = await validateCloudBaseUrl(baseUrl);
  if (urlError) {
    sendJsonError(res, urlError, 502);
    return true;
  }

  // /api/cloud/compat/* → /api/compat/*  (existing mapping)
  // /api/cloud/v1/*    → /api/v1/*       (eliza v1 endpoints, e.g. pairing-token)
  const compatPath = isV1Route
    ? pathname.slice("/api/cloud".length)
    : pathname.replace("/api/cloud", "/api");
  const fullUrl = req.url ?? pathname;
  const qsIndex = fullUrl.indexOf("?");
  const queryString = qsIndex >= 0 ? fullUrl.slice(qsIndex) : "";
  const upstreamUrl = `${baseUrl}${compatPath}${queryString}`;
  const headers = buildAuthHeaders(state.config, apiKey);

  try {
    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await readBody(req);
    }

    const upstreamRes = await fetchUpstream(upstreamUrl, method, headers, body);
    const parsed = await parseUpstreamJsonResponse(upstreamRes, method);

    if (parsed.kind === "head") {
      res.statusCode = upstreamRes.status;
      res.end();
      return true;
    }

    if (parsed.kind === "json") {
      if (upstreamRes.status === 404) {
        sendUpstreamNotFound(res, pathname, parsed.body);
        return true;
      }
      sendJson(res, parsed.body, upstreamRes.status);
      return true;
    }

    if (upstreamRes.status === 404) {
      sendUpstreamNotFound(res, pathname);
      return true;
    }

    const upstreamStatus = upstreamRes.ok ? 502 : upstreamRes.status;
    if (parsed.kind === "empty") {
      const message = upstreamRes.ok
        ? "Eliza Cloud returned an empty response."
        : `Eliza Cloud returned HTTP ${upstreamRes.status} with an empty response body.`;
      sendJsonError(res, message, upstreamStatus);
      return true;
    }

    const message =
      parsed.kind === "invalid-json"
        ? "Eliza Cloud returned malformed JSON."
        : "Eliza Cloud returned a non-JSON response.";
    const detail = summarizeUpstreamBody(parsed.bodyText);
    logger.warn(
      `[cloud-compat] ${message} ${method} ${compatPath} (${upstreamRes.status})${detail ? `: ${detail}` : ""}`,
    );
    sendJsonError(
      res,
      detail ? `${message} ${detail}` : message,
      upstreamStatus,
    );
    return true;
  } catch (error) {
    handleUpstreamError(error, res);
    return true;
  }
}
