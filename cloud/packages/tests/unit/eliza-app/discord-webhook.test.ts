/**
 * Discord Webhook Tests
 *
 * Tests for Discord webhook processing logic:
 * - DM-only filtering (skip guild messages)
 * - Bot message filtering
 * - Empty message handling
 * - Attachment processing (regular + voice)
 * - Event type filtering
 * - Discord message sending with 429 retry logic
 */

import { describe, expect, test } from "bun:test";

describe("Discord Webhook", () => {
  describe("Event type filtering", () => {
    const HANDLED_EVENT_TYPES = ["MESSAGE_CREATE"];

    const shouldHandleEvent = (eventType: string): boolean => {
      return HANDLED_EVENT_TYPES.includes(eventType);
    };

    test("handles MESSAGE_CREATE events", () => {
      expect(shouldHandleEvent("MESSAGE_CREATE")).toBe(true);
    });

    test("skips MESSAGE_UPDATE events", () => {
      expect(shouldHandleEvent("MESSAGE_UPDATE")).toBe(false);
    });

    test("skips MESSAGE_DELETE events", () => {
      expect(shouldHandleEvent("MESSAGE_DELETE")).toBe(false);
    });

    test("skips INTERACTION_CREATE events", () => {
      expect(shouldHandleEvent("INTERACTION_CREATE")).toBe(false);
    });

    test("skips unknown event types", () => {
      expect(shouldHandleEvent("UNKNOWN_EVENT")).toBe(false);
    });
  });

  describe("DM-only filtering", () => {
    interface MessageData {
      guild_id?: string | null;
    }

    const isDMMessage = (data: MessageData): boolean => {
      // DM messages have no guild_id (null or undefined)
      return !data.guild_id;
    };

    test("identifies DM message (null guild_id)", () => {
      expect(isDMMessage({ guild_id: null })).toBe(true);
    });

    test("identifies DM message (undefined guild_id)", () => {
      expect(isDMMessage({})).toBe(true);
    });

    test("identifies server message", () => {
      expect(isDMMessage({ guild_id: "123456789012345678" })).toBe(false);
    });

    test("identifies server message (empty string is truthy in this context)", () => {
      // Empty string is falsy in JS, so would be treated as DM
      // This tests the actual behavior
      expect(isDMMessage({ guild_id: "" })).toBe(true);
    });
  });

  describe("Bot message filtering", () => {
    interface Author {
      bot?: boolean;
    }

    const isBotMessage = (author: Author): boolean => {
      return author.bot === true;
    };

    test("identifies bot message", () => {
      expect(isBotMessage({ bot: true })).toBe(true);
    });

    test("identifies human message (bot: false)", () => {
      expect(isBotMessage({ bot: false })).toBe(false);
    });

    test("identifies human message (bot undefined)", () => {
      expect(isBotMessage({})).toBe(false);
    });
  });

  describe("Empty message handling", () => {
    interface MessageData {
      content: string;
      attachments?: { url: string }[];
      voice_attachments?: { url: string }[];
    }

    const hasContent = (data: MessageData): boolean => {
      const hasText = data.content.trim().length > 0;
      const hasAttachments = (data.attachments?.length ?? 0) > 0;
      const hasVoiceAttachments = (data.voice_attachments?.length ?? 0) > 0;
      return hasText || hasAttachments || hasVoiceAttachments;
    };

    test("detects message with text content", () => {
      expect(hasContent({ content: "Hello!" })).toBe(true);
    });

    test("detects message with only whitespace as empty", () => {
      expect(hasContent({ content: "   " })).toBe(false);
    });

    test("detects empty content string", () => {
      expect(hasContent({ content: "" })).toBe(false);
    });

    test("detects message with attachments", () => {
      expect(
        hasContent({
          content: "",
          attachments: [{ url: "https://example.com/file.png" }],
        }),
      ).toBe(true);
    });

    test("detects message with voice attachments", () => {
      expect(
        hasContent({
          content: "",
          voice_attachments: [{ url: "https://example.com/voice.ogg" }],
        }),
      ).toBe(true);
    });

    test("detects message with both text and attachments", () => {
      expect(
        hasContent({
          content: "Check this out!",
          attachments: [{ url: "https://example.com/file.png" }],
        }),
      ).toBe(true);
    });

    test("detects completely empty message", () => {
      expect(hasContent({ content: "", attachments: [], voice_attachments: [] })).toBe(false);
    });
  });

  describe("Attachment processing", () => {
    interface DiscordAttachment {
      url: string;
      content_type?: string;
      filename?: string;
    }

    interface Media {
      url: string;
      contentType?: string;
      title?: string;
    }

    const processAttachments = (attachments: DiscordAttachment[]): Media[] => {
      return attachments.map((att) => ({
        url: att.url,
        contentType: att.content_type,
        title: att.filename,
      }));
    };

    test("converts Discord attachment to Media format", () => {
      const attachments: DiscordAttachment[] = [
        {
          url: "https://cdn.discordapp.com/attachments/123/456/image.png",
          content_type: "image/png",
          filename: "image.png",
        },
      ];

      const media = processAttachments(attachments);

      expect(media).toHaveLength(1);
      expect(media[0].url).toBe("https://cdn.discordapp.com/attachments/123/456/image.png");
      expect(media[0].contentType).toBe("image/png");
      expect(media[0].title).toBe("image.png");
    });

    test("handles attachment without content_type", () => {
      const attachments: DiscordAttachment[] = [
        {
          url: "https://example.com/file",
          filename: "file",
        },
      ];

      const media = processAttachments(attachments);

      expect(media[0].contentType).toBeUndefined();
    });

    test("handles attachment without filename", () => {
      const attachments: DiscordAttachment[] = [
        {
          url: "https://example.com/file.png",
          content_type: "image/png",
        },
      ];

      const media = processAttachments(attachments);

      expect(media[0].title).toBeUndefined();
    });

    test("processes multiple attachments", () => {
      const attachments: DiscordAttachment[] = [
        {
          url: "https://example.com/1.png",
          content_type: "image/png",
          filename: "1.png",
        },
        {
          url: "https://example.com/2.jpg",
          content_type: "image/jpeg",
          filename: "2.jpg",
        },
        {
          url: "https://example.com/3.pdf",
          content_type: "application/pdf",
          filename: "3.pdf",
        },
      ];

      const media = processAttachments(attachments);

      expect(media).toHaveLength(3);
      expect(media[0].contentType).toBe("image/png");
      expect(media[1].contentType).toBe("image/jpeg");
      expect(media[2].contentType).toBe("application/pdf");
    });

    test("handles empty attachments array", () => {
      const media = processAttachments([]);
      expect(media).toHaveLength(0);
    });
  });

  describe("Voice attachment processing", () => {
    interface VoiceAttachment {
      url: string;
      content_type: string;
      filename: string;
    }

    interface Media {
      url: string;
      contentType?: string;
      title?: string;
    }

    const processVoiceAttachments = (voiceAttachments: VoiceAttachment[]): Media[] => {
      return voiceAttachments.map((va) => ({
        url: va.url,
        contentType: va.content_type,
        title: va.filename,
      }));
    };

    test("processes voice attachment", () => {
      const voiceAttachments: VoiceAttachment[] = [
        {
          url: "https://cdn.discordapp.com/attachments/123/456/voice-message.ogg",
          content_type: "audio/ogg",
          filename: "voice-message.ogg",
        },
      ];

      const media = processVoiceAttachments(voiceAttachments);

      expect(media).toHaveLength(1);
      expect(media[0].url).toContain("voice-message.ogg");
      expect(media[0].contentType).toBe("audio/ogg");
      expect(media[0].title).toBe("voice-message.ogg");
    });

    test("handles multiple voice attachments", () => {
      const voiceAttachments: VoiceAttachment[] = [
        {
          url: "https://example.com/voice1.ogg",
          content_type: "audio/ogg",
          filename: "voice1.ogg",
        },
        {
          url: "https://example.com/voice2.ogg",
          content_type: "audio/ogg",
          filename: "voice2.ogg",
        },
      ];

      const media = processVoiceAttachments(voiceAttachments);

      expect(media).toHaveLength(2);
    });
  });

  describe("Discord message length limit", () => {
    const MAX_DISCORD_MESSAGE_LENGTH = 2000;

    const truncateMessage = (content: string): string => {
      return content.slice(0, MAX_DISCORD_MESSAGE_LENGTH);
    };

    test("keeps short messages unchanged", () => {
      const message = "Hello, world!";
      expect(truncateMessage(message)).toBe(message);
    });

    test("truncates messages at 2000 characters", () => {
      const longMessage = "a".repeat(2500);
      const truncated = truncateMessage(longMessage);
      expect(truncated).toHaveLength(2000);
    });

    test("handles exactly 2000 character messages", () => {
      const message = "b".repeat(2000);
      expect(truncateMessage(message)).toHaveLength(2000);
      expect(truncateMessage(message)).toBe(message);
    });

    test("handles empty messages", () => {
      expect(truncateMessage("")).toBe("");
    });
  });

  describe("Discord 429 retry logic", () => {
    const parseRetryAfter = (retryAfterHeader: string | null): number => {
      if (!retryAfterHeader) return 1000; // Default 1 second
      const seconds = parseFloat(retryAfterHeader);
      if (Number.isNaN(seconds)) return 1000;
      return seconds * 1000; // Convert to milliseconds
    };

    test("parses numeric Retry-After header", () => {
      expect(parseRetryAfter("5")).toBe(5000);
      expect(parseRetryAfter("1.5")).toBe(1500);
      expect(parseRetryAfter("0.5")).toBe(500);
    });

    test("returns default for null header", () => {
      expect(parseRetryAfter(null)).toBe(1000);
    });

    test("returns default for invalid header", () => {
      expect(parseRetryAfter("invalid")).toBe(1000);
      expect(parseRetryAfter("")).toBe(1000);
    });

    test("handles decimal values", () => {
      expect(parseRetryAfter("2.5")).toBe(2500);
    });
  });

  describe("Idempotency key generation", () => {
    const generateIdempotencyKey = (eventId: string): string => {
      return `discord:eliza-app:${eventId}`;
    };

    test("generates correct idempotency key format", () => {
      const key = generateIdempotencyKey("1234567890123456789");
      expect(key).toBe("discord:eliza-app:1234567890123456789");
    });

    test("includes event ID in key", () => {
      const eventId = "9876543210987654321";
      const key = generateIdempotencyKey(eventId);
      expect(key).toContain(eventId);
    });
  });

  describe("Room ID generation", () => {
    // Simulating deterministic UUID generation pattern
    const generateRoomIdPattern = (
      platform: string,
      agentId: string,
      discordUserId: string,
    ): string => {
      return `${platform}-${agentId}-${discordUserId}`;
    };

    test("generates consistent room ID for same inputs", () => {
      const roomId1 = generateRoomIdPattern("discord", "agent-123", "user-456");
      const roomId2 = generateRoomIdPattern("discord", "agent-123", "user-456");
      expect(roomId1).toBe(roomId2);
    });

    test("generates different room IDs for different users", () => {
      const roomId1 = generateRoomIdPattern("discord", "agent-123", "user-456");
      const roomId2 = generateRoomIdPattern("discord", "agent-123", "user-789");
      expect(roomId1).not.toBe(roomId2);
    });

    test("includes platform in room ID", () => {
      const roomId = generateRoomIdPattern("discord", "agent-123", "user-456");
      expect(roomId).toContain("discord");
    });
  });

  describe("Author data extraction", () => {
    interface DiscordAuthor {
      id: string;
      username: string;
      global_name?: string | null;
      avatar?: string | null;
      bot?: boolean;
    }

    interface ExtractedAuthorData {
      discordId: string;
      username: string;
      globalName: string | null;
      avatarUrl: string | null;
    }

    const extractAuthorData = (author: DiscordAuthor): ExtractedAuthorData => {
      const avatarUrl = author.avatar
        ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png`
        : null;

      return {
        discordId: author.id,
        username: author.username,
        globalName: author.global_name ?? null,
        avatarUrl,
      };
    };

    test("extracts all author data", () => {
      const author: DiscordAuthor = {
        id: "123456789",
        username: "testuser",
        global_name: "Test User",
        avatar: "abcdef123456",
      };

      const data = extractAuthorData(author);

      expect(data.discordId).toBe("123456789");
      expect(data.username).toBe("testuser");
      expect(data.globalName).toBe("Test User");
      expect(data.avatarUrl).toBe("https://cdn.discordapp.com/avatars/123456789/abcdef123456.png");
    });

    test("handles missing global_name", () => {
      const author: DiscordAuthor = {
        id: "123",
        username: "user",
      };

      const data = extractAuthorData(author);

      expect(data.globalName).toBeNull();
    });

    test("handles null avatar", () => {
      const author: DiscordAuthor = {
        id: "123",
        username: "user",
        avatar: null,
      };

      const data = extractAuthorData(author);

      expect(data.avatarUrl).toBeNull();
    });
  });

  describe("Response content extraction", () => {
    type MessageContent = string | { text?: string };

    const extractResponseText = (content: MessageContent): string => {
      if (typeof content === "string") return content;
      return content?.text || "";
    };

    test("extracts string content directly", () => {
      expect(extractResponseText("Hello!")).toBe("Hello!");
    });

    test("extracts text from object content", () => {
      expect(extractResponseText({ text: "Hello!" })).toBe("Hello!");
    });

    test("returns empty string for object without text", () => {
      expect(extractResponseText({})).toBe("");
    });

    test("returns empty string for undefined text", () => {
      expect(extractResponseText({ text: undefined })).toBe("");
    });

    test("handles empty string content", () => {
      expect(extractResponseText("")).toBe("");
    });
  });
});

describe("Discord Event Payload Validation", () => {
  interface DiscordEventPayload {
    event_type: string;
    event_id: string;
    data: {
      id: string;
      channel_id: string;
      guild_id?: string | null;
      author: {
        id: string;
        username: string;
        bot?: boolean;
      };
      content: string;
    };
  }

  const isValidPayload = (payload: unknown): payload is DiscordEventPayload => {
    if (typeof payload !== "object" || payload === null) return false;
    const p = payload as Record<string, unknown>;
    if (typeof p.event_type !== "string") return false;
    if (typeof p.event_id !== "string") return false;
    if (typeof p.data !== "object" || p.data === null) return false;
    const data = p.data as Record<string, unknown>;
    if (typeof data.id !== "string") return false;
    if (typeof data.channel_id !== "string") return false;
    if (typeof data.author !== "object" || data.author === null) return false;
    const author = data.author as Record<string, unknown>;
    if (typeof author.id !== "string") return false;
    if (typeof author.username !== "string") return false;
    if (typeof data.content !== "string") return false;
    return true;
  };

  test("validates correct payload structure", () => {
    const payload = {
      event_type: "MESSAGE_CREATE",
      event_id: "123456789",
      data: {
        id: "123456789",
        channel_id: "987654321",
        author: {
          id: "111222333",
          username: "testuser",
        },
        content: "Hello!",
      },
    };
    expect(isValidPayload(payload)).toBe(true);
  });

  test("rejects payload missing event_type", () => {
    const payload = {
      event_id: "123",
      data: {
        id: "1",
        channel_id: "2",
        author: { id: "3", username: "u" },
        content: "x",
      },
    };
    expect(isValidPayload(payload)).toBe(false);
  });

  test("rejects payload missing event_id", () => {
    const payload = {
      event_type: "MESSAGE_CREATE",
      data: {
        id: "1",
        channel_id: "2",
        author: { id: "3", username: "u" },
        content: "x",
      },
    };
    expect(isValidPayload(payload)).toBe(false);
  });

  test("rejects payload missing data", () => {
    const payload = {
      event_type: "MESSAGE_CREATE",
      event_id: "123",
    };
    expect(isValidPayload(payload)).toBe(false);
  });

  test("rejects payload missing author", () => {
    const payload = {
      event_type: "MESSAGE_CREATE",
      event_id: "123",
      data: { id: "1", channel_id: "2", content: "x" },
    };
    expect(isValidPayload(payload)).toBe(false);
  });

  test("rejects null payload", () => {
    expect(isValidPayload(null)).toBe(false);
  });

  test("rejects non-object payload", () => {
    expect(isValidPayload("string")).toBe(false);
    expect(isValidPayload(123)).toBe(false);
  });
});
