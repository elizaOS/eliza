import { describe, expect, it } from "vitest";

import { CHARACTER_DEFINITIONS } from "./character-presets.characters.js";
import {
  buildElizaCharacterCatalog,
  getDefaultStylePreset,
  resolveStylePresetByAvatarIndex,
  resolveStylePresetById,
} from "./character-presets.js";

// avatarIndex is a VRM art-asset index, not a persona key: several personas can
// share one art asset (the default Eliza and Chen both render asset 1). These
// tests pin the resolution contract when the default character and a named
// preset that shares its avatar are provisioned side by side.
describe("character preset resolution with a shared avatarIndex", () => {
  const defaultDefinition = CHARACTER_DEFINITIONS[0];
  const sibling = CHARACTER_DEFINITIONS.find(
    (definition) =>
      definition !== defaultDefinition &&
      definition.avatarIndex === defaultDefinition.avatarIndex,
  );

  it("bundles the ambiguous pair the contract is about (data premise)", () => {
    expect(defaultDefinition?.id).toBe("eliza");
    expect(sibling?.id).toBe("chen");
    expect(sibling?.avatarIndex).toBe(defaultDefinition?.avatarIndex);
  });

  it("resolves every preset to its own persona by id", () => {
    for (const definition of CHARACTER_DEFINITIONS) {
      const preset = resolveStylePresetById(definition.id);
      expect(preset?.id).toBe(definition.id);
      expect(preset?.name).toBe(definition.name);
      expect(preset?.system).toContain(definition.system);
      expect(preset?.avatarIndex).toBe(definition.avatarIndex);
    }
  });

  it("resolves the shared avatarIndex to the default persona, not the last-declared sibling", () => {
    const preset = resolveStylePresetByAvatarIndex(
      defaultDefinition.avatarIndex,
    );
    expect(preset?.id).toBe(defaultDefinition.id);
    expect(preset?.name).toBe(defaultDefinition.name);
    expect(preset?.system).toContain(defaultDefinition.system);
  });

  it("resolves every unshared avatarIndex to its own persona", () => {
    for (const definition of CHARACTER_DEFINITIONS) {
      const holders = CHARACTER_DEFINITIONS.filter(
        (candidate) => candidate.avatarIndex === definition.avatarIndex,
      );
      if (holders.length > 1) {
        continue;
      }
      expect(resolveStylePresetByAvatarIndex(definition.avatarIndex)?.id).toBe(
        definition.id,
      );
    }
  });

  it("keeps the default Eliza and the sibling preset as two distinct personas", () => {
    const eliza = resolveStylePresetById("eliza");
    const chen = resolveStylePresetById("chen");
    expect(eliza).toBeDefined();
    expect(chen).toBeDefined();
    expect(eliza?.system).not.toBe(chen?.system);
    expect(eliza?.bio).not.toEqual(chen?.bio);
    // The default persona must survive an avatarIndex round-trip: resolving
    // the avatar it renders may not swap it for the sibling's persona.
    expect(resolveStylePresetByAvatarIndex(eliza?.avatarIndex)?.id).toBe(
      "eliza",
    );
    expect(getDefaultStylePreset().id).toBe("eliza");
  });

  it("emits unique catalog asset ids and one injected character per persona", () => {
    const { assets, injectedCharacters } = buildElizaCharacterCatalog();
    const ids = assets.map((asset) => asset.id);
    expect(new Set(ids).size).toBe(ids.length);
    const slugs = assets.map((asset) => asset.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(injectedCharacters).toHaveLength(CHARACTER_DEFINITIONS.length);
  });
});
