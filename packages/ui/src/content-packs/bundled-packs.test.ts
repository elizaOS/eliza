import { getDefaultStylePreset, getStylePresets } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { getBundledContentPacks } from "./bundled-packs";

/**
 * Bundled content packs must be derived from the shared character-preset
 * registry, not hardcoded. This guards against the historical drift where
 * bundled-packs.ts carried its own (stale) catchphrases — e.g. Chen read
 * "Hey there!" while the registry says "Let's get to work!".
 */
describe("getBundledContentPacks", () => {
  const defaultPresetId = getDefaultStylePreset().id;
  const registryPresets = getStylePresets().filter(
    (preset) => preset.id !== defaultPresetId,
  );

  it("produces one pack per named (non-default) preset", () => {
    const packs = getBundledContentPacks();
    expect(packs).toHaveLength(8);
    expect(packs.map((pack) => pack.manifest.id)).toEqual(
      registryPresets.map((preset) => preset.id),
    );
  });

  it("derives name + catchphrase from the shared registry for all 8 characters", () => {
    const packs = getBundledContentPacks();
    for (const preset of registryPresets) {
      const pack = packs.find(
        (candidate) => candidate.manifest.id === preset.id,
      );
      expect(pack, `missing bundled pack for ${preset.id}`).toBeDefined();
      // Name matches the registry.
      expect(pack?.manifest.name).toBe(preset.name);
      expect(pack?.personality?.name).toBe(preset.name);
      // Catchphrase matches the registry (proves the drift is gone).
      expect(pack?.personality?.catchphrase).toBe(preset.catchphrase);
      expect(pack?.manifest.assets.personality?.catchphrase).toBe(
        preset.catchphrase,
      );
    }
  });

  it("has no stale catchphrases from the old hardcoded table", () => {
    const packs = getBundledContentPacks();
    const stale: Record<string, string> = {
      chen: "Hey there!",
      jin: "What's up?",
      kei: "Hi!",
      momo: "Hello!",
      rin: "Greetings!",
      ryu: "Yo!",
      satoshi: "Welcome!",
      yuki: "Nice to meet you!",
    };
    for (const pack of packs) {
      expect(pack.personality?.catchphrase).not.toBe(stale[pack.manifest.id]);
    }
  });

  it("references /vrms assets by avatarIndex-derived slug", () => {
    const packs = getBundledContentPacks();
    for (const preset of registryPresets) {
      const pack = packs.find(
        (candidate) => candidate.manifest.id === preset.id,
      );
      const slug = `bundled-${preset.avatarIndex}`;
      expect(pack?.avatarIndex).toBe(preset.avatarIndex);
      expect(pack?.vrmUrl).toBeUndefined();
      expect(pack?.vrmPreviewUrl).toBe(`/vrms/previews/${slug}.png`);
      expect(pack?.backgroundUrl).toBe(`/vrms/backgrounds/${slug}.png`);
      expect(pack?.manifest.assets.vrm?.slug).toBe(slug);
      expect(pack?.manifest.assets.vrm?.file).toBe(`${slug}.vrm.gz`);
      expect(pack?.source).toEqual({ kind: "bundled", id: preset.id });
    }
  });
});
