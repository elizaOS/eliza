/**
 * Exercises failure-template propagation through localized preset resolution
 * and verifies callers receive an independently mutable template object.
 */
import { describe, expect, it } from "vitest";

import { CHARACTER_DEFINITIONS } from "./character-presets.characters.js";
import {
  getStylePresets,
  resolveStylePresetById,
} from "./character-presets.js";
import { CHARACTER_LANGUAGES } from "./contracts/first-run-options.js";

const elizaDefinition = CHARACTER_DEFINITIONS.find(
  (definition) => definition.id === "eliza",
);

describe("eliza preset failure templates", () => {
  it("survives preset resolution in every supported language", () => {
    // Failure replies are language-independent by construction (the runtime
    // emits them verbatim, exactly like the English framework strings they
    // replace), so resolving a non-English variant must not drop them.
    for (const language of CHARACTER_LANGUAGES) {
      const preset = resolveStylePresetById("eliza", language);
      expect(preset?.templates).toEqual(elizaDefinition?.templates);
    }
  });

  it("exposes the templates through the catalog builder too", () => {
    const preset = getStylePresets("en").find((entry) => entry.id === "eliza");
    expect(preset?.templates).toEqual(elizaDefinition?.templates);
  });

  it("does not share a mutable object with the definition", () => {
    // resolveCharacterVariant copies every other field; a shared reference here
    // would let one consumer's edit rewrite the bundled persona process-wide.
    const preset = resolveStylePresetById("eliza");
    expect(preset?.templates).not.toBe(elizaDefinition?.templates);
  });
});
