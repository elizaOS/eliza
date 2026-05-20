/**
 * Team Chat API Validation Unit Tests
 *
 * Tests the Zod schema validation for team chat API endpoints.
 * These tests verify input validation without hitting the database.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

// Replicate the message schema from route.ts
const messageSchema = z.object({
  content: z
    .string()
    .min(1, "Message content is required")
    .max(4000, "Message too long. Maximum 4000 characters allowed."),
  mentionedAgentIds: z
    .array(z.string().regex(/^\d+$/, "Invalid agent ID format"))
    .max(10, "Maximum 10 agents can be mentioned at once.")
    .optional(),
});

// Replicate the typing schema from route.ts
const typingSchema = z.object({
  isTyping: z.boolean(),
});

describe("Message API Schema Validation", () => {
  describe("content field", () => {
    test("accepts valid content", () => {
      const result = messageSchema.safeParse({
        content: "Hello, how are you?",
      });
      expect(result.success).toBe(true);
    });

    test("rejects empty content", () => {
      const result = messageSchema.safeParse({
        content: "",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("required");
      }
    });

    test("rejects content over 4000 characters", () => {
      const result = messageSchema.safeParse({
        content: "A".repeat(4001),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("4000");
      }
    });

    test("accepts content at exactly 4000 characters", () => {
      const result = messageSchema.safeParse({
        content: "A".repeat(4000),
      });
      expect(result.success).toBe(true);
    });

    test("accepts content at exactly 1 character", () => {
      const result = messageSchema.safeParse({
        content: "A",
      });
      expect(result.success).toBe(true);
    });

    test("rejects non-string content", () => {
      const result = messageSchema.safeParse({
        content: 12345,
      });
      expect(result.success).toBe(false);
    });

    test("rejects null content", () => {
      const result = messageSchema.safeParse({
        content: null,
      });
      expect(result.success).toBe(false);
    });

    test("rejects undefined content", () => {
      const result = messageSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe("mentionedAgentIds field", () => {
    test("accepts valid agent IDs", () => {
      const result = messageSchema.safeParse({
        content: "Hello @agent",
        mentionedAgentIds: ["123456789", "987654321"],
      });
      expect(result.success).toBe(true);
    });

    test("accepts empty array", () => {
      const result = messageSchema.safeParse({
        content: "Hello everyone",
        mentionedAgentIds: [],
      });
      expect(result.success).toBe(true);
    });

    test("accepts missing mentionedAgentIds (optional)", () => {
      const result = messageSchema.safeParse({
        content: "Hello everyone",
      });
      expect(result.success).toBe(true);
    });

    test("rejects more than 10 mentioned agents", () => {
      const result = messageSchema.safeParse({
        content: "Hello everyone",
        mentionedAgentIds: Array.from({ length: 11 }, (_, i) =>
          String(i + 1000000000),
        ),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("10");
      }
    });

    test("accepts exactly 10 mentioned agents", () => {
      const result = messageSchema.safeParse({
        content: "Hello everyone",
        mentionedAgentIds: Array.from({ length: 10 }, (_, i) =>
          String(i + 1000000000),
        ),
      });
      expect(result.success).toBe(true);
    });

    test("rejects non-numeric agent IDs", () => {
      const result = messageSchema.safeParse({
        content: "Hello @agent",
        mentionedAgentIds: ["abc123"],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("Invalid agent ID");
      }
    });

    test("rejects agent IDs with special characters", () => {
      const result = messageSchema.safeParse({
        content: "Hello @agent",
        mentionedAgentIds: ["123-456"],
      });
      expect(result.success).toBe(false);
    });

    test("rejects agent IDs with spaces", () => {
      const result = messageSchema.safeParse({
        content: "Hello @agent",
        mentionedAgentIds: ["123 456"],
      });
      expect(result.success).toBe(false);
    });

    test("rejects non-array mentionedAgentIds", () => {
      const result = messageSchema.safeParse({
        content: "Hello @agent",
        mentionedAgentIds: "123456789",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("combined validation", () => {
    test("accepts fully valid message with mentions", () => {
      const result = messageSchema.safeParse({
        content: "Hey @TradingBot, analyze PEPE for me please",
        mentionedAgentIds: ["267685933648707584"],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.content).toBe(
          "Hey @TradingBot, analyze PEPE for me please",
        );
        expect(result.data.mentionedAgentIds).toEqual(["267685933648707584"]);
      }
    });

    test("rejects message with both content too long and too many mentions", () => {
      const result = messageSchema.safeParse({
        content: "A".repeat(5000),
        mentionedAgentIds: Array.from({ length: 15 }, (_, i) =>
          String(i + 1000000000),
        ),
      });
      expect(result.success).toBe(false);
      // Should have multiple issues
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
      }
    });
  });
});

describe("Typing API Schema Validation", () => {
  test("accepts isTyping: true", () => {
    const result = typingSchema.safeParse({ isTyping: true });
    expect(result.success).toBe(true);
  });

  test("accepts isTyping: false", () => {
    const result = typingSchema.safeParse({ isTyping: false });
    expect(result.success).toBe(true);
  });

  test("rejects string isTyping", () => {
    const result = typingSchema.safeParse({ isTyping: "true" });
    expect(result.success).toBe(false);
  });

  test("rejects number isTyping", () => {
    const result = typingSchema.safeParse({ isTyping: 1 });
    expect(result.success).toBe(false);
  });

  test("rejects null isTyping", () => {
    const result = typingSchema.safeParse({ isTyping: null });
    expect(result.success).toBe(false);
  });

  test("rejects missing isTyping", () => {
    const result = typingSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("allows extra fields (Zod permits unknown keys by default)", () => {
    // Zod allows extra fields by default and strips them from output
    // Use .strict() if you need to reject extra fields
    const result = typingSchema.safeParse({
      isTyping: true,
      extraField: "should be ignored",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Extra field is stripped from output
      expect(result.data.isTyping).toBe(true);
    }
  });
});

describe("Edge Cases in Validation", () => {
  test("handles unicode in content", () => {
    const result = messageSchema.safeParse({
      content: "Hello 👋 你好 مرحبا שלום",
    });
    expect(result.success).toBe(true);
  });

  test("handles newlines in content", () => {
    const result = messageSchema.safeParse({
      content: "Line 1\nLine 2\nLine 3",
    });
    expect(result.success).toBe(true);
  });

  test("handles tabs in content", () => {
    const result = messageSchema.safeParse({
      content: "Column1\tColumn2\tColumn3",
    });
    expect(result.success).toBe(true);
  });

  test("handles content with only whitespace", () => {
    const result = messageSchema.safeParse({
      content: "   ",
    });
    // This passes min(1) since it has 3 chars, but semantically may be empty
    // The API handler should trim and check for empty
    expect(result.success).toBe(true);
  });

  test("handles very long snowflake IDs", () => {
    // Snowflake IDs can be 18-19 digits
    const result = messageSchema.safeParse({
      content: "Hello",
      mentionedAgentIds: ["267685933648707584123"],
    });
    expect(result.success).toBe(true);
  });

  test("handles agent ID with leading zeros", () => {
    const result = messageSchema.safeParse({
      content: "Hello",
      mentionedAgentIds: ["0000123456"],
    });
    expect(result.success).toBe(true);
  });

  test("handles empty string agent IDs", () => {
    const result = messageSchema.safeParse({
      content: "Hello",
      mentionedAgentIds: [""],
    });
    expect(result.success).toBe(false);
  });
});
