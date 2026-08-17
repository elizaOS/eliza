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
  androidDeepLinkBuffer?: AndroidDeepLinkBuffer;
}

export interface AndroidDeepLinkBuffer {
  peekPendingUrl: () => Promise<{ url?: string | null }>;
  acknowledgePendingUrl: (options: {
    url: string;
  }) => Promise<{ cleared: boolean }>;
}

// There is one document/window, so there is one visibilitychange→lifecycle and
// one online/offline→network bridge. Tracked at module scope so re-init (HMR /
// repeated init) replaces the previous handlers instead of leaking new ones.
let activeVisibilityHandler: (() => void) | null = null;
let activeOnlineHandler: (() => void) | null = null;
let activeOfflineHandler: (() => void) | null = null;

const COLD_LAUNCH_URL_REPLAY_MS = 15_000;
const COLD_LAUNCH_URL_REPLAY_INTERVAL_MS = 1_000;

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

function shouldBridgeVisibilityLifecycle(ctx: MobileLifecycleContext): boolean {
  return ctx.isNative || isStandalonePwa();
}

export function createMobileLifecycle(ctx: MobileLifecycleContext) {
  let keyboardListenersRegistered = false;
  let deepLinkListenerRegistered = false;
  let deepLinkHandlingReady = false;
  let lifecycleListenersRegistered = false;
  let networkStatusListenerRegistered = false;
  const handledDeepLinks = new Set<string>();
  const pendingDeepLinks = new Map<string, Array<() => void>>();

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
        // The app already provides its own chat controls; Capacitor's optional
        // previous/next/done strip is redundant on the iPhone keyboard.
        await Keyboard.setAccessoryBarVisible({ isVisible: false });
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

  function initializeDeepLinks(): void {
    if (deepLinkListenerRegistered) return;
    deepLinkListenerRegistered = true;

    const acknowledgeBufferedUrl = (url: string): (() => void) | undefined => {
      if (!ctx.androidDeepLinkBuffer) return undefined;
      return () => {
        void ctx.androidDeepLinkBuffer
          ?.acknowledgePendingUrl({ url })
          .catch((error) => {
            // error-policy:J4 native replay remains pending for the next
            // renderer when acknowledgement cannot reach the optional plugin
            logNativePluginUnavailable("DeepLinkBuffer", error);
          });
      };
    };

    const captureDeepLinkOnce = (
      url: string | null | undefined,
      acknowledge?: () => void,
    ): boolean => {
      const trimmed = url?.trim();
      if (!trimmed) return false;
      if (handledDeepLinks.has(trimmed)) {
        if (deepLinkHandlingReady) {
          acknowledge?.();
        } else if (acknowledge) {
          pendingDeepLinks.get(trimmed)?.push(acknowledge);
        }
        return false;
      }
      handledDeepLinks.add(trimmed);
      if (deepLinkHandlingReady) {
        ctx.handleDeepLink(trimmed);
        acknowledge?.();
      } else {
        pendingDeepLinks.set(trimmed, acknowledge ? [acknowledge] : []);
      }
      return true;
    };

    // Warm intents can arrive while the renderer is reloading. main.tsx arms
    // this during module evaluation, before DOMContentLoaded, so Capacitor never
    // dispatches a URL only into the previous document's dead callback registry.
    void Promise.resolve(
      CapacitorApp.addListener("appUrlOpen", ({ url }) => {
        captureDeepLinkOnce(url);
      }),
      // error-policy:J4 App plugin unavailable — deep links degrade to the
      // cold-launch replay below / web routing
    ).catch((error) => {
      logNativePluginUnavailable("App", error);
    });

    let replayTimer: ReturnType<typeof setInterval> | null = null;
    const replayStartedAt = Date.now();
    const stopReplay = (): void => {
      if (!replayTimer) return;
      clearInterval(replayTimer);
      replayTimer = null;
    };
    const readLaunchUrls = (): void => {
      void CapacitorApp.getLaunchUrl()
        .then((result) => {
          captureDeepLinkOnce(result?.url);
        })
        // error-policy:J4 App plugin unavailable — native replay may still work
        .catch((error) => {
          logNativePluginUnavailable("App", error);
        });
      if (ctx.androidDeepLinkBuffer) {
        void ctx.androidDeepLinkBuffer
          .peekPendingUrl()
          .then((result) => {
            const url = result?.url;
            captureDeepLinkOnce(
              url,
              url ? acknowledgeBufferedUrl(url) : undefined,
            );
          })
          // error-policy:J4 optional Android replay bridge — Capacitor App
          // remains the ordinary cold/warm deep-link path
          .catch((error) => {
            logNativePluginUnavailable("DeepLinkBuffer", error);
          });
      }
    };
    readLaunchUrls();
    replayTimer = setInterval(() => {
      if (Date.now() - replayStartedAt >= COLD_LAUNCH_URL_REPLAY_MS) {
        stopReplay();
        return;
      }
      readLaunchUrls();
    }, COLD_LAUNCH_URL_REPLAY_INTERVAL_MS);
    unrefTimer(replayTimer);
  }

  function initializeAppLifecycle(): void {
    initializeDeepLinks();
    if (!deepLinkHandlingReady) {
      deepLinkHandlingReady = true;
      for (const [url, acknowledgements] of pendingDeepLinks) {
        ctx.handleDeepLink(url);
        for (const acknowledge of acknowledgements) acknowledge();
      }
      pendingDeepLinks.clear();
    }

    // Each Capacitor listener fires its handler N times if added N times;
    // guard against duplicate registrations from HMR / repeated init.
    if (lifecycleListenersRegistered) return;
    lifecycleListenersRegistered = true;

    // Single source of truth for the foreground/background state so the
    // Capacitor `appStateChange` listener and the `visibilitychange` fallback
    // below never double-dispatch — each only fires on an actual transition.
    let lastActive: boolean | null = null;
    const setAppActive = (active: boolean): void => {
      if (lastActive === active) return;
      lastActive = active;
      dispatchAppEvent(active ? APP_RESUME_EVENT : APP_PAUSE_EVENT);
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
    initializeDeepLinks,
    initializeAppLifecycle,
    initializeNetworkListener,
    logNativePluginUnavailable,
  };
}

export type MobileLifecycle = ReturnType<typeof createMobileLifecycle>;
