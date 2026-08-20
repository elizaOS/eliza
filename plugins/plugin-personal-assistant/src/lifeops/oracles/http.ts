/**
 * Bounded HTTP/JSON boundary shared by external-oracle adapters.
 *
 * Production endpoints are fixed by each adapter. Test endpoint overrides are
 * accepted only for an explicitly enabled loopback origin, which lets contract
 * tests exercise the real HTTP stack without opening a production SSRF seam.
 */

import { isElizaError } from "@elizaos/core";
import { oracleError } from "./contracts.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export interface BoundedJsonResponse {
  body: unknown;
  headers: Headers;
  status: number;
}

export type OracleFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface BoundedJsonRequest {
  url: URL;
  safeResource: string;
  method?: "GET" | "POST";
  headers?: HeadersInit;
  body?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  fetchImpl?: OracleFetch;
  sensitiveValues?: readonly string[];
}

export async function requestBoundedJson(
  input: BoundedJsonRequest,
): Promise<BoundedJsonResponse> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw oracleError(
      "HTTP timeout must be a positive integer.",
      "ORACLE_HTTP_CONFIG",
      {
        safeResource: input.safeResource,
      },
    );
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw oracleError(
      "HTTP body limit must be a positive integer.",
      "ORACLE_HTTP_CONFIG",
      { safeResource: input.safeResource },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  let response: Response | undefined;
  let bodyConsumed = false;
  try {
    response = await fetchImpl(input.url, {
      method: input.method ?? "GET",
      headers: input.headers,
      body: input.body,
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      throw oracleError(
        "External source attempted an HTTP redirect.",
        "ORACLE_HTTP_REDIRECT",
        {
          safeResource: input.safeResource,
          status: response.status,
        },
      );
    }
    if (!response.ok) {
      throw oracleError(
        "External source returned an unsuccessful HTTP status.",
        "ORACLE_HTTP_STATUS",
        {
          safeResource: input.safeResource,
          status: response.status,
        },
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (
      !contentType ||
      (!contentType.includes("application/json") &&
        !contentType.includes("application/geo+json") &&
        !contentType.includes("+json"))
    ) {
      throw oracleError(
        "External source returned a non-JSON media type.",
        "ORACLE_HTTP_CONTENT_TYPE",
        { safeResource: input.safeResource },
      );
    }

    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength);
      if (
        !Number.isSafeInteger(parsedLength) ||
        parsedLength < 0 ||
        parsedLength > maxBodyBytes
      ) {
        throw oracleError(
          "External source response exceeded the configured body limit.",
          "ORACLE_HTTP_BODY_LIMIT",
          { safeResource: input.safeResource, maxBodyBytes },
        );
      }
    }

    const bytes = await readBoundedBody(
      response,
      maxBodyBytes,
      input.safeResource,
    );
    bodyConsumed = true;

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      // error-policy:J3 Provider bytes must be valid UTF-8 before JSON parsing;
      // malformed text is an explicit invalid response.
      throw oracleError(
        "External source returned invalid UTF-8.",
        "ORACLE_HTTP_INVALID_UTF8",
        { safeResource: input.safeResource },
        cause,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (cause) {
      // error-policy:J3 Provider bytes are untrusted; invalid JSON is an
      // explicit parse failure and never becomes an empty successful payload.
      throw oracleError(
        "External source returned invalid JSON.",
        "ORACLE_HTTP_INVALID_JSON",
        { safeResource: input.safeResource },
        cause,
      );
    }
    return { body, headers: response.headers, status: response.status };
  } catch (cause) {
    if (isElizaError(cause)) {
      throw cause;
    }
    // error-policy:J2 The HTTP boundary adds a safe resource label and keeps
    // provider URLs and credentials out of the error message and context.
    throw oracleError(
      controller.signal.aborted
        ? "External source request timed out."
        : "External source request failed.",
      controller.signal.aborted ? "ORACLE_HTTP_TIMEOUT" : "ORACLE_HTTP_NETWORK",
      { safeResource: input.safeResource },
      sanitizeCause(cause, input.sensitiveValues ?? []),
    );
  } finally {
    clearTimeout(timeout);
    if (response?.body && !bodyConsumed) {
      try {
        await response.body.cancel();
      } catch {
        // error-policy:J6 best-effort cancellation after a rejected response
      }
    }
  }
}

async function readBoundedBody(
  response: Response,
  maxBodyBytes: number,
  safeResource: string,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (value.byteLength > maxBodyBytes - total) {
        throw oracleError(
          "External source response exceeded the configured body limit.",
          "ORACLE_HTTP_BODY_LIMIT",
          { safeResource, maxBodyBytes },
        );
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // error-policy:J6 stream lock release is best-effort teardown
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function sanitizeCause(
  cause: unknown,
  sensitiveValues: readonly string[],
): Error {
  const rawMessage =
    cause instanceof Error ? cause.message : "External request rejected.";
  const message = sensitiveValues.reduce(
    (current, secret) =>
      secret.length > 0 ? current.replaceAll(secret, "[REDACTED]") : current,
    rawMessage,
  );
  const sanitized = new Error(message);
  sanitized.name = cause instanceof Error ? cause.name : "ExternalRequestError";
  return sanitized;
}

export function resolveFixedEndpoint(args: {
  production: string;
  override?: string;
  allowInsecureLoopbackForTests?: boolean;
}): URL {
  const production = new URL(args.production);
  if (!args.override) {
    return production;
  }
  const override = new URL(args.override);
  if (!args.allowInsecureLoopbackForTests || !isLoopbackUrl(override)) {
    throw oracleError(
      "External source endpoint overrides are restricted to explicit loopback tests.",
      "ORACLE_ENDPOINT_REJECTED",
    );
  }
  return override;
}

export function assertTrustedContinuation(
  candidate: string,
  trustedBase: URL,
  safeResource: string,
): URL {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch (cause) {
    // error-policy:J3 Continuation URLs are provider-controlled input and must
    // fail closed when they are not valid absolute URLs.
    throw oracleError(
      "External source returned an invalid continuation URL.",
      "ORACLE_CONTINUATION_INVALID",
      { safeResource },
      cause,
    );
  }
  if (
    url.origin !== trustedBase.origin ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw oracleError(
      "External source returned an untrusted continuation URL.",
      "ORACLE_CONTINUATION_REJECTED",
      { safeResource },
    );
  }
  return url;
}

export function freshnessFromHeaders(args: {
  headers: Headers;
  observedAt: Date;
  sourceUpdatedAt?: string | null;
  defaultTtlMs: number;
}): {
  observedAt: string;
  sourceUpdatedAt: string | null;
  freshUntil: string;
} {
  let ttlMs = args.defaultTtlMs;
  const cacheControl = args.headers.get("cache-control");
  const maxAgeMatch = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)(?:,|$)/i);
  if (maxAgeMatch) {
    const seconds = Number(maxAgeMatch[1]);
    if (Number.isSafeInteger(seconds) && seconds >= 0) {
      ttlMs = Math.min(seconds * 1_000, args.defaultTtlMs);
    }
  }
  return {
    observedAt: args.observedAt.toISOString(),
    sourceUpdatedAt: args.sourceUpdatedAt ?? null,
    freshUntil: new Date(args.observedAt.getTime() + ttlMs).toISOString(),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function readFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isRfc3339Instant(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  );
}

function isLoopbackUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  if (url.search.length > 0 || url.hash.length > 0) return false;
  return (
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]" ||
    url.hostname === "localhost"
  );
}
