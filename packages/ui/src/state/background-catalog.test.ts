/**
 * Background catalog (#13538): metadata, resolution, and config mapping. Proves
 * the catalog is the single source of truth for the gallery + agent name-select
 * and that unknown names resolve to nothing (confinement).
 */
import { describe, expect, it } from "vitest";
import { getShaderPreset } from "../backgrounds/shader-presets";
import {
  BACKGROUND_CATALOG,
  catalogEntryToConfig,
  DEFAULT_BACKGROUND_CATALOG_ID,
  resolveCatalogEntry,
} from "./ui-preferences";

const resolveSource = (id: string) => getShaderPreset(id)?.source;

describe("background catalog (#13538)", () => {
  it("image sources are same-origin, code-free (data / served asset / media) URLs", () => {
    for (const e of BACKGROUND_CATALOG) {
      if (e.kind === "image") {
        // The curated default is a served same-origin static asset (the sunset
        // wallpaper). Every OTHER image entry stays a tiny code-free gradient
        // data URL (#13538: no per-entry bundled binary bloat). All three
        // classes are same-origin and carry no GLSL source / preset id, so the
        // apply-channel confinement invariants (#11088 / #13523) hold.
        const isServedAsset =
          (e.id === DEFAULT_BACKGROUND_CATALOG_ID &&
            e.source.startsWith("/")) ||
          e.source.startsWith("/wallpapers/");
        expect(
          e.source.startsWith("data:image/svg+xml") ||
            e.source.startsWith("/api/media/") ||
            isServedAsset,
        ).toBe(true);
        // A served-asset reference is a short same-origin path; the gradient
        // data URLs stay tiny too. Either way the STRING is well under any
        // binary threshold (the bytes live in public/, never in the source).
        expect(e.source.length).toBeLessThan(2048);
      }
      if (e.kind === "glsl") {
        // A catalog glsl entry names a preset id, NEVER carries GLSL source.
        expect(e.source).not.toContain("gl_FragColor");
        expect(getShaderPreset(e.source)).toBeTruthy();
      }
    }
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
