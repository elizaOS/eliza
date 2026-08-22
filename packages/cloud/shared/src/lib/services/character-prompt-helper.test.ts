/**
 * Character prompt composition retains every configured trait and example.
 * The test is deterministic and does not touch the character datastore.
 */
import { describe, expect, test } from "bun:test";
import { buildCharacterSystemPrompt } from "./character-prompt-helper";

describe("buildCharacterSystemPrompt", () => {
  test("retains all configured lists and long sentinel content", () => {
    const longExample = `${"x".repeat(1_100_000)}END_OF_CHARACTER_EXAMPLE`;
    const prompt = buildCharacterSystemPrompt({
      name: "Complete Character",
      bio: "Complete biography",
      adjectives: Array.from({ length: 12 }, (_, index) => `adjective-${index}`),
      topics: Array.from({ length: 12 }, (_, index) => `topic-${index}`),
      postExamples: ["example-0", "example-1", "example-2", longExample],
      postStyle: Array.from({ length: 8 }, (_, index) => `post-style-${index}`),
      allStyle: Array.from({ length: 8 }, (_, index) => `all-style-${index}`),
    });

    for (let index = 0; index < 12; index += 1) {
      expect(prompt).toContain(`adjective-${index}`);
      expect(prompt).toContain(`topic-${index}`);
    }
    for (let index = 0; index < 8; index += 1) {
      expect(prompt).toContain(`post-style-${index}`);
      expect(prompt).toContain(`all-style-${index}`);
    }
    expect(prompt).toContain("END_OF_CHARACTER_EXAMPLE");
    expect(prompt).toContain(longExample);
  });
});
