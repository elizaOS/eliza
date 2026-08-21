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

  it("keeps conversational identity to the agent's name", () => {
    expect(definition).toBeDefined();
    const identity = [
      definition?.system,
      ...(definition?.bio ?? []),
      ...(definition?.messageExamples ?? []).flatMap((conversation) =>
        conversation.map(({ content }) => content.text),
      ),
    ].join("\n");
    expect(definition?.system).toContain('say "I\'m {{name}}."');
    expect(definition?.messageExamples[0]?.[1]?.content.text).toBe(
      "I'm {{agentName}}.",
    );
    expect(identity).not.toMatch(
      /eliza research|san francisco|elizaos|open source|self-host|github\.com|\b(?:shaw|nubs|shad0w)\b/i,
    );
  });

  it("keeps consequential ambiguity and side-effect claims receipt-bound", () => {
    expect(definition).toBeDefined();
    expect(definition?.system).toContain(
      "Before consequential actions, confirm the exact target.",
    );
    expect(definition?.system).toContain("without a matching result.");

    const replies = definition?.messageExamples.flatMap((conversation) =>
      conversation
        .filter(({ user }) => user === "{{agentName}}")
        .map(({ content }) => content.text),
    );
    expect(replies).toContain("What time tomorrow?");
    expect(replies?.join("\n")).not.toMatch(
      /Done\. 9am|Give me a minute|Three more minutes|I'll ping you/u,
    );
  });

  it("keeps brevity flexible and warmth grounded in attention", () => {
    expect(definition).toBeDefined();
    expect(definition?.system).toContain(
      "Let warmth come from attention, specificity, and remembering the thread",
    );
    expect(definition?.system).toContain(
      "Not every message is a task to optimize.",
    );
    expect(definition?.style.chat).toContain(
      "short answers are welcome, but clarity beats an arbitrary word limit",
    );
    expect(definition?.style.chat).toContain(
      "an explicit ask for length or detail beats the brevity default",
    );
    expect(definition?.style.chat).toContain(
      '"tell me more" is about the last thing discussed, answer it instead of asking which thing',
    );
  });

  it("carries the warm identity into every language variant's resolved system", () => {
    expect(definition).toBeDefined();
    for (const language of Object.keys(definition?.variants ?? {})) {
      const preset = resolveStylePresetById(
        "eliza",
        language as keyof NonNullable<typeof definition>["variants"],
      );
      expect(preset?.system).toContain(
        "Make the user's next five minutes easier.",
      );
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
