/**
 * Verifies the window `online`/`offline` connectivity fallback in
 * `createMobileLifecycle().initializeNetworkListener` — the path that drives
 * NETWORK_STATUS_CHANGE_EVENT when the Capacitor Network plugin is absent from
 * the Android WebView bridge (mocked to throw here), including transition
 * de-duplication. jsdom harness.
 */
import { NETWORK_STATUS_CHANGE_EVENT } from "@elizaos/ui/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMobileLifecycle } from "./mobile-lifecycle";

// The live Android/Capacitor entrypoint (main.tsx `getMobileLifecycle()`)
// delegates its network listener to this helper's `initializeNetworkListener`,
// so the #10472 window `online`/`offline` fallback runs in production.
//
// Simulate the exact on-device failure that motivated the fallback: the
// Capacitor `Network` plugin is absent from the Android WebView bridge, so
// `import("@capacitor/network")` rejects and no native listener registers — only
// the window online/offline fallback can drive NETWORK_STATUS_CHANGE_EVENT.
vi.mock("@capacitor/network", () => {
  throw new Error("Network plugin unavailable (simulated Android WebView)");
});

function makeLifecycle() {
  return createMobileLifecycle({
    isNative: true,
    isIOS: false,
    isAndroid: true,
    logPrefix: "[test]",
    handleDeepLink: () => {},
  });
}

function captureNetworkEvents(): {
  events: boolean[];
  dispose: () => void;
} {
  const events: boolean[] = [];
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ connected: boolean }>).detail;
    events.push(detail.connected);
  };
  document.addEventListener(NETWORK_STATUS_CHANGE_EVENT, handler);
  return {
    events,
    dispose: () =>
      document.removeEventListener(NETWORK_STATUS_CHANGE_EVENT, handler),
  };
}

describe("network-status online/offline fallback (wired via getMobileLifecycle)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("dispatches NETWORK_STATUS_CHANGE_EVENT from window offline/online when the Network plugin is unavailable", async () => {
    const capture = captureNetworkEvents();
    try {
      await makeLifecycle().initializeNetworkListener();

      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));

      expect(capture.events).toEqual([false, true]);
    } finally {
      capture.dispose();
    }
  });

  it("dedupes repeated transitions so only real changes emit an event", async () => {
    const capture = captureNetworkEvents();
    try {
      await makeLifecycle().initializeNetworkListener();

      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));

      expect(capture.events).toEqual([false, true]);
    } finally {
      capture.dispose();
    }
  });
});
