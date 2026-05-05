export const APP_AUTHORIZE_PATH = "/app-auth/authorize";
export const APP_AUTH_RETURN_TO_KEY = "eliza_app_auth_return_to";

export function buildAppAuthorizeReturnTo(search: string): string {
  const normalizedSearch = search && search.startsWith("?") ? search : search ? `?${search}` : "";
  return `${APP_AUTHORIZE_PATH}${normalizedSearch}`;
}

export function buildAppAuthorizeLoginHref(search: string): string {
  return `/login?returnTo=${encodeURIComponent(buildAppAuthorizeReturnTo(search))}`;
}

export function storeCurrentAppAuthorizeReturnTo(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(APP_AUTH_RETURN_TO_KEY, window.location.href);
  } catch {
    // Best effort. Browsers can deny storage; callers should still handle
    // missing app-auth context explicitly.
  }
}

export function clearStoredAppAuthorizeReturnTo(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(APP_AUTH_RETURN_TO_KEY);
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
    return null;
  }
}
