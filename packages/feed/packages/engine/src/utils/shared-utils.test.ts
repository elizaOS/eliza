/**
 * Tests for shared utility functions
 */
import { describe, expect, it } from "bun:test";
import {
  formatActorVoiceContext,
  stripHashtagsAndEmojis,
} from "./shared-utils";

describe("stripHashtagsAndEmojis", () => {
  it("should strip single hashtag", () => {
    const input = "This is a post #crypto about something";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe("This is a post about something");
  });

  it("should strip multiple hashtags", () => {
    const input = "Breaking news #AI #crypto #tech is happening";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe("Breaking news is happening");
  });

  it("should strip hashtags at end of content", () => {
    const input = "Great announcement today #news #breaking";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe("Great announcement today");
  });

  it("should strip emojis", () => {
    const input = "This is amazing 🚀 news 🔥";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe("This is amazing news");
  });

  it("should strip both hashtags and emojis", () => {
    const input = "Big news 🎉 #crypto is coming #AI 🚀";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe("Big news is coming");
  });

  it("should normalize multiple spaces", () => {
    const input = "This has   multiple    spaces";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe("This has multiple spaces");
  });

  it("should trim whitespace", () => {
    const input = "   content with spaces   ";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe("content with spaces");
  });

  it("should handle empty string", () => {
    const result = stripHashtagsAndEmojis("");
    expect(result).toBe("");
  });

  it("should not modify content without hashtags or emojis", () => {
    const input = "This is a normal post without any special characters";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe(input);
  });

  it("should preserve double newlines for paragraph breaks", () => {
    const input = "First paragraph here.\n\nSecond paragraph here.";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe("First paragraph here.\n\nSecond paragraph here.");
  });

  it("should normalize triple+ newlines to double newlines", () => {
    const input = "First paragraph.\n\n\n\nSecond paragraph.";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("should preserve single newlines", () => {
    const input = "Line one.\nLine two.";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe("Line one.\nLine two.");
  });

  it("should handle mixed content with hashtags, emojis, and paragraph breaks", () => {
    const input =
      "First paragraph #news 🎉\n\nSecond paragraph #crypto is here.\n\nThird paragraph 🚀";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe(
      "First paragraph\n\nSecond paragraph is here.\n\nThird paragraph",
    );
  });

  it("should clean up spaces around newlines", () => {
    const input = "First paragraph.   \n\n   Second paragraph.";
    const result = stripHashtagsAndEmojis(input);
    expect(result).toBe("First paragraph.\n\nSecond paragraph.");
  });
});

describe("formatActorVoiceContext", () => {
  it("should return empty string for actor without voice data", () => {
    const actor = { name: "Test Actor" };
    const result = formatActorVoiceContext(actor);
    expect(result).toBe("");
  });

  it("should include personality when provided", () => {
    const actor = { name: "Test Actor", personality: "sarcastic visionary" };
    const result = formatActorVoiceContext(actor);
    expect(result).toContain("PERSONALITY: sarcastic visionary");
  });

  it("should include post style when provided", () => {
    const actor = { name: "Test Actor", postStyle: "Short, cryptic posts" };
    const result = formatActorVoiceContext(actor);
    expect(result).toContain("WRITING STYLE: Short, cryptic posts");
  });

  it("should include example posts when provided", () => {
    const actor = {
      name: "Test Actor",
      postExample: ["lol", "just shipped it"],
    };
    const result = formatActorVoiceContext(actor);
    expect(result).toContain("EXAMPLE POSTS");
  });

  it("should include voice header with actor name", () => {
    const actor = {
      name: "AIlon Musk",
      realName: "Elon Musk",
      personality: "erratic",
    };
    const result = formatActorVoiceContext(actor);
    expect(result).toContain("REAL PERSON");
    expect(result).toContain("ELON MUSK");
    expect(result).toContain("PARODY CHARACTER: AILON MUSK");
  });
});
