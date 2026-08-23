/**
 * Covers the pure helpers behind the character editor.
 *
 * `buildCharacterDraftFromPreset` seeds an editable draft from a shared roster
 * preset, so it must deep-copy every list it carries over: a draft that shared
 * arrays with the preset would let one user's edits rewrite the preset for
 * every later character built from it. Token substitution has to reach every
 * field the preset can carry, not just the obvious ones.
 *
 * `shouldApplyPresetDefaults` decides whether preset defaults overwrite user
 * edits, so it must stay false for the one case that would destroy work — a
 * saved character with real content whose name still matches the roster entry.
 *
 * Pure functions — no React.
 */
import { describe, expect, it } from "vitest";

import type { CharacterRosterEntry } from "./CharacterRoster";
import {
  buildCharacterDraftFromPreset,
  getFirstRunPresetStyles,
  replaceCharacterToken,
  shouldApplyPresetDefaults,
} from "./character-editor-helpers.ts";

function preset(overrides: Record<string, unknown> = {}) {
  return {
    bio: ["I am {{name}}."],
    system: "You are {{agentName}}.",
    adjectives: ["curious"],
    style: { all: ["all-1"], chat: ["chat-1"], post: ["post-1"] },
    messageExamples: [
      [
        { user: "{{user1}}", content: { text: "hi {{name}}" } },
        {
          user: "{{agentName}}",
          content: { text: "hello from {{agentName}}" },
        },
      ],
    ],
    postExamples: ["a post by {{name}}"],
    ...overrides,
  };
}

const entry = (name: string, overrides: Record<string, unknown> = {}) =>
  ({ name, preset: preset(overrides) }) as unknown as CharacterRosterEntry;

describe("getFirstRunPresetStyles", () => {
  it("returns an empty list for anything that is not an options object", () => {
    for (const value of [null, undefined, "x", 42, []]) {
      expect(getFirstRunPresetStyles(value)).toEqual([]);
    }
  });

  it("returns an empty list when styles is absent or not an array", () => {
    expect(getFirstRunPresetStyles({})).toEqual([]);
    expect(getFirstRunPresetStyles({ styles: "nope" })).toEqual([]);
    expect(getFirstRunPresetStyles({ styles: null })).toEqual([]);
  });

  it("returns the styles array when present", () => {
    const styles = [{ id: "a" }];
    expect(getFirstRunPresetStyles({ styles })).toBe(styles);
  });
});

describe("replaceCharacterToken", () => {
  it("replaces both token spellings", () => {
    expect(replaceCharacterToken("{{name}} and {{agentName}}", "Momo")).toBe(
      "Momo and Momo",
    );
  });

  it("replaces every occurrence, not just the first", () => {
    expect(replaceCharacterToken("{{name}} {{name}} {{name}}", "Momo")).toBe(
      "Momo Momo Momo",
    );
  });

  it("leaves text without tokens untouched", () => {
    expect(replaceCharacterToken("plain text", "Momo")).toBe("plain text");
    expect(replaceCharacterToken("", "Momo")).toBe("");
  });

  it("leaves unrelated tokens alone", () => {
    expect(replaceCharacterToken("{{user1}}", "Momo")).toBe("{{user1}}");
  });
});

describe("buildCharacterDraftFromPreset", () => {
  it("uses the roster name for both name and username", () => {
    const draft = buildCharacterDraftFromPreset(entry("Momo"));
    expect(draft.name).toBe("Momo");
    expect(draft.username).toBe("Momo");
  });

  it("substitutes tokens in bio, system, and post examples", () => {
    const draft = buildCharacterDraftFromPreset(entry("Momo"));
    expect(draft.bio).toBe("I am Momo.");
    expect(draft.system).toBe("You are Momo.");
    expect(draft.postExamples).toEqual(["a post by Momo"]);
  });

  it("joins multi-line bios with newlines", () => {
    const draft = buildCharacterDraftFromPreset(
      entry("Momo", { bio: ["line one", "line two"] }),
    );
    expect(draft.bio).toBe("line one\nline two");
  });

  it("maps the agent speaker to the character name and substitutes example text", () => {
    const [conversation] = buildCharacterDraftFromPreset(
      entry("Momo"),
    ).messageExamples;
    expect(conversation?.examples[1]?.name).toBe("Momo");
    expect(conversation?.examples[1]?.content.text).toBe("hello from Momo");
    expect(conversation?.examples[0]?.content.text).toBe("hi Momo");
  });

  it("leaves a non-agent speaker token as the substituted user token", () => {
    const [conversation] = buildCharacterDraftFromPreset(
      entry("Momo"),
    ).messageExamples;
    expect(conversation?.examples[0]?.name).toBe("{{user1}}");
  });

  it("does not share its arrays with the preset", () => {
    // A shared array would let one character's edits rewrite the preset for
    // every later character built from it.
    const rosterEntry = entry("Momo");
    const source = rosterEntry.preset as unknown as ReturnType<typeof preset>;
    const draft = buildCharacterDraftFromPreset(rosterEntry);

    draft.adjectives.push("injected");
    draft.style.all.push("injected");
    draft.style.chat.push("injected");
    draft.style.post.push("injected");

    expect(source.adjectives).not.toContain("injected");
    expect(source.style.all).not.toContain("injected");
    expect(source.style.chat).not.toContain("injected");
    expect(source.style.post).not.toContain("injected");
  });

  it("carries an empty preset through without throwing", () => {
    const draft = buildCharacterDraftFromPreset(
      entry("Momo", {
        bio: [],
        adjectives: [],
        style: { all: [], chat: [], post: [] },
        messageExamples: [],
        postExamples: [],
      }),
    );
    expect(draft.bio).toBe("");
    expect(draft.messageExamples).toEqual([]);
  });
});

describe("shouldApplyPresetDefaults", () => {
  it("applies defaults when there is no meaningful content", () => {
    expect(shouldApplyPresetDefaults(false, "Chen", "Momo")).toBe(true);
    expect(shouldApplyPresetDefaults(false, "Momo", "Momo")).toBe(true);
    expect(shouldApplyPresetDefaults(false, null, "Momo")).toBe(true);
  });

  it("does NOT overwrite real content when the name still matches", () => {
    // The one case that would destroy the user's work.
    expect(shouldApplyPresetDefaults(true, "Momo", "Momo")).toBe(false);
  });

  it("matches the name case- and whitespace-insensitively", () => {
    expect(shouldApplyPresetDefaults(true, "  momo  ", "Momo")).toBe(false);
    expect(shouldApplyPresetDefaults(true, "MOMO", "momo")).toBe(false);
  });

  it("applies defaults when the user switched to a different preset", () => {
    expect(shouldApplyPresetDefaults(true, "Chen", "Momo")).toBe(true);
  });

  it("applies defaults when the saved name is missing or unusable", () => {
    expect(shouldApplyPresetDefaults(true, null, "Momo")).toBe(true);
    expect(shouldApplyPresetDefaults(true, undefined, "Momo")).toBe(true);
    expect(shouldApplyPresetDefaults(true, "   ", "Momo")).toBe(true);
  });
});
