/**
 * Exercises the browser/native lifecycle as one jsdom integration: an OS link
 * arriving before React wiring is queued, cold and warm links dedupe, native
 * listener readiness is observable, and the sibling app/network/keyboard
 * bridges remain live.
 */
import {
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  ELIZA_BACK_INTENT_EVENT,
  NETWORK_STATUS_CHANGE_EVENT,
} from "@elizaos/ui/events";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  appListeners: new Map<string, (payload: never) => void>(),
  keyboardListeners: new Map<string, (payload: never) => void>(),
  networkListener: null as ((payload: { connected: boolean }) => void) | null,
  launchUrl: "elizaos://settings?source=cold",
  rejectAppUrlListener: false,
  minimizeApp: vi.fn(async () => {}),
  statusCalls: [] as Array<[string, unknown]>,
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(
      async (name: string, listener: (payload: never) => void) => {
        if (name === "appUrlOpen" && native.rejectAppUrlListener) {
          throw new Error("native listener rejected");
        }
        native.appListeners.set(name, listener);
        return { remove: async () => native.appListeners.delete(name) };
      },
    ),
    getLaunchUrl: vi.fn(async () => ({ url: native.launchUrl })),
    minimizeApp: native.minimizeApp,
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock("@capacitor/keyboard", () => ({
  KeyboardResize: { None: "none" },
  Keyboard: {
    setResizeMode: vi.fn(async () => {}),
    setScroll: vi.fn(async () => {}),
    setAccessoryBarVisible: vi.fn(async () => {}),
    addListener: vi.fn((name: string, listener: (payload: never) => void) => {
      native.keyboardListeners.set(name, listener);
    }),
  },
}));

vi.mock("@capacitor/status-bar", () => ({
  Style: { Dark: "dark" },
  StatusBar: {
    setStyle: vi.fn(async (value) => native.statusCalls.push(["style", value])),
    setOverlaysWebView: vi.fn(async (value) =>
      native.statusCalls.push(["overlay", value]),
    ),
    setBackgroundColor: vi.fn(async (value) =>
      native.statusCalls.push(["background", value]),
    ),
  },
}));

vi.mock("@capacitor/network", () => ({
  Network: {
    addListener: vi.fn(
      async (
        _name: string,
        listener: (payload: { connected: boolean }) => void,
      ) => {
        native.networkListener = listener;
        return { remove: async () => (native.networkListener = null) };
      },
    ),
  },
}));

import { createMobileLifecycle } from "./mobile-lifecycle";

describe("mobile lifecycle ingress and bridges", () => {
  afterEach(() => {
    native.rejectAppUrlListener = false;
    document.body.className = "";
    document.body.style.removeProperty("--keyboard-height");
    vi.restoreAllMocks();
  });

  it("queues pre-mount links and drives every native lifecycle bridge", async () => {
    await vi.waitFor(() => {
      expect(document.documentElement.dataset.elizaMobileDeepLinkReady).toBe(
        "ready",
      );
    });

    const earlyLink =
      "elizaos://first-run/runtime/remote?api=http://127.0.0.1:31337";
    const ingressCountBefore = Number(
      document.documentElement.dataset.elizaMobileDeepLinkCount ?? "0",
    );
    native.appListeners.get("appUrlOpen")?.({ url: earlyLink } as never);
    expect(
      Number(document.documentElement.dataset.elizaMobileDeepLinkCount),
    ).toBe(ingressCountBefore + 1);

    const deepLinks: string[] = [];
    const lifecycle = createMobileLifecycle({
      isNative: true,
      isIOS: false,
      isAndroid: true,
      logPrefix: "[test]",
      handleDeepLink: (url) => deepLinks.push(url),
    });

    const appStates: string[] = [];
    const networkStates: boolean[] = [];
    const onPause = () => appStates.push("pause");
    const onResume = () => appStates.push("resume");
    const onNetwork = (event: Event) =>
      networkStates.push(
        (event as CustomEvent<{ connected: boolean }>).detail.connected,
      );
    document.addEventListener(APP_PAUSE_EVENT, onPause);
    document.addEventListener(APP_RESUME_EVENT, onResume);
    document.addEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);

    await lifecycle.initializeStatusBar();
    await lifecycle.initializeKeyboard();
    lifecycle.initializeAppLifecycle();
    await lifecycle.initializeNetworkListener();

    await vi.waitFor(() => {
      expect(deepLinks).toEqual([earlyLink, native.launchUrl]);
    });
    expect(native.statusCalls.map(([name]) => name)).toEqual([
      "style",
      "overlay",
      "background",
    ]);

    native.appListeners.get("appUrlOpen")?.({ url: earlyLink } as never);
    native.appListeners.get("appUrlOpen")?.({
      url: "elizaos://wallet?source=warm",
    } as never);
    expect(
      Number(document.documentElement.dataset.elizaMobileDeepLinkCount),
    ).toBe(ingressCountBefore + 3);
    expect(deepLinks).toEqual([
      earlyLink,
      native.launchUrl,
      "elizaos://wallet?source=warm",
    ]);

    native.appListeners.get("appStateChange")?.({ isActive: false } as never);
    native.appListeners.get("appStateChange")?.({ isActive: false } as never);
    native.appListeners.get("appStateChange")?.({ isActive: true } as never);
    expect(appStates).toEqual(["pause", "resume"]);

    native.keyboardListeners.get("keyboardWillShow")?.({
      keyboardHeight: 321,
    } as never);
    expect(document.body.classList.contains("keyboard-open")).toBe(true);
    expect(document.body.style.getPropertyValue("--keyboard-height")).toBe(
      "321px",
    );
    native.keyboardListeners.get("keyboardWillHide")?.({} as never);
    expect(document.body.classList.contains("keyboard-open")).toBe(false);

    native.networkListener?.({ connected: false });
    native.networkListener?.({ connected: false });
    window.dispatchEvent(new Event("online"));
    expect(networkStates).toEqual([false, true]);

    native.appListeners.get("backButton")?.({ canGoBack: false } as never);
    expect(native.minimizeApp).toHaveBeenCalledTimes(1);
    const handleBack = (event: Event) => {
      (event as CustomEvent<{ handled: boolean }>).detail.handled = true;
    };
    window.addEventListener(ELIZA_BACK_INTENT_EVENT, handleBack);
    native.appListeners.get("backButton")?.({ canGoBack: false } as never);
    window.removeEventListener(ELIZA_BACK_INTENT_EVENT, handleBack);
    expect(native.minimizeApp).toHaveBeenCalledTimes(1);

    const listenerCount = native.appListeners.size;
    lifecycle.initializeAppLifecycle();
    expect(native.appListeners.size).toBe(listenerCount);

    document.removeEventListener(APP_PAUSE_EVENT, onPause);
    document.removeEventListener(APP_RESUME_EVENT, onResume);
    document.removeEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);
  });

  it("publishes an unavailable state when native warm-link ingress rejects", async () => {
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for("eliza.mobile-deep-link-ingress")
    ];
    delete document.documentElement.dataset.elizaMobileDeepLinkReady;
    native.rejectAppUrlListener = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();

    await import("./mobile-lifecycle");
    await vi.waitFor(() => {
      expect(document.documentElement.dataset.elizaMobileDeepLinkReady).toBe(
        "unavailable",
      );
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("appUrlOpen listener unavailable"),
      "native listener rejected",
    );
  });
});
