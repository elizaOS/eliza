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
 * calling user.
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
    let payload: ArrayBuffer;
    try {
      upstream = await this.deps.fetchImpl(url.toString(), {
        method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      payload = await upstream.arrayBuffer();
    } catch (error) {
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
    const bytes = new Uint8Array(payload);
    const responseBody = textual ? new TextDecoder().decode(bytes) : encodeBase64(bytes);

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
