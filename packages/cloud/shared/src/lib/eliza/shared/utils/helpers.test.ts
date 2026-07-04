// Exercises helpers behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import {
  cleanPrompt,
  containsAISpeak,
  extractAttachments,
  isRepeatedOpening,
  isRepetitiveGreeting,
  removeAISpeak,
  trackOpening,
} from "./helpers";

/**
 * Response post-processing keeps the agent in-character and de-duplicates
 * openings. These are pure string transforms plus a per-room LRU of recent
 * openings; the attachment extractor is also a safety filter (drops base64
 * data: URLs and non-http placeholders before they reach the client).
 */

describe("AI-speak detection + removal", () => {
  test("flags persona-breaking phrases", () => {
    expect(containsAISpeak("As an AI, I cannot do that")).toBe(true);
    expect(containsAISpeak("As a language model I lack feelings")).toBe(true);
    expect(containsAISpeak("Sure, happy to help!")).toBe(false);
  });

  test("removeAISpeak strips the offending sentence, keeps the rest", () => {
    const out = removeAISpeak("As an AI, I can't feel. But the weather is sunny.");
    expect(out).not.toMatch(/As an AI/i);
    expect(out).toContain("weather is sunny");
  });
});

describe("isRepetitiveGreeting", () => {
  test("matches bare greetings, ignores substantive openers", () => {
    expect(isRepetitiveGreeting("Hey!")).toBe(true);
    expect(isRepetitiveGreeting("Hello there")).toBe(true);
    expect(isRepetitiveGreeting("Hey, did the deploy finish?")).toBe(false);
  });
});

describe("cleanPrompt", () => {
  test("collapses blank runs, trims leading newlines + trailing whitespace", () => {
    expect(cleanPrompt("\n\nhello   \n\n\n\nworld\n\n")).toBe("hello\n\nworld\n");
  });
});

describe("isRepeatedOpening / trackOpening", () => {
  test("a tracked opening is detected as repeated, per-room", () => {
    const room = "room-helpers-test-1";
    const text = "Good morning team, here is the plan.";
    expect(isRepeatedOpening(room, text)).toBe(false);
    trackOpening(room, text);
    expect(isRepeatedOpening(room, text)).toBe(true);
    // a different room is unaffected.
    expect(isRepeatedOpening("room-helpers-test-2", text)).toBe(false);
  });
});

describe("extractAttachments", () => {
  test("keeps http attachments, drops data: URLs / placeholders / empties", () => {
    const results = [
      { data: { attachments: [{ url: "https://cdn.example.com/a.png" }] } },
      { data: { attachments: [{ url: "data:image/png;base64,AAAA" }] } },
      { data: { attachments: [{ url: "[pending]" }, { url: "" }] } },
      { data: { attachments: [{ url: "ftp://nope" }] } },
      {},
    ];
    const out = extractAttachments(results);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://cdn.example.com/a.png");
  });
});
