/** Implements Electrobun desktop desktop http request ts behavior for app-core shell integration. */
import {
  isElizaCloudControlPlaneHostname,
  isElizaDedicatedAgentHostname,
  isLoopbackBindHost,
  isWildcardBindHost,
} from "@elizaos/shared";
import { resolveExternalApiBase } from "./api-base";

function isExternalPlainHttpUrl(parsed: URL): boolean {
  return (
    parsed.protocol === "http:" &&
    !isLoopbackBindHost(parsed.hostname) &&
    !isWildcardBindHost(parsed.hostname)
  );
}

function isConfiguredExternalApiBaseUrl(parsed: URL): boolean {
  if (parsed.protocol !== "http:") return false;
  const configured = resolveExternalApiBase(
    process.env as Record<string, string | undefined>,
  ).base;
  return Boolean(configured && parsed.origin === configured);
}

/**
 * Trusted Eliza Cloud HTTPS origins whose CORS policy does not allowlist
 * loopback renderer origins (e.g. http://127.0.0.1:5174). The desktop main
 * process (bun) can reach these directly, so the renderer proxies through
 * desktopHttpRequest to bypass the WKWebView CORS block.
 */
function isTrustedElizaCloudHttpsUrl(parsed: URL): boolean {
  if (parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  return (
    isElizaCloudControlPlaneHostname(hostname) ||
    isElizaDedicatedAgentHostname(hostname)
  );
}

export function normalizeDesktopHttpRequest(params: unknown): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Buffer | null;
  timeoutMs?: number;
} {
  if (!params || typeof params !== "object") {
    throw new Error("desktopHttpRequest params must be an object.");
  }
  const record = params as Record<string, unknown>;
  if (typeof record.url !== "string") {
    throw new Error("desktopHttpRequest url must be a string.");
  }
  const parsed = new URL(record.url);
  if (
    !isExternalPlainHttpUrl(parsed) &&
    !isConfiguredExternalApiBaseUrl(parsed) &&
    !isTrustedElizaCloudHttpsUrl(parsed)
  ) {
    throw new Error(
      "desktopHttpRequest supports only external or configured desktop API plain HTTP URLs, or trusted Eliza Cloud HTTPS URLs.",
    );
  }
  const method = typeof record.method === "string" ? record.method : "GET";
  const headers =
    record.headers && typeof record.headers === "object"
      ? Object.fromEntries(
          Object.entries(record.headers as Record<string, unknown>)
            .filter((entry): entry is [string, string] => {
              return typeof entry[1] === "string";
            })
            .map(([key, value]) => [key, value]),
        )
      : {};
  // Binary request body (e.g. STT audio upload as FormData) arrives as base64;
  // decode to a Buffer so fetch sends the raw bytes with the correct
  // Content-Type (including multipart boundary) from the headers.
  const bodyBase64 =
    typeof record.bodyBase64 === "string" ? record.bodyBase64 : null;
  const body =
    bodyBase64 !== null
      ? Buffer.from(bodyBase64, "base64")
      : typeof record.body === "string"
        ? record.body
        : null;
  const timeoutMs =
    typeof record.timeoutMs === "number" &&
    Number.isFinite(record.timeoutMs) &&
    record.timeoutMs > 0
      ? record.timeoutMs
      : undefined;
  return { url: parsed.toString(), method, headers, body, timeoutMs };
}

function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

export async function desktopHttpRequest(params: unknown): Promise<{
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | null;
  bodyBase64?: string | null;
}> {
  const request = normalizeDesktopHttpRequest(params);
  const abortController = new AbortController();
  const operation = (async () => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      // Body may be a string (text) or Buffer (binary base64-decoded);
      // Buffer is a valid BodyInit at runtime but the DOM lib types don't
      // include it, so cast through BodyInit.
      body: request.body as BodyInit | null,
      signal: abortController.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const isBinary =
      contentType.startsWith("audio/") ||
      contentType.startsWith("image/") ||
      contentType.startsWith("video/") ||
      contentType.startsWith("application/octet-stream") ||
      contentType.startsWith("application/wasm");
    if (isBinary) {
      const buf = await response.arrayBuffer();
      const bodyBase64 = Buffer.from(buf).toString("base64");
      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeadersToRecord(response.headers),
        body: null,
        bodyBase64,
      };
    }
    const body = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeadersToRecord(response.headers),
      body,
      bodyBase64: null,
    };
  })();

  if (!request.timeoutMs) {
    return operation;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      reject(
        new Error(`desktopHttpRequest timed out after ${request.timeoutMs}ms.`),
      );
    }, request.timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
