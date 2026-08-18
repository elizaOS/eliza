/**
 * Return-to plumbing for the app-authorize flow: the path, the persisted
 * return target, and the fail-closed scheme gate for hand-off navigations.
 */
import { shellLocalStorage } from "../../../surface-realm-channel";
export const APP_AUTHORIZE_PATH = "/app-auth/authorize";
export const APP_AUTH_RETURN_TO_KEY = "eliza_app_auth_return_to";

export function buildAppAuthorizeReturnTo(search: string): string {
  const normalizedSearch = search?.startsWith("?")
    ? search
    : search
      ? `?${search}`
      : "";
  return `${APP_AUTHORIZE_PATH}${normalizedSearch}`;
}

export function buildAppAuthorizeLoginHref(search: string): string {
  return `/login?returnTo=${encodeURIComponent(buildAppAuthorizeReturnTo(search))}`;
}

function clearAppAuthorizeResponseParams(url: URL): void {
  url.searchParams.delete("token");
  url.searchParams.delete("code");
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");
}

export function buildAppAuthorizeCompletionRedirect(input: {
  code: string;
  redirectUri: string;
  state?: string | null;
}): string {
  const url = new URL(input.redirectUri);
  clearAppAuthorizeResponseParams(url);
  url.searchParams.set("code", input.code);
  if (input.state != null) url.searchParams.set("state", input.state);
  return url.toString();
}

export function buildAppAuthorizeCancelRedirect(input: {
  redirectUri: string;
  state?: string | null;
}): string {
  const url = new URL(input.redirectUri);
  clearAppAuthorizeResponseParams(url);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", "User denied authorization");
  if (input.state != null) url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * Protocols that must never become a navigation target from the authorize
 * hand-off, even though `new URL()` parses them without complaint.
 */
const BLOCKED_REDIRECT_PROTOCOLS: ReadonlySet<string> = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
]);

/**
 * Fail-closed scheme gate for the authorize hand-off navigation. Allows
 * http(s) URLs and native-app custom schemes shaped like real navigation
 * targets (`myapp://callback` or `myapp:/callback`); everything else —
 * scriptable protocols, slash-less `scheme:payload` forms, unparseable
 * input — is rejected. Passing here is necessary, not sufficient: the server
 * separately requires the URI's origin to be registered for the app.
 */
export function isSafeAppAuthorizeRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // error-policy:J3 unparseable hand-off target is rejected (fail closed).
    return false;
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol === "http:" || protocol === "https:") return true;
  if (BLOCKED_REDIRECT_PROTOCOLS.has(protocol)) return false;
  if (!/^[a-z][a-z0-9+.-]*:$/.test(protocol)) return false;
  return /^[a-z][a-z0-9+.-]*:\/\/?/i.test(value);
}

export function storeCurrentAppAuthorizeReturnTo(): void {
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.setItem(APP_AUTH_RETURN_TO_KEY, window.location.href);
  } catch {
    // Best effort. Browsers can deny storage; callers should still handle
    // missing app-auth context explicitly.
  }
}

export function clearStoredAppAuthorizeReturnTo(): void {
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.removeItem(APP_AUTH_RETURN_TO_KEY);
  } catch {
    // Best effort. A stale value is harmless because reads validate origin
    // and path, but clearing avoids surprising later email callbacks.
  }
}

export function readStoredAppAuthorizeReturnTo(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(APP_AUTH_RETURN_TO_KEY);
    if (!stored) return null;

    const url = new URL(stored, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (url.pathname !== APP_AUTHORIZE_PATH) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    // error-policy:J3 unreadable storage or unparseable stored URL — no
    // authorize return target is trusted (fail-closed).
    return null;
  }
}
