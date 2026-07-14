/**
 * Idempotent Capacitor lifecycle wiring for iOS/Android, built by
 * `createMobileLifecycle` and driven from the app-shell boot: status-bar
 * overlay + dark style, keyboard accessory/resize, app foreground/background
 * events (with a `visibilitychange` fallback), hardware back-button navigation,
 * deep-link bootstrap (cold + warm launch URLs), and the network connectivity
 * bridge that lets the WebSocket reconnect scheduler stop burning backoff during
 * airplane mode. Each Capacitor call is guarded so a missing or throwing plugin
 * degrades to a log instead of stranding the rest of the wiring.
 */

import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import {
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  dispatchAppEvent,
  dispatchBackIntent,
  NETWORK_STATUS_CHANGE_EVENT,
  type NetworkStatusChangeDetail,
} from "@elizaos/ui/events";
import { isStandalonePwa } from "@elizaos/ui/platform";

export interface MobileLifecycleContext {
  isNative: boolean;
  isIOS: boolean;
  isAndroid: boolean;
  logPrefix: string;
  handleDeepLink: (url: string) => void;
}

// There is one document/window, so there is one visibilitychange→lifecycle and
// one online/offline→network bridge. Tracked at module scope so re-init (HMR /
// repeated init) replaces the previous handlers instead of leaking new ones.
let activeVisibilityHandler: (() => void) | null = null;
let activeOnlineHandler: (() => void) | null = null;
let activeOfflineHandler: (() => void) | null = null;

const COLD_LAUNCH_URL_REPLAY_MS = 15_000;
const COLD_LAUNCH_URL_REPLAY_INTERVAL_MS = 1_000;
const MOBILE_DEEP_LINK_READY_DATASET_KEY = "elizaMobileDeepLinkReady";
const MOBILE_DEEP_LINK_COUNT_DATASET_KEY = "elizaMobileDeepLinkCount";
const MOBILE_DEEP_LINK_INGRESS_KEY = Symbol.for(
  "eliza.mobile-deep-link-ingress",
);

interface MobileDeepLinkIngress {
  activeHandler: ((url: string) => void) | null;
  listenerReady: Promise<void> | null;
  pendingUrls: Set<string>;
}

const mobileDeepLinkIngress = (() => {
  const host = globalThis as typeof globalThis & {
    [MOBILE_DEEP_LINK_INGRESS_KEY]?: MobileDeepLinkIngress;
  };
  host[MOBILE_DEEP_LINK_INGRESS_KEY] ??= {
    activeHandler: null,
    listenerReady: null,
    pendingUrls: new Set<string>(),
  };
  return host[MOBILE_DEEP_LINK_INGRESS_KEY];
})();

function markMobileDeepLinkIngress(state: "ready" | "unavailable"): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset[MOBILE_DEEP_LINK_READY_DATASET_KEY] = state;
}

function markMobileDeepLinkIngressUnavailable(error: unknown): void {
  markMobileDeepLinkIngress("unavailable");
  console.warn(
    "[mobile-lifecycle] App appUrlOpen listener unavailable:",
    error instanceof Error ? error.message : error,
  );
}

function receiveMobileDeepLink(url: string | null | undefined): void {
  const trimmed = url?.trim();
  if (!trimmed) return;
  if (typeof document !== "undefined") {
    // Native-device E2E attaches through CDP after the WebView boots. A count
    // proves that Capacitor appUrlOpen delivered the OS intent without exposing
    // the URL or its token-bearing query string in renderer diagnostics.
    const previous = Number.parseInt(
      document.documentElement.dataset[MOBILE_DEEP_LINK_COUNT_DATASET_KEY] ??
        "0",
      10,
    );
    document.documentElement.dataset[MOBILE_DEEP_LINK_COUNT_DATASET_KEY] =
      String((Number.isFinite(previous) ? previous : 0) + 1);
  }
  if (mobileDeepLinkIngress.activeHandler) {
    mobileDeepLinkIngress.activeHandler(trimmed);
    return;
  }
  mobileDeepLinkIngress.pendingUrls.add(trimmed);
}

function installMobileDeepLinkIngress(
  isNative = Capacitor.isNativePlatform(),
): Promise<void> {
  if (mobileDeepLinkIngress.listenerReady) {
    return mobileDeepLinkIngress.listenerReady;
  }
  if (typeof window === "undefined" || !isNative) {
    return Promise.resolve();
  }

  try {
    const registration = CapacitorApp.addListener("appUrlOpen", ({ url }) => {
      receiveMobileDeepLink(url);
    });
    mobileDeepLinkIngress.listenerReady = Promise.resolve(registration)
      .then(() => {
        markMobileDeepLinkIngress("ready");
      })
      .catch((error) => {
        // error-policy:J4 getLaunchUrl remains the cold-launch fallback when
        // native warm-link registration rejects.
        markMobileDeepLinkIngressUnavailable(error);
      });
  } catch (error) {
    // error-policy:J4 Some bridge shims throw synchronously instead of
    // returning a rejection; getLaunchUrl remains the cold-launch fallback.
    markMobileDeepLinkIngressUnavailable(error);
    mobileDeepLinkIngress.listenerReady = Promise.resolve();
  }
  return mobileDeepLinkIngress.listenerReady;
}

function attachMobileDeepLinkHandler(handler: (url: string) => void): void {
  mobileDeepLinkIngress.activeHandler = handler;
  const pending = [...mobileDeepLinkIngress.pendingUrls];
  mobileDeepLinkIngress.pendingUrls.clear();
  for (const url of pending) handler(url);
}

// Register during module evaluation, before the async app boot and React mount.
// Native warm links arriving in that window are queued until lifecycle wiring
// supplies the product handler; cold links still replay through getLaunchUrl.
void installMobileDeepLinkIngress();

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

function shouldBridgeVisibilityLifecycle(ctx: MobileLifecycleContext): boolean {
  return ctx.isNative || isStandalonePwa();
}

export function createMobileLifecycle(ctx: MobileLifecycleContext) {
  let keyboardListenersRegistered = false;
  let lifecycleListenersRegistered = false;
  let networkStatusListenerRegistered = false;

  function logNativePluginUnavailable(
    pluginName: string,
    error: unknown,
  ): void {
    console.warn(
      `${ctx.logPrefix} ${pluginName} plugin not available:`,
      error instanceof Error ? error.message : error,
    );
  }

  async function initializeStatusBar(): Promise<void> {
    if (!ctx.isNative) return;
    // Edge-to-edge: status bar overlays the WebView so
    // `env(safe-area-inset-top)` reports the real status-bar height.
    try {
      const { StatusBar, Style } = await import("@capacitor/status-bar");
      await StatusBar.setStyle({ style: Style.Dark });
      if (ctx.isAndroid) {
        await StatusBar.setOverlaysWebView({ overlay: true });
        await StatusBar.setBackgroundColor({ color: "#00000000" });
      }
    } catch (error) {
      // error-policy:J4 optional native plugin — absence is a designed degrade
      logNativePluginUnavailable("StatusBar", error);
    }
  }

  async function initializeKeyboard(): Promise<void> {
    if (keyboardListenersRegistered) return;

    // A Keyboard-bridge throw (pod/plugin skew) must not reject and strand the
    // rest of lifecycle wiring — guard it like the sibling initializeStatusBar.
    try {
      if (ctx.isIOS) {
        await Keyboard.setResizeMode({ mode: KeyboardResize.None });
        await Keyboard.setScroll({ isDisabled: true });
        await Keyboard.setAccessoryBarVisible({ isVisible: true });
      }

      keyboardListenersRegistered = true;
      Keyboard.addListener("keyboardWillShow", (info) => {
        document.body.style.setProperty(
          "--keyboard-height",
          `${info.keyboardHeight}px`,
        );
        document.body.classList.add("keyboard-open");
      });

      Keyboard.addListener("keyboardWillHide", () => {
        document.body.style.setProperty("--keyboard-height", "0px");
        document.body.classList.remove("keyboard-open");
      });
    } catch (error) {
      // error-policy:J4 optional native plugin — absence is a designed degrade
      logNativePluginUnavailable("Keyboard", error);
    }
  }

  function initializeAppLifecycle(): void {
    // Each Capacitor listener fires its handler N times if added N times;
    // guard against duplicate registrations from HMR / repeated init.
    if (lifecycleListenersRegistered) return;
    lifecycleListenersRegistered = true;

    // Single source of truth for the foreground/background state so the
    // Capacitor `appStateChange` listener and the `visibilitychange` fallback
    // below never double-dispatch — each only fires on an actual transition.
    let lastActive: boolean | null = null;
    const handledDeepLinks = new Set<string>();
    const setAppActive = (active: boolean): void => {
      if (lastActive === active) return;
      lastActive = active;
      dispatchAppEvent(active ? APP_RESUME_EVENT : APP_PAUSE_EVENT);
    };
    const handleDeepLinkOnce = (url: string | null | undefined): boolean => {
      const trimmed = url?.trim();
      if (!trimmed || handledDeepLinks.has(trimmed)) return false;
      handledDeepLinks.add(trimmed);
      ctx.handleDeepLink(trimmed);
      return true;
    };

    void Promise.resolve(
      CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        setAppActive(isActive);
      }),
      // error-policy:J4 App plugin unavailable — the visibilitychange fallback
      // still drives pause/resume on native and installed-PWA surfaces.
    ).catch((error) => {
      logNativePluginUnavailable("App", error);
    });

    if (activeVisibilityHandler) {
      document.removeEventListener("visibilitychange", activeVisibilityHandler);
      activeVisibilityHandler = null;
    }
    // Browser tab visibility is not an app suspend signal: desktop browsers keep
    // agent requests and sockets alive in hidden tabs. Use the fallback only on
    // native WebViews and installed PWAs, where the OS can freeze or kill the
    // renderer without a reliable Capacitor `appStateChange`.
    if (shouldBridgeVisibilityLifecycle(ctx)) {
      activeVisibilityHandler = () => {
        setAppActive(document.visibilityState !== "hidden");
      };
      document.addEventListener("visibilitychange", activeVisibilityHandler);
    }

    void Promise.resolve(
      CapacitorApp.addListener("backButton", ({ canGoBack }) => {
        // Give the shell first crack at the back press: an open chat sheet (or
        // any future back-dismissable overlay) closes ONE layer and reports it
        // handled, so hardware back dismisses the sheet instead of navigating
        // the app out from under it — matching desktop/web Escape-to-close
        // (#9148). `dispatchBackIntent` resolves synchronously; only an
        // unhandled press falls through to the app's default back below.
        if (dispatchBackIntent()) return;
        if (canGoBack) {
          window.history.back();
        } else {
          // At the root view the hardware back button was a no-op (the app
          // felt frozen). Match Android convention: send the app to the
          // background (minimize) rather than killing it, so the agent + state
          // survive.
          void CapacitorApp.minimizeApp().catch(() => {
            // error-policy:J4 minimizeApp is Android-only; elsewhere the back
            // press simply no-ops at the root view.
          });
        }
      }),
      // error-policy:J4 App plugin unavailable — the back press no-ops
    ).catch((error) => {
      logNativePluginUnavailable("App", error);
    });

    // Module evaluation owns the earliest possible registration, while this
    // second entry covers SSR/test imports that first ran without a native
    // window. The shared promise keeps both paths on one OS listener.
    void installMobileDeepLinkIngress(ctx.isNative);
    attachMobileDeepLinkHandler(handleDeepLinkOnce);

    let replayTimer: ReturnType<typeof setInterval> | null = null;
    const replayStartedAt = Date.now();
    const stopReplay = (): void => {
      if (!replayTimer) return;
      clearInterval(replayTimer);
      replayTimer = null;
    };
    const readLaunchUrl = (): void => {
      void CapacitorApp.getLaunchUrl()
        .then((result) => {
          if (handleDeepLinkOnce(result?.url)) stopReplay();
        })
        // error-policy:J4 App plugin unavailable — stop the replay loop
        .catch((error) => {
          stopReplay();
          logNativePluginUnavailable("App", error);
        });
    };
    readLaunchUrl();
    replayTimer = setInterval(() => {
      if (Date.now() - replayStartedAt >= COLD_LAUNCH_URL_REPLAY_MS) {
        stopReplay();
        return;
      }
      readLaunchUrl();
    }, COLD_LAUNCH_URL_REPLAY_INTERVAL_MS);
    unrefTimer(replayTimer);
  }

  async function initializeNetworkListener(): Promise<void> {
    if (networkStatusListenerRegistered) return;
    networkStatusListenerRegistered = true;

    // Single source of truth for connectivity so the Capacitor `Network`
    // listener and the window online/offline fallback never double-dispatch.
    let lastConnected: boolean | null = null;
    const setConnected = (connected: boolean): void => {
      if (lastConnected === connected) return;
      lastConnected = connected;
      const detail: NetworkStatusChangeDetail = { connected };
      dispatchAppEvent(NETWORK_STATUS_CHANGE_EVENT, detail);
    };

    // Robust fallback: `online`/`offline` fire reliably on every surface — and on
    // Android the Capacitor `Network` plugin can be unavailable (observed absent
    // from the WebView bridge on-device), in which case the listener below never
    // registers and NETWORK_STATUS_CHANGE_EVENT (which the WebSocket reconnect
    // scheduler consumes to stop burning backoff in airplane mode) never fires.
    // Deduped via `setConnected`; registered idempotently at module scope.
    if (activeOnlineHandler)
      window.removeEventListener("online", activeOnlineHandler);
    if (activeOfflineHandler)
      window.removeEventListener("offline", activeOfflineHandler);
    activeOnlineHandler = () => setConnected(true);
    activeOfflineHandler = () => setConnected(false);
    window.addEventListener("online", activeOnlineHandler);
    window.addEventListener("offline", activeOfflineHandler);

    if (!ctx.isNative) return;

    try {
      const { Network } = await import("@capacitor/network");
      await Network.addListener("networkStatusChange", (status) => {
        setConnected(status.connected);
      });
    } catch (error) {
      // error-policy:J4 the online/offline fallback above remains active, so
      // leave the listener marked registered rather than resetting for a
      // native retry
      logNativePluginUnavailable("Network", error);
    }
  }

  return {
    initializeStatusBar,
    initializeKeyboard,
    initializeAppLifecycle,
    initializeNetworkListener,
    logNativePluginUnavailable,
  };
}

export type MobileLifecycle = ReturnType<typeof createMobileLifecycle>;
