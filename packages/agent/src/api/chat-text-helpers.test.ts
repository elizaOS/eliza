/**
 * Exercises the agent HTTP boundary's assistant-text cleanup without replacing
 * or clipping complete long responses.
 */
import { describe, expect, it } from "vitest";
import { stripAssistantStageDirections } from "./chat-text-helpers.ts";

describe("stripAssistantStageDirections", () => {
  it("preserves complete text beyond the former 100k boundary", () => {
    const text = `${"complete line\n".repeat(9_000)}final line`;
    expect(text.length).toBeGreaterThan(100_000);
    expect(stripAssistantStageDirections(text)).toBe(text);
  });

  it("strips standalone stage directions surrounded by whitespace or punctuation", () => {
    expect(stripAssistantStageDirections("Hello *smiles* world")).toBe("Hello world");
    expect(stripAssistantStageDirections("Hello _laughs_ there!")).toBe("Hello there!");
    expect(stripAssistantStageDirections("Well, *whispers* secret")).toBe("Well, secret");
  });

  it("does not strip stage directions embedded within uppercase or alphanumeric tokens", () => {
    expect(stripAssistantStageDirections("TEST*smiles*BAR")).toBe("TEST*smiles*BAR");
    expect(stripAssistantStageDirections("foo*smiles*bar")).toBe("foo*smiles*bar");
    expect(stripAssistantStageDirections("TEST_laughs_BAR")).toBe("TEST_laughs_BAR");
    expect(stripAssistantStageDirections("10*20*30")).toBe("10*20*30");
  });
});
