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

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
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
    ).catch((error) => {
      logNativePluginUnavailable("App", error);
    });

    // Robust pause/resume fallback. `document.visibilitychange` fires reliably on
    // every surface (web, desktop, iOS/Android WebView) when the app is
    // backgrounded/foregrounded — including when the Capacitor `App` plugin's
    // `appStateChange` is delayed, missing, or (as observed on an Android
    // device) reports the App plugin as "not implemented", in which case the
    // listener above never registers and pause/resume would otherwise never
    // fire — so APP_PAUSE_EVENT-driven work (e.g. pruning backgrounded views to
    // reclaim memory) never runs on background. Deduped via `setAppActive` so it
    // never double-fires alongside a working `appStateChange`.
    if (activeVisibilityHandler) {
      document.removeEventListener("visibilitychange", activeVisibilityHandler);
    }
    activeVisibilityHandler = () => {
      setAppActive(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", activeVisibilityHandler);

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
            // minimizeApp is Android-only; ignore where unavailable.
          });
        }
      }),
    ).catch((error) => {
      logNativePluginUnavailable("App", error);
    });

    void Promise.resolve(
      CapacitorApp.addListener("appUrlOpen", ({ url }) => {
        handleDeepLinkOnce(url);
      }),
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
    const readLaunchUrl = (): void => {
      void CapacitorApp.getLaunchUrl()
        .then((result) => {
          if (handleDeepLinkOnce(result?.url)) stopReplay();
        })
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

    try {
      const { Network } = await import("@capacitor/network");
      await Network.addListener("networkStatusChange", (status) => {
        setConnected(status.connected);
      });
    } catch (error) {
      // The online/offline fallback above remains active, so leave the listener
      // marked registered rather than resetting for a native retry.
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
