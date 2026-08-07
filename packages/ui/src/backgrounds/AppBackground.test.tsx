/** Verifies AppBackground through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Verifies AppBackground reads the persisted BackgroundConfig from app state
 * and renders the matching surface: a shader host in the configured color for
 * `mode: shader`, an image host for `mode: image`. jsdom render over a seeded
 * store double.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireNativeBackdrop,
  activateNativeBackdrop,
  type NativeBackdropLease,
  releaseNativeBackdrop,
  resetNativeBackdropForTests,
  setNativeBackdropEncoderForTests,
} from "../glass/native-backdrop";
import { resetGlassBridgeForTests } from "../glass/native-bridge";
import { __setAppValueForTests } from "../state/app-store";
import { AppBackground } from "./AppBackground";

function seed(backgroundConfig: unknown) {
  __setAppValueForTests({
    backgroundConfig,
    setBackgroundConfig: () => {},
  } as never);
}

function installNativeGlassBridge() {
  const bridge = {
    attachGlass: vi.fn(async () => ({ attached: true })),
    updateRect: vi.fn(async () => {}),
    detachGlass: vi.fn(async () => {}),
    setGrouping: vi.fn(async () => {}),
    setBackdrop: vi.fn(async () => ({ applied: true })),
    clearBackdrop: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => ({ available: true })),
  };
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    registerPlugin: () => bridge,
  };
  resetGlassBridgeForTests();
  resetNativeBackdropForTests();
  setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
  return bridge;
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  (globalThis as { Capacitor?: unknown }).Capacitor = undefined;
  resetGlassBridgeForTests();
  resetNativeBackdropForTests();
  setNativeBackdropEncoderForTests(null);
  document.documentElement.classList.remove("eliza-native-backdrop");
  document.documentElement.style.backgroundColor = "";
  document.documentElement.style.backgroundImage = "";
});

describe("AppBackground", () => {
  it("renders the shader in the configured color by default", () => {
    seed({ mode: "shader", color: "#ef5a1f" });
    const { container } = render(<AppBackground />);
    const shader = container.querySelector<HTMLElement>(
      '[data-testid="app-background-shader"]',
    );
    expect(shader).not.toBeNull();
    // The "midnight ember" shader paints the seeded color as the top of a
    // vertical field gradient (backgroundImage), not a flat backgroundColor, so
    // the dark field can settle into a hair-warmer floor tone. Assert the
    // seeded color drives the gradient rather than a flat fill.
    expect(shader?.style.backgroundImage).toContain("rgb(239, 90, 31)");
    expect(shader?.style.backgroundImage).toContain("linear-gradient");
    expect(
      container.querySelector('[data-testid="app-background-image"]'),
    ).toBeNull();
  });

  it("renders a cover image when configured for image mode", () => {
    seed({ mode: "image", color: "#000000", imageUrl: "/api/media/x.png" });
    const { container } = render(<AppBackground />);
    const image = container.querySelector<HTMLElement>(
      '[data-testid="app-background-image"]',
    );
    expect(image).not.toBeNull();
    expect(image?.style.backgroundImage).toContain("/api/media/x.png");
    expect(
      container.querySelector('[data-testid="app-background-shader"]'),
    ).toBeNull();
  });

  it("always paints the legibility scrim inside the image wallpaper", () => {
    seed({ mode: "image", color: "#000000", imageUrl: "/api/media/x.png" });
    const { container } = render(<AppBackground />);
    const scrim = container.querySelector<HTMLElement>(
      '[data-testid="app-background-image-scrim"]',
    );
    expect(scrim).not.toBeNull();
    // The scrim lives INSIDE the image layer (one background layer invariant)
    // and darkens via the theme --bg token so content stays legible over any
    // wallpaper in both themes.
    expect(
      scrim?.closest('[data-testid="app-background-image"]'),
    ).not.toBeNull();
    expect(scrim?.className).toContain("bg-bg/50");
  });

  it("does NOT reintroduce the cosmetic warm bottom-floor gradient", () => {
    // The cosmetic warm-ember floor lift existed ONLY to disguise the launch-bg
    // band that showed when fixed app boxes stopped short of the drawable
    // screen. The wallpaper plus root-canvas mirror own the edge now, so the
    // cosmetic strip is dead weight and must NOT return. Only the legibility
    // scrim remains inside the single image layer.
    seed({ mode: "image", color: "#000000", imageUrl: "/api/media/x.png" });
    const { container } = render(<AppBackground />);
    expect(
      container.querySelector('[data-testid="app-background-image-floor"]'),
    ).toBeNull();
    const image = container.querySelector<HTMLElement>(
      '[data-testid="app-background-image"]',
    );
    // The image layer holds exactly ONE child: the scrim. No cosmetic strip.
    const children = Array.from(image?.children ?? []);
    expect(children).toHaveLength(1);
    expect(children[0]?.getAttribute("data-testid")).toBe(
      "app-background-image-scrim",
    );
  });

  it("renders the programmable shader (or its color-field fallback) for glsl mode", () => {
    seed({
      mode: "glsl",
      color: "#059669",
      shader: {
        presetId: "aurora",
        source:
          "precision highp float; void main(){ gl_FragColor = vec4(1.0); }",
        uniforms: { u_speed: 1, u_scale: 1, u_intensity: 1, u_seed: 0 },
      },
    });
    const { container } = render(<AppBackground />);
    // In jsdom there's no WebGL, so the glsl layer's safety path swaps in the
    // color field — either way a background layer must be present (no blank/crash).
    const glsl = container.querySelector('[data-testid="app-background-glsl"]');
    const shader = container.querySelector(
      '[data-testid="app-background-shader"]',
    );
    expect(glsl || shader).not.toBeNull();
  });

  it("falls back to the color field when a glsl config has no shader payload", () => {
    seed({ mode: "glsl", color: "#059669" });
    const { container } = render(<AppBackground />);
    expect(
      container.querySelector('[data-testid="app-background-shader"]'),
    ).not.toBeNull();
  });

  it("falls back to the shader when the config slice is missing", () => {
    __setAppValueForTests({} as never);
    const { container } = render(<AppBackground />);
    expect(
      container.querySelector('[data-testid="app-background-shader"]'),
    ).not.toBeNull();
  });

  it("keeps the apply channel mounted while hiding the visual layer", () => {
    seed({ mode: "shader", color: "#ef5a1f" });
    const { container } = render(<AppBackground visible={false} />);
    expect(
      container.querySelector('[data-testid="app-background-shader"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="app-background-image"]'),
    ).toBeNull();
  });

  it("publishes the wallpaper passively — nothing goes native without a consumer lease", async () => {
    // The shader-tax guard: merely mounting with an image wallpaper must not
    // touch the bridge (a permanently-transparent WebView costs the compositor
    // its opaque fast path app-wide). Hosting starts only when a glass anchor
    // acquires the backdrop.
    const bridge = installNativeGlassBridge();
    seed({
      mode: "image",
      color: "#160d07",
      imageUrl: "/wallpapers/canopy.webp",
    });
    const { container } = render(<AppBackground />);
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.setBackdrop).not.toHaveBeenCalled();
    const image = container.querySelector<HTMLElement>(
      '[data-testid="app-background-image"]',
    );
    expect(image?.style.backgroundImage).toContain("canopy.webp");
    expect(image?.dataset.nativeHosted).toBe("false");
  });

  it("hides only the image paint while native hosts it — the scrim stays", async () => {
    const bridge = installNativeGlassBridge();
    seed({
      mode: "image",
      color: "#160d07",
      imageUrl: "/wallpapers/canopy.webp",
    });
    const { container } = render(<AppBackground />);
    // Simulate the chat-sheet anchor's lease + atomic flip.
    await act(async () => {
      const lease = await acquireNativeBackdrop();
      expect(lease).not.toBeNull();
      expect(activateNativeBackdrop(lease as NativeBackdropLease)).toBe(true);
    });
    expect(bridge.setBackdrop).toHaveBeenCalledTimes(1);
    expect(bridge.setBackdrop).toHaveBeenCalledWith({
      imageBase64: "Zm9vYmFy",
      color: "#160d07",
    });
    const image = container.querySelector<HTMLElement>(
      '[data-testid="app-background-image"]',
    );
    expect(image?.dataset.nativeHosted).toBe("true");
    expect(image?.style.backgroundImage).toBe("");
    // Legibility scrim keeps painting: a translucent DOM layer composites
    // correctly over the native pixels, so text keeps winning on both tiers.
    expect(
      container.querySelector('[data-testid="app-background-image-scrim"]'),
    ).not.toBeNull();
    // Every root-canvas layer goes transparent together (html inline + the
    // body/#root class), or the launch-bg fill would mask the native pixels.
    expect(document.documentElement.classList).toContain(
      "eliza-native-backdrop",
    );
    expect(document.documentElement.style.backgroundColor).toBe("transparent");
    expect(document.documentElement.style.backgroundImage).toBe("");
  });

  it("restores the DOM paint the moment the lease is released", async () => {
    const bridge = installNativeGlassBridge();
    seed({
      mode: "image",
      color: "#160d07",
      imageUrl: "/wallpapers/canopy.webp",
    });
    const { container } = render(<AppBackground />);
    let lease: NativeBackdropLease | null = null;
    await act(async () => {
      lease = await acquireNativeBackdrop();
      expect(lease).not.toBeNull();
      expect(activateNativeBackdrop(lease as NativeBackdropLease)).toBe(true);
    });
    act(() => {
      releaseNativeBackdrop(lease as unknown as NativeBackdropLease);
    });
    const image = container.querySelector<HTMLElement>(
      '[data-testid="app-background-image"]',
    );
    expect(image?.dataset.nativeHosted).toBe("false");
    expect(image?.style.backgroundImage).toContain("canopy.webp");
    expect(document.documentElement.classList).not.toContain(
      "eliza-native-backdrop",
    );
    // The native layer clears a couple of frames later (it covers the swap).
    await waitFor(() => expect(bridge.clearBackdrop).toHaveBeenCalledTimes(1));
  });

  it("never publishes shader/color configs to the native coordinator", async () => {
    const bridge = installNativeGlassBridge();
    seed({ mode: "shader", color: "#3a1f0d" });
    render(<AppBackground />);
    await act(async () => {
      // No image wallpaper published → a lease attempt must refuse.
      expect(await acquireNativeBackdrop()).toBeNull();
    });
    expect(bridge.setBackdrop).not.toHaveBeenCalled();
  });

  it("mirrors an image background onto the ROOT canvas so the strip shows the wallpaper, not #160d07", () => {
    // The canvas-propagation cure (device r8): the ROOT element's background
    // paints the always-full-screen viewport canvas, immune to the collapsed
    // fixed-body ICB. Mounting AppBackground with an image config must mirror
    // that image onto documentElement so the bottom strip paints the wallpaper.
    document.documentElement.style.backgroundImage = "";
    seed({ mode: "image", color: "#160d07", imageUrl: "/bg-sunset.webp" });
    render(<AppBackground />);
    const bg = document.documentElement.style.backgroundImage;
    expect(bg).toContain("bg-sunset.webp");
    expect(document.documentElement.style.backgroundSize).toBe("cover");
    expect(document.documentElement.style.backgroundPosition).toBe(
      "center bottom",
    );
    document.documentElement.style.backgroundImage = "";
  });

  it("mirrors a shader field's base color onto the ROOT canvas (no image) so the strip matches the field", () => {
    document.documentElement.style.backgroundImage = "";
    seed({ mode: "shader", color: "#3a1f0d" });
    render(<AppBackground />);
    // No static image for a shader field (it's a WebGL canvas in a box); the
    // canvas gets the base color so the strip is the field's tone, not #160d07.
    expect(document.documentElement.style.backgroundImage).toBe("");
    expect(document.documentElement.style.backgroundColor).toBe(
      "rgb(58, 31, 13)",
    );
  });
});
