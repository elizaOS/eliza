/**
 * Tests for brand — canonical brand tokens and asset paths.
 */
import { describe, expect, it } from "vitest";
import {
  BRAND_COLORS,
  BRAND_PATHS,
  EXTERNAL_URLS,
  SURFACE_THEMES,
} from "./index.ts";

describe("brand", () => {
  it("exports EXTERNAL_URLS with expected keys", () => {
    expect(EXTERNAL_URLS.marketing).toBe("https://eliza.app");
    expect(EXTERNAL_URLS.github).toBe("https://github.com/elizaOS/eliza");
    expect(EXTERNAL_URLS.discord).toBe("https://discord.gg/eliza");
    expect(EXTERNAL_URLS.docs).toBe("https://docs.elizaos.ai");
  });

  it("exports BRAND_COLORS with hex values", () => {
    expect(BRAND_COLORS.blue).toBe("#0B35F1");
    expect(BRAND_COLORS.orange).toBe("#FF5800");
    expect(BRAND_COLORS.white).toBe("#FFFFFF");
    expect(BRAND_COLORS.black).toBe("#000000");
  });

  it("exports SURFACE_THEMES with themeClass", () => {
    expect(SURFACE_THEMES.cloud.themeClass).toBe("theme-cloud");
    expect(SURFACE_THEMES.os.themeClass).toBe("theme-os");
    expect(SURFACE_THEMES.app.themeClass).toBe("theme-app");
  });

  it("exports BRAND_PATHS with expected prefixes", () => {
    expect(BRAND_PATHS.logos).toBe("/brand/logos");
    expect(BRAND_PATHS.background).toBe("/brand/background");
  });

  it("has consistent surface background colors", () => {
    expect(SURFACE_THEMES.cloud.background).toBe(BRAND_COLORS.black);
    expect(SURFACE_THEMES.os.background).toBe(BRAND_COLORS.blue);
  });
});
