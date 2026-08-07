/**
 * Exercises the background-name matchers used to route requests such as
 * "use the misty-forest background" while rejecting unknown or generic colors.
 */
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_CATALOG_INDEX,
  DEFAULT_BACKGROUND_CATALOG_ID,
  detectCatalogId,
  matchCatalogId,
} from "./catalog-index";

describe("background catalog index (#13538)", () => {
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
