import { describe, expect, it } from "vitest";
import { prepareDraftForSave } from "../character/character-draft-helpers";
import { replaceNameTokens, tokenizeNameOccurrences } from "./name-tokens";

describe("tokenizeNameOccurrences", () => {
  it("replaces whole-word occurrences with {{name}}", () => {
    expect(tokenizeNameOccurrences("Momo is composed.", "Momo")).toBe(
      "{{name}} is composed.",
    );
  });

  it("handles multiple occurrences across one string", () => {
    expect(
      tokenizeNameOccurrences("Momo likes Momo-sized tasks. Momo!", "Momo"),
    ).toBe("{{name}} likes {{name}}-sized tasks. {{name}}!");
  });

  it("respects word boundaries — does not replace inside other words", () => {
    // "Kai" must not match inside "Kaizen" or "Mikaila".
    expect(
      tokenizeNameOccurrences("Kaizen is not Mikaila and Kai is Kai.", "Kai"),
    ).toBe("Kaizen is not Mikaila and {{name}} is {{name}}.");
  });

  it("is case-sensitive", () => {
    // "momo" (lowercase) mid-sentence should not tokenize when the
    // stored name is "Momo" — the user's intent is ambiguous and we'd
    // rather under-tokenize than destroy prose.
    expect(tokenizeNameOccurrences("momo is not Momo.", "Momo")).toBe(
      "momo is not {{name}}.",
    );
  });

  it("is idempotent — running twice yields the same result", () => {
    const once = tokenizeNameOccurrences("Momo is composed.", "Momo");
    const twice = tokenizeNameOccurrences(once, "Momo");
    expect(twice).toBe(once);
  });

  it("no-ops on empty text or empty name", () => {
    expect(tokenizeNameOccurrences("", "Momo")).toBe("");
    expect(tokenizeNameOccurrences("some text", "")).toBe("some text");
    expect(tokenizeNameOccurrences("some text", "   ")).toBe("some text");
  });

  it("refuses to tokenize single-character names (guardrail)", () => {
    // A one-letter name like "A" would eat every standalone "A" in prose.
    expect(tokenizeNameOccurrences("A is a character named A.", "A")).toBe(
      "A is a character named A.",
    );
  });

  it("does not crash on regex special characters in the name", () => {
    // Names with punctuation don't reliably match word boundaries, so
    // the tokenizer is allowed to leave such text untouched — the
    // important invariant is that the regex stays valid.
    expect(() =>
      tokenizeNameOccurrences("Some text here.", "Dr. X."),
    ).not.toThrow();
    expect(() =>
      tokenizeNameOccurrences("Text with (parens).", "(name)"),
    ).not.toThrow();
  });

  it("round-trips cleanly with replaceNameTokens", () => {
    const original = "Momo is composed. Momo likes clarity.";
    const tokenized = tokenizeNameOccurrences(original, "Momo");
    expect(replaceNameTokens(tokenized, "Momo")).toBe(original);
    // And the whole point of tokenization — renaming propagates:
    expect(replaceNameTokens(tokenized, "Nyx")).toBe(
      "Nyx is composed. Nyx likes clarity.",
    );
  });
});

describe("prepareDraftForSave — name tokenization", () => {
  it("tokenizes bio, system, topics, postExamples, and style on save", () => {
    const result = prepareDraftForSave({
      name: "Momo",
      bio: "Momo is composed.\nMomo is tidy.",
      system: "You are Momo, a careful assistant.",
      topics: ["how Momo thinks", "unrelated topic"],
      postExamples: ["Momo just shipped."],
      style: {
        all: ["Momo speaks softly"],
        chat: [],
        post: ["Momo posts seldom"],
      },
    });

    expect(result.bio).toEqual(["{{name}} is composed.", "{{name}} is tidy."]);
    expect(result.system).toBe("You are {{name}}, a careful assistant.");
    expect(result.topics).toEqual(["how {{name}} thinks", "unrelated topic"]);
    expect(result.postExamples).toEqual(["{{name}} just shipped."]);
    expect(result.style).toEqual({
      all: ["{{name}} speaks softly"],
      post: ["{{name}} posts seldom"],
    });
  });

  it("tokenizes messageExamples body text while preserving existing speaker tokenization", () => {
    const result = prepareDraftForSave({
      name: "Momo",
      messageExamples: [
        {
          examples: [
            { name: "User", content: { text: "hey Momo" } },
            { name: "Momo", content: { text: "Momo here — how can I help?" } },
          ],
        },
      ],
    });

    const messageExamples = result.messageExamples as Array<{
      examples: Array<{ name: string; content: { text: string } }>;
    }>;
    expect(messageExamples[0].examples[0].content.text).toBe("hey {{name}}");
    expect(messageExamples[0].examples[1].content.text).toBe(
      "{{name}} here — how can I help?",
    );
  });

  it("tokenizes the previous name too when the user renames in the same save", () => {
    // User loaded a character named "Momo", renamed to "Nyx", and
    // edited the bio to add a new line referencing the new name. The
    // stored bio still contains old "Momo" literals from onboarding.
    const result = prepareDraftForSave(
      {
        name: "Nyx",
        bio: "Momo is composed.\nNyx prefers clarity.",
        system: "You are Nyx. Momo was my old name.",
      },
      "Momo",
    );

    expect(result.bio).toEqual([
      "{{name}} is composed.",
      "{{name}} prefers clarity.",
    ]);
    expect(result.system).toBe("You are {{name}}. {{name}} was my old name.");
  });

  it("leaves the name field itself as a literal (source of truth)", () => {
    const result = prepareDraftForSave({
      name: "Momo",
      bio: "Momo is composed.",
    });
    expect(result.name).toBe("Momo");
    expect(result.bio).toEqual(["{{name}} is composed."]);
  });

  it("no-ops when the draft has no name (no tokenization anchor)", () => {
    const result = prepareDraftForSave({
      bio: "Momo is composed.",
    });
    // Without a current name, the tokenizer has nothing to match against.
    // The bio persists as-is; next load will still render literal text.
    // This is acceptable because the save path refuses to persist a
    // character without a name at the callsite level anyway.
    expect(result.bio).toEqual(["Momo is composed."]);
  });

  it("round-trips through replaceNameTokens without drift", () => {
    const result = prepareDraftForSave({
      name: "Momo",
      bio: "Momo is composed. Momo values clarity.",
      system: "You are Momo.",
    });
    const bio = result.bio as string[];
    // Rendering with the same name reproduces the original.
    expect(bio.map((line) => replaceNameTokens(line, "Momo"))).toEqual([
      "Momo is composed. Momo values clarity.",
    ]);
    // Rendering after a rename propagates through every field.
    expect(bio.map((line) => replaceNameTokens(line, "Nyx"))).toEqual([
      "Nyx is composed. Nyx values clarity.",
    ]);
    expect(replaceNameTokens(result.system as string, "Nyx")).toBe(
      "You are Nyx.",
    );
  });
});
