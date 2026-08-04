/** Verifies glass tokens through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Contract tests for the unified glass system: recipe integrity (every variant
 * fully specified, fills stay translucent, the sheet stays saturate-free),
 * tier resolution (CSS tiers off-native; native only when the injected
 * Capacitor global + plugin answer yes), GlassSurface rendering + native
 * anchoring lifecycle against a fake bridge. jsdom harness — the real-pixels
 * path is covered by the shell capture fixtures.
 */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GlassStyles,
  GlassSurface,
  useNativeGlassAnchor,
} from "./GlassSurface";
import {
  resetNativeBackdropForTests,
  setNativeBackdropEncoderForTests,
  setNativeWallpaperSource,
} from "./native-backdrop";
import { resetGlassBridgeForTests } from "./native-bridge";
import { GLASS_RECIPES, type GlassVariant } from "./tokens";

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
    registerPlugin: <T,>(name: string): T => {
      if (name !== "GlassBridge") throw new Error(`unexpected plugin ${name}`);
      if (!bridge) throw new Error("not registered");
      return bridge as unknown as T;
    },
  };
}

/** Publish an image wallpaper + a jsdom-safe encoder so anchors can lease it. */
function seedWallpaper() {
  setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
  setNativeWallpaperSource({
    imageUrl: "https://localhost/wallpapers/canopy.webp",
    color: "#160d07",
  });
}

beforeEach(() => {
  resetGlassBridgeForTests();
  resetNativeBackdropForTests();
  // jsdom has no ResizeObserver; the anchor effect uses it for rect sync.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
  (globalThis as CapGlobal).Capacitor = undefined;
  resetGlassBridgeForTests();
  resetNativeBackdropForTests();
  setNativeBackdropEncoderForTests(null);
  document.documentElement.classList.remove("eliza-native-backdrop");
});

describe("glass tokens", () => {
  const variants = Object.keys(GLASS_RECIPES) as GlassVariant[];

  it("fully specifies every variant", () => {
    for (const v of variants) {
      const r = GLASS_RECIPES[v];
      expect(r.background.length, v).toBeGreaterThan(0);
      expect(r.backdropFilter, v).toMatch(/blur\(/);
      expect(r.edgeShadow.length, v).toBeGreaterThan(0);
      expect(r.sheen, v).toMatch(/gradient/);
      expect(r.radius.length, v).toBeGreaterThan(0);
    }
  });

  it("keeps every fill translucent — glass never goes opaque", () => {
    for (const v of variants) {
      const bg = GLASS_RECIPES[v].background;
      expect(bg, v).toMatch(/transparent|\/\s*\d+%/);
    }
  });

  it("keeps the sheet saturate-free (saturate reads brown over the warm theme)", () => {
    expect(GLASS_RECIPES.sheet.backdropFilter).not.toMatch(/saturate/);
    expect(GLASS_RECIPES.sheet.refraction).toBeNull();
  });

  it("gives refraction only to small surfaces (card, menu)", () => {
    expect(GLASS_RECIPES.card.refraction).toMatch(/^url\(/);
    expect(GLASS_RECIPES.menu.refraction).toMatch(/^url\(/);
    expect(GLASS_RECIPES.sheet.refraction).toBeNull();
    expect(GLASS_RECIPES.banner.refraction).toBeNull();
  });
});

function AnchorHarness({ enabled }: { enabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const tier = useNativeGlassAnchor(ref, { enabled });
  return <div ref={ref} data-testid="anchor" data-glass-tier={tier} />;
}

describe("GlassSurface", () => {
  it("renders the variant class and a css tier off-native", () => {
    const { getByTestId } = render(
      <GlassSurface variant="menu" data-testid="s" />,
    );
    const el = getByTestId("s");
    expect(el.className).toContain("eliza-glass-menu");
    expect(el.dataset.glassTier).toMatch(/^css-/);
  });

  it("upgrades to native only after wallpaper + region are BOTH acknowledged", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    seedWallpaper();
    const { getByTestId, unmount } = render(
      <GlassSurface variant="pill" interactive data-testid="s" />,
    );
    await waitFor(() =>
      expect(getByTestId("s").dataset.glassTier).toBe("native"),
    );
    // The wallpaper must be hosted natively BEFORE the region attaches: an
    // under-WebView glass region without a backdrop samples the black window.
    expect(bridge.setBackdrop).toHaveBeenCalledTimes(1);
    expect(bridge.attachGlass).toHaveBeenCalledTimes(1);
    const backdropOrder = bridge.setBackdrop.mock.invocationCallOrder[0] ?? 0;
    const attachOrder = bridge.attachGlass.mock.invocationCallOrder[0] ?? 0;
    expect(backdropOrder).toBeLessThan(attachOrder);
    const call = bridge.attachGlass.mock.calls[0]?.[0] as unknown as {
      id: string;
      interactive: boolean;
      rect: { width: number };
    };
    expect(call.id.length).toBeGreaterThan(0);
    expect(call.interactive).toBe(true);
    unmount();
    await waitFor(() => expect(bridge.detachGlass).toHaveBeenCalledTimes(1));
    // The lease was the last holder, so the wallpaper clears (a couple of
    // frames later — the native copy covers the DOM swap-back).
    await waitFor(() => expect(bridge.clearBackdrop).toHaveBeenCalledTimes(1));
  });

  it("holds the CSS tier while either native acknowledgement is pending", async () => {
    let resolveBackdrop: (value: { applied: boolean }) => void = () => {};
    let resolveAttach: (value: { attached: boolean }) => void = () => {};
    const bridge = fakeBridge({
      setBackdrop: vi.fn(
        () =>
          new Promise<{ applied: boolean }>((resolve) => {
            resolveBackdrop = resolve;
          }),
      ),
      attachGlass: vi.fn(
        () =>
          new Promise<{ attached: boolean }>((resolve) => {
            resolveAttach = resolve;
          }),
      ),
    });
    installCapacitor(bridge);
    seedWallpaper();
    const { getByTestId } = render(<AnchorHarness enabled />);
    await waitFor(() => expect(bridge.setBackdrop).toHaveBeenCalledTimes(1));
    expect(getByTestId("anchor").dataset.glassTier).toMatch(/^css-/);
    await act(async () => {
      resolveBackdrop({ applied: true });
    });
    await waitFor(() => expect(bridge.attachGlass).toHaveBeenCalledTimes(1));
    expect(getByTestId("anchor").dataset.glassTier).toMatch(/^css-/);
    await act(async () => {
      resolveAttach({ attached: true });
    });
    await waitFor(() =>
      expect(getByTestId("anchor").dataset.glassTier).toBe("native"),
    );
  });

  it("keeps Android on the CSS tier — the near-opaque panel is churn, not glass (#16200)", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge, "android");
    seedWallpaper();
    const { getByTestId } = render(
      <GlassSurface variant="menu" data-testid="s" />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(getByTestId("s").dataset.glassTier).toMatch(/^css-/);
    expect(bridge.setBackdrop).not.toHaveBeenCalled();
    expect(bridge.attachGlass).not.toHaveBeenCalled();
  });

  it("stays CSS with no image wallpaper published — nothing to sample natively", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    const { getByTestId } = render(<AnchorHarness enabled />);
    await new Promise((r) => setTimeout(r, 20));
    expect(getByTestId("anchor").dataset.glassTier).toMatch(/^css-/);
    expect(bridge.setBackdrop).not.toHaveBeenCalled();
    expect(bridge.attachGlass).not.toHaveBeenCalled();
  });

  it("keeps CSS and never attaches when the native host refuses the wallpaper", async () => {
    const bridge = fakeBridge({
      setBackdrop: vi.fn(async () => ({ applied: false })),
    });
    installCapacitor(bridge);
    seedWallpaper();
    const { getByTestId } = render(<AnchorHarness enabled />);
    await waitFor(() => expect(bridge.setBackdrop).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(getByTestId("anchor").dataset.glassTier).toMatch(/^css-/);
    expect(bridge.attachGlass).not.toHaveBeenCalled();
  });

  it("releases the wallpaper lease when the region attach is refused", async () => {
    const bridge = fakeBridge({
      attachGlass: vi.fn(async () => ({ attached: false })),
    });
    installCapacitor(bridge);
    seedWallpaper();
    const { getByTestId } = render(<AnchorHarness enabled />);
    await waitFor(() => expect(bridge.attachGlass).toHaveBeenCalledTimes(1));
    expect(getByTestId("anchor").dataset.glassTier).toMatch(/^css-/);
    await waitFor(() => expect(bridge.clearBackdrop).toHaveBeenCalledTimes(1));
  });

  it("detaches and restores CSS immediately when the anchor disables (drag start)", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    seedWallpaper();
    const { getByTestId, rerender } = render(<AnchorHarness enabled />);
    await waitFor(() =>
      expect(getByTestId("anchor").dataset.glassTier).toBe("native"),
    );
    rerender(<AnchorHarness enabled={false} />);
    // Same-render CSS restore: the finger must never wait on native teardown.
    expect(getByTestId("anchor").dataset.glassTier).toMatch(/^css-/);
    await waitFor(() => expect(bridge.detachGlass).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bridge.clearBackdrop).toHaveBeenCalledTimes(1));
  });

  it("refuses activation when the wallpaper changes while the region attach is in flight", async () => {
    // The #17048 review's pending-lease race: acquire succeeds, then the
    // wallpaper source changes (or vanishes) while attachGlass is awaiting.
    // Activation must revalidate the lease and refuse — hiding the DOM over
    // the pixels native still holds would flash the previous wallpaper.
    let resolveAttach: (value: { attached: boolean }) => void = () => {};
    const bridge = fakeBridge({
      attachGlass: vi.fn(
        () =>
          new Promise<{ attached: boolean }>((resolve) => {
            resolveAttach = resolve;
          }),
      ),
    });
    installCapacitor(bridge);
    seedWallpaper();
    const { getByTestId } = render(<AnchorHarness enabled />);
    await waitFor(() => expect(bridge.attachGlass).toHaveBeenCalledTimes(1));
    // Source vanishes while the region attach is still awaiting its ack.
    act(() => {
      setNativeWallpaperSource(null);
    });
    await act(async () => {
      resolveAttach({ attached: true });
    });
    await new Promise((r) => setTimeout(r, 20));
    // Never native over stale pixels; the anchor released its lease.
    expect(getByTestId("anchor").dataset.glassTier).toMatch(/^css-/);
    await waitFor(() => expect(bridge.detachGlass).toHaveBeenCalledTimes(1));
  });

  it("drops to CSS and tears down when the wallpaper switches away while anchored", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    seedWallpaper();
    const { getByTestId } = render(<AnchorHarness enabled />);
    await waitFor(() =>
      expect(getByTestId("anchor").dataset.glassTier).toBe("native"),
    );
    act(() => {
      setNativeWallpaperSource(null);
    });
    expect(getByTestId("anchor").dataset.glassTier).toMatch(/^css-/);
    await waitFor(() => expect(bridge.detachGlass).toHaveBeenCalledTimes(1));
  });

  it("stays on the css tier when the plugin reports unavailable", async () => {
    const bridge = fakeBridge({
      isAvailable: vi.fn(async () => ({ available: false })),
    });
    installCapacitor(bridge);
    seedWallpaper();
    const { getByTestId } = render(
      <GlassSurface variant="card" data-testid="s" />,
    );
    // Let the availability probe settle, then assert no upgrade happened.
    await new Promise((r) => setTimeout(r, 20));
    expect(getByTestId("s").dataset.glassTier).toMatch(/^css-/);
    expect(bridge.attachGlass).not.toHaveBeenCalled();
    expect(bridge.setBackdrop).not.toHaveBeenCalled();
  });

  it("GlassStyles emits one class block per variant plus the refraction defs", () => {
    const { container } = render(<GlassStyles />);
    const css = container.querySelector("style")?.textContent ?? "";
    for (const v of Object.keys(GLASS_RECIPES)) {
      expect(css).toContain(`.eliza-glass-${v}`);
    }
    expect(container.querySelector("svg filter")).not.toBeNull();
  });
});
