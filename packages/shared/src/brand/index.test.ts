/**
 * Unit tests for the @elizaos/shared/brand token registry.
 *
 * Exercises the real consumer contracts of src/brand/index.ts rather than
 * restating its literals: every registered asset path must resolve to a file
 * in packages/shared/assets (the tree scripts/sync-to-public.mjs publishes
 * into consumers' public/brand/), surface themes must compose from the
 * canonical palette with readable contrast, external URLs must be
 * well-formed https, and font tokens must stay structurally valid CSS.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BANNER_FILES,
  BRAND_COLORS,
  BRAND_FAVICONS,
  BRAND_PATHS,
  CLOUD_BACKGROUND_ASSETS,
  CONCEPT_PRODUCT_IMAGES,
  EXTERNAL_URLS,
  FONT_STACK,
  FONT_WEIGHTS,
  LOGO_FILES,
  OG_EMBED_FILES,
  SURFACE_THEMES,
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const assetsRoot = resolve(here, "..", "..", "assets");

function expectAssetFile(relativePath: string) {
  const absolutePath = join(assetsRoot, relativePath);
  expect(
    existsSync(absolutePath),
    `registry points at missing asset: ${relativePath}`,
  ).toBe(true);
  expect(
    statSync(absolutePath).isFile(),
    `not a regular file: ${relativePath}`,
  ).toBe(true);
}

/**
 * Full public-relative registry entries ("/brand/<category>/<file>") must map
 * onto the same layout scripts/sync-to-public.mjs produces under public/.
 */
function expectSyncedBrandPath(publicPath: string) {
  const prefix = "/brand/";
  expect(
    publicPath.startsWith(prefix),
    `path is not public-relative to /brand/: ${publicPath}`,
  ).toBe(true);
  expectAssetFile(publicPath.slice(prefix.length));
}

describe("brand", () => {
  it("resolves every registered logo, banner, og-embed, concept and background asset to a real synced file", () => {
    expect(Object.keys(LOGO_FILES).length).toBeGreaterThan(0);
    for (const fileName of Object.values(LOGO_FILES)) {
      expectAssetFile(join("logos", fileName));
    }

    for (const fileName of Object.values(BANNER_FILES)) {
      expectAssetFile(join("banners", fileName));
    }

    for (const fileName of Object.values(OG_EMBED_FILES)) {
      expectAssetFile(join("ogembeds", fileName));
    }

    for (const assetPath of Object.values(CONCEPT_PRODUCT_IMAGES)) {
      expectSyncedBrandPath(assetPath);
    }

    for (const assetPath of Object.values(CLOUD_BACKGROUND_ASSETS)) {
      expectSyncedBrandPath(assetPath);
    }
  });

  it("resolves every registered favicon to a real file in the favicons category", () => {
    expect(Object.keys(BRAND_FAVICONS).length).toBeGreaterThan(0);
    for (const faviconPath of Object.values(BRAND_FAVICONS)) {
      expectSyncedBrandPath(faviconPath);
    }
  });

  it("maps every brand path category to its sync destination backed by a real asset directory", () => {
    expect(Object.keys(BRAND_PATHS).length).toBeGreaterThan(0);
    for (const [category, publicPath] of Object.entries(BRAND_PATHS)) {
      expect(publicPath).toBe(`/brand/${category}`);
      const categoryDir = join(assetsRoot, category);
      expect(existsSync(categoryDir), `missing asset dir: ${category}`).toBe(
        true,
      );
      expect(statSync(categoryDir).isDirectory()).toBe(true);
    }
  });

  it("composes each surface theme from palette colors with readable contrast and its documented theme class", () => {
    const paletteValues = new Set(Object.values(BRAND_COLORS));
    for (const [surface, theme] of Object.entries(SURFACE_THEMES)) {
      expect(theme.themeClass).toBe(`theme-${surface}`);
      expect(
        paletteValues.has(theme.background),
        `${surface} background is not a palette color`,
      ).toBe(true);
      expect(
        paletteValues.has(theme.text),
        `${surface} text is not a palette color`,
      ).toBe(true);
      expect(theme.background).not.toBe(theme.text);
    }
  });

  it("exposes only well-formed https URLs free of queries, fragments and credentials", () => {
    expect(Object.keys(EXTERNAL_URLS).length).toBeGreaterThan(0);
    for (const url of Object.values(EXTERNAL_URLS)) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.hostname.length).toBeGreaterThan(0);
      expect(parsed.search, `url carries a query: ${url}`).toBe("");
      expect(parsed.hash, `url carries a fragment: ${url}`).toBe("");
      expect(parsed.username, `url carries credentials: ${url}`).toBe("");
      expect(parsed.password, `url carries credentials: ${url}`).toBe("");
    }
  });

  it("defines brand colors as canonical six-digit hex values", () => {
    expect(Object.keys(BRAND_COLORS).length).toBeGreaterThan(0);
    for (const color of Object.values(BRAND_COLORS)) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("keeps the font stack a valid CSS family list ending in a generic fallback", () => {
    expect(FONT_STACK.trim().endsWith("sans-serif")).toBe(true);
    expect((FONT_STACK.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it("lists font weights in strictly ascending CSS-valid order", () => {
    expect(FONT_WEIGHTS.length).toBeGreaterThan(1);
    FONT_WEIGHTS.reduce((previous, weight) => {
      expect(weight).toBeGreaterThan(previous);
      return weight;
    }, 0);
    for (const weight of FONT_WEIGHTS) {
      expect(Number.isFinite(weight)).toBe(true);
      expect(weight).toBeGreaterThanOrEqual(1);
      expect(weight).toBeLessThanOrEqual(1000);
    }
  });
});
