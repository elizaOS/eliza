import { describe, expect, it } from "vitest";

import {
  buildElizaCharacterCatalog,
  getDefaultStylePreset,
  resolveStylePresetByAvatarIndex,
  resolveStylePresetById,
} from "./character-presets.js";

// `avatarIndex` is a VRM art-asset index, not a persona key — several personas
// can intentionally share one art asset (default Eliza and Chen both use
// index 1). Resolution over an ambiguous index must be deterministic and
// first-wins (earliest-declared persona), never last-wins.
describe("avatar-index resolution (shared art assets)", () => {
  it("resolves an ambiguous avatar index to the earliest-declared persona", () => {
    const defaultPreset = getDefaultStylePreset();
    const byIndex = resolveStylePresetByAvatarIndex(defaultPreset.avatarIndex);
    expect(byIndex?.id).toBe(defaultPreset.id);
  });

  it("resolves avatarIndex 1 to eliza, not the sibling persona sharing the asset", () => {
    expect(resolveStylePresetByAvatarIndex(1)?.id).toBe("eliza");
  });

  it("still resolves unshared avatar indexes to their own persona", () => {
    const chen = resolveStylePresetById("chen");
    expect(chen).toBeDefined();
    // Chen deliberately shares avatarIndex 1 with default Eliza; every other
    // persona owns its index and must keep resolving to itself.
    const jin = resolveStylePresetById("jin");
    expect(jin).toBeDefined();
    if (!jin) {
      throw new Error("jin preset missing");
    }
    expect(resolveStylePresetByAvatarIndex(jin.avatarIndex)?.id).toBe("jin");
  });
});

describe("buildElizaCharacterCatalog", () => {
  it("emits assets with unique ids (dedupes shared avatar indexes)", () => {
    const { assets } = buildElizaCharacterCatalog();
    const ids = assets.map((asset) => asset.id);
    expect(new Set(ids).size).toBe(ids.length);
    const slugs = assets.map((asset) => asset.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("titles a shared asset after the earliest-declared persona", () => {
    const { assets } = buildElizaCharacterCatalog();
    const defaultPreset = getDefaultStylePreset();
    const shared = assets.find(
      (asset) => asset.id === defaultPreset.avatarIndex,
    );
    expect(shared?.title).toBe(defaultPreset.name);
  });

  it("keeps every persona in injectedCharacters even when assets are shared", () => {
    const { injectedCharacters } = buildElizaCharacterCatalog();
    const names = injectedCharacters.map((character) => character.name);
    expect(names).toContain("Eliza");
    expect(names).toContain("Chen");
  });
});
