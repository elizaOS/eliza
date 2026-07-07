// @vitest-environment jsdom
//
// html-canvas-paint — the canvas-propagation cure for the iOS standalone bottom
// strip (device r8). Verifies that the active background is mirrored onto the
// ROOT element (whose background paints the always-full-screen viewport canvas)
// so the strip shows the wallpaper / its base color, NEVER the near-black
// `--launch-bg` (#160d07).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundConfig } from "../state/ui-preferences";
import { DEFAULT_BACKGROUND_COLOR } from "../state/ui-preferences";

// Deterministic URL resolution so the test asserts on stable, resolved URLs
// rather than the environment's real asset/api base.
vi.mock("../utils/asset-url", () => ({
  resolveAppAssetUrl: (u: string) => `ASSET:${u}`,
  resolveApiUrl: (u: string) => `API:${u}`,
}));

import {
  applyRootCanvasPaint,
  computeRootCanvasPaint,
} from "./html-canvas-paint";

function resetRootStyle(): void {
  const s = document.documentElement.style;
  s.backgroundImage = "";
  s.backgroundColor = "";
  s.backgroundSize = "";
  s.backgroundPosition = "";
  s.backgroundRepeat = "";
}

describe("computeRootCanvasPaint — what mirrors onto the canvas", () => {
  it("image mode mirrors the active wallpaper URL (public asset resolved)", () => {
    const config: BackgroundConfig = {
      mode: "image",
      color: "#160d07",
      imageUrl: "/wallpapers/dusk-dunes.webp",
    };
    const paint = computeRootCanvasPaint(config);
    // The exact resolved URL is mirrored so the canvas paints the SAME bytes as
    // the box wallpaper — no divergent second image on the strip.
    expect(paint.backgroundImage).toBe(
      'url("ASSET:/wallpapers/dusk-dunes.webp")',
    );
    // A base color still fills behind a still-loading / transparent-edged image
    // so the reveal is warm, never the near-black launch-bg.
    expect(paint.backgroundColor).toBe("#160d07");
  });

  it("image mode routes an /api/media upload through the API base", () => {
    const paint = computeRootCanvasPaint({
      mode: "image",
      color: "#222222",
      imageUrl: "/api/media/abc123",
    });
    expect(paint.backgroundImage).toBe('url("API:/api/media/abc123")');
    expect(paint.backgroundColor).toBe("#222222");
  });

  it("image mode passes data: URLs through untouched", () => {
    const dataUrl = "data:image/svg+xml,%3Csvg/%3E";
    const paint = computeRootCanvasPaint({
      mode: "image",
      color: "#000000",
      imageUrl: dataUrl,
    });
    expect(paint.backgroundImage).toBe(`url("${dataUrl}")`);
  });

  it("shader mode has NO image and mirrors the field base color", () => {
    const paint = computeRootCanvasPaint({ mode: "shader", color: "#3a1f0d" });
    expect(paint.backgroundImage).toBeNull();
    expect(paint.backgroundColor).toBe("#3a1f0d");
  });

  it("glsl mode has NO image and mirrors the field base color", () => {
    const paint = computeRootCanvasPaint({
      mode: "glsl",
      color: "#7a2410",
      shader: { source: "void main(){}", uniforms: {} as never },
    });
    expect(paint.backgroundImage).toBeNull();
    expect(paint.backgroundColor).toBe("#7a2410");
  });

  it("image mode WITHOUT a url falls back to the base color, no image", () => {
    const paint = computeRootCanvasPaint({
      mode: "image",
      color: "#123456",
    });
    expect(paint.backgroundImage).toBeNull();
    expect(paint.backgroundColor).toBe("#123456");
  });

  it("a null / malformed config falls back to the default launch color, never empty", () => {
    for (const cfg of [null, undefined, {} as BackgroundConfig]) {
      const paint = computeRootCanvasPaint(cfg);
      expect(paint.backgroundImage).toBeNull();
      // Crucially NOT empty string: the canvas must always get a warm fill so it
      // never falls back to the stylesheet launch-bg via an empty inline value.
      expect(paint.backgroundColor).toBe(DEFAULT_BACKGROUND_COLOR);
    }
  });
});

describe("applyRootCanvasPaint — writes onto document.documentElement", () => {
  beforeEach(resetRootStyle);
  afterEach(resetRootStyle);

  it("(a) mirrors the active image URL onto html background-image + cover/bottom", () => {
    applyRootCanvasPaint({
      mode: "image",
      color: "#160d07",
      imageUrl: "/wallpapers/reef.webp",
    });
    const s = document.documentElement.style;
    expect(s.backgroundImage).toBe('url("ASSET:/wallpapers/reef.webp")');
    expect(s.backgroundSize).toBe("cover");
    // Anchored to the BOTTOM so the canvas crop is continuous with the box image
    // at the home-indicator edge (the strip we are filling).
    expect(s.backgroundPosition).toBe("center bottom");
    expect(s.backgroundRepeat).toBe("no-repeat");
    expect(s.backgroundColor).toBe("rgb(22, 13, 7)");
  });

  it("(b) color/shader path mirrors the base color and clears any prior image", () => {
    // First apply an image (leaves image props set)...
    applyRootCanvasPaint({
      mode: "image",
      color: "#160d07",
      imageUrl: "/wallpapers/reef.webp",
    });
    expect(document.documentElement.style.backgroundImage).not.toBe("");
    // ...then switch to a shader field: the stale image MUST be cleared so the
    // canvas becomes a flat fill of the field base, not the old wallpaper.
    applyRootCanvasPaint({ mode: "shader", color: "#3a1f0d" });
    const s = document.documentElement.style;
    expect(s.backgroundImage).toBe("");
    expect(s.backgroundSize).toBe("");
    expect(s.backgroundPosition).toBe("");
    expect(s.backgroundRepeat).toBe("");
    expect(s.backgroundColor).toBe("rgb(58, 31, 13)");
  });

  it("(c) FOUC guard untouched pre-mirror: the root inline background is empty until first apply", () => {
    // Before any apply call, the runtime mirror has written NOTHING inline, so
    // the stylesheet `:root { --launch-bg }` FOUC paint is the sole source of
    // the pre-boot canvas color (index.html is deliberately not touched).
    const s = document.documentElement.style;
    expect(s.backgroundImage).toBe("");
    expect(s.backgroundColor).toBe("");
    // The first apply upgrades it (inline wins over the :root rule by
    // specificity), proving the mirror overrides the launch-bg only once the
    // app knows its wallpaper.
    applyRootCanvasPaint({
      mode: "image",
      color: "#160d07",
      imageUrl: "/bg-sunset.webp",
    });
    expect(document.documentElement.style.backgroundImage).toBe(
      'url("ASSET:/bg-sunset.webp")',
    );
  });
});
