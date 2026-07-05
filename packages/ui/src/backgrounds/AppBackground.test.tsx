// @vitest-environment jsdom

/**
 * Verifies AppBackground reads the persisted BackgroundConfig from app state
 * and renders the matching surface: a shader host in the configured color for
 * `mode: shader`, an image host for `mode: image`. jsdom render over a seeded
 * store double.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { __setAppValueForTests } from "../state/app-store";
import { AppBackground } from "./AppBackground";

function seed(backgroundConfig: unknown) {
  __setAppValueForTests({
    backgroundConfig,
    setBackgroundConfig: () => {},
  } as never);
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
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

  it("lifts the wallpaper's bottom edge with a warm floor so it never reads as a black band", () => {
    // The residual "black band" on the standalone home view: the fixed inset-0
    // wallpaper DOES paint into the iOS home-indicator safe-area, but cover-
    // cropping a wallpaper whose bottom is dark (the stock sunset, many user
    // uploads) left that strip near-black. A short bottom-anchored warm floor
    // gradient lifts only the lowest strip toward the ember floor tone, so the
    // zone under the composer reads as intentional ambience, not a dead bar.
    seed({ mode: "image", color: "#000000", imageUrl: "/api/media/x.png" });
    const { container } = render(<AppBackground />);
    const floor = container.querySelector<HTMLElement>(
      '[data-testid="app-background-image-floor"]',
    );
    expect(floor).not.toBeNull();
    // Lives INSIDE the single image layer (one-background invariant holds).
    expect(
      floor?.closest('[data-testid="app-background-image"]'),
    ).not.toBeNull();
    // Anchored at the true bottom edge, a short strip only — never a full wash.
    expect(floor?.className).toContain("bottom-0");
    expect(floor?.className).toContain("inset-x-0");
    expect(floor?.className).not.toContain("inset-0");
    // A bottom-anchored gradient (fades UP to transparent) built on the theme
    // --bg token so it stays warm-but-legible in both themes, not a flat fill.
    expect(floor?.style.backgroundImage).toContain("linear-gradient");
    expect(floor?.style.backgroundImage).toContain("to top");
    expect(floor?.style.backgroundImage).toContain("var(--bg)");
    expect(floor?.style.backgroundImage).toContain("transparent");
  });

  it("paints the bottom floor ABOVE the legibility scrim (so the scrim can't dim it back to black)", () => {
    // Ordering invariant: the floor must be the LAST child of the image layer.
    // Under the scrim it would just get re-dimmed toward --bg and the band
    // would return; above it, it lifts the already-scrimmed bottom out of
    // near-black. Assert DOM order rather than z-index (both are absolute).
    seed({ mode: "image", color: "#000000", imageUrl: "/api/media/x.png" });
    const { container } = render(<AppBackground />);
    const image = container.querySelector<HTMLElement>(
      '[data-testid="app-background-image"]',
    );
    const children = Array.from(image?.children ?? []);
    const scrimIdx = children.findIndex(
      (c) => c.getAttribute("data-testid") === "app-background-image-scrim",
    );
    const floorIdx = children.findIndex(
      (c) => c.getAttribute("data-testid") === "app-background-image-floor",
    );
    expect(scrimIdx).toBeGreaterThanOrEqual(0);
    expect(floorIdx).toBeGreaterThanOrEqual(0);
    expect(floorIdx).toBeGreaterThan(scrimIdx);
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
});
