/** Verifies the unified glass system's public barrel through its consumers' import path. */
// @vitest-environment jsdom
/**
 * Public-entry contract tests for `src/glass/index.ts`: everything a consumer
 * importing the glass barrel gets must be LIVE, not merely present. Covers the
 * native-bridge capability matrix (registration, platform gating, memoized
 * availability, the reset seam), the CSS tier probe branches, the passive-tier
 * invariant (capability alone never upgrades a surface while no anchor holds
 * the backdrop), backdrop-store defaults, and component/stylesheet wiring
 * driven by GLASS_RECIPES. The inner modules' anchoring lifecycle is covered
 * by glass.test.tsx; here the barrel itself is the only system-under-test
 * import path.
 */

import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cssGlassTier,
  GLASS_RECIPES,
  GlassStyles,
  GlassSurface,
  type GlassVariant,
  glassBridge,
  isNativeBackdropActive,
  isNativeGlassAvailable,
  nativeGlassPlatform,
  resetGlassBridgeForTests,
  resetNativeBackdropForTests,
  setNativeWallpaperSource,
  useNativeBackdropActive,
  useNativeGlass,
} from "./index";

type CapGlobal = { Capacitor?: unknown };
type CssGlobal = { CSS?: unknown };

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
    registerPlugin: <T,>(name: string): T => {
      if (name !== "GlassBridge") throw new Error(`unexpected plugin ${name}`);
      if (!bridge) throw new Error("not registered");
      return bridge as unknown as T;
    },
  };
}

function installCapacitorRaw(capacitor: unknown) {
  (globalThis as CapGlobal).Capacitor = capacitor;
}

/**
 * Pin the browser capability `cssGlassTier()` probes. jsdom's own CSS.supports
 * answer is an implementation detail; the tier contract is defined against the
 * `backdrop-filter: url(#x)` refraction query.
 */
function installCss(
  mode: "refraction" | "frosted" | "no-supports-api" | "absent",
) {
  const g = globalThis as CssGlobal;
  if (mode === "refraction") {
    g.CSS = {
      supports: (property: string, value?: string) =>
        property === "backdrop-filter" && value === "url(#x)",
    };
  } else if (mode === "frosted") {
    g.CSS = { supports: () => false };
  } else if (mode === "no-supports-api") {
    g.CSS = {};
  } else {
    g.CSS = undefined;
  }
}

beforeEach(() => {
  resetGlassBridgeForTests();
  resetNativeBackdropForTests();
});

afterEach(() => {
  cleanup();
  (globalThis as CapGlobal).Capacitor = undefined;
  (globalThis as CssGlobal).CSS = undefined;
  resetGlassBridgeForTests();
  resetNativeBackdropForTests();
});

describe("glass barrel — native bridge capability", () => {
  it("answers null and false with no Capacitor global at all", async () => {
    expect(glassBridge()).toBeNull();
    expect(nativeGlassPlatform()).toBeNull();
    await expect(isNativeGlassAvailable()).resolves.toBe(false);
  });

  it("registers the plugin proxy on ios and caches it across calls", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge, "ios");
    const first = glassBridge();
    expect(first).not.toBeNull();
    expect(glassBridge()).toBe(first);
    expect(nativeGlassPlatform()).toBe("ios");
    await expect(isNativeGlassAvailable()).resolves.toBe(true);
  });

  it("registers on android too and reports the android platform", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge, "android");
    expect(glassBridge()).not.toBeNull();
    expect(nativeGlassPlatform()).toBe("android");
    await expect(isNativeGlassAvailable()).resolves.toBe(true);
  });

  it("falls back to Plugins.GlassBridge when registerPlugin is absent", () => {
    const bridge = fakeBridge();
    installCapacitorRaw({
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      Plugins: { GlassBridge: bridge },
    });
    expect(glassBridge()).toBe(bridge);
  });

  it("treats an unregistered plugin as no native glass instead of crashing", async () => {
    installCapacitor(null);
    expect(glassBridge()).toBeNull();
    expect(nativeGlassPlatform()).toBe("ios");
    await expect(isNativeGlassAvailable()).resolves.toBe(false);
  });

  it("keeps non-native Capacitor environments off the native tier", () => {
    const bridge = fakeBridge();
    installCapacitorRaw({
      isNativePlatform: () => false,
      getPlatform: () => "ios",
      registerPlugin: <T,>(): T => {
        if (!bridge) throw new Error("not registered");
        return bridge as unknown as T;
      },
    });
    expect(glassBridge()).toBeNull();
    expect(nativeGlassPlatform()).toBeNull();
  });

  it("reports null platform when the native shell names an unknown platform", () => {
    const bridge = fakeBridge();
    installCapacitorRaw({
      isNativePlatform: () => true,
      getPlatform: () => "web",
      registerPlugin: <T,>(): T => bridge as unknown as T,
    });
    expect(nativeGlassPlatform()).toBeNull();
  });

  it("degrades a throwing availability probe to false (#J4)", async () => {
    const bridge = fakeBridge({
      isAvailable: vi.fn(async () => {
        throw new Error("older shell");
      }),
    });
    installCapacitor(bridge);
    await expect(isNativeGlassAvailable()).resolves.toBe(false);
  });

  it("stays unavailable when the plugin answers available:false", async () => {
    const bridge = fakeBridge({
      isAvailable: vi.fn(async () => ({ available: false })),
    });
    installCapacitor(bridge);
    await expect(isNativeGlassAvailable()).resolves.toBe(false);
    expect(bridge.isAvailable).toHaveBeenCalledTimes(1);
  });

  it("memoizes one availability probe per document until the reset seam runs", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    const first = isNativeGlassAvailable();
    const second = isNativeGlassAvailable();
    expect(second).toBe(first);
    await expect(first).resolves.toBe(true);
    expect(bridge.isAvailable).toHaveBeenCalledTimes(1);

    resetGlassBridgeForTests();

    const third = isNativeGlassAvailable();
    expect(third).not.toBe(first);
    await expect(third).resolves.toBe(true);
    expect(bridge.isAvailable).toHaveBeenCalledTimes(2);
  });

  it("keeps the cached proxy over a swapped global until reset re-resolves", () => {
    const first = fakeBridge();
    installCapacitor(first, "ios");
    const cached = glassBridge();
    expect(cached).not.toBeNull();

    // A fresh renderer global must NOT silently replace the memoized proxy…
    const second = fakeBridge();
    installCapacitor(second, "ios");
    expect(glassBridge()).toBe(cached);

    // …only the documented boot-time reset seam may.
    resetGlassBridgeForTests();
    expect(glassBridge()).toBe(second);
  });
});

describe("glass barrel — css tier probe", () => {
  it("reports css-refraction where url() backdrop-filter is supported", () => {
    installCss("refraction");
    expect(cssGlassTier()).toBe("css-refraction");
  });

  it("reports css-frosted when the refraction query is unsupported", () => {
    installCss("frosted");
    expect(cssGlassTier()).toBe("css-frosted");
  });

  it("reports css-frosted when CSS exists without a supports API", () => {
    installCss("no-supports-api");
    expect(cssGlassTier()).toBe("css-frosted");
  });

  it("reports css-frosted when there is no CSS global at all", () => {
    installCss("absent");
    expect(cssGlassTier()).toBe("css-frosted");
  });
});

describe("glass barrel — passive tier invariant", () => {
  it("never upgrades a passive surface to native, even on a capable device", async () => {
    installCss("frosted");
    installCapacitor(fakeBridge());
    const { result } = renderHook(() => useNativeGlass());
    // Synchronous first paint on the CSS tier — no unstyled flash.
    expect(result.current).toBe("css-frosted");
    // The probe resolves true; without a held backdrop the tier stays CSS.
    await act(async () => {
      await expect(isNativeGlassAvailable()).resolves.toBe(true);
    });
    expect(result.current).toBe("css-frosted");
  });

  it("paints the refraction tier synchronously on a capable browser", () => {
    installCss("refraction");
    const { result } = renderHook(() => useNativeGlass());
    expect(result.current).toBe("css-refraction");
  });
});

describe("glass barrel — backdrop store defaults", () => {
  it("starts inactive and stays inactive while nobody leases the backdrop", () => {
    expect(isNativeBackdropActive()).toBe(false);
    const { result } = renderHook(() => useNativeBackdropActive());
    expect(result.current).toBe(false);
    act(() => {
      setNativeWallpaperSource({
        imageUrl: "https://localhost/wallpapers/canopy.webp",
        color: "#160d07",
      });
    });
    // Publishing a source alone never hides the DOM wallpaper — activation
    // requires a lease only the anchor layer can take.
    expect(isNativeBackdropActive()).toBe(false);
    expect(result.current).toBe(false);
  });

  it("accepts repeated null publications without flipping the store", () => {
    act(() => {
      setNativeWallpaperSource(null);
      setNativeWallpaperSource(null);
    });
    expect(isNativeBackdropActive()).toBe(false);
  });

  it("restores the pristine inactive default on the test reset seam", () => {
    act(() => {
      setNativeWallpaperSource({
        imageUrl: "https://localhost/wallpapers/canopy.webp",
        color: "#160d07",
      });
    });
    resetNativeBackdropForTests();
    expect(isNativeBackdropActive()).toBe(false);
    const { result } = renderHook(() => useNativeBackdropActive());
    expect(result.current).toBe(false);
  });
});

describe("glass barrel — component wiring through the public entry", () => {
  it("renders a variant class merged with the caller's className plus children", () => {
    installCss("frosted");
    const { getByTestId, getByText } = render(
      <GlassSurface variant="pill" className="my-chrome" data-testid="s">
        <span>content</span>
      </GlassSurface>,
    );
    const el = getByTestId("s");
    expect(el.className).toBe("eliza-glass-pill my-chrome");
    expect(el.dataset.glassTier).toBe("css-frosted");
    expect(getByText("content")).toBeTruthy();
  });

  it("emits stylesheet rules derived from each recipe through GlassStyles", () => {
    const { container } = render(<GlassStyles />);
    const css = container.querySelector("style")?.textContent ?? "";
    for (const variant of Object.keys(GLASS_RECIPES) as GlassVariant[]) {
      const recipe = GLASS_RECIPES[variant];
      // Every variant paints its recipe fill…
      expect(css).toContain(`background-color: ${recipe.background};`);
      // …and carries the transparent native override for tier upgrades.
      expect(css).toContain(
        `.eliza-glass-${variant}[data-glass-tier="native"]`,
      );
      if (recipe.refraction) {
        expect(css).toContain(`backdrop-filter: ${recipe.refraction};`);
        expect(css).toContain(
          `.eliza-glass-${variant}:not([data-glass-tier="native"])`,
        );
      } else {
        expect(css).not.toContain(
          `.eliza-glass-${variant}:not([data-glass-tier="native"])`,
        );
      }
    }
  });

  it("keeps the sheet saturate-free in its emitted stylesheet rule", () => {
    const { container } = render(<GlassStyles />);
    const css = container.querySelector("style")?.textContent ?? "";
    const sheetBlock = css.match(/\.eliza-glass-sheet \{[^}]*\}/)?.[0] ?? "";
    expect(sheetBlock).not.toContain("saturate");
    expect(sheetBlock).toContain(GLASS_RECIPES.sheet.backdropFilter);
  });
});
