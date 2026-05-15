// === Phase 5D: extracted from main.tsx ===
// Idempotent Capacitor lifecycle wiring for iOS/Android: status bar overlay
// + dark style, keyboard accessory/resize, app foreground/background events,
// back-button navigation, deep-link bootstrap (cold + warm), and the network
// connectivity bridge that lets the WebSocket reconnect scheduler stop
// burning backoff during airplane mode.

import { App as CapacitorApp } from "@capacitor/app";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import {
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  dispatchAppEvent,
  NETWORK_STATUS_CHANGE_EVENT,
  type NetworkStatusChangeDetail,
} from "@elizaos/ui";

export interface MobileLifecycleContext {
  isNative: boolean;
  isIOS: boolean;
  isAndroid: boolean;
  logPrefix: string;
  handleDeepLink: (url: string) => void;
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
  }

  function initializeAppLifecycle(): void {
    // Each Capacitor listener fires its handler N times if added N times;
    // guard against duplicate registrations from HMR / repeated init.
    if (lifecycleListenersRegistered) return;
    lifecycleListenersRegistered = true;

    void Promise.resolve(
      CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive) {
          dispatchAppEvent(APP_RESUME_EVENT);
        } else {
          dispatchAppEvent(APP_PAUSE_EVENT);
        }
      }),
    ).catch((error) => {
      logNativePluginUnavailable("App", error);
    });

    void Promise.resolve(
      CapacitorApp.addListener("backButton", ({ canGoBack }) => {
        if (canGoBack) {
          window.history.back();
        }
      }),
    ).catch((error) => {
      logNativePluginUnavailable("App", error);
    });

    void Promise.resolve(
      CapacitorApp.addListener("appUrlOpen", ({ url }) => {
        ctx.handleDeepLink(url);
      }),
    ).catch((error) => {
      logNativePluginUnavailable("App", error);
    });

    void CapacitorApp.getLaunchUrl()
      .then((result) => {
        if (result?.url) {
          ctx.handleDeepLink(result.url);
        }
      })
      .catch((error) => {
        logNativePluginUnavailable("App", error);
      });
  }

  async function initializeNetworkListener(): Promise<void> {
    if (networkStatusListenerRegistered) return;
    networkStatusListenerRegistered = true;
    try {
      const { Network } = await import("@capacitor/network");
      await Network.addListener("networkStatusChange", (status) => {
        const detail: NetworkStatusChangeDetail = {
          connected: status.connected,
        };
        dispatchAppEvent(NETWORK_STATUS_CHANGE_EVENT, detail);
      });
    } catch (error) {
      networkStatusListenerRegistered = false;
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
