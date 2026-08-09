/** Pure helper coverage for landing touch-target sizing and hidden chrome a11y. */

import { describe, expect, it } from "vitest";
import {
  COMPOSER_VIEWPORT_LIFT_PX,
  hiddenChromeDomProps,
  landingChromeBottomCss,
} from "../src/lib/landing-chrome-a11y";
import { resolveTouchOverlaySize } from "../src/lib/touch-overlay-size";

describe("resolveTouchOverlaySize", () => {
  it("expands sub-44 projected hit rects to the touch floor", () => {
    expect(resolveTouchOverlaySize(37, 36)).toEqual({ width: 44, height: 44 });
    expect(resolveTouchOverlaySize(87, 37)).toEqual({ width: 87, height: 44 });
  });

  it("does not shrink already-compliant rects", () => {
    expect(resolveTouchOverlaySize(48, 48)).toEqual({ width: 48, height: 48 });
  });
});

describe("hiddenChromeDomProps", () => {
  it("leaves the tab/a11y trees alone when chrome is interactive", () => {
    expect(hiddenChromeDomProps(true)).toEqual({});
  });

  it("marks retained-but-hidden chrome inert and aria-hidden", () => {
    expect(hiddenChromeDomProps(false)).toEqual({
      inert: true,
      "aria-hidden": true,
    });
  });
});

describe("landingChromeBottomCss", () => {
  it("lifts composer chrome by the rotateX spill floor and safe-area", () => {
    expect(landingChromeBottomCss(COMPOSER_VIEWPORT_LIFT_PX)).toBe(
      "max(8px, env(safe-area-inset-bottom, 0px))",
    );
  });

  it("preserves larger login/verify bottom offsets", () => {
    expect(landingChromeBottomCss(240)).toBe(
      "max(240px, env(safe-area-inset-bottom, 0px))",
    );
  });

  it("clamps non-positive bases to zero before maxing with safe-area", () => {
    expect(landingChromeBottomCss(0)).toBe(
      "max(0px, env(safe-area-inset-bottom, 0px))",
    );
    expect(landingChromeBottomCss(-12)).toBe(
      "max(0px, env(safe-area-inset-bottom, 0px))",
    );
  });
});
