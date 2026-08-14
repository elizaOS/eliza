/**
 * Service worker registration for view-bundle offline caching.
 *
 * Only registers in production builds and only on platforms that support
 * service workers natively. Capacitor (iOS/Android) and Electrobun (desktop)
 * are excluded — they either prohibit SW or run in webview contexts where SW
 * support is unreliable.
 */

function isCapacitorNative(): boolean {
  try {
    const cap = (
      globalThis as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    ).Capacitor;
    return (
      typeof cap?.isNativePlatform === "function" && cap.isNativePlatform()
    );
  } catch {
    // error-policy:J4 capability probe — no Capacitor bridge means not native
    return false;
  }
}

function isElectrobunHost(): boolean {
  const win = globalThis as {
    __electrobunWindowId?: number;
    __electrobunWebviewId?: number;
    __ELIZA_ELECTROBUN_RPC__?: unknown;
  };
  return (
    typeof win.__electrobunWindowId === "number" ||
    typeof win.__electrobunWebviewId === "number" ||
    win.__ELIZA_ELECTROBUN_RPC__ !== undefined
  );
}

const AUTH_NAVIGATION_PATH_RE =
  /^\/(?:login(?:\/|$)|auth(?:\/|$)|oidc\/continue(?:\/|$))/;

/** Auth callbacks and bridges are one-time navigations that updates must not replay. */
export function isAuthNavigationUrl(rawUrl: string): boolean {
  try {
    return AUTH_NAVIGATION_PATH_RE.test(new URL(rawUrl).pathname);
  } catch {
    // error-policy:J3 an unparseable current URL is treated as auth-sensitive;
    // skipping an update reload is safer than replaying an unknown navigation.
    return true;
  }
}

/**
 * When a NEW service worker reaches `installed` while an existing controller is
 * present, a fresh renderer was just deployed. The new SW's own `activate`
 * already skips-waiting + claims + navigates windows, but wiring the client side
 * of the update makes the transition immediate and observable: tell the waiting
 * worker to take over (SKIP_WAITING), then reload once it becomes the controller.
 * Guarded so the FIRST install (no prior controller) does NOT reload — that is a
 * normal first paint, not an update (CONVERSATIONS-500-2026-07-22 fix #1).
 */
export function wireServiceWorkerUpdateReload(
  registration: ServiceWorkerRegistration,
  serviceWorkers: ServiceWorkerContainer = navigator.serviceWorker,
  reload: () => void = () => globalThis.location.reload(),
  currentUrl: () => string = () => globalThis.location.href,
): void {
  // Snapshot before `controllerchange`: first-install claim changes this from
  // null to the new worker, while an update already has the previous worker.
  // Only the latter represents a stale renderer that needs a reload.
  const isUpdate = Boolean(serviceWorkers.controller);
  let reloading = false;
  const reloadOnControllerChange = () => {
    if (!isUpdate || reloading || isAuthNavigationUrl(currentUrl())) return;
    reloading = true;
    // The new worker is now controlling this page → load the new renderer.
    reload();
  };

  const trackInstalling = (worker: ServiceWorker | null) => {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      // A worker reaching `installed` with an existing controller = an UPDATE
      // (not the first install). Ask it to activate immediately.
      if (worker.state === "installed" && serviceWorkers.controller) {
        try {
          worker.postMessage({ type: "SKIP_WAITING" });
        } catch {
          /* postMessage unsupported — the SW's own skipWaiting still runs */
        }
      }
    });
  };

  // A worker already waiting at registration time (installed between sessions).
  if (registration.waiting && serviceWorkers.controller) {
    try {
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    } catch {
      /* non-fatal */
    }
  }

  registration.addEventListener("updatefound", () => {
    trackInstalling(registration.installing);
  });

  // On an update, reload exactly once when control passes to the new worker.
  serviceWorkers.addEventListener("controllerchange", reloadOnControllerChange);
}

/**
 * Register /sw.js with scope "/" in production web builds only.
 * Safe to call unconditionally — bails out when the environment is unsuitable.
 */
export function registerViewServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  if (isCapacitorNative()) return;
  if (isElectrobunHost()) return;

  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then((registration) => {
      // WebKit under automation (and some webviews) expose
      // `navigator.serviceWorker` yet resolve register() to undefined rather
      // than rejecting. That is SW-unavailable, not a failure — reading
      // `.scope` off it would throw and masquerade as a registration error.
      if (!registration) return;
      console.info("[SW] Registered, scope:", registration.scope);
      // Auto-reload into a new renderer when a deploy ships a new worker
      // (the per-deploy build rev makes sw.js byte-change so this actually fires).
      wireServiceWorkerUpdateReload(registration);
    })
    // error-policy:J4 the service worker is a PWA enhancement — the app
    // works without it; the failure is logged for triage
    .catch((err: unknown) => {
      console.error(
        "[SW] Registration failed:",
        err instanceof Error ? err.message : err,
      );
    });
}
