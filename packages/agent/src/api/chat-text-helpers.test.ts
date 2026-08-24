/**
 * Exercises the agent HTTP boundary's assistant-text cleanup without replacing
 * or clipping complete long responses. Covers stage direction stripping,
 * spacing tidying, and no-response placeholder detection.
 */
import { describe, expect, it } from "vitest";
import {
  isClientVisibleNoResponse,
  isNoResponsePlaceholder,
  stripAssistantStageDirections,
} from "./chat-text-helpers.ts";

describe("isNoResponsePlaceholder", () => {
  it("identifies empty and whitespace-only text as placeholder", () => {
    expect(isNoResponsePlaceholder("")).toBe(true);
    expect(isNoResponsePlaceholder("   ")).toBe(true);
    expect(isNoResponsePlaceholder("\n\t  \r\n")).toBe(true);
  });

  it("identifies standard and parenthesized (no response) case-insensitively", () => {
    expect(isNoResponsePlaceholder("no response")).toBe(true);
    expect(isNoResponsePlaceholder("(no response)")).toBe(true);
    expect(isNoResponsePlaceholder("NO RESPONSE")).toBe(true);
    expect(isNoResponsePlaceholder("(NO RESPONSE)")).toBe(true);
    expect(isNoResponsePlaceholder("  (No Response)  ")).toBe(true);
    expect(isNoResponsePlaceholder("No response")).toBe(true);
  });

  it("rejects real messages and non-matching prefixes/suffixes", () => {
    expect(isNoResponsePlaceholder("Hello world")).toBe(false);
    expect(isNoResponsePlaceholder("no response received from server")).toBe(
      false,
    );
    expect(isNoResponsePlaceholder("(no response needed)")).toBe(false);
    expect(isNoResponsePlaceholder("there is no response")).toBe(false);
  });
});

describe("stripAssistantStageDirections", () => {
  it("preserves complete text beyond the former 100k boundary", () => {
    const text = `${"complete line\n".repeat(9_000)}final line`;
    expect(text.length).toBeGreaterThan(100_000);
    expect(stripAssistantStageDirections(text)).toBe(text);
  });

  it("strips asterisk-wrapped stage directions", () => {
    expect(stripAssistantStageDirections("*smiles* Hello there!")).toBe(
      " Hello there!",
    );
    expect(
      stripAssistantStageDirections("I can help you with that *beams warmly*."),
    ).toBe("I can help you with that.");
    expect(
      stripAssistantStageDirections("Hello *chuckles softly* there."),
    ).toBe("Hello there.");
    expect(
      stripAssistantStageDirections("Let me think... *pauses thoughtfully*"),
    ).toBe("Let me think... ");
  });

  it("strips underscore-wrapped stage directions", () => {
    expect(stripAssistantStageDirections("_nods_ Indeed.")).toBe(" Indeed.");
    expect(stripAssistantStageDirections("I agree _glances at screen_.")).toBe(
      "I agree.",
    );
    expect(stripAssistantStageDirections("Hello _yawns_ friend.")).toBe(
      "Hello friend.",
    );
  });

  it("preserves emphasis and words not in stage direction vocabulary", () => {
    expect(
      stripAssistantStageDirections("This is *important* information."),
    ).toBe("This is *important* information.");
    expect(
      stripAssistantStageDirections("Please note the _critical_ detail."),
    ).toBe("Please note the _critical_ detail.");
    expect(stripAssistantStageDirections("See *custom note* here.")).toBe(
      "See *custom note* here.",
    );
  });

  it("preserves mid-word and non-boundary asterisks/underscores", () => {
    expect(stripAssistantStageDirections("foo*smiles*bar")).toBe(
      "foo*smiles*bar",
    );
    expect(stripAssistantStageDirections("snake_case_variable")).toBe(
      "snake_case_variable",
    );
  });

  it("tidies punctuation spacing after removing stage directions", () => {
    expect(stripAssistantStageDirections("Hello *smiles* , world!")).toBe(
      "Hello, world!",
    );
    expect(stripAssistantStageDirections("Is that true *winks* ?")).toBe(
      "Is that true?",
    );
    expect(stripAssistantStageDirections("Great *cheers* !")).toBe("Great!");
    expect(stripAssistantStageDirections("Status ( *nods* ) updated")).toBe(
      "Status () updated",
    );
  });

  it("collapses multiple spaces and tab runs around newlines", () => {
    expect(stripAssistantStageDirections("Line 1   \n   Line 2")).toBe(
      "Line 1\nLine 2",
    );
    expect(stripAssistantStageDirections("Word 1    Word 2")).toBe(
      "Word 1 Word 2",
    );
  });
});

describe("isClientVisibleNoResponse", () => {
  it("returns true for empty or raw placeholder text", () => {
    expect(isClientVisibleNoResponse("")).toBe(true);
    expect(isClientVisibleNoResponse("   ")).toBe(true);
    expect(isClientVisibleNoResponse("(no response)")).toBe(true);
  });

  it("returns true when text contains only stage directions and placeholders", () => {
    expect(isClientVisibleNoResponse("*smiles*")).toBe(true);
    expect(isClientVisibleNoResponse("_sighs_ (no response)")).toBe(true);
    expect(
      isClientVisibleNoResponse("*waving* \n\n (NO RESPONSE) \n *nods*"),
    ).toBe(true);
    expect(isClientVisibleNoResponse("*beams* _chuckles_")).toBe(true);
  });

  it("returns false when meaningful text remains after stripping stage directions", () => {
    expect(isClientVisibleNoResponse("*smiles* Hello world!")).toBe(false);
    expect(isClientVisibleNoResponse("Sure, I can help *nods*")).toBe(false);
    expect(
      isClientVisibleNoResponse("*chuckles* That is a great question."),
    ).toBe(false);
  });
});
