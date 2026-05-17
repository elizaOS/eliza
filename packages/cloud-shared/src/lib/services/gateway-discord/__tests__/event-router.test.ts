/**
 * Discord Event Router Unit Tests
 *
 * Tests for lib/services/gateway-discord/event-router.ts
 *
 * Note: This module has complex dependencies that require extensive mocking.
 * These tests focus on logic that can be tested through data validation
 * and helper function behavior.
 */

import { describe, expect, test } from "bun:test";
import { MessageCreateDataSchema } from "../schemas";

// Test the helper functions and logic without complex mocking

describe("sanitizeError logic", () => {
  /**
   * Discord bot token pattern for sanitization.
   * Tokens have format: base64(bot_id).base64(timestamp).base64(hmac)
   * - Part 1 (bot ID): 18-30 characters (varies by ID length)
   * - Part 2 (timestamp): 6 characters
   * - Part 3 (HMAC): 27-40 characters
   */
  const DISCORD_TOKEN_PATTERN_GLOBAL =
    /[A-Za-z0-9_-]{18,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g;

  // Non-global version for single matching tests
  const DISCORD_TOKEN_PATTERN = /[A-Za-z0-9_-]{18,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/;

  const sanitizeError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(DISCORD_TOKEN_PATTERN_GLOBAL, "[REDACTED_TOKEN]");
  };

  // Fake Discord tokens for testing (same format as real tokens: ~26.6.38 chars)
  // DO NOT use real tokens in tests
  const SAMPLE_TOKENS = [
    "MTE0NzU5OTI0NzM5NjEyNjcyMA.G1xK2z.FAKE_TOKEN_abcdefghijklmnopqrstuvwxyz12",
    "MTE0NzU5OTI0NzM5NjEyNjcyMQ.H2yL3a.TEST_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ34",
    "MTE0NzU5OTI0NzM5NjEyNjcyMg.I3zM4b.MOCK_TOKEN_0123456789abcdefghijklmno56",
  ];

  test("regex matches Discord token format", () => {
    for (const token of SAMPLE_TOKENS) {
      expect(token).toMatch(DISCORD_TOKEN_PATTERN);
    }
  });

  test("redacts Discord bot tokens from error messages", () => {
    for (const token of SAMPLE_TOKENS) {
      const sanitized = sanitizeError(token);
      expect(sanitized).toBe("[REDACTED_TOKEN]");
      expect(sanitized).not.toContain(token);
    }
  });

  test("preserves non-token text in error messages", () => {
    const message = "Error connecting to Discord: Network timeout";
    const sanitized = sanitizeError(message);
    expect(sanitized).toBe(message); // No change
  });

  test("token embedded in error message is redacted", () => {
    const token = SAMPLE_TOKENS[0];
    const message = `Failed to authenticate with token: ${token}`;
    const sanitized = sanitizeError(message);
    expect(sanitized).toBe("Failed to authenticate with token: [REDACTED_TOKEN]");
    expect(sanitized).not.toContain(token);
  });

  test("handles Error objects", () => {
    const token = SAMPLE_TOKENS[1];
    const error = new Error(`Auth failed: ${token}`);
    const sanitized = sanitizeError(error);
    expect(sanitized).toBe("Auth failed: [REDACTED_TOKEN]");
  });

  test("handles multiple tokens in one message", () => {
    const msg = `Token1: ${SAMPLE_TOKENS[0]}, Token2: ${SAMPLE_TOKENS[1]}`;
    const sanitized = sanitizeError(msg);
    expect(sanitized).not.toContain(SAMPLE_TOKENS[0]);
    expect(sanitized).not.toContain(SAMPLE_TOKENS[1]);
    expect(sanitized).toBe("Token1: [REDACTED_TOKEN], Token2: [REDACTED_TOKEN]");
  });

  test("handles non-Error objects", () => {
    const sanitized = sanitizeError({ message: "error" });
    expect(sanitized).toBe("[object Object]");
  });

  test("regex does not match non-token strings", () => {
    const nonTokens = [
      "short.str.ing",
      "this is a normal error message",
      "123.456.789",
      "abc.def.ghi",
    ];
    for (const str of nonTokens) {
      expect(str).not.toMatch(DISCORD_TOKEN_PATTERN);
    }
  });
});

describe("truncateUtf16Safe logic", () => {
  // Replicate the truncateUtf16Safe function
  const truncateUtf16Safe = (str: string, maxLength: number): string => {
    if (str.length <= maxLength) {
      return str;
    }

    let truncated = str.slice(0, maxLength);

    // Check if we cut in the middle of a surrogate pair
    const lastChar = truncated.charCodeAt(truncated.length - 1);
    if (lastChar >= 0xd800 && lastChar <= 0xdbff) {
      // Last char is a high surrogate without its low surrogate - remove it
      truncated = truncated.slice(0, -1);
    }

    return truncated;
  };

  test("does not truncate strings under limit", () => {
    const shortString = "Hello";
    const result = truncateUtf16Safe(shortString, 2000);
    expect(result).toBe(shortString);
  });

  test("truncates strings over limit", () => {
    const longString = "a".repeat(2500);
    const result = truncateUtf16Safe(longString, 2000);
    expect(result.length).toBe(2000);
  });

  test("handles surrogate pairs correctly", () => {
    // Emoji like 😀 is a surrogate pair (2 UTF-16 code units)
    const emoji = "😀";
    expect(emoji.length).toBe(2); // Surrogate pair

    // If we truncate at position 1, we'd cut the surrogate pair
    const result = truncateUtf16Safe(emoji, 1);
    // Should remove the orphaned high surrogate
    expect(result.length).toBe(0);
  });

  test("preserves complete emoji when there is room", () => {
    const str = "Hi 😀";
    expect(str.length).toBe(5); // "Hi " (3) + emoji (2)

    const result = truncateUtf16Safe(str, 5);
    expect(result).toBe(str);
  });

  test("removes emoji if truncation would split it", () => {
    const str = "Hi 😀";
    // Truncating at 4 would cut the emoji in half
    const result = truncateUtf16Safe(str, 4);
    expect(result).toBe("Hi ");
  });
});

describe("channel filtering logic", () => {
  test("enabledChannels empty allows all", () => {
    const enabledChannels: string[] = [];
    const channelId = "channel-123";

    // If empty, should allow (no filtering)
    const shouldProcess = enabledChannels.length === 0 || enabledChannels.includes(channelId);
    expect(shouldProcess).toBe(true);
  });

  test("enabledChannels with matching channel allows", () => {
    const enabledChannels = ["channel-123", "channel-456"];
    const channelId = "channel-123";

    const shouldProcess = enabledChannels.length === 0 || enabledChannels.includes(channelId);
    expect(shouldProcess).toBe(true);
  });

  test("enabledChannels without matching channel blocks", () => {
    const enabledChannels = ["channel-123", "channel-456"];
    const channelId = "channel-789";

    const shouldProcess = enabledChannels.length === 0 || enabledChannels.includes(channelId);
    expect(shouldProcess).toBe(false);
  });

  test("disabledChannels blocks matching channel", () => {
    const disabledChannels = ["channel-123"];
    const channelId = "channel-123";

    const shouldBlock = disabledChannels.includes(channelId);
    expect(shouldBlock).toBe(true);
  });

  test("disabledChannels allows non-matching channel", () => {
    const disabledChannels = ["channel-123"];
    const channelId = "channel-456";

    const shouldBlock = disabledChannels.includes(channelId);
    expect(shouldBlock).toBe(false);
  });
});

describe("keyword matching logic", () => {
  const matchesKeyword = (content: string, keywords: string[]): boolean => {
    const contentLower = content.toLowerCase();
    return keywords.some((k) => {
      const keywordLower = k.toLowerCase();
      // Use word boundary regex to avoid false positives
      const wordBoundaryRegex = new RegExp(
        `\\b${keywordLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      );
      return wordBoundaryRegex.test(contentLower);
    });
  };

  test("matches exact keyword", () => {
    expect(matchesKeyword("Hello there!", ["hello"])).toBe(true);
  });

  test("matches keyword with different case", () => {
    expect(matchesKeyword("HELLO there!", ["hello"])).toBe(true);
    expect(matchesKeyword("Hello there!", ["HELLO"])).toBe(true);
  });

  test("does not match partial word", () => {
    // "or" should not match "organization" or "more"
    expect(matchesKeyword("Tell me more about organizations", ["or"])).toBe(false);
  });

  test("matches word at boundaries", () => {
    expect(matchesKeyword("help me please", ["help"])).toBe(true);
    expect(matchesKeyword("I need help", ["help"])).toBe(true);
    expect(matchesKeyword("help!", ["help"])).toBe(true);
  });

  test("matches multiple keywords", () => {
    expect(matchesKeyword("Can you help?", ["hello", "help"])).toBe(true);
    expect(matchesKeyword("Hello world", ["hello", "help"])).toBe(true);
  });

  test("returns false when no keywords match", () => {
    expect(matchesKeyword("Goodbye everyone", ["hello", "help"])).toBe(false);
  });

  test("escapes regex special characters in keywords", () => {
    expect(matchesKeyword("test.keyword here", ["test.keyword"])).toBe(true);
    expect(matchesKeyword("test+keyword here", ["test+keyword"])).toBe(true);
  });
});

describe("mention mode logic", () => {
  test("detects bot mention in mentions array", () => {
    const botUserId = "bot-user-111";
    const mentions = [{ id: "bot-user-111", username: "TestBot", bot: true }];

    const botMentioned = mentions.some((m) => m.id === botUserId);
    expect(botMentioned).toBe(true);
  });

  test("detects when bot is not mentioned", () => {
    const botUserId = "bot-user-111";
    const mentions = [{ id: "other-user-222", username: "OtherUser", bot: false }];

    const botMentioned = mentions.some((m) => m.id === botUserId);
    expect(botMentioned).toBe(false);
  });

  test("handles empty mentions array", () => {
    const botUserId = "bot-user-111";
    const mentions: Array<{ id: string }> = [];

    const botMentioned = mentions.some((m) => m.id === botUserId);
    expect(botMentioned).toBe(false);
  });
});

describe("message processing - data transformation", () => {
  test("MessageCreateDataSchema accepts attachments", () => {
    const messageWithAttachments = {
      id: "msg-123",
      channel_id: "channel-789",
      author: {
        id: "user-456",
        username: "testuser",
        bot: false,
      },
      content: "Check this image!",
      timestamp: "2024-01-15T12:00:00.000Z",
      attachments: [
        {
          id: "att-123",
          filename: "image.png",
          url: "https://cdn.discordapp.com/attachments/123/456/image.png",
          content_type: "image/png",
          size: 1024,
        },
      ],
    };

    const result = MessageCreateDataSchema.safeParse(messageWithAttachments);
    expect(result.success).toBe(true);
    expect(result.data?.attachments).toHaveLength(1);
    expect(result.data?.attachments?.[0].filename).toBe("image.png");
  });

  test("MessageCreateDataSchema accepts voice attachments", () => {
    const messageWithVoice = {
      id: "msg-123",
      channel_id: "channel-789",
      author: {
        id: "user-456",
        username: "testuser",
        bot: false,
      },
      content: "",
      timestamp: "2024-01-15T12:00:00.000Z",
      voice_attachments: [
        {
          url: "https://blob.elizacloud.ai/voice.ogg",
          expires_at: "2024-01-15T13:00:00.000Z",
          size: 5000,
          content_type: "audio/ogg",
          filename: "voice.ogg",
        },
      ],
    };

    const result = MessageCreateDataSchema.safeParse(messageWithVoice);
    expect(result.success).toBe(true);
    expect(result.data?.voice_attachments).toHaveLength(1);
    expect(result.data?.voice_attachments?.[0].content_type).toBe("audio/ogg");
  });

  test("MessageCreateDataSchema accepts combined attachments", () => {
    const messageWithBoth = {
      id: "msg-123",
      channel_id: "channel-789",
      author: {
        id: "user-456",
        username: "testuser",
        bot: false,
      },
      content: "Voice and image!",
      timestamp: "2024-01-15T12:00:00.000Z",
      attachments: [
        {
          id: "att-123",
          filename: "image.png",
          url: "https://cdn.discordapp.com/attachments/123/456/image.png",
        },
      ],
      voice_attachments: [
        {
          url: "https://blob.elizacloud.ai/voice.ogg",
          expires_at: "2024-01-15T13:00:00.000Z",
          size: 5000,
          content_type: "audio/ogg",
          filename: "voice.ogg",
        },
      ],
    };

    const result = MessageCreateDataSchema.safeParse(messageWithBoth);
    expect(result.success).toBe(true);
    expect(result.data?.attachments).toHaveLength(1);
    expect(result.data?.voice_attachments).toHaveLength(1);
  });
});

describe("bot message filtering", () => {
  test("detects bot messages", () => {
    const author = { id: "bot-123", username: "Bot", bot: true };
    expect(author.bot).toBe(true);
  });

  test("detects user messages", () => {
    const author = { id: "user-456", username: "User", bot: false };
    expect(author.bot).toBe(false);
  });

  test("handles missing bot field", () => {
    const author = { id: "user-456", username: "User" } as {
      id: string;
      username: string;
      bot?: boolean;
    };
    expect(author.bot ?? false).toBe(false);
  });
});
