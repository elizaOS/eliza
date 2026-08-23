/**
 * Authenticated fetch helper for dashboard API requests.
 *
 * Layers two auth modes onto a single call:
 *   - Cookie + CSRF (browser session): sends the `eliza_session` cookie via
 *     `credentials: "include"` and mirrors the readable `eliza_csrf` cookie
 *     into the `x-eliza-csrf` header on state-changing requests.
 *   - Bearer (machine token / self-hosted bootstrap): if `getBootConfig()`
 *     exposes an apiToken, attaches `Authorization: Bearer ...`.
 *
 * Both modes can coexist for control-plane requests. Dedicated-agent origins
 * are bearer-only: parent-domain browser cookies and their CSRF mirror are
 * omitted at the client before the Worker enforces the same boundary.
 */

import { getBootConfig } from "../config/boot-config";
import { hydrateAndroidLocalAgentTokenForUrl } from "../first-run/local-agent-token";
import { resolveApiUrl } from "../utils/asset-url";
import { isDedicatedCloudAgentBase } from "../utils/cloud-agent-base";
import { androidNativeAgentTransportForUrl } from "./android-native-agent-transport";
import { readCsrfTokenFromCookie } from "./auth/csrf-cookie";
import { CSRF_HEADER_NAME } from "./auth/sessions";
import { desktopHttpTransportForUrl } from "./desktop-http-transport";
import { desktopLocalAgentTransportForUrl } from "./desktop-local-agent-transport";
import { iosInProcessAgentTransportForUrl } from "./ios-local-agent-transport";
import { nativeCloudHttpTransportForUrl } from "./native-cloud-http-transport";
import { defaultFetchTimeoutMs } from "./request-timeout";
import { type AgentRequestContext, fetchAgentTransport } from "./transport";

export { readCsrfTokenFromCookie } from "./auth/csrf-cookie";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

export async function fetchWithCsrf(
  url: string,
  init: RequestInit = {},
  context: AgentRequestContext = {},
): Promise<Response> {
  return fetchWithCsrfInternal(url, init, context, true);
}

/**
 * Authenticated same-origin request for routes owned by the renderer host
 * rather than the injected agent API base (for example local voice-session
 * control traffic). Auth headers, CSRF, timeouts, and platform transports stay
 * identical to fetchWithCsrf; only relative URL absolutization is suppressed.
 */
export async function fetchSameOriginWithCsrf(
  url: string,
  init: RequestInit = {},
  context: AgentRequestContext = {},
): Promise<Response> {
  return fetchWithCsrfInternal(url, init, context, false);
}

async function fetchWithCsrfInternal(
  url: string,
  init: RequestInit,
  context: AgentRequestContext,
  resolveRelativeApiPath: boolean,
): Promise<Response> {
  // Resolve relative API paths against the configured API base. On Capacitor
  // remote mode the page origin is the bundle's asset server, which answers
  // ANY path with index.html and HTTP 200 — a relative "/api/..." fetch
  // "succeeds" and then explodes at JSON parse. No-op when no base is set
  // (plain same-origin web). Absolute and protocol-relative URLs pass through
  // untouched — resolveApiUrl prefixes blindly and would corrupt them.
  if (resolveRelativeApiPath && url.startsWith("/") && !url.startsWith("//")) {
    url = resolveApiUrl(url);
  }
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const isDedicatedAgentRequest = isDedicatedCloudAgentBase(url);

  if (!isDedicatedAgentRequest && STATE_CHANGING_METHODS.has(method)) {
    const csrfToken = readCsrfTokenFromCookie();
    if (csrfToken) {
      headers.set(CSRF_HEADER_NAME, csrfToken);
    }
  }

  if (!headers.has("Authorization")) {
    await hydrateAndroidLocalAgentTokenForUrl(url);
    const apiToken = getBootConfig().apiToken?.trim();
    if (apiToken) {
      headers.set("Authorization", `Bearer ${apiToken}`);
    }
  }

  const requestInit: RequestInit = {
    ...init,
    credentials: isDedicatedAgentRequest ? "omit" : "include",
    headers,
  };
  return requestViaAgentTransport(url, requestInit, context);
}

/**
 * Route a caller-authenticated request through the canonical platform
 * transport selector without adding cookies, CSRF, or boot-token headers.
 */
export async function requestViaAgentTransport(
  url: string,
  init: RequestInit = {},
  context: AgentRequestContext = {},
): Promise<Response> {
  const transport =
    (await androidNativeAgentTransportForUrl(url)) ??
    (await iosInProcessAgentTransportForUrl(url)) ??
    (await desktopLocalAgentTransportForUrl(url)) ??
    desktopHttpTransportForUrl(url) ??
    nativeCloudHttpTransportForUrl(url) ??
    fetchAgentTransport;
  return transport.request(url, init, {
    timeoutMs: context.timeoutMs ?? defaultFetchTimeoutMs(url, init),
    ...(context.responseType ? { responseType: context.responseType } : {}),
  });
}
