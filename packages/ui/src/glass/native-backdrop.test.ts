/** Verifies the native-backdrop coordinator through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Contract tests for the native wallpaper lease coordinator: diagnostics probe,
 * store subscriptions, acquire/activate/release semantics (refusals, stale
 * epochs, exactly-once release, multi-holder), encode caching vs. re-piping,
 * the two-frame delayed native clear and its drag->settle cancellation, and
 * the React hooks that consume the store. Real coordinator module + real
 * bridge plumbing against an injected fake Capacitor plugin; the real-pixels
 * path is covered by device capture fixtures.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireNativeBackdrop,
  activateNativeBackdrop,
  isNativeBackdropActive,
  type NativeBackdropLease,
  nativeGlassDiag,
  releaseNativeBackdrop,
  resetNativeBackdropForTests,
  setNativeBackdropEncoderForTests,
  setNativeGlassDiag,
  setNativeWallpaperSource,
  subscribeNativeBackdrop,
  useNativeBackdropActive,
  useNativeGlassDiag,
} from "./native-backdrop";
import { resetGlassBridgeForTests } from "./native-bridge";

type CapGlobal = { Capacitor?: unknown };

function fakeBridge(overrides: Record<string, unknown> = {}) {
  return {
    attachGlass: vi.fn(async (_options: unknown) => ({ attached: true })),
    updateRect: vi.fn(async () => {}),
    detachGlass: vi.fn(async () => {}),
    setGrouping: vi.fn(async () => {}),
    setBackdrop: vi.fn(async (_options: unknown) => ({ applied: true })),
    clearBackdrop: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => ({ available: true })),
    ...overrides,
  };
}

function installCapacitor(
  bridge: ReturnType<typeof fakeBridge> | null,
  platform: "ios" | "android" = "ios",
) {
  (globalThis as CapGlobal).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    registerPlugin: <T>(name: string): T => {
      if (name !== "GlassBridge") throw new Error(`unexpected plugin ${name}`);
      if (!bridge) throw new Error("not registered");
      return bridge as unknown as T;
    },
  };
}

/** Publish an image wallpaper + a jsdom-safe encoder so callers can lease it. */
function seedWallpaper(
  overrides: Partial<{ url: string; color: string }> = {},
) {
  const url = overrides.url ?? "https://localhost/wallpapers/canopy.webp";
  const color = overrides.color ?? "#160d07";
  setNativeWallpaperSource({ imageUrl: url, color });
  return { url, color };
}

/** Lease the seeded wallpaper, returning null-safe access to the result. */
async function leaseSeeded(): Promise<NativeBackdropLease | null> {
  return acquireNativeBackdrop();
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetGlassBridgeForTests();
  resetNativeBackdropForTests();
  // resetNativeBackdropForTests deliberately preserves the diag probe; each
  // case normalizes it so assertions see their own slice of history.
  setNativeGlassDiag("idle");
});

afterEach(() => {
  cleanup();
  (globalThis as CapGlobal).Capacitor = undefined;
  resetGlassBridgeForTests();
  resetNativeBackdropForTests();
  setNativeGlassDiag("idle");
  setNativeBackdropEncoderForTests(null);
});

describe("native-backdrop diagnostics + store", () => {
  it("starts idle and inactive", () => {
    expect(nativeGlassDiag()).toBe("idle");
    expect(isNativeBackdropActive()).toBe(false);
  });

  it("notifies subscribers only when the diag slug actually changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNativeBackdrop(listener);

    setNativeGlassDiag("probe-a");
    setNativeGlassDiag("probe-a");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(nativeGlassDiag()).toBe("probe-a");

    unsubscribe();
    setNativeGlassDiag("probe-b");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("acquireNativeBackdrop", () => {
  it("resolves null with a diagnostic when no image wallpaper is published", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);

    const lease = await leaseSeeded();

    expect(lease).toBeNull();
    expect(nativeGlassDiag()).toBe("no-image-wallpaper");
    expect(bridge.setBackdrop).not.toHaveBeenCalled();
  });

  it("pipes encoded bytes to native and returns a live lease", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
    const { color } = seedWallpaper();

    const lease = await leaseSeeded();

    expect(lease).not.toBeNull();
    expect(lease?.released).toBe(false);
    expect(typeof lease?.epoch).toBe("number");
    expect(bridge.setBackdrop).toHaveBeenCalledTimes(1);
    expect(bridge.setBackdrop).toHaveBeenCalledWith({
      imageBase64: "Zm9vYmFy",
      color,
    });
    expect(nativeGlassDiag()).toBe("backdrop-leased");
    expect(isNativeBackdropActive()).toBe(false);
  });

  it("resolves null without calling native when encoding fails", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    setNativeBackdropEncoderForTests(async () => null);
    seedWallpaper();

    const lease = await leaseSeeded();

    expect(lease).toBeNull();
    expect(bridge.setBackdrop).not.toHaveBeenCalled();
    expect(isNativeBackdropActive()).toBe(false);
  });

  it("resolves null and records the refusal when native declines the backdrop", async () => {
    const bridge = fakeBridge({
      setBackdrop: vi.fn(async () => ({ applied: false })),
    });
    installCapacitor(bridge);
    setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
    seedWallpaper();

    const lease = await leaseSeeded();

    expect(lease).toBeNull();
    expect(nativeGlassDiag()).toBe("native-refused-backdrop");
    expect(isNativeBackdropActive()).toBe(false);
  });

  it("reuses the cached encode across leases but re-sends bytes to native", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    const encode = vi.fn(async () => "Zm9vYmFy");
    setNativeBackdropEncoderForTests(encode);
    seedWallpaper();

    const first = await leaseSeeded();
    releaseNativeBackdrop(first as NativeBackdropLease);
    await waitFor(() => expect(bridge.clearBackdrop).toHaveBeenCalledTimes(1));

    const second = await leaseSeeded();

    expect(second).not.toBeNull();
    expect(bridge.setBackdrop).toHaveBeenCalledTimes(2);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it("re-acquiring during the two-frame clear grace cancels the clear and skips re-piping", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
    seedWallpaper();

    const first = await leaseSeeded();
    releaseNativeBackdrop(first as NativeBackdropLease);
    const second = await leaseSeeded();

    expect(second).not.toBeNull();
    expect(bridge.setBackdrop).toHaveBeenCalledTimes(1);
    await settle(90);
    expect(bridge.clearBackdrop).not.toHaveBeenCalled();

    expect(activateNativeBackdrop(second as NativeBackdropLease)).toBe(true);
    expect(isNativeBackdropActive()).toBe(true);
  });
});

describe("activateNativeBackdrop + releaseNativeBackdrop lifecycle", () => {
  it("flips the store atomically on activation and restores it on final release", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
    seedWallpaper();
    const listener = vi.fn();
    subscribeNativeBackdrop(listener);

    const lease = await leaseSeeded();
    expect(activateNativeBackdrop(lease as NativeBackdropLease)).toBe(true);
    expect(isNativeBackdropActive()).toBe(true);
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    releaseNativeBackdrop(lease as NativeBackdropLease);
    expect(isNativeBackdropActive()).toBe(false);
    expect(listener).toHaveBeenCalled();
    await waitFor(() => expect(bridge.clearBackdrop).toHaveBeenCalledTimes(1));
  });

  it("refuses a stale lease after the wallpaper source changed mid-flight", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
    seedWallpaper();

    const lease = await leaseSeeded();
    setNativeWallpaperSource({
      imageUrl: "https://localhost/wallpapers/dune.webp",
      color: "#160d07",
    });

    expect(activateNativeBackdrop(lease as NativeBackdropLease)).toBe(false);
    expect(nativeGlassDiag()).toBe("stale-lease");
    expect(isNativeBackdropActive()).toBe(false);
  });

  it("keeps activation until the last holder releases and ignores double release", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
    seedWallpaper();

    const a = await leaseSeeded();
    const b = await leaseSeeded();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(activateNativeBackdrop(a as NativeBackdropLease)).toBe(true);
    expect(isNativeBackdropActive()).toBe(true);

    releaseNativeBackdrop(a as NativeBackdropLease);
    expect(isNativeBackdropActive()).toBe(true);
    // Exactly-once: the repeated release must not free b's hold.
    releaseNativeBackdrop(a as NativeBackdropLease);
    expect(isNativeBackdropActive()).toBe(true);
    expect(b?.released).toBe(false);

    releaseNativeBackdrop(b as NativeBackdropLease);
    expect(isNativeBackdropActive()).toBe(false);
    await waitFor(() => expect(bridge.clearBackdrop).toHaveBeenCalledTimes(1));
  });

  it("republishing an identical source is a no-op that keeps outstanding leases valid", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
    const source = seedWallpaper();

    const lease = await leaseSeeded();
    setNativeWallpaperSource({ imageUrl: source.url, color: source.color });

    expect(activateNativeBackdrop(lease as NativeBackdropLease)).toBe(true);
    expect(isNativeBackdropActive()).toBe(true);
    expect(bridge.setBackdrop).toHaveBeenCalledTimes(1);
  });
});

describe("wallpaper source changes while held", () => {
  it("re-pipes new bytes in place and stays active when the source changes live", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
    seedWallpaper();

    const lease = await leaseSeeded();
    expect(activateNativeBackdrop(lease as NativeBackdropLease)).toBe(true);

    setNativeBackdropEncoderForTests(async () => "ZHVuZQ==");
    seedWallpaper({ url: "https://localhost/wallpapers/dune.webp" });
    expect(isNativeBackdropActive()).toBe(true);

    await waitFor(() => expect(bridge.setBackdrop).toHaveBeenCalledTimes(2));
    expect(bridge.setBackdrop).toHaveBeenLastCalledWith({
      imageBase64: "ZHVuZQ==",
      color: "#160d07",
    });
    expect(isNativeBackdropActive()).toBe(true);
  });

  it("wakes subscribers when the source changes under an inactive holder", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
    seedWallpaper();
    const listener = vi.fn();
    subscribeNativeBackdrop(listener);

    const lease = await leaseSeeded();
    listener.mockClear();
    seedWallpaper({ url: "https://localhost/wallpapers/dune.webp" });

    expect(listener).toHaveBeenCalled();
    expect(isNativeBackdropActive()).toBe(false);
    expect(activateNativeBackdrop(lease as NativeBackdropLease)).toBe(false);
  });

  it("deactivates and clears when the source vanishes under a holder", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
    seedWallpaper();

    const lease = await leaseSeeded();
    expect(activateNativeBackdrop(lease as NativeBackdropLease)).toBe(true);

    setNativeWallpaperSource(null);
    expect(isNativeBackdropActive()).toBe(false);
    expect(activateNativeBackdrop(lease as NativeBackdropLease)).toBe(false);
    await waitFor(() => expect(bridge.clearBackdrop).toHaveBeenCalledTimes(1));
  });
});

describe("react subscriptions", () => {
  it("exposes the diag probe through useNativeGlassDiag", () => {
    const { result } = renderHook(() => useNativeGlassDiag());
    expect(result.current).toBe("idle");

    act(() => {
      setNativeGlassDiag("backdrop-leased");
    });
    expect(result.current).toBe("backdrop-leased");
  });

  it("tracks the active store through useNativeBackdropActive across a full lease", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
    seedWallpaper();
    const { result } = renderHook(() => useNativeBackdropActive());
    expect(result.current).toBe(false);

    let lease: NativeBackdropLease | null = null;
    await act(async () => {
      lease = await acquireNativeBackdrop();
    });
    let activated = false;
    act(() => {
      if (lease) activated = activateNativeBackdrop(lease);
    });
    expect(activated).toBe(true);
    expect(result.current).toBe(true);

    act(() => {
      if (lease) releaseNativeBackdrop(lease);
    });
    expect(result.current).toBe(false);
  });
});
