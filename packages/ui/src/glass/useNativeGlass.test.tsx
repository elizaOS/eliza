/** Verifies the glass tier probe through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Contract tests for tier resolution: `cssGlassTier`'s capability branching
 * (url() backdrop-filter support vs the frosted fallback) and
 * `useNativeGlass`'s full decision truth table — synchronous CSS tier on
 * first paint, upgrade to "native" only when BOTH the async availability
 * probe answers yes AND a backdrop lease is active, and live fallback when
 * the lease releases. Everything runs against the real module graph: the
 * Capacitor global carries a fake GlassBridge plugin (the platform boundary,
 * same convention as glass.test.tsx) and the backdrop store is driven through
 * its public lease APIs with the encoder test seam. jsdom harness — the
 * real-pixels path is covered by the shell capture fixtures.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireNativeBackdrop,
  activateNativeBackdrop,
  releaseNativeBackdrop,
  resetNativeBackdropForTests,
  setNativeBackdropEncoderForTests,
  setNativeWallpaperSource,
} from "./native-backdrop";
import {
  isNativeGlassAvailable,
  resetGlassBridgeForTests,
} from "./native-bridge";
import { cssGlassTier, useNativeGlass } from "./useNativeGlass";

type CapGlobal = { Capacitor?: unknown };
type CssGlobal = { CSS?: unknown };

const realCss = globalThis.CSS;

function fakeBridge(overrides: Record<string, unknown> = {}) {
  return {
    attachGlass: vi.fn(async () => ({ attached: true })),
    updateRect: vi.fn(async () => {}),
    detachGlass: vi.fn(async () => {}),
    setGrouping: vi.fn(async () => {}),
    setBackdrop: vi.fn(async () => ({ applied: true })),
    clearBackdrop: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    getRegionState: vi.fn(async () => ({ exists: false, regionCount: 0 })),
    isAvailable: vi.fn(async () => ({ available: true })),
    ...overrides,
  };
}

function installCapacitor(bridge: ReturnType<typeof fakeBridge>) {
  (globalThis as CapGlobal).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    registerPlugin: <T,>(name: string): T => {
      if (name !== "GlassBridge") throw new Error(`unexpected plugin ${name}`);
      return bridge as unknown as T;
    },
  };
}

function installCssSupports(
  supports?: (property: string, value: string) => boolean,
) {
  (globalThis as CssGlobal).CSS = supports === undefined ? {} : { supports };
}

/** Lease + activate the real backdrop store behind a jsdom-safe encoder. */
async function activateBackdrop() {
  setNativeBackdropEncoderForTests(async () => "encoded-bytes");
  setNativeWallpaperSource({
    imageUrl: "file:///wallpaper.jpg",
    color: "#101010",
  });
  const lease = await acquireNativeBackdrop();
  if (!lease) throw new Error("fixture could not lease the native backdrop");
  expect(activateNativeBackdrop(lease)).toBe(true);
  return lease;
}

beforeEach(() => {
  resetGlassBridgeForTests();
});

afterEach(() => {
  cleanup();
  resetNativeBackdropForTests();
  resetGlassBridgeForTests();
  delete (globalThis as CapGlobal).Capacitor;
  (globalThis as CssGlobal).CSS = realCss;
});

describe("cssGlassTier", () => {
  it('reports "css-refraction" when the browser supports url() backdrop-filters', () => {
    installCssSupports(() => true);
    expect(cssGlassTier()).toBe("css-refraction");
  });

  it('falls back to "css-frosted" when url() backdrop-filters are rejected', () => {
    installCssSupports(() => false);
    expect(cssGlassTier()).toBe("css-frosted");
  });

  it("treats an absent CSS.supports as no refraction support", () => {
    installCssSupports(undefined);
    expect(cssGlassTier()).toBe("css-frosted");
  });

  it('stays on "css-frosted" when CSS itself is missing', () => {
    delete (globalThis as CssGlobal).CSS;
    expect(cssGlassTier()).toBe("css-frosted");
  });
});

describe("useNativeGlass", () => {
  it("resolves synchronously to the CSS tier before the availability probe answers", () => {
    installCssSupports(() => false);
    const { result } = renderHook(useNativeGlass);
    expect(result.current).toBe("css-frosted");
  });

  it('upgrades to "native" once the probe answers while a backdrop lease is active', async () => {
    installCapacitor(fakeBridge());
    await activateBackdrop();
    const { result } = renderHook(useNativeGlass);
    expect(result.current).toBe("css-frosted");
    await waitFor(() => expect(result.current).toBe("native"));
  });

  it("keeps the CSS tier when the plugin answers yes but no backdrop is active", async () => {
    installCapacitor(fakeBridge());
    const { result } = renderHook(useNativeGlass);
    expect(result.current).toBe("css-frosted");
    let answered: boolean | undefined;
    await act(async () => {
      answered = await isNativeGlassAvailable();
    });
    expect(answered).toBe(true);
    expect(result.current).toBe("css-frosted");
  });

  it("keeps the CSS tier when only the backdrop is active (probe answers false)", async () => {
    installCapacitor(fakeBridge());
    await activateBackdrop();
    delete (globalThis as CapGlobal).Capacitor;
    resetGlassBridgeForTests();
    const { result } = renderHook(useNativeGlass);
    expect(result.current).toBe("css-frosted");
    let answered: boolean | undefined;
    await act(async () => {
      answered = await isNativeGlassAvailable();
    });
    expect(answered).toBe(false);
    expect(result.current).toBe("css-frosted");
  });

  it("drops back to the CSS tier when the active backdrop releases after native engaged", async () => {
    installCapacitor(fakeBridge());
    const lease = await activateBackdrop();
    const { result } = renderHook(useNativeGlass);
    await waitFor(() => expect(result.current).toBe("native"));
    act(() => {
      releaseNativeBackdrop(lease);
    });
    await waitFor(() => expect(result.current).toBe("css-frosted"));
  });
});
