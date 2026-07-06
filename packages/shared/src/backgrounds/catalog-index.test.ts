/**
 * Background catalog NAME INDEX (#13538): the shared metadata half + the
 * matchers the BACKGROUND action uses to route "use the misty-forest background"
 * to a name-select. Proves the index is code-free and unknown names resolve to
 * nothing (confinement).
 */
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_CATALOG_INDEX,
  DEFAULT_BACKGROUND_CATALOG_ID,
  detectCatalogId,
  GLSL_BACKGROUND_META,
  IMAGE_BACKGROUND_META,
  matchCatalogId,
  NATURAL_BACKGROUND_META,
  PHOTO_BACKGROUND_META,
} from "./catalog-index";

describe("background catalog index (#13538)", () => {
  it("is the union of natural + photo + glsl metadata, code-free", () => {
    expect(BACKGROUND_CATALOG_INDEX.length).toBe(
      NATURAL_BACKGROUND_META.length +
        PHOTO_BACKGROUND_META.length +
        GLSL_BACKGROUND_META.length,
    );
    for (const e of BACKGROUND_CATALOG_INDEX) {
      // Pure metadata: no render source of any kind lives in the index.
      expect(e).not.toHaveProperty("source");
      expect(e.palette.length).toBeGreaterThan(0);
      expect(e.tags.length).toBeGreaterThan(0);
    }
  });

  it("ships the five curated photo wallpapers (#14 default-wallpapers)", () => {
    const ids = PHOTO_BACKGROUND_META.map((e) => e.id);
    expect(ids).toEqual([
      "dusk-dunes",
      "reef",
      "slate",
      "ember-dunes",
      "canopy",
    ]);
    for (const e of PHOTO_BACKGROUND_META) {
      // Photo wallpapers are image entries with a sampled 3-stop palette.
      expect(e.kind).toBe("image");
      expect(e.palette.length).toBeGreaterThanOrEqual(3);
      expect(e.label).toBeTruthy();
      expect(e.description).toBeTruthy();
    }
    // The image name-select set is exactly the gradient + photo image entries.
    expect(IMAGE_BACKGROUND_META.length).toBe(
      NATURAL_BACKGROUND_META.length + PHOTO_BACKGROUND_META.length,
    );
    expect(IMAGE_BACKGROUND_META.every((e) => e.kind === "image")).toBe(true);
  });

  it("the default id names a real catalog entry", () => {
    expect(
      BACKGROUND_CATALOG_INDEX.some(
        (e) => e.id === DEFAULT_BACKGROUND_CATALOG_ID,
      ),
    ).toBe(true);
  });

  it("matchCatalogId resolves id / label / fuzzy, undefined for unknown", () => {
    expect(matchCatalogId("misty-forest")).toBe("misty-forest");
    expect(matchCatalogId("Misty Forest")).toBe("misty-forest");
    expect(matchCatalogId("  ocean deep ")).toBe("ocean-deep");
    expect(matchCatalogId("aurora")).toBe("aurora");
    // The curated photo wallpapers resolve by id and label too.
    expect(matchCatalogId("reef")).toBe("reef");
    expect(matchCatalogId("Ember Dunes")).toBe("ember-dunes");
    expect(matchCatalogId("  dusk dunes ")).toBe("dusk-dunes");
    expect(matchCatalogId("totally-unknown")).toBeUndefined();
    expect(matchCatalogId("")).toBeUndefined();
    expect(matchCatalogId(undefined)).toBeUndefined();
  });

  it("matchCatalogId does NOT resolve generic color/tag words", () => {
    // "green"/"blue"/"warm" are tags on some entries but are color words that
    // belong to the color parser — they must not resolve to a curated image.
    expect(matchCatalogId("green")).toBeUndefined();
    expect(matchCatalogId("blue")).toBeUndefined();
    expect(matchCatalogId("warm")).toBeUndefined();
  });

  it("detectCatalogId only fires on distinctive catalog names, not plain colors", () => {
    expect(detectCatalogId("use the misty forest background")).toBe(
      "misty-forest",
    );
    expect(detectCatalogId("set the ocean-deep wallpaper")).toBe("ocean-deep");
    // The agent can name the new photo wallpapers too.
    expect(detectCatalogId("set the reef background")).toBe("reef");
    expect(detectCatalogId("use the ember dunes wallpaper")).toBe(
      "ember-dunes",
    );
    expect(detectCatalogId("put the canopy background on")).toBe("canopy");
    // A bare color word must NOT hijack a color request into a catalog select.
    expect(detectCatalogId("make the background green")).toBeUndefined();
    expect(detectCatalogId("set it to teal")).toBeUndefined();
  });
});
