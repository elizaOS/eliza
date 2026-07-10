// @vitest-environment jsdom
/**
 * Contract tests for the unified glass system: recipe integrity (every variant
 * fully specified, fills stay translucent, the sheet stays saturate-free),
 * tier resolution (CSS tiers off-native; native only when the injected
 * Capacitor global + plugin answer yes), GlassSurface rendering + native
 * anchoring lifecycle against a fake bridge. jsdom harness — the real-pixels
 * path is covered by the shell capture fixtures.
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassStyles, GlassSurface } from "./GlassSurface";
import { resetGlassBridgeForTests } from "./native-bridge";
import { GLASS_RECIPES, type GlassVariant } from "./tokens";

type CapGlobal = { Capacitor?: unknown };

function fakeBridge(overrides: Record<string, unknown> = {}) {
  return {
    attachGlass: vi.fn(async (_options: unknown) => ({ attached: true })),
    updateRect: vi.fn(async () => {}),
    detachGlass: vi.fn(async () => {}),
    setGrouping: vi.fn(async () => {}),
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

beforeEach(() => {
  resetGlassBridgeForTests();
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

describe("GlassSurface", () => {
  it("renders the variant class and a css tier off-native", () => {
    const { getByTestId } = render(
      <GlassSurface variant="menu" data-testid="s" />,
    );
    const el = getByTestId("s");
    expect(el.className).toContain("eliza-glass-menu");
    expect(el.dataset.glassTier).toMatch(/^css-/);
  });

  it("upgrades to the native tier and anchors through the bridge", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge);
    const { getByTestId, unmount } = render(
      <GlassSurface variant="pill" interactive data-testid="s" />,
    );
    await waitFor(() =>
      expect(getByTestId("s").dataset.glassTier).toBe("native"),
    );
    await waitFor(() => expect(bridge.attachGlass).toHaveBeenCalledTimes(1));
    const call = bridge.attachGlass.mock.calls[0]?.[0] as unknown as {
      id: string;
      interactive: boolean;
      rect: { width: number };
    };
    expect(call.id.length).toBeGreaterThan(0);
    expect(call.interactive).toBe(true);
    unmount();
    await waitFor(() => expect(bridge.detachGlass).toHaveBeenCalledTimes(1));
  });

  it("upgrades to the native tier on Android too — same bridge, same contract", async () => {
    const bridge = fakeBridge();
    installCapacitor(bridge, "android");
    const { getByTestId, unmount } = render(
      <GlassSurface variant="menu" data-testid="s" />,
    );
    await waitFor(() =>
      expect(getByTestId("s").dataset.glassTier).toBe("native"),
    );
    await waitFor(() => expect(bridge.attachGlass).toHaveBeenCalledTimes(1));
    unmount();
    await waitFor(() => expect(bridge.detachGlass).toHaveBeenCalledTimes(1));
  });

  it("stays on the css tier when the plugin reports unavailable", async () => {
    const bridge = fakeBridge({
      isAvailable: vi.fn(async () => ({ available: false })),
    });
    installCapacitor(bridge);
    const { getByTestId } = render(
      <GlassSurface variant="card" data-testid="s" />,
    );
    // Let the availability probe settle, then assert no upgrade happened.
    await new Promise((r) => setTimeout(r, 20));
    expect(getByTestId("s").dataset.glassTier).toMatch(/^css-/);
    expect(bridge.attachGlass).not.toHaveBeenCalled();
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
