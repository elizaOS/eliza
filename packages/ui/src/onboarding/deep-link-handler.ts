/**
 * Deep-link entry for the onboarding picker.
 *
 * iOS and Android wire `eliza://onboard/step/<id>` URLs through Capacitor's
 * `App.addListener("appUrlOpen", ...)`. The native shell hands the URL string
 * to the renderer; this module translates the onboarding-specific paths into
 * the URL-query contract that `RuntimeGate` already reads on mount
 * (`?runtime=picker&runtimeTarget=<choice>`), mutates the browser URL via
 * `history.replaceState`, and lets RuntimeGate's existing effect open the
 * matching sub-view.
 *
 * Recognized steps:
 *
 *   - `provider` → opens the local sub-view; `LocalStage` starts at `"provider"`
 *     by default, so this lands directly on the provider list.
 *   - `local`    → opens the local sub-view.
 *   - `cloud`    → opens the cloud sub-view.
 *   - `remote`   → opens the remote sub-view.
 *
 * Unknown steps fall back to the default chooser (`?runtime=picker` only) so
 * the user sees the picker tiles instead of a dead screen.
 *
 * Defensive behavior:
 *
 *   - Malformed URLs are ignored silently (returns `false`).
 *   - Wrong scheme is ignored silently (returns `false`).
 *   - Non-onboard paths under the right scheme are ignored silently — caller
 *     can fall through to its own switch (returns `false`).
 *   - Server-side render (no `window`) is a no-op (returns `false`).
 *
 * The URL parser (`routeOnboardingDeepLink`) is platform-agnostic and has no
 * Capacitor imports, so it can be unit-tested with vitest + jsdom without
 * bootstrapping the full app shell. The optional listener wrapper
 * (`installOnboardingDeepLinkListener`) dynamically imports `@capacitor/app`
 * and resolves to a no-op when the native bridge is unavailable.
 */

import {
  RUNTIME_PICKER_QUERY_NAME,
  RUNTIME_PICKER_QUERY_VALUE,
  RUNTIME_PICKER_TARGET_QUERY_NAME,
  type RuntimePickerTarget,
} from "./reload-into-runtime-picker";

/** Path prefix expected after the scheme — `eliza://onboard/step/<id>`. */
const ONBOARD_HOST = "onboard";
const STEP_SEGMENT = "step";

type OnboardingStepId = "provider" | "local" | "cloud" | "remote";

const STEP_TO_PICKER_TARGET: Record<OnboardingStepId, RuntimePickerTarget> = {
  provider: "local",
  local: "local",
  cloud: "cloud",
  remote: "remote",
};

function isOnboardingStepId(value: string): value is OnboardingStepId {
  return value in STEP_TO_PICKER_TARGET;
}

/**
 * Parses `eliza://onboard/step/<id>` (or any scheme matching `urlScheme`)
 * and writes the matching `?runtime=picker&runtimeTarget=<choice>` query
 * params to the current location. Returns `true` when the URL matched the
 * onboarding contract (so the caller can stop processing); returns `false`
 * for anything else.
 *
 * @param url        The raw URL string handed in by Capacitor's
 *                   `appUrlOpen` event.
 * @param urlScheme  The app's deep-link scheme without the trailing `:`
 *                   (e.g. `"eliza"`).
 */
export function routeOnboardingDeepLink(
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
  if (parsed.host !== ONBOARD_HOST) return false;

  const pathSegments = parsed.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (pathSegments.length === 0) return false;
  if (pathSegments[0] !== STEP_SEGMENT) return false;

  const stepId = pathSegments[1] ?? "";
  const next = new URL(window.location.href);
  next.searchParams.set(RUNTIME_PICKER_QUERY_NAME, RUNTIME_PICKER_QUERY_VALUE);

  if (isOnboardingStepId(stepId)) {
    next.searchParams.set(
      RUNTIME_PICKER_TARGET_QUERY_NAME,
      STEP_TO_PICKER_TARGET[stepId],
    );
  } else {
    // Unknown step: surface the chooser but do not pin a target. RuntimeGate's
    // effect (`if (!pickerTargetOverride) return;`) leaves the sub-view on
    // `"chooser"` so the user can still pick by hand.
    next.searchParams.delete(RUNTIME_PICKER_TARGET_QUERY_NAME);
  }

  // Use replaceState rather than `window.location.href = ...` so the deep-link
  // entry does not trigger a full reload — the renderer is already mounted and
  // RuntimeGate's `useEffect` will re-read the params on its next render.
  window.history.replaceState(window.history.state, "", next.toString());
  return true;
}

/**
 * Wires `App.addListener("appUrlOpen", ...)` (and `App.getLaunchUrl()` for
 * cold-launch links) so onboarding deep links route through
 * `routeOnboardingDeepLink`.
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

export async function installOnboardingDeepLinkListener(options: {
  urlScheme: string;
  onError?: (error: unknown) => void;
  /**
   * Optional fall-through called for any URL that did NOT match the
   * onboarding contract. Lets the host wire its existing deep-link switch
   * (chat, settings, share, ...) without losing those URLs.
   */
  onUnmatched?: (url: string) => void;
}): Promise<() => void> {
  const { urlScheme, onError, onUnmatched } = options;

  let capacitorApp: CapacitorAppShape;
  try {
    const mod = (await import(
      // `@capacitor/app` is not a declared dependency of `@elizaos/ui` — the
      // host app brings the native bridge. Dynamic import means web bundles
      // skip this branch when the package is not installed.
      /* @vite-ignore */ "@capacitor/app"
    )) as { App: CapacitorAppShape };
    capacitorApp = mod.App;
  } catch (error) {
    onError?.(error);
    return () => {};
  }

  const handler = (event: AppUrlOpenEvent): void => {
    const matched = routeOnboardingDeepLink(event.url, urlScheme);
    if (!matched) onUnmatched?.(event.url);
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
  ONBOARD_HOST,
  STEP_SEGMENT,
  STEP_TO_PICKER_TARGET,
};
