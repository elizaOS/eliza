/**
 * Cloud credential broker for first-party plugin provider calls.
 *
 * Plugins reference connections only by opaque connection ID; this service
 * resolves the credential server-side, refreshes it through the owning
 * connection adapter, and executes the provider request against an
 * audience-pinned host allowlist. Raw token material never leaves the broker:
 * responses carry provider payloads and refresh metadata only.
 *
 * Invariants: the upstream request is built from scratch (inbound Eliza
 * auth/cookies are never forwarded), caller-supplied headers must pass an
 * explicit allowlist, upstream redirects are not followed (a credentialed
 * request must not chase an attacker-controllable Location), and connections
 * are pinned to the caller's organization and, when user-owned, to the
 * calling user. Both directions of the exchange are byte-budgeted: the request
 * body against {@link MAX_REQUEST_BODY_BYTES} and the upstream response against
 * {@link MAX_RESPONSE_BODY_BYTES}, charged before the bytes are retained, so an
 * allowlisted host cannot decide how much memory the isolate spends.
 */

import { logger } from "../../utils/logger";
import { Errors, OAuthError, OAuthErrorCode } from "./errors";
import { oauthService } from "./oauth-service";
import type { OAuthConnection, TokenResult } from "./types";

/** Audience pin for one platform: exact upstream hosts the broker may call. */
export interface BrokerPlatformPolicy {
  /** Exact lowercase hostnames the platform's API lives on. */
  allowedHosts: readonly string[];
  /** Additional platform-specific request headers callers may set. */
  extraAllowedRequestHeaders?: readonly string[];
}

/**
 * Per-platform audience pins. A platform absent from this table cannot be
 * brokered — additions must name the exact provider API hosts, never a
 * wildcard or a caller-supplied host.
 */
export const BROKER_PLATFORM_POLICIES: Record<string, BrokerPlatformPolicy> = {
  google: {
    allowedHosts: [
      "www.googleapis.com",
      "gmail.googleapis.com",
      "calendar.googleapis.com",
      "drive.googleapis.com",
      "sheets.googleapis.com",
      "docs.googleapis.com",
      "people.googleapis.com",
      "tasks.googleapis.com",
      "youtube.googleapis.com",
    ],
    extraAllowedRequestHeaders: ["x-goog-fieldmask"],
  },
  microsoft: { allowedHosts: ["graph.microsoft.com"] },
  linear: { allowedHosts: ["api.linear.app"] },
  notion: {
    allowedHosts: ["api.notion.com"],
    extraAllowedRequestHeaders: ["notion-version"],
  },
  github: {
    allowedHosts: ["api.github.com"],
    extraAllowedRequestHeaders: ["x-github-api-version"],
  },
  slack: { allowedHosts: ["slack.com"] },
  hubspot: { allowedHosts: ["api.hubapi.com"] },
  asana: { allowedHosts: ["app.asana.com"] },
  dropbox: {
    allowedHosts: ["api.dropboxapi.com", "content.dropboxapi.com"],
    extraAllowedRequestHeaders: ["dropbox-api-arg"],
  },
  airtable: { allowedHosts: ["api.airtable.com"] },
  zoom: { allowedHosts: ["api.zoom.us"] },
  jira: { allowedHosts: ["api.atlassian.com"] },
  linkedin: {
    allowedHosts: ["api.linkedin.com"],
    extraAllowedRequestHeaders: ["linkedin-version", "x-restli-protocol-version"],
  },
  twitter: { allowedHosts: ["api.twitter.com", "api.x.com", "upload.twitter.com"] },
};

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_REQUEST_BODY_BYTES = 1_000_000;
/**
 * How much larger than the caller's request budget a brokered response may be.
 *
 * Derived from {@link MAX_REQUEST_BODY_BYTES} rather than written as its own
 * literal so the two halves of `callProvider` cannot drift: the request cap and
 * the response cap are the same number scaled by one factor, and changing the
 * request cap moves both.
 */
const RESPONSE_BODY_BUDGET_MULTIPLIER = 5;
/**
 * Hard byte ceiling on the upstream response the broker will materialize.
 *
 * The broker returns provider payloads inside a single JSON envelope field, so
 * every upstream byte is paid for at least twice inside one isolate: once as
 * the read bytes and again as the `utf8`/`base64` string (the base64 branch
 * expands by 4/3 on top). Without a ceiling that cost is set by whatever the
 * allowlisted host chooses to send. `UPSTREAM_TIMEOUT_MS` bounds the *duration*
 * of the read, not its size — 30s of provider bandwidth is far more than an
 * isolate's memory ceiling — so the budget has to be counted in bytes.
 */
const MAX_RESPONSE_BODY_BYTES = MAX_REQUEST_BODY_BYTES * RESPONSE_BODY_BUDGET_MULTIPLIER;
const UPSTREAM_TIMEOUT_MS = 30_000;

/** Headers any brokered request may set, regardless of platform. */
const GENERIC_ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "if-match",
  "if-none-match",
  "prefer",
  "range",
]);

/**
 * Credential-bearing or transport-owned headers a caller must never supply.
 * These are rejected loudly (400) rather than silently stripped so a plugin
 * that tries to smuggle its own auth fails fast in development.
 */
const FORBIDDEN_REQUEST_HEADER_PATTERNS: readonly RegExp[] = [
  /^authorization$/,
  /^proxy-authorization$/,
  /^cookie2?$/,
  /^set-cookie$/,
  /^x-api-key$/,
  /^api-key$/,
  /^x-eliza-/,
  /^host$/,
  /^origin$/,
  /^referer$/,
  /^content-length$/,
  /^transfer-encoding$/,
  /^connection$/,
  /^forwarded$/,
  /^x-forwarded-/,
];

/** Upstream response headers that are safe to relay to the caller. */
const RESPONSE_HEADER_ALLOWLIST: readonly (string | RegExp)[] = [
  "content-type",
  "etag",
  "link",
  "location",
  "retry-after",
  /^x-ratelimit-/,
];

const TEXTUAL_CONTENT_TYPE =
  /^(text\/|application\/(json|xml|x-www-form-urlencoded)|.*\+(json|xml))/i;

export interface BrokeredProviderRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface BrokeredProviderCallParams {
  organizationId: string;
  userId: string;
  connectionId: string;
  request: BrokeredProviderRequest;
}

export interface BrokeredProviderResponse {
  connectionId: string;
  platform: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: "utf8" | "base64";
  tokenRefreshed: boolean;
}

export interface BrokeredTokenRefreshParams {
  organizationId: string;
  userId: string;
  connectionId: string;
}

/** Refresh outcome exposed to the runtime — deliberately token-free. */
export interface BrokeredTokenRefreshResult {
  connectionId: string;
  platform: string;
  status: "active";
  refreshed: boolean;
  expiresAt?: string;
  scopes?: string[];
}

export interface CredentialBrokerDeps {
  getConnection: (params: {
    organizationId: string;
    connectionId: string;
  }) => Promise<OAuthConnection | null>;
  getValidToken: (params: {
    organizationId: string;
    connectionId: string;
    platform?: string;
  }) => Promise<TokenResult>;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  policies?: Record<string, BrokerPlatformPolicy>;
}

function invalidRequest(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.INVALID_SCOPE_REQUEST, message, false);
}

function isForbiddenHeader(name: string): boolean {
  return FORBIDDEN_REQUEST_HEADER_PATTERNS.some((pattern) => pattern.test(name));
}

function isAllowedResponseHeader(name: string): boolean {
  return RESPONSE_HEADER_ALLOWLIST.some((entry) =>
    typeof entry === "string" ? entry === name : entry.test(name),
  );
}

/**
 * Validate the caller-supplied target against the platform's audience pin.
 * Throws on anything other than an https URL whose exact host is allowlisted.
 */
export function validateBrokeredUrl(rawUrl: string, policy: BrokerPlatformPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (cause) {
    // error-policy:J3 untrusted-input sanitizing — an unparseable target is an
    // explicit invalid-request error, never a pass-through.
    const parseError = invalidRequest("Invalid provider request URL");
    parseError.cause = cause;
    throw parseError;
  }
  if (url.protocol !== "https:") {
    throw invalidRequest("Provider requests must use https");
  }
  if (url.username || url.password) {
    throw invalidRequest("Provider request URL must not carry credentials");
  }
  if (url.port !== "") {
    throw invalidRequest("Provider request URL must not specify a port");
  }
  const host = url.hostname.toLowerCase();
  if (!policy.allowedHosts.includes(host)) {
    throw invalidRequest(`Host ${host} is not an allowed audience for this connection`);
  }
  return url;
}

/**
 * Validate caller-supplied headers against the generic and platform
 * allowlists. Credential-bearing headers are rejected, not stripped.
 */
export function validateBrokeredHeaders(
  headers: Record<string, string> | undefined,
  policy: BrokerPlatformPolicy,
): Record<string, string> {
  const validated: Record<string, string> = {};
  if (!headers) return validated;
  const extra = new Set((policy.extraAllowedRequestHeaders ?? []).map((h) => h.toLowerCase()));
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase().trim();
    if (typeof value !== "string") {
      throw invalidRequest(`Header ${name} must be a string`);
    }
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw invalidRequest("Header names and values must not contain CR/LF");
    }
    if (isForbiddenHeader(name)) {
      throw invalidRequest(`Header ${name} is managed by the broker and must not be supplied`);
    }
    if (!GENERIC_ALLOWED_REQUEST_HEADERS.has(name) && !extra.has(name)) {
      throw invalidRequest(`Header ${name} is not allowed for brokered provider requests`);
    }
    validated[name] = value;
  }
  return validated;
}

/**
 * Typed over-budget failure. The operator-facing numbers go to the log, not to
 * the caller's message, for the same reason the transport failure above is
 * generic: the response envelope is caller-visible and must not narrate what an
 * allowlisted host sent back on a credentialed connection.
 */
function responseTooLarge(context: Record<string, unknown>): OAuthError {
  logger.warn("[CredentialBroker] Upstream response exceeded the broker byte budget", context);
  return new OAuthError(
    OAuthErrorCode.UPSTREAM_RESPONSE_TOO_LARGE,
    `Upstream response exceeds the ${MAX_RESPONSE_BODY_BYTES}-byte broker limit`,
    false,
  );
}

function cancelUpstreamBody(response: Response, reason?: unknown): void {
  try {
    void response.body?.cancel(reason).catch(() => {
      // error-policy:J6 the authoritative failure is already known; cancelling
      // the upstream body is best-effort connection teardown.
    });
  } catch {
    // error-policy:J6 synchronous cancellation is best-effort teardown.
  }
}

function cancelUpstreamReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {
      // error-policy:J6 the authoritative failure is already known; cancelling
      // the reader is best-effort connection teardown.
    });
  } catch {
    // error-policy:J6 synchronous cancellation is best-effort teardown.
  }
}

/**
 * Read an upstream response body under a hard byte budget, charged BEFORE the
 * bytes are retained.
 *
 * Two checks, in this order:
 *  1. A declared `content-length` over budget is refused without reading the
 *     body at all, so a provider that announces its size never gets a single
 *     byte allocated.
 *  2. Otherwise the body is streamed and each chunk is charged against the
 *     running total before it is pushed onto the retained list, so a response
 *     with no `content-length` (or a lying one) is cut off at the budget
 *     instead of after it. Peak retention is the budget plus the one chunk
 *     already in hand, never a function of what the host chose to send.
 *
 * Over-budget is a typed `UPSTREAM_RESPONSE_TOO_LARGE` failure, never a
 * truncated body served as success: a caller that received the first N bytes
 * of a provider payload labelled `status: 200` could not tell it apart from
 * the real thing.
 *
 * This mirrors, contract for contract, `readBodyWithLimit` in
 * `services/social-media/media-download.ts` — content-length pre-check, then a
 * charge-before-retain streaming loop, then best-effort cancellation. It is not
 * called directly because that helper is module-private and welded to the
 * social-media byte constants and `SOCIAL_MEDIA_DOWNLOAD_TOO_LARGE` error
 * codes, which are the wrong contract for an OAuth-broker caller that must
 * surface an `OAuthError` the route boundary can map.
 */
async function readUpstreamBodyWithinBudget(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const rawLength = response.headers.get("content-length");
  const declaredLength = rawLength === null ? null : Number(rawLength);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    cancelUpstreamBody(response);
    throw responseTooLarge({ declaredBytes: declaredLength, maxBytes });
  }

  const body = response.body;
  if (!body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw responseTooLarge({ receivedBytes: bytes.byteLength, maxBytes });
    }
    return bytes;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        cancelUpstreamReader(reader);
        throw responseTooLarge({ receivedBytes: total, maxBytes });
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // error-policy:J6 stream lock release is best-effort teardown.
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

// Chunked base64 keeps large binary payloads off the argument-spread stack limit.
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class CredentialBroker {
  private readonly deps: CredentialBrokerDeps;

  constructor(deps: CredentialBrokerDeps) {
    this.deps = deps;
  }

  private policyFor(platform: string): BrokerPlatformPolicy {
    const policies = this.deps.policies ?? BROKER_PLATFORM_POLICIES;
    const policy = policies[platform];
    if (!policy) {
      throw new OAuthError(
        OAuthErrorCode.PLATFORM_NOT_SUPPORTED,
        `Platform ${platform} does not support brokered provider requests`,
        false,
      );
    }
    return policy;
  }

  /**
   * Resolve the connection under the caller's organization and user binding.
   * A connection owned by another user is reported as not found so the broker
   * does not leak connection existence across users.
   */
  private async requireAccessibleConnection(params: {
    organizationId: string;
    userId: string;
    connectionId: string;
  }): Promise<OAuthConnection> {
    const connection = await this.deps.getConnection({
      organizationId: params.organizationId,
      connectionId: params.connectionId,
    });
    if (!connection || (connection.userId && connection.userId !== params.userId)) {
      throw Errors.connectionNotFound(params.connectionId);
    }
    if (connection.status === "revoked") {
      throw Errors.connectionRevoked(connection.platform);
    }
    if (connection.status !== "active") {
      throw Errors.connectionExpired(connection.platform);
    }
    return connection;
  }

  /** Refresh (or revalidate) a connection's token without exposing it. */
  async refreshToken(params: BrokeredTokenRefreshParams): Promise<BrokeredTokenRefreshResult> {
    const connection = await this.requireAccessibleConnection(params);
    const token = await this.deps.getValidToken({
      organizationId: params.organizationId,
      connectionId: connection.id,
      platform: connection.platform,
    });
    return {
      connectionId: connection.id,
      platform: connection.platform,
      status: "active",
      refreshed: token.refreshed,
      expiresAt: token.expiresAt?.toISOString(),
      scopes: token.scopes,
    };
  }

  /** Execute one provider request with server-side credential injection. */
  async callProvider(params: BrokeredProviderCallParams): Promise<BrokeredProviderResponse> {
    const connection = await this.requireAccessibleConnection(params);
    const policy = this.policyFor(connection.platform);

    const method = params.request.method?.toUpperCase?.() ?? "";
    if (!ALLOWED_METHODS.has(method)) {
      throw invalidRequest(`Method ${params.request.method} is not allowed`);
    }

    const url = validateBrokeredUrl(params.request.url, policy);
    const headers = validateBrokeredHeaders(params.request.headers, policy);

    const body = params.request.body;
    if (body !== undefined) {
      if (typeof body !== "string") {
        throw invalidRequest("Request body must be a string");
      }
      if (!BODY_METHODS.has(method)) {
        throw invalidRequest(`Method ${method} must not carry a request body`);
      }
      if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
        throw invalidRequest("Request body exceeds the 1MB broker limit");
      }
    }

    const token = await this.deps.getValidToken({
      organizationId: params.organizationId,
      connectionId: connection.id,
      platform: connection.platform,
    });

    headers.authorization = `Bearer ${token.accessToken}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream: Response;
    let payload: Uint8Array;
    try {
      upstream = await this.deps.fetchImpl(url.toString(), {
        method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      payload = await readUpstreamBodyWithinBudget(upstream, MAX_RESPONSE_BODY_BYTES);
    } catch (error) {
      // An over-budget response is already a typed broker error with its own
      // code; re-flattening it into "request failed" would hide a caller-fixable
      // 502 behind a generic transport failure.
      if (error instanceof OAuthError) throw error;
      // error-policy:J2 context-adding rethrow — transport/deadline failures
      // become a typed broker error; the route boundary maps it to 502. The
      // message never includes the credentialed request headers.
      const isAbort = error instanceof Error && error.name === "AbortError";
      logger.warn("[CredentialBroker] Upstream request failed", {
        organizationId: params.organizationId,
        connectionId: connection.id,
        platform: connection.platform,
        host: url.hostname,
        reason: isAbort ? "timeout" : "transport",
      });
      throw new OAuthError(
        OAuthErrorCode.INTERNAL_ERROR,
        isAbort
          ? `Upstream ${connection.platform} request timed out`
          : `Upstream ${connection.platform} request failed`,
        false,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (isAllowedResponseHeader(lower)) responseHeaders[lower] = value;
    });

    const contentType = upstream.headers.get("content-type") ?? "";
    const textual = contentType === "" || TEXTUAL_CONTENT_TYPE.test(contentType);
    const bodyEncoding: "utf8" | "base64" = textual ? "utf8" : "base64";
    const responseBody = textual ? new TextDecoder().decode(payload) : encodeBase64(payload);

    logger.info("[CredentialBroker] Brokered provider request", {
      organizationId: params.organizationId,
      connectionId: connection.id,
      platform: connection.platform,
      host: url.hostname,
      method,
      status: upstream.status,
      tokenRefreshed: token.refreshed,
    });

    return {
      connectionId: connection.id,
      platform: connection.platform,
      status: upstream.status,
      headers: responseHeaders,
      body: responseBody,
      bodyEncoding,
      tokenRefreshed: token.refreshed,
    };
  }
}

export function createCredentialBroker(deps: CredentialBrokerDeps): CredentialBroker {
  return new CredentialBroker(deps);
}

/** Production broker wired to the OAuth service and the platform fetch. */
export const credentialBroker = createCredentialBroker({
  getConnection: (params) => oauthService.getConnection(params),
  getValidToken: (params) => oauthService.getValidToken(params),
  fetchImpl: (input, init) => fetch(input, init),
});
