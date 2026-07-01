import { describe, expect, test } from "bun:test";
import { character } from "./character";

// Real coverage for the Discord example's character config (#10718). The package
// `test` script was `vitest run --passWithNoTests` with zero test files, so it
// was always green while verifying nothing — and VALIDATION.md listed it as
// `test`-verified. This asserts the character contract createCharacter must
// preserve, so a regression (a dropped Discord setting, an emptied prompt, a
// renamed bot) fails instead of passing silently.
describe("Discord example character", () => {
  test("has the expected identity and non-empty prompts", () => {
    expect(character.name).toBe("DiscordEliza");

    // bio may be normalized to a string or string[]; either way it must carry text.
    const bioText = Array.isArray(character.bio)
      ? character.bio.join(" ")
      : String(character.bio ?? "");
    expect(bioText.trim().length).toBeGreaterThan(0);

    expect(typeof character.system).toBe("string");
    expect(character.system).toContain("DiscordEliza");
    // The system prompt is Discord-specific, not a generic stub.
    expect(character.system?.toLowerCase()).toContain("discord");
  });

  test("preserves the Discord behavior settings through createCharacter", () => {
    const discord = (
      character.settings as { discord?: Record<string, unknown> } | undefined
    )?.discord;
    expect(discord).toBeDefined();
    // These two flags are the example's whole point — a bot that ignores other
    // bots and only replies to mentions. A dropped/renamed key must fail here.
    expect(discord?.shouldIgnoreBotMessages).toBe(true);
    expect(discord?.shouldRespondOnlyToMentions).toBe(true);
  });
});
