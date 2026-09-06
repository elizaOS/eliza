/**
 * Unit tests for the `utils/theme` helpers (pure functions, no React/DOM).
 *
 * Covers the CSS-variable projection and the merge precedence rules that
 * <LoginProvider> relies on when combining tenant theme config with
 * caller overrides.
 */

import { describe, expect, test } from "vitest";
import type { TenantTheme } from "../types.js";
import { DEFAULT_THEME, mergeTheme, themeToCSS } from "../utils/theme.js";

describe("themeToCSS", () => {
  test("projects every theme field onto its --stwd-* custom property", () => {
    const css = themeToCSS(DEFAULT_THEME);
    expect(css["--stwd-primary"]).toBe(DEFAULT_THEME.primaryColor);
    expect(css["--stwd-accent"]).toBe(DEFAULT_THEME.accentColor);
    expect(css["--stwd-bg"]).toBe(DEFAULT_THEME.backgroundColor);
    expect(css["--stwd-surface"]).toBe(DEFAULT_THEME.surfaceColor);
    expect(css["--stwd-text"]).toBe(DEFAULT_THEME.textColor);
    expect(css["--stwd-muted"]).toBe(DEFAULT_THEME.mutedColor);
    expect(css["--stwd-success"]).toBe(DEFAULT_THEME.successColor);
    expect(css["--stwd-error"]).toBe(DEFAULT_THEME.errorColor);
    expect(css["--stwd-warning"]).toBe(DEFAULT_THEME.warningColor);
  });

  test("suffixes borderRadius with px", () => {
    const css = themeToCSS({ ...DEFAULT_THEME, borderRadius: 12 });
    expect(css["--stwd-radius"]).toBe("12px");
  });

  test("falls back to the default font stack when fontFamily is empty", () => {
    const css = themeToCSS({ ...DEFAULT_THEME, fontFamily: "" });
    expect(css["--stwd-font"]).toBe("Inter, system-ui, sans-serif");
  });

  test("uses a provided fontFamily verbatim", () => {
    const css = themeToCSS({ ...DEFAULT_THEME, fontFamily: "Comic Sans MS" });
    expect(css["--stwd-font"]).toBe("Comic Sans MS");
  });
});

describe("mergeTheme", () => {
  test("returns the base theme untouched when no overrides are given", () => {
    const merged = mergeTheme(DEFAULT_THEME);
    expect(merged).toBe(DEFAULT_THEME);
  });

  test("returns the base theme untouched when overrides is undefined", () => {
    const merged = mergeTheme(DEFAULT_THEME, undefined);
    expect(merged).toBe(DEFAULT_THEME);
  });

  test("override fields win over base fields", () => {
    const overrides: Partial<TenantTheme> = {
      primaryColor: "#FF0000",
      borderRadius: 0,
    };
    const merged = mergeTheme(DEFAULT_THEME, overrides);
    expect(merged.primaryColor).toBe("#FF0000");
    expect(merged.borderRadius).toBe(0);
    // Untouched fields fall through from the base.
    expect(merged.accentColor).toBe(DEFAULT_THEME.accentColor);
    expect(merged.colorScheme).toBe(DEFAULT_THEME.colorScheme);
  });

  test("does not mutate the base theme object", () => {
    const baseClone = { ...DEFAULT_THEME };
    mergeTheme(DEFAULT_THEME, { primaryColor: "#123456" });
    expect(DEFAULT_THEME).toEqual(baseClone);
  });

  test("mergeTheme preserves tenant appearance asset URLs", () => {
    const theme = mergeTheme(DEFAULT_THEME, {
      logoUrl: "https://assets.example.test/logo.png",
      faviconUrl: "https://assets.example.test/favicon.ico",
    });

    expect(theme.logoUrl).toBe("https://assets.example.test/logo.png");
    expect(theme.faviconUrl).toBe("https://assets.example.test/favicon.ico");
  });
});
