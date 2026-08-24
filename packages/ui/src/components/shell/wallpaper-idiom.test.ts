/**
 * Unit tests for the wallpaper-surface visual tokens. Pins the fixed
 * light-text ladder ordering, the dark-glass recipe structure, and the
 * theme-independence contract shared by wallpaper-mounted shell chrome.
 */
import { describe, expect, it } from "vitest";
import {
  WALLPAPER_FLOAT_SHADOW,
  WALLPAPER_GLASS,
  WALLPAPER_TEXT,
} from "./wallpaper-idiom.ts";

const TEXT_LADDER_KEYS = [
  "base",
  "strong",
  "primary",
  "secondary",
  "muted",
  "soft",
  "faint",
  "whisper",
] as const;

function ladderOpacity(key: (typeof TEXT_LADDER_KEYS)[number]): number {
  const match = WALLPAPER_TEXT[key].match(/^text-white(?:\/(\d+))?$/);
  expect(match, `${key} must be a bare text-white utility`).not.toBeNull();
  return match?.[1] === undefined ? 100 : Number(match[1]);
}

describe("wallpaper-idiom", () => {
  it("exposes exactly the documented token groups", () => {
    expect(Object.keys(WALLPAPER_TEXT)).toEqual([
      ...TEXT_LADDER_KEYS,
      "danger",
      "warning",
    ]);
    expect(Object.keys(WALLPAPER_GLASS)).toEqual([
      "notificationCenter",
      "menuPanel",
      "menuStatus",
      "menuWarning",
      "messageBubble",
      "iconPlate",
      "floatingControl",
    ]);
    expect(typeof WALLPAPER_FLOAT_SHADOW).toBe("string");
  });

  it("floats naked text with a single dark shadow tuned for bright backgrounds", () => {
    const parts = WALLPAPER_FLOAT_SHADOW.match(
      /^\[text-shadow:(\d+)_(\d+)px_(\d+)px_rgba\((\d+),(\d+),(\d+),(0?\.\d+)\)\]$/,
    );
    expect(
      parts,
      `malformed float shadow: ${WALLPAPER_FLOAT_SHADOW}`,
    ).not.toBeNull();
    expect(parts?.slice(1, 4)).toEqual(["0", "1", "4"]);
    expect(parts?.slice(4, 7)).toEqual(["0", "0", "0"]);
    expect(Number(parts?.[7])).toBe(0.7);
  });

  it("orders the white-text ladder strictly from full opacity down to whisper", () => {
    const opacities = TEXT_LADDER_KEYS.map(ladderOpacity);
    for (let index = 1; index < opacities.length; index += 1) {
      expect(
        opacities[index],
        `${TEXT_LADDER_KEYS[index]} must sit below ${TEXT_LADDER_KEYS[index - 1]} in the ladder`,
      ).toBeLessThan(opacities[index - 1]);
    }
    expect(opacities[0]).toBe(100);
    expect(opacities[opacities.length - 1]).toBe(35);
  });

  it("keeps status tints as high-opacity light shades of red and amber", () => {
    expect(WALLPAPER_TEXT.danger).toMatch(/^text-red-\d+\/(?:8\d|9\d|100)$/);
    expect(WALLPAPER_TEXT.warning).toMatch(/^text-amber-\d+\/(?:8\d|9\d|100)$/);
  });

  it("never emits dark text or theme-dependent variants on any token", () => {
    const values = [
      WALLPAPER_FLOAT_SHADOW,
      ...Object.values(WALLPAPER_TEXT),
      ...Object.values(WALLPAPER_GLASS),
    ];
    for (const value of values) {
      expect(value).not.toMatch(
        /\btext-(?:black|gray|slate|zinc|neutral|stone)-/,
      );
      expect(value).not.toMatch(/\bdark:/);
      expect(value).not.toMatch(
        /-(?:foreground|background|card|popover|muted|accent|border)(?:[\s/"']|$)/,
      );
    }
  });

  it("grounds floating menu panels on the shared bg-black/85 wash", () => {
    for (const key of ["menuPanel", "menuStatus", "menuWarning"] as const) {
      expect(WALLPAPER_GLASS[key]).toContain("bg-black/85");
      expect(WALLPAPER_GLASS[key]).toContain("border");
    }
  });

  it("pairs the notification center blur with a supports-query fallback fill", () => {
    const recipe = WALLPAPER_GLASS.notificationCenter;
    expect(recipe).toContain("backdrop-blur-md");
    expect(recipe).toContain("supports-[backdrop-filter]:bg-black/30");
    expect(recipe.indexOf("bg-black/35")).toBeLessThan(
      recipe.indexOf("supports-[backdrop-filter]"),
    );
  });

  it("keeps chat message bubbles text-only on the shared panel glass", () => {
    expect(WALLPAPER_GLASS.messageBubble).toBe("text-white");
    expect(WALLPAPER_GLASS.messageBubble).not.toMatch(/\b(bg|border)-/);
  });

  it("gives hoverable plates a hover state and warning menus an amber hairline", () => {
    expect(WALLPAPER_GLASS.iconPlate).toContain("hover:bg-white/20");
    expect(WALLPAPER_GLASS.floatingControl).toContain("hover:bg-black/70");
    expect(WALLPAPER_GLASS.menuWarning).toContain("border-amber-400/25");
    for (const key of [
      "notificationCenter",
      "menuPanel",
      "menuStatus",
    ] as const) {
      expect(WALLPAPER_GLASS[key]).toMatch(/\bborder-white\/\d+/);
    }
  });

  it("emits clean, trimmed utility strings ready for class composition", () => {
    const values = [
      WALLPAPER_FLOAT_SHADOW,
      ...Object.values(WALLPAPER_TEXT),
      ...Object.values(WALLPAPER_GLASS),
    ];
    for (const value of values) {
      expect(value.length).toBeGreaterThan(0);
      expect(value).toBe(value.trim());
      expect(value).not.toMatch(/\s{2,}/);
    }
  });
});
