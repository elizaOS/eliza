/**
 * Unit tests for theme definition schema, CSS variable mappings, and validation logic.
 * Validates theme structure requirements, font links, and CSS custom property tables.
 */
import { describe, expect, it } from "vitest";
import {
  THEME_CSS_VAR_MAP,
  THEME_CSS_VAR_NAMES,
  THEME_FONT_CSS_VARS,
  THEME_FONT_LINK_ID,
  validateThemeDefinition,
} from "../theme.ts";

describe("theme contracts", () => {
  describe("constants", () => {
    it("defines font link id", () => {
      expect(THEME_FONT_LINK_ID).toBe("eliza-theme-font");
    });

    it("maps font CSS variable names correctly", () => {
      expect(THEME_FONT_CSS_VARS.body).toBe("--font-body");
      expect(THEME_FONT_CSS_VARS.display).toBe("--font-display");
      expect(THEME_FONT_CSS_VARS.chat).toBe("--font-chat");
      expect(THEME_FONT_CSS_VARS.mono).toBe("--mono");
    });

    it("maps key CSS color variables", () => {
      expect(THEME_CSS_VAR_MAP.bg).toBe("--bg");
      expect(THEME_CSS_VAR_MAP.accent).toBe("--accent");
      expect(THEME_CSS_VAR_MAP.border).toBe("--border");
      expect(THEME_CSS_VAR_NAMES).toContain("--bg");
      expect(THEME_CSS_VAR_NAMES).toContain("--accent");
    });
  });

  describe("validateThemeDefinition", () => {
    it("rejects non-object root inputs", () => {
      expect(validateThemeDefinition(null)).toEqual([
        { field: "root", message: "Theme must be a JSON object" },
      ]);
      expect(validateThemeDefinition("string")).toEqual([
        { field: "root", message: "Theme must be a JSON object" },
      ]);
      expect(validateThemeDefinition([1, 2])).toEqual([
        { field: "root", message: "Theme must be a JSON object" },
      ]);
    });

    it("validates required id and name fields", () => {
      const errors = validateThemeDefinition({});
      expect(errors).toContainEqual({
        field: "id",
        message: "Theme id is required",
      });
      expect(errors).toContainEqual({
        field: "name",
        message: "Theme name is required",
      });
    });

    it("rejects invalid kebab-case id", () => {
      const errors = validateThemeDefinition({
        id: "Invalid_ID!",
        name: "Test",
      });
      expect(errors).toContainEqual({
        field: "id",
        message:
          "Theme id must be kebab-case (lowercase letters, numbers, hyphens)",
      });
    });

    it("rejects non-object light, dark, or fonts entries", () => {
      const errors = validateThemeDefinition({
        id: "cyber-neon",
        name: "Cyber Neon",
        light: "not-an-object",
        dark: 123,
        fonts: "font-string",
      });
      expect(errors).toContainEqual({
        field: "light",
        message: "light must be an object",
      });
      expect(errors).toContainEqual({
        field: "dark",
        message: "dark must be an object",
      });
      expect(errors).toContainEqual({
        field: "fonts",
        message: "fonts must be an object",
      });
    });

    it("passes valid theme definitions", () => {
      const valid = {
        id: "cyber-neon",
        name: "Cyber Neon",
        description: "High contrast neon palette",
        light: { bg: "#ffffff", accent: "#ff0077" },
        dark: { bg: "#000000", accent: "#00ffff" },
        fonts: { body: "Inter, sans-serif" },
      };
      expect(validateThemeDefinition(valid)).toEqual([]);
    });
  });
});
