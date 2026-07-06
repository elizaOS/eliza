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

  it("extends the shader wallpaper past the collapsed-ICB bottom via the JS-MEASURED reclaim var (standalone PWA)", () => {
    // BOTTOM-BAR ROOT CAUSE (device r6): the wallpaper is `fixed inset-0`, so
    // its `bottom: 0` anchors to the fixed-descendant initial containing block.
    // On the installed iOS standalone PWA that ICB COLLAPSES to the small/layout
    // viewport (~59px short of the true bottom), so the wallpaper stops ABOVE
    // the home-indicator zone and the dimmed launch-bg shows through as the
    // near-black strip. The OLD `-1 * max(0px, 100lvh - 100dvh)` CSS-unit calc
    // was a NO-OP on device (the collapsed ICB resolves lvh === dvh), which is
    // why the strip survived 5 fixes. The reclaim now references the
    // JS-MEASURED `--standalone-bottom-reclaim` var so it reflects the ACTUAL
    // device gap. No-op everywhere the two viewports agree (var = 0).
    seed({ mode: "shader", color: "#ef5a1f" });
    const { container } = render(<AppBackground />);
    const shader = container.querySelector<HTMLElement>(
      '[data-testid="app-background-shader"]',
    );
    // jsdom's CSS parser preserves var()/calc() literally; assert the reclaim
    // references the MEASURED var, not the useless lvh/dvh CSS-unit delta.
    const bottom = shader?.style.bottom ?? "";
    expect(bottom).toContain("calc");
    expect(bottom).toContain("--standalone-bottom-reclaim");
    expect(bottom).not.toContain("100dvh");
    expect(bottom).not.toContain("100lvh");
  });

  it("extends the image wallpaper past the collapsed-ICB bottom via the JS-MEASURED reclaim var (standalone PWA)", () => {
    seed({ mode: "image", color: "#000000", imageUrl: "/api/media/x.png" });
    const { container } = render(<AppBackground />);
    const image = container.querySelector<HTMLElement>(
      '[data-testid="app-background-image"]',
    );
    const bottom = image?.style.bottom ?? "";
    expect(bottom).toContain("calc");
    expect(bottom).toContain("--standalone-bottom-reclaim");
    expect(bottom).not.toContain("100dvh");
    expect(bottom).not.toContain("100lvh");
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

  it("does NOT reintroduce the cosmetic warm bottom-floor gradient (measured reclaim makes the wallpaper own the true bottom)", () => {
    // The cosmetic warm-ember floor lift existed ONLY to disguise the launch-bg
    // band that showed when the wallpaper stopped ~59px short under the useless
    // CSS-unit reclaim. With the JS-MEASURED reclaim the wallpaper's own pixels
    // reach the true physical bottom, so the cosmetic strip is dead weight and
    // must NOT return (it re-tinted the home-indicator zone a warm brown — the
    // recurring "bottom bar" in disguise). Only the legibility scrim remains
    // inside the single image layer.
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
    seed({ mode: "image", color: "#160d07", imageUrl: "/bg-sunset.jpg" });
    render(<AppBackground />);
    const bg = document.documentElement.style.backgroundImage;
    expect(bg).toContain("bg-sunset.jpg");
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
