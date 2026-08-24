/**
 * Contract tests for the per-variant glass token table in `./tokens`: the
 * cross-field optical contracts consumers branch on (rim + refraction matrix,
 * fill-opacity ordering, shared liquid-glass layer identity, blur-strength
 * ladder, recipe-to-fill-constant wiring). Complements the render-focused
 * `glass.test.tsx`, which owns the sheet-fill literal and the native-tier
 * lifecycle; this suite drives the real token module deterministically with
 * no mocks and no DOM.
 */

import { describe, expect, it } from "vitest";
import {
  LIQUID_GLASS_BLUR,
  LIQUID_GLASS_EDGE_SHADOW,
  LIQUID_GLASS_REFRACTION,
  LIQUID_GLASS_SHEEN,
} from "../components/shell/liquid-glass";
import {
  GLASS_BANNER_FILL,
  GLASS_CARD_FILL,
  GLASS_MENU_FILL,
  GLASS_PILL_FILL,
  GLASS_RECIPES,
  GLASS_SHEET_FILL,
  type GlassVariant,
} from "./tokens";

const VARIANTS = [
  "sheet",
  "card",
  "pill",
  "menu",
  "banner",
] as const satisfies readonly GlassVariant[];

/** Alpha percentage of an `rgb(r g b / N%)` translucent fill. */
function fillOpacity(background: string): number {
  const match = background.match(/\/\s*(\d+(?:\.\d+)?)%/);
  expect(match, background).not.toBeNull();
  return Number(match?.[1]);
}

/** Blur radius in px of a `blur(Npx ...)` backdrop filter. */
function blurRadius(backdropFilter: string): number {
  const match = backdropFilter.match(/blur\((\d+(?:\.\d+)?)px\)/);
  expect(match, backdropFilter).not.toBeNull();
  return Number(match?.[1]);
}

describe("glass recipe tokens", () => {
  it("resolves every documented surface role to a recipe with no undefined layers", () => {
    for (const v of VARIANTS) {
      const recipe = GLASS_RECIPES[v];
      expect(recipe, v).toBeDefined();
      for (const [field, value] of Object.entries(recipe)) {
        expect(value, `${v}.${field}`).not.toBeUndefined();
      }
    }
  });

  it("draws the rim ring on persistent chrome only (sheet and banner stay bare)", () => {
    expect(GLASS_RECIPES.sheet.rim).toBe(false);
    expect(GLASS_RECIPES.banner.rim).toBe(false);
    expect(GLASS_RECIPES.card.rim).toBe(true);
    expect(GLASS_RECIPES.pill.rim).toBe(true);
    expect(GLASS_RECIPES.menu.rim).toBe(true);
  });

  it("never upgrades the compact pill to Chromium refraction", () => {
    expect(GLASS_RECIPES.pill.refraction).toBeNull();
  });

  it("keeps card and menu refraction anchored to the shared filter def", () => {
    expect(GLASS_RECIPES.card.refraction).toBe(LIQUID_GLASS_REFRACTION);
    expect(GLASS_RECIPES.menu.refraction).toBe(LIQUID_GLASS_REFRACTION);
  });

  it("renders menu chrome darker than cards so hit targets stay legible", () => {
    expect(fillOpacity(GLASS_RECIPES.menu.background)).toBeGreaterThan(
      fillOpacity(GLASS_RECIPES.card.background),
    );
  });

  it("raises banner above card opacity for instant toast legibility", () => {
    expect(fillOpacity(GLASS_RECIPES.banner.background)).toBeGreaterThan(
      fillOpacity(GLASS_RECIPES.card.background),
    );
  });

  it("keeps the pill the lightest of the rgb-alpha fills so its icon carries contrast", () => {
    const pillOpacity = fillOpacity(GLASS_PILL_FILL);
    for (const v of ["card", "menu", "banner"] as const) {
      expect(pillOpacity, v).toBeLessThan(
        fillOpacity(GLASS_RECIPES[v].background),
      );
    }
  });

  it("shares one edge-shadow + sheen token across every role", () => {
    for (const v of VARIANTS) {
      expect(GLASS_RECIPES[v].edgeShadow, v).toBe(LIQUID_GLASS_EDGE_SHADOW);
      expect(GLASS_RECIPES[v].sheen, v).toBe(LIQUID_GLASS_SHEEN);
    }
  });

  it("pulls card, menu and banner blur from the shared liquid-glass token", () => {
    expect(GLASS_RECIPES.card.backdropFilter).toBe(LIQUID_GLASS_BLUR);
    expect(GLASS_RECIPES.menu.backdropFilter).toBe(LIQUID_GLASS_BLUR);
    expect(GLASS_RECIPES.banner.backdropFilter).toBe(LIQUID_GLASS_BLUR);
  });

  it("orders blur strength sheet > floating panels > compact pill", () => {
    expect(blurRadius(GLASS_RECIPES.sheet.backdropFilter)).toBeGreaterThan(
      blurRadius(LIQUID_GLASS_BLUR),
    );
    expect(blurRadius(LIQUID_GLASS_BLUR)).toBeGreaterThan(
      blurRadius(GLASS_RECIPES.pill.backdropFilter),
    );
    expect(GLASS_RECIPES.pill.backdropFilter).toMatch(/saturate\(/);
  });

  it("wires every recipe fill to its exported fill constant", () => {
    expect(GLASS_RECIPES.sheet.background).toBe(GLASS_SHEET_FILL);
    expect(GLASS_RECIPES.card.background).toBe(GLASS_CARD_FILL);
    expect(GLASS_RECIPES.menu.background).toBe(GLASS_MENU_FILL);
    expect(GLASS_RECIPES.banner.background).toBe(GLASS_BANNER_FILL);
    expect(GLASS_RECIPES.pill.background).toBe(GLASS_PILL_FILL);
  });

  it("rounds the pill into a full capsule while panels keep finite radii", () => {
    expect(Number.parseFloat(GLASS_RECIPES.pill.radius)).toBeGreaterThan(100);
    for (const v of ["sheet", "card", "menu", "banner"] as const) {
      expect(Number.parseFloat(GLASS_RECIPES[v].radius), v).toBeLessThan(10);
    }
  });
});
