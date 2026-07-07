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

  it("renders wallpaper layers as `fixed inset-0` that CONSUME the bottom-reclaim offset (extend past the collapsed ICB)", () => {
    // CONSUMPTION CONTRACT (#15178). The wallpaper is `fixed inset-0`, but on
    // the installed iOS standalone PWA the fixed containing block collapses to
    // the small ICB (device: `ce873` vs physical `sh932`), so a bare `inset-0`
    // (`bottom: 0`) stops the field ~59px SHORT of the home-indicator edge —
    // the recurring unpainted black strip. shaw's WIP (f903c59) asserted "no
    // bottom override", codifying that regression. The correct contract: the
    // fixed field's `bottom` is dropped by the JS-MEASURED
    // `--standalone-bottom-reclaim` so it reaches the TRUE physical bottom. The
    // var is a hard 0 off the iOS-standalone/native surface, so this is a
    // no-op on desktop/web/Android.
    seed({ mode: "shader", color: "#ef5a1f" });
    const { container } = render(<AppBackground />);
    const shader = container.querySelector<HTMLElement>(
      '[data-testid="app-background-shader"]',
    );
    expect(shader?.className).toContain("fixed");
    expect(shader?.className).toContain("inset-0");
    // The field MUST consume the reclaim var on its bottom (else it re-ships the
    // #15178 strip). React normalizes the offset to the resolved calc() string.
    expect(shader?.style.bottom ?? "").toContain(
      "var(--standalone-bottom-reclaim",
    );
  });

  it("renders the image wallpaper as `fixed inset-0` that CONSUMES the bottom-reclaim offset", () => {
    seed({ mode: "image", color: "#000000", imageUrl: "/api/media/x.png" });
    const { container } = render(<AppBackground />);
    const image = container.querySelector<HTMLElement>(
      '[data-testid="app-background-image"]',
    );
    expect(image?.className).toContain("fixed");
    expect(image?.className).toContain("inset-0");
    // The wallpaper MUST reach the true physical bottom via the measured var.
    expect(image?.style.bottom ?? "").toContain(
      "var(--standalone-bottom-reclaim",
    );
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
