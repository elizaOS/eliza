/**
 * Unit coverage for the shared wallpaper idiom token module.
 * The harness is pure Vitest: no DOM or mocked browser state, just locked class
 * recipes so duplicated shell wallpaper values do not drift again.
 */
import { describe, expect, it } from "vitest";

import {
  WALLPAPER_FLOAT_SHADOW,
  WALLPAPER_GLASS,
  WALLPAPER_TEXT,
} from "./wallpaper-idiom";

describe("wallpaper idiom tokens", () => {
  it("keeps floating wallpaper text on one shared shadow", () => {
    expect(WALLPAPER_FLOAT_SHADOW).toBe(
      "[text-shadow:0_1px_4px_rgba(0,0,0,0.7)]",
    );
  });

  it("keeps wallpaper text and glass recipes tokenized", () => {
    expect(WALLPAPER_TEXT.primary).toBe("text-white/85");
    expect(WALLPAPER_GLASS.notificationCenter).toContain("backdrop-blur-md");
    expect(WALLPAPER_GLASS.notificationCenter).not.toContain(
      "backdrop-blur-xl",
    );
    expect(Object.values(WALLPAPER_GLASS).join(" ")).not.toMatch(
      /#[0-9a-f]{3,8}/i,
    );
  });
});
