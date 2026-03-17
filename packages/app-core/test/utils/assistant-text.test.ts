import { describe, expect, it } from "vitest";
import { stripAssistantStageDirections } from "../../src/utils/assistant-text";

describe("stripAssistantStageDirections", () => {
  it("strips asterisk-wrapped stage directions", () => {
    const result = stripAssistantStageDirections("Hello *smiles warmly* there");
    expect(result).not.toContain("smiles warmly");
    expect(result).toContain("Hello");
    expect(result).toContain("there");
  });

  it("strips underscore-wrapped stage directions", () => {
    const result = stripAssistantStageDirections("Hello _waves happily_ there");
    expect(result).not.toContain("waves happily");
  });

  it("preserves asterisk content that is NOT a stage direction", () => {
    const result = stripAssistantStageDirections(
      "Use *bold text* for emphasis",
    );
    expect(result).toContain("bold text");
  });

  it("preserves underscore content that is NOT a stage direction", () => {
    const result = stripAssistantStageDirections(
      "Use _italic text_ for emphasis",
    );
    expect(result).toContain("italic text");
  });

  it("handles empty input", () => {
    expect(stripAssistantStageDirections("")).toBe("");
  });

  it("handles text with no stage directions", () => {
    expect(stripAssistantStageDirections("Just plain text")).toBe(
      "Just plain text",
    );
  });

  it("handles multiple stage directions in one message", () => {
    const result = stripAssistantStageDirections(
      "*nods* I agree. *smiles* That sounds right.",
    );
    expect(result).not.toContain("nods");
    expect(result).not.toContain("smiles");
    expect(result).toContain("I agree.");
    expect(result).toContain("That sounds right.");
  });

  it("handles stage direction at start of text", () => {
    const result = stripAssistantStageDirections("*laughs* That's funny!");
    expect(result).not.toContain("laughs");
    expect(result).toContain("That's funny!");
  });

  it("handles stage direction at end of text", () => {
    const result = stripAssistantStageDirections("Goodbye! *waves*");
    expect(result).not.toContain("waves");
    expect(result).toContain("Goodbye!");
  });

  it("does not strip across newlines (asterisk pattern is non-greedy single line)", () => {
    const input = "*smiles\nacross lines*";
    const result = stripAssistantStageDirections(input);
    expect(result).toContain("smiles");
  });
});
