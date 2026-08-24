/**
 * Unit tests for wallpaper idiom: validates visual token mappings.
 */
import { describe, expect, it } from "vitest";
import {
  WALLPAPER_FLOAT_SHADOW,
  WALLPAPER_GLASS,
  WALLPAPER_TEXT,
} from "./wallpaper-idiom.ts";

describe("wallpaper-idiom", () => {
  it("defines float shadow class string", () => {
    expect(WALLPAPER_FLOAT_SHADOW).toContain("text-shadow:0_1px_4px");
  });

  it("defines light text color hierarchy", () => {
    expect(WALLPAPER_TEXT.base).toBe("text-white");
    expect(WALLPAPER_TEXT.strong).toBe("text-white/95");
    expect(WALLPAPER_TEXT.danger).toContain("text-red-200");
  });

  it("defines dark glass recipes for chrome", () => {
    expect(WALLPAPER_GLASS.notificationCenter).toContain("backdrop-blur-md");
    expect(WALLPAPER_GLASS.menuPanel).toContain("bg-black/85");
  });
});
