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

let registrationStarted = false;
let developmentCleanupStarted = false;

/**
 * A browser can remain controlled by a production service worker after the
 * developer switches back to Vite. That stale worker rewrites local API
 * requests using its old routing rules, which makes a healthy loopback runtime
 * look remote/authenticated and can strand the dev shell in onboarding.
 *
 * Development never needs an offline worker, so remove every registration. If
 * the current document was already controlled, one reload is required to shed
 * that controller; the next load has no registration and therefore cannot loop.
 */
export async function clearDevelopmentServiceWorkers(
  serviceWorkers: ServiceWorkerContainer,
  reload: () => void = () => globalThis.location.reload(),
): Promise<void> {
  const wasControlled = Boolean(serviceWorkers.controller);
  const registrations = await serviceWorkers.getRegistrations();
  const unregistered = await Promise.all(
    registrations.map((registration) => registration.unregister()),
  );

  if (wasControlled && unregistered.some(Boolean)) reload();
}

/**
 * When a NEW service worker reaches `installed` while an existing controller is
 * present, a fresh renderer was just deployed. Tell the waiting worker to take
 * over; its `activate` handler is the SINGLE navigation owner: it claims clients,
 * skips auth routes, and navigates each ordinary window once. A second page-side
 * `controllerchange` reload races that navigation and can refresh the same login
 * journey twice, so this registration seam deliberately never reloads a page.
 */
export function wireServiceWorkerUpdateActivation(
  registration: ServiceWorkerRegistration,
  serviceWorkers: ServiceWorkerContainer = navigator.serviceWorker,
): void {
  const isUpdate = Boolean(serviceWorkers.controller);

  const trackInstalling = (worker: ServiceWorker | null) => {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      // A worker reaching `installed` with an existing controller = an UPDATE
      // (not the first install). Ask it to activate immediately.
      if (worker.state === "installed" && isUpdate) {
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
}

/**
 * Register /sw.js with scope "/" in production web builds only.
 * Safe to call unconditionally — bails out when the environment is unsuitable.
 */
export function registerViewServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  if (isCapacitorNative()) return;
  if (isElectrobunHost()) return;

  if (!import.meta.env.PROD) {
    if (developmentCleanupStarted) return;
    developmentCleanupStarted = true;
    void clearDevelopmentServiceWorkers(navigator.serviceWorker).catch(
      (err: unknown) => {
        console.warn(
          "[SW] Development cleanup failed:",
          err instanceof Error ? err.message : err,
        );
      },
    );
    return;
  }

  if (registrationStarted) return;
  registrationStarted = true;

  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then((registration) => {
      // WebKit under automation (and some webviews) expose
      // `navigator.serviceWorker` yet resolve register() to undefined rather
      // than rejecting. That is SW-unavailable, not a failure — reading
      // `.scope` off it would throw and masquerade as a registration error.
      if (!registration) return;
      console.info("[SW] Registered, scope:", registration.scope);
      // Activate a new worker immediately; its activation owns the one safe
      // renderer navigation for each non-auth window.
      wireServiceWorkerUpdateActivation(registration);
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
