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
 * Query-parameter aliases that carry the remote agent URL on a
 * `<scheme>://first-run/runtime/remote?api=<url>` deep link. `api` is the
 * documented form; the others are accepted so a host that already emits a
 * `connect`-style `url=`/`apiBase=` link does not silently drop the address.
 */
const REMOTE_CONNECT_QUERY_KEYS = ["api", "apiBase", "url", "host"] as const;

export interface FirstRunRemoteConnectDeepLink {
  /** The raw remote agent URL captured from the deep link (not yet trusted). */
  apiBase: string;
}

/**
 * Parses a device "connect to a remote agent at a URL" first-run deep link:
 * `<scheme>://first-run/runtime/remote?api=<url>`. Returns the captured URL
 * when the link targets the remote runtime AND carries an address; returns
 * `null` for every other shape (wrong scheme/host, a non-remote target, or a
 * bare `remote` link with no URL — that case still flows through
 * {@link routeFirstRunDeepLink} as a runtime pre-selection).
 *
 * This parser is intentionally pure: it does NOT validate trust or connect.
 * The app shell owns the trust policy (`isTrustedDeepLinkApiBaseUrl`) and the
 * connect dispatch, so the same hardened path serves both this link and the
 * existing `<scheme>://connect?url=` link.
 */
export function parseFirstRunRemoteConnectDeepLink(
  url: string,
  urlScheme: string,
): FirstRunRemoteConnectDeepLink | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // error-policy:J3 untrusted deep-link URL — unparseable means "not ours"
    return null;
  }

  if (parsed.protocol !== `${urlScheme}:`) return null;
  if (parsed.host !== FIRST_RUN_HOST) return null;

  const pathSegments = parsed.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (pathSegments[0] !== RUNTIME_SEGMENT) return null;
  if (pathSegments[1] !== STEP_TO_FIRST_RUN_TARGET.remote) return null;

  for (const key of REMOTE_CONNECT_QUERY_KEYS) {
    const value = parsed.searchParams.get(key)?.trim();
    if (value) return { apiBase: value };
  }

  return null;
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
    // error-policy:J3 untrusted deep-link URL — unparseable means "not routed"
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
 * Minimal contract this module needs from `@capacitor/app`. Keeps the optional
 * peer import surface honest; native hosts supply the bridge, and we don't want
 * a `typeof import("@capacitor/app")` to silently promote it.
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
      // `@capacitor/app` is an optional peer supplied by native hosts. Dynamic
      // import means web bundles skip this branch when the package is absent.
      /* @vite-ignore */ capacitorAppPackage
    )) as { App: CapacitorAppShape };
    capacitorApp = mod.App;
  } catch (error) {
    // error-policy:J1 optional native module missing/broken — deliver the
    // failure to the caller's onError and disable deep links
    onError?.(error);
    return () => {};
  }

  const handler = (event: AppUrlOpenEvent): void => {
    const matched = routeFirstRunDeepLink(event.url, urlScheme);
    if (!matched) onUnmatched?.(event.url);
  };

  let listenerHandle: ListenerHandle | undefined;
  try {
    listenerHandle = await capacitorApp.addListener("appUrlOpen", handler);
  } catch (error) {
    // error-policy:J1 listener registration failed — deliver to onError
    onError?.(error);
    return () => {};
  }

  // Cold-launch links: `appUrlOpen` only fires while the app is alive; the
  // initial URL that brought the app up is exposed via `getLaunchUrl()`.
  try {
    const launch = await capacitorApp.getLaunchUrl();
    if (launch?.url) handler({ url: launch.url });
  } catch (error) {
    // error-policy:J1 cold-launch URL read failed — deliver to onError;
    // live appUrlOpen links still work
    onError?.(error);
  }

  return () => {
    if (!listenerHandle) return;
    // error-policy:J6 teardown — removal failure is still reported
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
