import type http from "node:http";
import { logger } from "@elizaos/core";
import { normalizeCloudSiteUrl } from "../cloud/base-url";
import { validateCloudBaseUrl } from "../cloud/validate-url";
import { sendJson, sendJsonError } from "./http-helpers";

interface CloudProxyConfigLike {
  cloud?: {
    apiKey?: string;
    baseUrl?: string;
    serviceKey?: string;
  };
}

export interface CloudCompatRouteState {
  config: CloudProxyConfigLike;
}

const PROXY_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576;
const RETRY_BACKOFF_MS = 2_000;

export function resolveCloudBaseUrl(config: CloudProxyConfigLike): string {
  return normalizeCloudSiteUrl(config.cloud?.baseUrl);
}

function buildAuthHeaders(
  config: CloudProxyConfigLike,
): Record<string, string> {
  const serviceKey = config.cloud?.serviceKey?.trim();
  const apiKey = config.cloud?.apiKey?.trim();

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

export async function handleCloudCompatRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: CloudCompatRouteState,
): Promise<boolean> {
  if (!pathname.startsWith("/api/cloud/compat/")) return false;

  const apiKey = state.config.cloud?.apiKey?.trim();
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

  const compatPath = pathname.replace("/api/cloud", "/api");
  const fullUrl = req.url ?? pathname;
  const qsIndex = fullUrl.indexOf("?");
  const queryString = qsIndex >= 0 ? fullUrl.slice(qsIndex) : "";
  const upstreamUrl = `${baseUrl}${compatPath}${queryString}`;
  const headers = buildAuthHeaders(state.config);

  try {
    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await readBody(req);
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await fetchUpstream(upstreamUrl, method, headers, body);
    } catch (firstErr) {
      if (
        firstErr instanceof Response ||
        (firstErr instanceof Error &&
          "code" in firstErr &&
          (firstErr as { code: string }).code === "REDIRECT")
      ) {
        throw firstErr;
      }
      throw firstErr;
    }

    if (upstreamRes.status === 503) {
      logger.info(
        `[cloud-compat] Got 503 from upstream, retrying after ${RETRY_BACKOFF_MS}ms: ${compatPath}`,
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      try {
        upstreamRes = await fetchUpstream(upstreamUrl, method, headers, body);
      } catch {
        // Keep the original 503 response.
      }
    }

    const responseData = await upstreamRes.json().catch(() => ({
      success: false,
      error: `HTTP ${upstreamRes.status}`,
    }));

    sendJson(res, responseData, upstreamRes.status);
    return true;
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code: string }).code === "REDIRECT"
    ) {
      sendJsonError(
        res,
        "Eliza Cloud request was redirected; redirects are not allowed",
        502,
      );
      return true;
    }

    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        err.message.toLowerCase().includes("timeout"));

    if (isTimeout) {
      logger.warn(`[cloud-compat] Upstream request timed out: ${compatPath}`);
      sendJsonError(res, "Eliza Cloud request timed out", 504);
    } else {
      logger.warn(
        `[cloud-compat] Upstream request failed: ${compatPath} — ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonError(res, "Failed to reach Eliza Cloud", 502);
    }
    return true;
  }
}
