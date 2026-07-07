// @vitest-environment jsdom
/**
 * Unit coverage for the chat-sheet liquid-glass recipe. The production contract
 * is token-based: neutral inset edge depth plus a soft specular sheen, with no
 * accent colors and no full-surface refraction filter.
 */
import { describe, expect, it } from "vitest";

import { LIQUID_GLASS_EDGE_SHADOW, LIQUID_GLASS_SHEEN } from "./liquid-glass";

describe("liquid-glass", () => {
  it("keeps the bevel neutral: inset highlight + shade, no accent/blue", () => {
    expect(LIQUID_GLASS_EDGE_SHADOW).toContain("inset");
    expect(LIQUID_GLASS_EDGE_SHADOW.split(",")).toHaveLength(3);
    expect(LIQUID_GLASS_EDGE_SHADOW).toContain("255 255 255");
    expect(LIQUID_GLASS_EDGE_SHADOW.toLowerCase()).not.toMatch(
      /blue|#[0-9a-f]*[0-9a-f]{2}(ff|cc)\b|var\(--accent/,
    );
  });

  it("defines a neutral specular sheen token", () => {
    expect(LIQUID_GLASS_SHEEN).toContain("radial-gradient");
    expect(LIQUID_GLASS_SHEEN).toContain("rgba(255,255,255");
    expect(LIQUID_GLASS_SHEEN.toLowerCase()).not.toMatch(
      /blue|#[0-9a-f]*[0-9a-f]{2}(ff|cc)\b|var\(--accent/,
    );
  });
});
