/** Exercises theme validation with valid definitions and malformed inputs. */
import { describe, expect, it } from "vitest";
import { validateThemeDefinition } from "../theme.ts";

describe("theme contracts", () => {
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
