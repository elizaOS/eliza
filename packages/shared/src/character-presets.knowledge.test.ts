/**
 * Pins the baked-in knowledge contract for bundled character presets against
 * the real CHARACTER_DEFINITIONS — no mocks. Preset knowledge is ingested by
 * `DocumentService.processCharacterDocuments`, which treats an entry as a file
 * only when `existsSync` resolves it and otherwise stores the entry verbatim as
 * a document. These tests hold the two properties that makes safe: entries are
 * inline text that can never be mistaken for a path, and each stays inside the
 * 2000-character window that `generateContentBasedId` hashes for identity.
 */
import { describe, expect, it } from "vitest";

import { CHARACTER_DEFINITIONS } from "./character-presets.characters.js";
import {
  getDefaultStylePreset,
  getStylePresets,
  resolveStylePresetById,
} from "./character-presets.js";
import { CHARACTER_LANGUAGES } from "./contracts/first-run-options.js";

// The id window in generateContentBasedId (packages/core/src/features/
// documents/utils.ts). An entry longer than this hashes to the same id as its
// own first 2000 chars, so a later edit past the window is silently skipped on
// re-ingest instead of replacing the stored document.
const DOCUMENT_ID_HASH_WINDOW = 2000;

describe("bundled preset knowledge", () => {
  const presetsWithKnowledge = CHARACTER_DEFINITIONS.filter(
    (definition) => (definition.knowledge?.length ?? 0) > 0,
  );

  it("ships knowledge on the default eliza preset (data premise)", () => {
    expect(presetsWithKnowledge.map((definition) => definition.id)).toContain(
      "eliza",
    );
    expect(getDefaultStylePreset().knowledge?.length ?? 0).toBeGreaterThan(0);
  });

  it("carries definition knowledge onto the resolved preset", () => {
    for (const definition of presetsWithKnowledge) {
      expect(resolveStylePresetById(definition.id)?.knowledge).toEqual(
        definition.knowledge,
      );
    }
  });

  it("leaves knowledge undefined for presets that declare none", () => {
    for (const definition of CHARACTER_DEFINITIONS) {
      if (definition.knowledge) continue;
      expect(resolveStylePresetById(definition.id)).toBeDefined();
      expect(resolveStylePresetById(definition.id)?.knowledge).toBeUndefined();
    }
  });

  it("copies knowledge instead of sharing the definition's array", () => {
    const definition = presetsWithKnowledge[0];
    expect(definition).toBeDefined();
    const preset = resolveStylePresetById(definition.id);
    expect(preset?.knowledge).not.toBe(definition.knowledge);

    preset?.knowledge?.push("mutation must not reach the bundled definition");
    expect(resolveStylePresetById(definition.id)?.knowledge).toEqual(
      definition.knowledge,
    );
  });

  it("resolves the same knowledge for every supported language", () => {
    for (const language of CHARACTER_LANGUAGES) {
      const preset = getStylePresets(language).find(
        (candidate) => candidate.id === "eliza",
      );
      expect(preset?.knowledge).toEqual(
        CHARACTER_DEFINITIONS.find((definition) => definition.id === "eliza")
          ?.knowledge,
      );
    }
  });

  it("keeps every entry inline text, never a path that cannot resolve on a user's machine", () => {
    for (const definition of presetsWithKnowledge) {
      for (const entry of definition.knowledge ?? []) {
        expect(entry.trim()).toBe(entry);
        expect(entry.length).toBeGreaterThan(0);
        // A path-shaped entry is the failure mode this contract exists to
        // prevent: it would not resolve on an end user's machine and would be
        // ingested as a document whose entire body is the path string.
        expect(entry).not.toMatch(/^[./~]|^[A-Za-z]:[\\/]/);
        expect(entry).not.toMatch(/\.(md|txt|pdf|json|ya?ml|html?|csv)$/i);
        // Prose, not a bare filename: the ingested body is what gets embedded.
        expect(entry).toMatch(/\s/);
      }
    }
  });

  it("keeps every entry inside the document-id hash window", () => {
    for (const definition of presetsWithKnowledge) {
      for (const entry of definition.knowledge ?? []) {
        expect(entry.length).toBeLessThan(DOCUMENT_ID_HASH_WINDOW);
      }
    }
  });

  it("keeps entries distinct so retrieval cannot surface duplicate documents", () => {
    for (const definition of presetsWithKnowledge) {
      const entries = definition.knowledge ?? [];
      expect(new Set(entries).size).toBe(entries.length);
    }
  });
});
