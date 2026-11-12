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
import type { NetworkStatusChangeDetail } from "@elizaos/core/protocol";
import {
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  dispatchAppEvent,
  dispatchBackIntent,
  initializeIosKeyboardAccessoryBar,
  isStandalonePwa,
  NETWORK_STATUS_CHANGE_EVENT,
} from "@elizaos/ui";

/** Native consumption may follow either applied navigation or explicit rejection. */
export type DeepLinkApplicationResult = boolean | { rejected: true };

export interface MobileLifecycleContext {
  isNative: boolean;
  isIOS: boolean;
  isAndroid: boolean;
  logPrefix: string;
  /**
   * Most deep-link routes finish synchronously; the top-level-surface
   * navigation-intent route returns a promise that resolves once the intent
   * actually landed in the shell (not merely enqueued). `initializeDeepLinks`
   * awaits it before acknowledging the Android capture receipt.
   */
  handleDeepLink: (
    url: string,
  ) => undefined | Promise<DeepLinkApplicationResult>;
  androidDeepLinkBuffer?: AndroidDeepLinkBuffer;
}

export interface AndroidDeepLinkReceipt {
  url?: string | null;
  receiptId?: string | null;
  receiptVersion?: number;
}

export interface AndroidDeepLinkBuffer {
  peekPendingUrl: () => Promise<AndroidDeepLinkReceipt>;
  acknowledgePendingUrl: (options: {
    url: string;
    receiptId: string;
  }) => Promise<{ cleared: boolean }>;
}

type DeepLinkAttempt = {
  url: string;
  key?: string;
  acknowledgements: Array<() => void>;
  completed: boolean;
};

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
  // Replay identity is a native capture receipt on v2 Android shells, and a
  // URL on legacy/iOS launch channels. Warm legacy events remain distinct.
  const replayAttempts = new Map<string, DeepLinkAttempt>();
  const coldLaunchEchoCandidates = new Set<string>();
  const pendingDeepLinks: DeepLinkAttempt[] = [];

  const applyDeepLink = (attempt: DeepLinkAttempt): void => {
    const failed = (error?: unknown): void => {
      if (attempt.key && replayAttempts.get(attempt.key) === attempt) {
        replayAttempts.delete(attempt.key);
      }
      if (error !== undefined) {
        // error-policy:J1 failed application does not authorize acknowledgement.
        console.warn(
          `${ctx.logPrefix} Deep-link navigation application failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    };
    const completed = (): void => {
      attempt.completed = true;
      for (const acknowledge of attempt.acknowledgements.splice(0))
        acknowledge();
    };
    try {
      const result = ctx.handleDeepLink(attempt.url);
      if (result && typeof result.then === "function") {
        void result
          .then((applied) => {
            if (
              applied === true ||
              (typeof applied === "object" && applied?.rejected === true)
            ) {
              completed();
            } else {
              failed();
            }
          })
          .catch(failed);
      } else {
        completed();
      }
    } catch (error) {
      // error-policy:J1 synchronous routes retain the same retry authority.
      failed(error);
    }
  };

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
        // Preserve the navigation/dismissal accessory for ordinary forms. The
        // chat composer suppresses it only while that field owns focus.
        await initializeIosKeyboardAccessoryBar();
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

    const buffer = ctx.androidDeepLinkBuffer;
    let receiptMode: "pending" | "legacy" | "receipt" = buffer
      ? "pending"
      : "legacy";
    const pendingLegacyLaunch = new Set<string>();
    let replayTimer: ReturnType<typeof setInterval> | null = null;

    const captureDeepLinkOnce = (
      url: string | null | undefined,
      acknowledge?: () => void,
      expectsAppUrlOpenEcho = false,
      receiptId?: string,
    ): void => {
      const trimmed = url?.trim();
      if (!trimmed) return;
      const key = receiptId ? `receipt:${receiptId}` : `url:${trimmed}`;
      const existing = replayAttempts.get(key);
      if (existing) {
        if (acknowledge) {
          if (existing.completed) acknowledge();
          else existing.acknowledgements.push(acknowledge);
        }
        return;
      }
      if (replayTimer && expectsAppUrlOpenEcho)
        coldLaunchEchoCandidates.add(trimmed);
      const attempt: DeepLinkAttempt = {
        url: trimmed,
        key,
        acknowledgements: acknowledge ? [acknowledge] : [],
        completed: false,
      };
      replayAttempts.set(key, attempt);
      if (deepLinkHandlingReady) applyDeepLink(attempt);
      else pendingDeepLinks.push(attempt);
    };

    const captureWarmDeepLink = (url: string | null | undefined): void => {
      const trimmed = url?.trim();
      if (!trimmed) return;
      if (coldLaunchEchoCandidates.delete(trimmed)) {
        captureDeepLinkOnce(trimmed);
        return;
      }
      // URL-only warm events are distinct actions, but cannot safely consume a
      // native slot that may already contain a newer identical URL.
      const attempt: DeepLinkAttempt = {
        url: trimmed,
        key: `url:${trimmed}`,
        acknowledgements: [],
        completed: false,
      };
      replayAttempts.set(`url:${trimmed}`, attempt);
      if (deepLinkHandlingReady) applyDeepLink(attempt);
      else pendingDeepLinks.push(attempt);
    };

    const chooseReceiptMode = (mode: "legacy" | "receipt"): void => {
      receiptMode = mode;
      if (mode === "legacy") {
        for (const url of pendingLegacyLaunch)
          captureDeepLinkOnce(url, undefined, ctx.isIOS);
      }
      pendingLegacyLaunch.clear();
    };

    const captureReceipt = (receipt: AndroidDeepLinkReceipt): void => {
      const url = receipt.url?.trim();
      const receiptId = receipt.receiptId?.trim();
      if (!url) return;
      if (!receiptId) {
        // Receiptless responses preserve navigation without consuming a native
        // entry whose capture identity is unavailable.
        captureDeepLinkOnce(url);
        return;
      }
      captureDeepLinkOnce(
        url,
        () => {
          void buffer
            ?.acknowledgePendingUrl({ url, receiptId })
            .catch((error) => {
              // error-policy:J4 a later peek determines whether the native
              // acknowledgement applied before this transport failure.
              logNativePluginUnavailable("DeepLinkBuffer", error);
            });
        },
        false,
        receiptId,
      );
    };

    void Promise.resolve(
      CapacitorApp.addListener("appUrlOpen", (event) => {
        const receiptId = (event as { receiptId?: unknown }).receiptId;
        if (buffer && typeof receiptId === "string" && receiptId.trim()) {
          chooseReceiptMode("receipt");
          captureReceipt({ url: event.url, receiptId });
        } else if (receiptMode === "pending") {
          // A URL-only App event identifies the legacy event contract. Handle
          // it before flushing its possible getLaunchUrl alias.
          captureWarmDeepLink(event.url);
          chooseReceiptMode("legacy");
        } else if (receiptMode === "legacy") {
          captureWarmDeepLink(event.url);
        }
      }),
      // error-policy:J4 native replay may still deliver the pending capture.
    ).catch((error) => logNativePluginUnavailable("App", error));

    const replayStartedAt = Date.now();
    const stopReplay = (): void => {
      if (!replayTimer) return;
      clearInterval(replayTimer);
      replayTimer = null;
      coldLaunchEchoCandidates.clear();
      // An optional native version query can remain unresolved. The existing
      // replay deadline must still release queued URL-only navigation.
      if (receiptMode === "pending") chooseReceiptMode("legacy");
    };
    const readLaunchUrls = (): void => {
      void CapacitorApp.getLaunchUrl()
        .then((result) => {
          const url = result?.url;
          if (!url || receiptMode === "receipt") return;
          if (receiptMode === "pending") pendingLegacyLaunch.add(url);
          else captureDeepLinkOnce(url, undefined, ctx.isIOS);
        })
        .catch((error) => {
          // error-policy:J4 the native receipt channel may still be available.
          logNativePluginUnavailable("App", error);
        });
      if (buffer) {
        void buffer
          .peekPendingUrl()
          .then((result) => {
            if (result.receiptVersion === 2) {
              chooseReceiptMode("receipt");
              captureReceipt(result);
            } else {
              chooseReceiptMode("legacy");
              captureDeepLinkOnce(result.url);
            }
          })
          .catch((error) => {
            // error-policy:J4 an App receipt can still identify this capture.
            // The replay deadline releases URL-only delivery if none arrives.
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
      for (const attempt of pendingDeepLinks) applyDeepLink(attempt);
      pendingDeepLinks.length = 0;
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

    // AppWeb also turns document visibility into appStateChange. Apply the
    // same suspend policy to that bridge so hiding a desktop browser tab does
    // not cancel its chat through the native lifecycle listener.
    if (shouldBridgeVisibilityLifecycle(ctx)) {
      void Promise.resolve(
        CapacitorApp.addListener("appStateChange", ({ isActive }) => {
          setAppActive(isActive);
        }),
        // error-policy:J4 App plugin unavailable — the visibilitychange fallback
        // still drives pause/resume on native and installed-PWA surfaces.
      ).catch((error) => {
        logNativePluginUnavailable("App", error);
      });
    }

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
