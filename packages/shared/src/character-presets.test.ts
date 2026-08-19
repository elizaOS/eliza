/**
 * Verifies character-preset resolution when several personas share one VRM
 * avatar art index (the default Eliza and Chen both render asset 1). Pins that
 * id lookup, avatarIndex lookup, the default-preset accessor, and the catalog
 * builder each resolve to the intended persona against the real bundled
 * CHARACTER_DEFINITIONS — no mocks.
 */
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

describe("default Eliza persona safety", () => {
  const definition = CHARACTER_DEFINITIONS.find(({ id }) => id === "eliza");

  it("keeps consequential ambiguity and side-effect claims receipt-bound", () => {
    expect(definition).toBeDefined();
    expect(definition?.system).toContain(
      "Ask one clear question before consequential actions, external writes",
    );
    expect(definition?.system).toContain(
      "unless the current turn has a matching tool receipt",
    );

    const replies = definition?.messageExamples.flatMap((conversation) =>
      conversation
        .filter(({ user }) => user === "{{agentName}}")
        .map(({ content }) => content.text),
    );
    expect(replies).toContain(
      "I'll use 9am tomorrow unless you want another time.",
    );
    expect(replies?.join("\n")).not.toMatch(
      /Done\. 9am|Give me a minute|Three more minutes|I'll ping you/u,
    );
  });

  it("does useful work before asking and anticipates without forcing a question", () => {
    expect(definition).toBeDefined();
    expect(definition?.bio).toContain(
      "Does the useful part first, then anticipates one grounded next step when it helps.",
    );
    expect(definition?.style.chat).toContain(
      "don't end every reply with a question; ask only when the answer unlocks useful work",
    );
    expect(definition?.style.chat).toContain(
      "when intent is vague, offer one grounded guess and make correction easy",
    );
    expect(definition?.variants.en.catchphrase).not.toMatch(/how can i help/i);
    expect(definition?.system).toContain(
      "On first contact, don't lead with a capability list or an open-ended",
    );

    const replies = definition?.messageExamples.flatMap((conversation) =>
      conversation
        .filter(({ user }) => user === "{{agentName}}")
        .map(({ content }) => content.text),
    );
    expect(replies).not.toContain("Sure. What is it?");
    expect(replies?.join("\n")).not.toMatch(/Warmer\? Funnier\? Shorter\?/u);
  });

  it("treats brevity as a default that explicit depth requests override", () => {
    expect(definition).toBeDefined();
    expect(definition?.system).toContain("Short is a default, not a ceiling.");
    expect(definition?.system).toContain(
      "give them the depth they asked for and keep it for the rest of the conversation",
    );
    expect(definition?.system).toContain(
      '"Tell me more" means more about what you were just talking about.',
    );
    expect(definition?.style.chat).toContain(
      "an explicit ask for length or detail beats every brevity rule, honor it for the whole conversation",
    );
    expect(definition?.style.chat).toContain(
      '"tell me more" is about the last thing discussed, answer it instead of asking which thing',
    );
  });

  it("carries the depth-override rule into every language variant's resolved system", () => {
    expect(definition).toBeDefined();
    for (const language of Object.keys(definition?.variants ?? {})) {
      const preset = resolveStylePresetById(
        "eliza",
        language as keyof NonNullable<typeof definition>["variants"],
      );
      expect(preset?.system).toContain("Short is a default, not a ceiling.");
    }
  });

  it("carries epistemic honesty into every resolved prompt instruction set", () => {
    expect(definition).toBeDefined();
    for (const language of Object.keys(definition?.variants ?? {})) {
      const preset = resolveStylePresetById(
        "eliza",
        language as keyof NonNullable<typeof definition>["variants"],
      );
      const renderedInstructions = [
        preset?.system,
        ...(preset?.style.all ?? []),
        ...(preset?.style.chat ?? []),
      ].join("\n");

      expect(renderedInstructions).toContain(
        "separate what you know, what you checked, and what you inferred",
      );
      expect(renderedInstructions).toContain(
        "never invent memory, use remembered details only when they are actually present",
      );
    }
  });
});
