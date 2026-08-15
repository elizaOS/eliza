/**
 * Tests the app-core character builder's persona-inheritance boundary with the
 * real upstream builder and bundled presets (no mocks): a custom agent name
 * still inherits the default preset persona, while an explicit replacement
 * system prompt opts out of preset backfill entirely.
 */
import { describe, expect, it } from "vitest";
import { buildCharacterFromConfig } from "./build-character-from-config";

type BuilderConfig = Parameters<typeof buildCharacterFromConfig>[0];

describe("app-core custom-name persona inheritance", () => {
  it("inherits the default preset persona and style for a custom name", () => {
    const character = buildCharacterFromConfig({
      agents: { list: [{ name: "Zzyzx Quorra" }] },
    } as BuilderConfig);

    expect(character.name).toBe("Zzyzx Quorra");
    expect(character.system).toContain("You're {{name}}");
    expect(character.style?.all?.length ?? 0).toBeGreaterThan(0);
    expect(character.style?.chat?.length ?? 0).toBeGreaterThan(0);
    expect(character.adjectives?.length ?? 0).toBeGreaterThan(0);
  });

  it("skips preset backfill when a replacement system prompt is supplied", () => {
    const character = buildCharacterFromConfig({
      agents: {
        list: [{ name: "Zzyzx Quorra", system: "You are a pirate. Arr." }],
      },
    } as BuilderConfig);

    expect(character.system).toContain("You are a pirate. Arr.");
    expect(character.system).not.toContain("You're {{name}}");
    expect(character.style).toBeUndefined();
    expect(character.adjectives ?? []).toHaveLength(0);
  });

  it("keeps explicit preset selection winning over the default fallback", () => {
    const custom = buildCharacterFromConfig({
      agents: { list: [{ name: "Zzyzx Quorra" }] },
      ui: { presetId: "satoshi" },
    } as BuilderConfig);

    expect(custom.name).toBe("Zzyzx Quorra");
    expect(custom.system).not.toContain("You're {{name}}");
  });
});
