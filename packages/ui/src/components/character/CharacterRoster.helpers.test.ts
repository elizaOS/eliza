/**
 * Unit tests for CharacterRoster helpers: validates roster mapping and custom pack creation.
 */

import type { StylePreset } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  createCustomPackRosterEntry,
  INSET_CLIP,
  resolveRosterEntries,
  SLANT_CLIP,
} from "./CharacterRoster.helpers.ts";

describe("CharacterRoster.helpers", () => {
  it("exports polygon clip path constants", () => {
    expect(SLANT_CLIP).toContain("polygon(");
    expect(INSET_CLIP).toContain("polygon(");
  });

  it("resolves StylePreset list into roster entries", () => {
    const presets = [
      { id: "preset-1", name: "Sam", avatarIndex: 1 },
      { id: "preset-2", name: null },
    ] as unknown as StylePreset[];

    const entries = resolveRosterEntries(presets);
    expect(entries.length).toBe(2);
    expect(entries[0].name).toBe("Sam");
    expect(entries[0].avatarIndex).toBe(1);
    expect(entries[1].name).toBe("Character 2");
  });

  it("creates custom pack roster entry", () => {
    const custom = createCustomPackRosterEntry({
      id: "pack-custom",
      name: "My Custom Agent",
    });
    expect(custom.id).toBe("pack-custom");
    expect(custom.name).toBe("My Custom Agent");
    expect(custom.avatarIndex).toBe(0);
  });
});
