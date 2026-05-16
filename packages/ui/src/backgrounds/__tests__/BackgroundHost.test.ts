import { describe, expect, it } from "vitest";
import { shouldUseSolidBackgroundFallback } from "../BackgroundHost";

describe("BackgroundHost", () => {
  it("uses a solid fallback for SVG-filtered backgrounds in Electrobun", () => {
    expect(
      shouldUseSolidBackgroundFallback({
        moduleKind: "svg-filtered-clouds",
        electrobunRuntime: true,
        reducedMotion: false,
      }),
    ).toBe(true);
  });

  it("uses a solid fallback for SVG-filtered backgrounds when motion is reduced", () => {
    expect(
      shouldUseSolidBackgroundFallback({
        moduleKind: "svg-filtered-clouds",
        electrobunRuntime: false,
        reducedMotion: true,
      }),
    ).toBe(true);
  });

  it("keeps non-SVG backgrounds on their own renderer", () => {
    expect(
      shouldUseSolidBackgroundFallback({
        moduleKind: "solid",
        electrobunRuntime: true,
        reducedMotion: true,
      }),
    ).toBe(false);
  });
});
