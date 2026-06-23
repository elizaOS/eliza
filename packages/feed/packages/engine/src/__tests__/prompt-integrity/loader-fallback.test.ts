import { describe, expect, it } from "vitest";
import { definePrompt } from "../../prompts/define-prompt";
import { renderPrompt } from "../../prompts/loader";

const tmpl = (template: string) =>
  definePrompt({
    id: "test-prompt",
    version: "1.0.0",
    category: "test",
    description: "prompt-integrity loader test",
    template,
  });

/**
 * Pins renderPrompt's validation + the silent-fallback surface so a missing
 * grounding value fails loudly where it should, and the set of vars that are
 * intentionally allowed to blank is explicit (a future promotion of a grounding
 * var to "required" is a deliberate change, caught by these tests).
 */
describe("renderPrompt validation", () => {
  it("throws when a provided required var is an empty string", () => {
    expect(() =>
      renderPrompt(tmpl("hello {{name}}"), { name: "" }),
    ).toThrow(/Required variable "name" is empty/);
  });

  it("throws when a provided required var is null/undefined", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: testing the null guard
      renderPrompt(tmpl("hello {{name}}"), { name: null as any }),
    ).toThrow(/Required variable "name" is undefined\/null/);
  });

  it("allowEmpty suppresses the required-var validation", () => {
    expect(renderPrompt(tmpl("hello {{name}}"), { name: "" }, { allowEmpty: true })).toBe(
      "hello ",
    );
  });

  it("fills a provided required var", () => {
    expect(renderPrompt(tmpl("hello {{name}}"), { name: "Feed" })).toBe(
      "hello Feed",
    );
  });
});

describe("silent-fallback surface (grounding vars are optional → blanked)", () => {
  // The grounding vars below are on renderPrompt's optionalVars allowlist, so an
  // OMITTED grounding value is silently replaced with "" instead of throwing.
  // This documents the known degradation surface; the prompt-data-integrity
  // suite separately proves the real pipeline DOES supply these.
  const GROUNDING_VARS = [
    "realityGrounding",
    "worldActors",
    "worldFacts",
    "worldEventExamples",
    "worldFactsContext",
    "characterRoster",
    "organizationRoster",
    "examples",
    "marketTable",
    "npcsList",
  ];

  for (const v of GROUNDING_VARS) {
    it(`blanks omitted "${v}" without throwing`, () => {
      const out = renderPrompt(tmpl(`A {{${v}}} B`), {});
      expect(out).toBe("A  B");
      // The placeholder is gone (blanked), not left literal.
      expect(out).not.toContain(`{{${v}}}`);
    });
  }
});
