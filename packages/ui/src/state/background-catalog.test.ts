/**
 * Background catalog (#13538): metadata, resolution, and config mapping. Proves
 * the catalog is the single source of truth for the gallery + agent name-select
 * and that unknown names resolve to nothing (confinement).
 */
import { describe, expect, it } from "vitest";
import { getShaderPreset } from "../backgrounds/shader-presets";
import {
  BACKGROUND_CATALOG,
  CURATED_NATURAL_BACKGROUNDS,
  catalogEntryToConfig,
  DEFAULT_BACKGROUND_CATALOG_ID,
  DEFAULT_BACKGROUND_CONFIG,
  GLSL_CATALOG_BACKGROUNDS,
  resolveCatalogEntry,
} from "./ui-preferences";

const resolveSource = (id: string) => getShaderPreset(id)?.source;

describe("background catalog (#13538)", () => {
  it("has natural image entries + the animated GLSL presets", () => {
    expect(CURATED_NATURAL_BACKGROUNDS.length).toBeGreaterThanOrEqual(4);
    expect(GLSL_CATALOG_BACKGROUNDS.length).toBe(5);
    expect(BACKGROUND_CATALOG.length).toBe(
      CURATED_NATURAL_BACKGROUNDS.length + GLSL_CATALOG_BACKGROUNDS.length,
    );
  });

  it("every entry carries the required metadata", () => {
    for (const e of BACKGROUND_CATALOG) {
      expect(e.id).toBeTruthy();
      expect(e.label).toBeTruthy();
      expect(e.description).toBeTruthy();
      expect(e.mood).toBeTruthy();
      expect(e.palette.length).toBeGreaterThan(0);
      expect(e.tags.length).toBeGreaterThan(0);
      expect(["image", "glsl", "color"]).toContain(e.kind);
    }
  });

  it("commits NO bundled binary — image sources are code-free data/served URLs", () => {
    for (const e of BACKGROUND_CATALOG) {
      if (e.kind === "image") {
        expect(
          e.source.startsWith("data:image/svg+xml") ||
            e.source.startsWith("/api/media/"),
        ).toBe(true);
        // The whole gradient stays tiny (well under any binary threshold).
        expect(e.source.length).toBeLessThan(2048);
      }
      if (e.kind === "glsl") {
        // A catalog glsl entry names a preset id, NEVER carries GLSL source.
        expect(e.source).not.toContain("gl_FragColor");
        expect(getShaderPreset(e.source)).toBeTruthy();
      }
    }
  });

  it("the boot default is a curated natural image, not a flat color", () => {
    expect(DEFAULT_BACKGROUND_CONFIG.mode).toBe("image");
    expect(DEFAULT_BACKGROUND_CONFIG.imageUrl).toContain("data:image/svg+xml");
    const def = BACKGROUND_CATALOG.find(
      (e) => e.id === DEFAULT_BACKGROUND_CATALOG_ID,
    );
    expect(def?.kind).toBe("image");
    expect(def?.source).toBe(DEFAULT_BACKGROUND_CONFIG.imageUrl);
  });

  it("resolveCatalogEntry matches by id, label, and fuzzy name", () => {
    expect(resolveCatalogEntry("misty-forest")?.id).toBe("misty-forest");
    expect(resolveCatalogEntry("Misty Forest")?.id).toBe("misty-forest");
    expect(resolveCatalogEntry("  MISTY forest ")?.id).toBe("misty-forest");
    expect(resolveCatalogEntry("aurora")?.id).toBe("aurora");
  });

  it("resolveCatalogEntry returns undefined for unknown / empty names", () => {
    expect(resolveCatalogEntry("nope-not-real")).toBeUndefined();
    expect(resolveCatalogEntry("")).toBeUndefined();
    expect(resolveCatalogEntry(undefined)).toBeUndefined();
  });

  it("catalogEntryToConfig maps image → image config", () => {
    const forest = resolveCatalogEntry("misty-forest");
    expect(forest).toBeTruthy();
    if (!forest) throw new Error("expected misty-forest entry");
    const config = catalogEntryToConfig(forest, resolveSource);
    expect(config?.mode).toBe("image");
    expect(config?.imageUrl).toBe(forest.source);
  });

  it("catalogEntryToConfig maps glsl → a config with the vetted preset source", () => {
    const aurora = resolveCatalogEntry("aurora");
    expect(aurora).toBeTruthy();
    if (!aurora) throw new Error("expected aurora entry");
    const config = catalogEntryToConfig(aurora, resolveSource);
    expect(config?.mode).toBe("glsl");
    expect(config?.shader?.presetId).toBe("aurora");
    expect(config?.shader?.source).toBe(getShaderPreset("aurora")?.source);
  });

  it("catalogEntryToConfig returns undefined for a glsl entry with an unresolvable preset", () => {
    const aurora = resolveCatalogEntry("aurora");
    if (!aurora) throw new Error("expected aurora entry");
    const bogus = { ...aurora, source: "not-a-real-preset" };
    expect(catalogEntryToConfig(bogus, resolveSource)).toBeUndefined();
  });
});
