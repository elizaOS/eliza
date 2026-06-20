/**
 * Deep-link entry for first-run setup.
 *
 * iOS and Android wire `eliza://first-run/runtime/<id>` URLs through Capacitor's
 * `App.addListener("appUrlOpen", ...)`. The native shell hands the URL string
 * to the renderer; this module translates first-run paths into the query
 * contract consumed by the setup screen.
 *
 * Recognized runtime targets:
 *
 *   - `local`    -> selects local.
 *   - `cloud`    -> selects cloud.
 *   - `remote`   -> selects remote.
 *
 * Unknown targets fall back to local first-run setup instead of a dead screen.
 *
 * Defensive behavior:
 *
 *   - Malformed URLs are ignored silently (returns `false`).
 *   - Wrong scheme is ignored silently (returns `false`).
 *   - Non-first-run paths under the right scheme are ignored silently — caller
 *     can fall through to its own switch (returns `false`).
 *   - Server-side render (no `window`) is a no-op (returns `false`).
 *
 * The URL parser (`routeFirstRunDeepLink`) is platform-agnostic and has no
 * Capacitor imports, so it can be unit-tested with vitest + jsdom without
 * bootstrapping the full app shell. The optional listener wrapper
 * (`installFirstRunDeepLinkListener`) dynamically imports `@capacitor/app`
 * and resolves to a no-op when the native bridge is unavailable.
 */

import {
  FIRST_RUN_QUERY_NAME,
  FIRST_RUN_QUERY_VALUE,
  FIRST_RUN_TARGET_QUERY_NAME,
  type FirstRunReloadTarget,
} from "./reload-into-first-run-runtime";

const FIRST_RUN_HOST = "first-run";
const RUNTIME_SEGMENT = "runtime";

type FirstRunPathTarget = "local" | "cloud" | "remote";

const STEP_TO_FIRST_RUN_TARGET: Record<
  FirstRunPathTarget,
  FirstRunReloadTarget
> = {
  local: "local",
  cloud: "cloud",
  remote: "remote",
};

function isFirstRunPathTarget(value: string): value is FirstRunPathTarget {
  return value in STEP_TO_FIRST_RUN_TARGET;
}

/**
 * Parses `eliza://first-run/runtime/<id>` (or any scheme matching `urlScheme`)
 * and writes the matching first-run runtime query
 * params to the current location. Returns `true` when the URL matched the
 * first-run contract (so the caller can stop processing); returns `false`
 * for anything else.
 *
 * @param url        The raw URL string handed in by Capacitor's
 *                   `appUrlOpen` event.
 * @param urlScheme  The app's deep-link scheme without the trailing `:`
 *                   (e.g. `"eliza"`).
 */
export function routeFirstRunDeepLink(url: string, urlScheme: string): boolean {
  if (typeof window === "undefined") return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== `${urlScheme}:`) return false;
  if (parsed.host !== FIRST_RUN_HOST) return false;

  const pathSegments = parsed.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (pathSegments.length === 0) return false;
  if (pathSegments[0] !== RUNTIME_SEGMENT) return false;

  const stepId = pathSegments[1] ?? "";
  const next = new URL(window.location.href);
  next.searchParams.set(FIRST_RUN_QUERY_NAME, FIRST_RUN_QUERY_VALUE);

  if (isFirstRunPathTarget(stepId)) {
    next.searchParams.set(
      FIRST_RUN_TARGET_QUERY_NAME,
      STEP_TO_FIRST_RUN_TARGET[stepId],
    );
  } else {
    next.searchParams.delete(FIRST_RUN_TARGET_QUERY_NAME);
  }

  window.history.replaceState(window.history.state, "", next.toString());
  return true;
}

const OAUTH_RETURN_HOSTS = new Set(["login", "oauth-callback"]);

/**
 * Parses the native OAuth return deep link
 * (`<scheme>://login?code=…&state=…` or `<scheme>://login#token=…`, plus the
 * `<scheme>://oauth-callback` alias) and rewrites the in-app `/login` location
 * so the existing Steward login `useEffect` consumes the `?code=` / `#token=`
 * the same way it does on web. Returns `true` when the URL matched an OAuth
 * return contract (so the caller can stop processing and close the in-app
 * browser); returns `false` for anything else.
 *
 * On match it sets `window.location` to `/login` carrying the original query
 * and hash via `history.replaceState`, then dispatches `popstate` so the SPA
 * router (react-router `BrowserRouter`) navigates to `/login` and mounts the
 * Steward login section, whose effect reads `consumeStewardCodeFromQuery()` /
 * `consumeStewardTokensFromHash()`.
 *
 * Defensive behavior mirrors {@link routeFirstRunDeepLink}: malformed URL,
 * wrong scheme, wrong host, or no OAuth payload → `false` with no mutation;
 * SSR (no `window`) → `false`.
 *
 * @param url        The raw URL string from Capacitor's `appUrlOpen` event.
 * @param urlScheme  The app's deep-link scheme without the trailing `:`
 *                   (e.g. `"elizaos"`).
 */
export function routeOAuthReturnDeepLink(
  url: string,
  urlScheme: string,
): boolean {
  if (typeof window === "undefined") return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== `${urlScheme}:`) return false;
  if (!OAUTH_RETURN_HOSTS.has(parsed.host)) return false;

  const search = parsed.search;
  const hash = parsed.hash;
  const hasCode = parsed.searchParams.has("code");
  const hasState = parsed.searchParams.has("state");
  const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
  const hasHashToken =
    hashParams.has("token") || hashParams.has("access_token");

  // Require an actual OAuth payload — a bare `<scheme>://login` with nothing to
  // hand off is not a return we can complete, so let the caller fall through.
  if (!hasCode && !hasState && !hasHashToken) return false;

  window.history.replaceState(
    window.history.state,
    "",
    `/login${search}${hash}`,
  );
  // Drive the SPA router (react-router listens for `popstate`) to /login so the
  // Steward login section mounts and its effect consumes the code/token.
  window.dispatchEvent(new PopStateEvent("popstate"));
  return true;
}

/**
 * Wires `App.addListener("appUrlOpen", ...)` (and `App.getLaunchUrl()` for
 * cold-launch links) so first-run deep links route through
 * `routeFirstRunDeepLink`.
 *
 * Resolves to a no-op when `@capacitor/app` cannot be loaded (web build,
 * Capacitor bridge not installed, dynamic import rejected). Errors thrown by
 * a listener registration are reported via the optional `onError` hook and
 * never propagate to the caller — Capacitor unavailability is the expected
 * shape on web and must not crash boot.
 *
 * Returns a cleanup function that removes the listener; safe to call even
 * when registration failed (no-op).
 */
/**
 * Minimal contract this module needs from `@capacitor/app`. Keeps the package
 * import surface honest — `@elizaos/ui` does not declare `@capacitor/app` as a
 * direct dependency (the native bridge ships from the host app), and we don't
 * want a `typeof import("@capacitor/app")` to silently promote it.
 */
type AppUrlOpenEvent = { url: string };
type ListenerHandle = { remove: () => Promise<void> };
type CapacitorAppShape = {
  addListener: (
    eventName: "appUrlOpen",
    handler: (event: AppUrlOpenEvent) => void,
  ) => Promise<ListenerHandle>;
  getLaunchUrl: () => Promise<{ url?: string } | null | undefined>;
};

type CapacitorBrowserShape = { close: () => Promise<void> };

/**
 * Dismiss the system in-app browser opened for OAuth after the provider
 * returns via the deep link. `@capacitor/browser` is not a declared dependency
 * of `@elizaos/ui` (the host app supplies the native bridge), so it is loaded
 * with a guarded dynamic import that no-ops on web builds where the package is
 * absent or `Browser.close()` rejects (no active native browser window).
 */
export function closeOAuthInAppBrowser(): void {
  const capacitorBrowserPackage = "@capacitor/browser";
  void import(/* @vite-ignore */ capacitorBrowserPackage)
    .then((mod) => (mod as { Browser: CapacitorBrowserShape }).Browser.close())
    .catch(() => {});
}

export async function installFirstRunDeepLinkListener(options: {
  urlScheme: string;
  onError?: (error: unknown) => void;
  /**
   * Optional fall-through called for any URL that did NOT match the
   * first-run contract. Lets the host wire its existing deep-link switch
   * (chat, settings, share, ...) without losing those URLs.
   */
  onUnmatched?: (url: string) => void;
}): Promise<() => void> {
  const { urlScheme, onError, onUnmatched } = options;

  let capacitorApp: CapacitorAppShape;
  try {
    const capacitorAppPackage = "@capacitor/app";
    const mod = (await import(
      // `@capacitor/app` is not a declared dependency of `@elizaos/ui` — the
      // host app brings the native bridge. Dynamic import means web bundles
      // skip this branch when the package is not installed.
      /* @vite-ignore */ capacitorAppPackage
    )) as { App: CapacitorAppShape };
    capacitorApp = mod.App;
  } catch (error) {
    onError?.(error);
    return () => {};
  }

  const handler = (event: AppUrlOpenEvent): void => {
    if (routeFirstRunDeepLink(event.url, urlScheme)) return;
    if (routeOAuthReturnDeepLink(event.url, urlScheme)) {
      closeOAuthInAppBrowser();
      return;
    }
    onUnmatched?.(event.url);
  };

  let listenerHandle: ListenerHandle | undefined;
  try {
    listenerHandle = await capacitorApp.addListener("appUrlOpen", handler);
  } catch (error) {
    onError?.(error);
    return () => {};
  }

  // Cold-launch links: `appUrlOpen` only fires while the app is alive; the
  // initial URL that brought the app up is exposed via `getLaunchUrl()`.
  try {
    const launch = await capacitorApp.getLaunchUrl();
    if (launch?.url) handler({ url: launch.url });
  } catch (error) {
    onError?.(error);
  }

  return () => {
    if (!listenerHandle) return;
    void listenerHandle.remove().catch((error) => {
      onError?.(error);
    });
  };
}

export const __TEST_ONLY__ = {
  FIRST_RUN_HOST,
  RUNTIME_SEGMENT,
  STEP_TO_FIRST_RUN_TARGET,
};
