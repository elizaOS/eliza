// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

/**
 * Coverage for `src/mobile-lifecycle.ts` — the idempotent Capacitor lifecycle
 * wiring (`createMobileLifecycle`). Exercises the two device-free seams a
 * jsdom test can drive deterministically:
 *
 *   - `initializeAppLifecycle()` — `@capacitor/app` `appStateChange` /
 *     `backButton` / `appUrlOpen` listeners + the cold-launch `getLaunchUrl()`
 *     deep-link bootstrap. Asserts the events the module dispatches
 *     (`APP_RESUME_EVENT` / `APP_PAUSE_EVENT`), the shipped Android hardware
 *     back contract (#9148) — `dispatchBackIntent()` gets first crack and a
 *     handled press returns early; an unhandled press falls through to
 *     `window.history.back()` when `canGoBack`, else `CapacitorApp.minimizeApp()`
 *     — and that both cold (`getLaunchUrl`) and warm (`appUrlOpen`) launches
 *     route through `ctx.handleDeepLink`.
 *   - `initializeNetworkListener()` — `@capacitor/network` `networkStatusChange`
 *     listener → `NETWORK_STATUS_CHANGE_EVENT` with the `{ connected }` detail.
 *
 * Both also assert the double-init idempotency guards: calling an initializer
 * twice registers its native listener exactly once.
 *
 * `@capacitor/app` is mocked with a fake listener registry so the test can
 * synchronously fire the captured handlers; `@capacitor/network` and
 * `@capacitor/keyboard` are mocked because `mobile-lifecycle.ts` imports them
 * (keyboard statically, network dynamically). The events are dispatched on
 * `document`, so the assertions listen on `document` (see
 * `dispatchAppEvent` in `@elizaos/ui/events`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  type BackIntentEventDetail,
  ELIZA_BACK_INTENT_EVENT,
  NETWORK_STATUS_CHANGE_EVENT,
} from "@elizaos/ui/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CapacitorEventHandler = (payload: unknown) => void;
type ListenerHandle = { remove: () => Promise<void> };

const { appListeners, networkListeners, capacitorAppMock, networkMock } =
  vi.hoisted(() => {
    const appListeners = new Map<string, CapacitorEventHandler[]>();
    const networkListeners = new Map<string, CapacitorEventHandler[]>();

    function record(
      registry: Map<string, CapacitorEventHandler[]>,
      eventName: string,
      handler: CapacitorEventHandler,
    ): Promise<ListenerHandle> {
      const handlers = registry.get(eventName) ?? [];
      handlers.push(handler);
      registry.set(eventName, handlers);
      return Promise.resolve({
        remove: async () => {
          const current = registry.get(eventName) ?? [];
          registry.set(
            eventName,
            current.filter((fn) => fn !== handler),
          );
        },
      });
    }

    let launchUrl: { url?: string } | null = null;

    return {
      appListeners,
      networkListeners,
      capacitorAppMock: {
        addListener: vi.fn(
          (eventName: string, handler: CapacitorEventHandler) =>
            record(appListeners, eventName, handler),
        ),
        getLaunchUrl: vi.fn(() => Promise.resolve(launchUrl)),
        minimizeApp: vi.fn(() => Promise.resolve()),
        __setLaunchUrl(next: { url?: string } | null) {
          launchUrl = next;
        },
      },
      networkMock: {
        addListener: vi.fn(
          (eventName: string, handler: CapacitorEventHandler) =>
            record(networkListeners, eventName, handler),
        ),
      },
    };
  });

vi.mock("@capacitor/app", () => ({ App: capacitorAppMock }));
vi.mock("@capacitor/network", () => ({ Network: networkMock }));
// `mobile-lifecycle.ts` imports these statically; only the app lifecycle and
// network paths are exercised here, so the keyboard module just needs to load.
vi.mock("@capacitor/keyboard", () => ({
  Keyboard: {
    setResizeMode: vi.fn(async () => undefined),
    setScroll: vi.fn(async () => undefined),
    setAccessoryBarVisible: vi.fn(async () => undefined),
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
  },
  KeyboardResize: { None: "none" },
}));

import {
  createMobileLifecycle,
  type MobileLifecycleContext,
} from "../src/mobile-lifecycle";

function fireAppEvent(eventName: string, payload: unknown): void {
  for (const handler of appListeners.get(eventName) ?? []) handler(payload);
}

// Drive a real document.visibilitychange (the App-plugin-independent lifecycle
// signal) by overriding the read-only visibilityState then dispatching the event.
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function stubDisplayMode(mode: "standalone" | "fullscreen" | "browser"): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes(`display-mode: ${mode}`),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function fireNetworkEvent(eventName: string, payload: unknown): void {
  for (const handler of networkListeners.get(eventName) ?? []) handler(payload);
}

function makeContext(
  overrides: Partial<MobileLifecycleContext> = {},
): MobileLifecycleContext {
  return {
    isNative: true,
    isIOS: false,
    isAndroid: true,
    logPrefix: "[test]",
    handleDeepLink: vi.fn(),
    ...overrides,
  };
}

let historyBackSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  appListeners.clear();
  networkListeners.clear();
  capacitorAppMock.__setLaunchUrl(null);
  historyBackSpy = vi
    .spyOn(window.history, "back")
    .mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  historyBackSpy.mockRestore();
  delete (window as { matchMedia?: unknown }).matchMedia;
  delete (navigator as { standalone?: unknown }).standalone;
});

describe("createMobileLifecycle — app lifecycle", () => {
  it("keeps the production app entrypoint delegating app lifecycle to this module (no stale inline duplicate)", () => {
    const mainSrc = readFileSync(join(import.meta.dirname, "../src/main.tsx"), {
      encoding: "utf8",
    });

    // The live entrypoint must route through the extracted helper — this suite
    // certifies the shipped behavior only while main.tsx actually calls it.
    expect(mainSrc).toContain("getMobileLifecycle().initializeAppLifecycle()");
    expect(mainSrc).toContain(
      "getMobileLifecycle().initializeNetworkListener()",
    );
    // ...and must not keep an inline duplicate of the wiring this module owns
    // (the pre-extraction copies of the visibilitychange fallback and the
    // hardware-back handler), or the tested code diverges from what ships.
    expect(mainSrc).not.toContain('addEventListener("visibilitychange"');
    expect(mainSrc).not.toContain('addListener("backButton"');
    expect(mainSrc).not.toContain('addListener("appStateChange"');
  });

  it("dispatches APP_RESUME_EVENT when the app becomes active", async () => {
    const lifecycle = createMobileLifecycle(makeContext());
    const resume = vi.fn();
    document.addEventListener(APP_RESUME_EVENT, resume);

    lifecycle.initializeAppLifecycle();
    await vi.waitFor(() =>
      expect(appListeners.has("appStateChange")).toBe(true),
    );

    fireAppEvent("appStateChange", { isActive: true });

    expect(resume).toHaveBeenCalledTimes(1);
    document.removeEventListener(APP_RESUME_EVENT, resume);
  });

  it("dispatches APP_PAUSE_EVENT when the app becomes inactive", async () => {
    const lifecycle = createMobileLifecycle(makeContext());
    const pause = vi.fn();
    document.addEventListener(APP_PAUSE_EVENT, pause);

    lifecycle.initializeAppLifecycle();
    await vi.waitFor(() =>
      expect(appListeners.has("appStateChange")).toBe(true),
    );

    fireAppEvent("appStateChange", { isActive: false });

    expect(pause).toHaveBeenCalledTimes(1);
    document.removeEventListener(APP_PAUSE_EVENT, pause);
  });

  it("dispatches APP_PAUSE_EVENT on visibilitychange to hidden (App-plugin-independent fallback)", async () => {
    const lifecycle = createMobileLifecycle(makeContext());
    const pause = vi.fn();
    document.addEventListener(APP_PAUSE_EVENT, pause);

    lifecycle.initializeAppLifecycle();
    setVisibility("hidden");

    // The visibilitychange fallback fires pause even though the Capacitor `App`
    // plugin's appStateChange may be unavailable / not implemented on the device.
    expect(pause).toHaveBeenCalledTimes(1);
    document.removeEventListener(APP_PAUSE_EVENT, pause);
    setVisibility("visible");
  });

  it("dispatches APP_RESUME_EVENT on visibilitychange back to visible", async () => {
    const lifecycle = createMobileLifecycle(makeContext());
    lifecycle.initializeAppLifecycle();
    setVisibility("hidden");

    const resume = vi.fn();
    document.addEventListener(APP_RESUME_EVENT, resume);
    setVisibility("visible");

    expect(resume).toHaveBeenCalledTimes(1);
    document.removeEventListener(APP_RESUME_EVENT, resume);
  });

  it("does not dispatch app lifecycle events from a normal browser tab visibilitychange", () => {
    stubDisplayMode("browser");
    const lifecycle = createMobileLifecycle(
      makeContext({ isNative: false, isIOS: false, isAndroid: false }),
    );
    const pause = vi.fn();
    const resume = vi.fn();
    document.addEventListener(APP_PAUSE_EVENT, pause);
    document.addEventListener(APP_RESUME_EVENT, resume);

    lifecycle.initializeAppLifecycle();
    setVisibility("hidden");
    setVisibility("visible");

    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    document.removeEventListener(APP_PAUSE_EVENT, pause);
    document.removeEventListener(APP_RESUME_EVENT, resume);
  });

  it("dispatches app lifecycle events from an installed web PWA visibilitychange", () => {
    stubDisplayMode("standalone");
    const lifecycle = createMobileLifecycle(
      makeContext({ isNative: false, isIOS: false, isAndroid: false }),
    );
    const pause = vi.fn();
    const resume = vi.fn();
    document.addEventListener(APP_PAUSE_EVENT, pause);
    document.addEventListener(APP_RESUME_EVENT, resume);

    lifecycle.initializeAppLifecycle();
    setVisibility("hidden");
    setVisibility("visible");

    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    document.removeEventListener(APP_PAUSE_EVENT, pause);
    document.removeEventListener(APP_RESUME_EVENT, resume);
  });

  it("does not double-dispatch when appStateChange and visibilitychange report the same transition", async () => {
    const lifecycle = createMobileLifecycle(makeContext());
    const pause = vi.fn();
    document.addEventListener(APP_PAUSE_EVENT, pause);

    lifecycle.initializeAppLifecycle();
    await vi.waitFor(() =>
      expect(appListeners.has("appStateChange")).toBe(true),
    );

    // Both signals report the same background transition; dedup => one PAUSE.
    fireAppEvent("appStateChange", { isActive: false });
    setVisibility("hidden");

    expect(pause).toHaveBeenCalledTimes(1);
    document.removeEventListener(APP_PAUSE_EVENT, pause);
    setVisibility("visible");
  });

  it("gives dispatchBackIntent first crack: a handled back press neither navigates nor minimizes", async () => {
    const lifecycle = createMobileLifecycle(makeContext());
    lifecycle.initializeAppLifecycle();
    await vi.waitFor(() => expect(appListeners.has("backButton")).toBe(true));

    // A shell consumer (e.g. the open chat sheet) claims the press (#9148).
    const consumeBackIntent = (event: Event) => {
      (event as CustomEvent<BackIntentEventDetail>).detail.handled = true;
    };
    window.addEventListener(ELIZA_BACK_INTENT_EVENT, consumeBackIntent);
    try {
      fireAppEvent("backButton", { canGoBack: true });
      fireAppEvent("backButton", { canGoBack: false });
    } finally {
      window.removeEventListener(ELIZA_BACK_INTENT_EVENT, consumeBackIntent);
    }

    // Handled → early return: no history navigation, no minimize — regardless
    // of canGoBack.
    expect(historyBackSpy).not.toHaveBeenCalled();
    expect(capacitorAppMock.minimizeApp).not.toHaveBeenCalled();
  });

  it("falls through an unhandled back press to window.history.back() when canGoBack", async () => {
    const lifecycle = createMobileLifecycle(makeContext());
    lifecycle.initializeAppLifecycle();
    await vi.waitFor(() => expect(appListeners.has("backButton")).toBe(true));

    // No consumer claims the intent (sheet at rest) → default back navigation.
    fireAppEvent("backButton", { canGoBack: true });

    expect(historyBackSpy).toHaveBeenCalledTimes(1);
    expect(capacitorAppMock.minimizeApp).not.toHaveBeenCalled();
  });

  it("minimizes the app on an unhandled back press at the root view (!canGoBack)", async () => {
    const lifecycle = createMobileLifecycle(makeContext());
    lifecycle.initializeAppLifecycle();
    await vi.waitFor(() => expect(appListeners.has("backButton")).toBe(true));

    // No consumer + no history → Android convention: background, don't freeze.
    fireAppEvent("backButton", { canGoBack: false });

    expect(historyBackSpy).not.toHaveBeenCalled();
    expect(capacitorAppMock.minimizeApp).toHaveBeenCalledTimes(1);
  });

  it("routes warm-launch appUrlOpen URLs through handleDeepLink", async () => {
    const ctx = makeContext();
    const lifecycle = createMobileLifecycle(ctx);
    lifecycle.initializeAppLifecycle();
    await vi.waitFor(() => expect(appListeners.has("appUrlOpen")).toBe(true));

    fireAppEvent("appUrlOpen", { url: "elizaos://chat/abc" });

    expect(ctx.handleDeepLink).toHaveBeenCalledTimes(1);
    expect(ctx.handleDeepLink).toHaveBeenCalledWith("elizaos://chat/abc");
  });

  it("routes cold-launch getLaunchUrl URLs through handleDeepLink", async () => {
    const ctx = makeContext();
    capacitorAppMock.__setLaunchUrl({ url: "elizaos://voice" });
    const lifecycle = createMobileLifecycle(ctx);

    lifecycle.initializeAppLifecycle();

    await vi.waitFor(() =>
      expect(ctx.handleDeepLink).toHaveBeenCalledWith("elizaos://voice"),
    );
    expect(ctx.handleDeepLink).toHaveBeenCalledTimes(1);
  });

  it("replays a late cold-launch URL once during the bounded startup window (#12074)", async () => {
    vi.useFakeTimers();
    const ctx = makeContext();
    const lifecycle = createMobileLifecycle(ctx);

    lifecycle.initializeAppLifecycle();
    await vi.waitFor(() =>
      expect(capacitorAppMock.getLaunchUrl).toHaveBeenCalledTimes(1),
    );
    expect(ctx.handleDeepLink).not.toHaveBeenCalled();

    capacitorAppMock.__setLaunchUrl({
      url: "elizaos://aec-loop?tag=echo-only",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ctx.handleDeepLink).toHaveBeenCalledTimes(1);
    expect(ctx.handleDeepLink).toHaveBeenCalledWith(
      "elizaos://aec-loop?tag=echo-only",
    );

    fireAppEvent("appUrlOpen", { url: "elizaos://aec-loop?tag=echo-only" });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(ctx.handleDeepLink).toHaveBeenCalledTimes(1);
  });

  it("does not call handleDeepLink when there is no cold-launch URL", async () => {
    const ctx = makeContext();
    capacitorAppMock.__setLaunchUrl(null);
    const lifecycle = createMobileLifecycle(ctx);

    lifecycle.initializeAppLifecycle();
    await vi.waitFor(() =>
      expect(capacitorAppMock.getLaunchUrl).toHaveBeenCalled(),
    );

    expect(ctx.handleDeepLink).not.toHaveBeenCalled();
  });

  it("registers each native lifecycle listener exactly once across double-init", async () => {
    const lifecycle = createMobileLifecycle(makeContext());

    lifecycle.initializeAppLifecycle();
    lifecycle.initializeAppLifecycle();

    await vi.waitFor(() =>
      expect(appListeners.has("appStateChange")).toBe(true),
    );

    expect(appListeners.get("appStateChange")?.length).toBe(1);
    expect(appListeners.get("backButton")?.length).toBe(1);
    expect(appListeners.get("appUrlOpen")?.length).toBe(1);
    // addListener is called 3× total (one per event), not 6×.
    expect(capacitorAppMock.addListener).toHaveBeenCalledTimes(3);
    expect(capacitorAppMock.getLaunchUrl).toHaveBeenCalledTimes(1);
  });
});

describe("createMobileLifecycle — network listener", () => {
  it("dispatches NETWORK_STATUS_CHANGE_EVENT with the connected flag", async () => {
    const lifecycle = createMobileLifecycle(makeContext());
    const received: boolean[] = [];
    const onNetwork = (event: Event) => {
      received.push(
        (event as CustomEvent<{ connected: boolean }>).detail.connected,
      );
    };
    document.addEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);

    await lifecycle.initializeNetworkListener();
    await vi.waitFor(() =>
      expect(networkListeners.has("networkStatusChange")).toBe(true),
    );

    fireNetworkEvent("networkStatusChange", { connected: false });
    fireNetworkEvent("networkStatusChange", { connected: true });

    expect(received).toEqual([false, true]);
    document.removeEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);
  });

  it("dispatches NETWORK_STATUS_CHANGE_EVENT on window offline/online (fallback when the Network plugin is unavailable)", async () => {
    const lifecycle = createMobileLifecycle(makeContext());
    const received: boolean[] = [];
    const onNetwork = (event: Event) => {
      received.push(
        (event as CustomEvent<{ connected: boolean }>).detail.connected,
      );
    };
    document.addEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);

    await lifecycle.initializeNetworkListener();

    // The window online/offline fallback drives connectivity even when the
    // Capacitor Network plugin never registered (as observed on Android).
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));

    expect(received).toEqual([false, true]);
    document.removeEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);
  });

  it("uses only the browser network events outside the native shell", async () => {
    const lifecycle = createMobileLifecycle(
      makeContext({ isNative: false, isIOS: false, isAndroid: false }),
    );
    const received: boolean[] = [];
    const onNetwork = (event: Event) => {
      received.push(
        (event as CustomEvent<{ connected: boolean }>).detail.connected,
      );
    };
    document.addEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);

    await lifecycle.initializeNetworkListener();
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));

    expect(received).toEqual([false, true]);
    expect(networkMock.addListener).not.toHaveBeenCalled();
    document.removeEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);
  });

  it("does not double-dispatch when Capacitor networkStatusChange and window offline agree", async () => {
    const lifecycle = createMobileLifecycle(makeContext());
    const received: boolean[] = [];
    const onNetwork = (event: Event) => {
      received.push(
        (event as CustomEvent<{ connected: boolean }>).detail.connected,
      );
    };
    document.addEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);

    await lifecycle.initializeNetworkListener();
    await vi.waitFor(() =>
      expect(networkListeners.has("networkStatusChange")).toBe(true),
    );

    // Both signals report the same disconnect; dedup => one dispatch.
    fireNetworkEvent("networkStatusChange", { connected: false });
    window.dispatchEvent(new Event("offline"));

    expect(received).toEqual([false]);
    document.removeEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);
  });

  it("registers the network listener exactly once across double-init", async () => {
    const lifecycle = createMobileLifecycle(makeContext());

    await lifecycle.initializeNetworkListener();
    await lifecycle.initializeNetworkListener();

    expect(networkMock.addListener).toHaveBeenCalledTimes(1);
    expect(networkListeners.get("networkStatusChange")?.length).toBe(1);
  });
});
