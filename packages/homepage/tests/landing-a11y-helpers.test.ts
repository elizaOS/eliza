/** Pure helper coverage for landing touch-target sizing. */

import { describe, expect, it } from "vitest";
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
