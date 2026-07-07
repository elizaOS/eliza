// @vitest-environment jsdom
/**
 * Unit coverage for the shared liquid-glass recipe (chat sheet + notification
 * cards). The production contract is token-based: neutral inset edge depth, a
 * soft specular sheen, a mask-composite rim that traces the rounded border, and
 * an SVG edge-refraction filter — all neutral, no accent/blue.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  LIQUID_GLASS_BLUR,
  LIQUID_GLASS_EDGE_SHADOW,
  LIQUID_GLASS_REFRACTION,
  LIQUID_GLASS_REFRACTION_FILTER_ID,
  LIQUID_GLASS_SHEEN,
  LiquidGlassRefractionDefs,
  liquidGlassRimCss,
} from "./liquid-glass";

const NO_ACCENT = /blue|#[0-9a-f]*[0-9a-f]{2}(ff|cc)\b|var\(--accent/;

describe("liquid-glass", () => {
  it("keeps the bevel neutral: inset highlight + shade, no accent/blue", () => {
    expect(LIQUID_GLASS_EDGE_SHADOW).toContain("inset");
    expect(LIQUID_GLASS_EDGE_SHADOW.split(",")).toHaveLength(3);
    expect(LIQUID_GLASS_EDGE_SHADOW).toContain("255 255 255");
    expect(LIQUID_GLASS_EDGE_SHADOW.toLowerCase()).not.toMatch(NO_ACCENT);
  });

  it("defines a neutral specular sheen token", () => {
    expect(LIQUID_GLASS_SHEEN).toContain("radial-gradient");
    expect(LIQUID_GLASS_SHEEN).toContain("rgba(255,255,255");
    expect(LIQUID_GLASS_SHEEN.toLowerCase()).not.toMatch(NO_ACCENT);
  });

  it("rim CSS traces the rounded border via a mask-composite ring, not a one-sided line", () => {
    const css = liquidGlassRimCss(".eliza-notif-glass");
    // Targets the caller's selector's ::before and follows the element radius.
    expect(css).toContain(".eliza-notif-glass::before");
    expect(css).toContain("border-radius: inherit");
    // The ring is the mask-composite (exclude/xor) padding-box trick — this is
    // what makes it a rounded rim on ALL edges rather than a single inset side.
    expect(css).toContain("mask-composite: exclude");
    expect(css).toContain("-webkit-mask-composite: xor");
    // Neutral white gradient only; no accent/blue.
    expect(css).toContain("rgba(255, 255, 255");
    expect(css.toLowerCase()).not.toMatch(NO_ACCENT);
  });

  it("refraction backdrop references the mounted filter with a plain-blur fallback", () => {
    expect(LIQUID_GLASS_REFRACTION).toContain(
      `url(#${LIQUID_GLASS_REFRACTION_FILTER_ID})`,
    );
    // Keeps blur+saturate alongside the displacement so it degrades sanely.
    expect(LIQUID_GLASS_REFRACTION).toContain("blur(");
    expect(LIQUID_GLASS_REFRACTION).toContain("saturate(");
    // The WebKit / no-url-backdrop fallback is frosted blur only (no url ref).
    expect(LIQUID_GLASS_BLUR).toContain("blur(");
    expect(LIQUID_GLASS_BLUR).not.toContain("url(");
  });

  it("mounts a static (fixed-seed) displacement filter with the referenced id", () => {
    const { container } = render(<LiquidGlassRefractionDefs />);
    const filter = container.querySelector(
      `filter#${LIQUID_GLASS_REFRACTION_FILTER_ID}`,
    );
    expect(filter).not.toBeNull();
    // Edge refraction = turbulence → blur → displacement; fixed seed keeps it
    // static (no shimmer over the live background, deterministic screenshots).
    const turbulence = filter?.querySelector("feTurbulence");
    expect(turbulence?.getAttribute("seed")).toBe("17");
    expect(filter?.querySelector("feDisplacementMap")).not.toBeNull();
  });
});
