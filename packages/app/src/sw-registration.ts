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
      globalThis as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    ).Capacitor;
    return typeof cap?.isNativePlatform === "function" && cap.isNativePlatform();
  } catch {
    return false;
  }
}

function isElectrobunHost(): boolean {
  const win = globalThis as unknown as {
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
      console.info("[SW] Registered, scope:", registration.scope);
    })
    .catch((err: unknown) => {
      console.error(
        "[SW] Registration failed:",
        err instanceof Error ? err.message : err,
      );
    });
}
