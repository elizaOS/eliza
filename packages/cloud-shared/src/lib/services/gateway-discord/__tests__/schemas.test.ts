/**
 * Discord Gateway Schemas Unit Tests
 *
 * Tests for lib/services/gateway-discord/schemas.ts
 */

import { describe, expect, test } from "bun:test";
import {
  ConnectionStatusUpdateSchema,
  DiscordAttachmentSchema,
  DiscordAuthorSchema,
  DiscordEventPayloadSchema,
  DiscordEventTypeSchema,
  DiscordMemberSchema,
  FailoverRequestSchema,
  MessageCreateDataSchema,
  VoiceAttachmentSchema,
} from "../schemas";

describe("DiscordEventTypeSchema", () => {
  test("accepts valid event types", () => {
    const validTypes = [
      "MESSAGE_CREATE",
      "MESSAGE_UPDATE",
      "MESSAGE_DELETE",
      "MESSAGE_REACTION_ADD",
      "MESSAGE_REACTION_REMOVE",
      "GUILD_MEMBER_ADD",
      "GUILD_MEMBER_REMOVE",
      "INTERACTION_CREATE",
      "TYPING_START",
    ];

    for (const type of validTypes) {
      const result = DiscordEventTypeSchema.safeParse(type);
      expect(result.success).toBe(true);
    }
  });

  test("rejects invalid event types", () => {
    const result = DiscordEventTypeSchema.safeParse("INVALID_EVENT");
    expect(result.success).toBe(false);
  });

  test("rejects empty string", () => {
    const result = DiscordEventTypeSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(DiscordEventTypeSchema.safeParse(123).success).toBe(false);
    expect(DiscordEventTypeSchema.safeParse(null).success).toBe(false);
    expect(DiscordEventTypeSchema.safeParse(undefined).success).toBe(false);
  });
});

describe("DiscordAuthorSchema", () => {
  test("accepts valid author with required fields", () => {
    const result = DiscordAuthorSchema.safeParse({
      id: "123456789012345678",
      username: "testuser",
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid author with all optional fields", () => {
    const result = DiscordAuthorSchema.safeParse({
      id: "123456789012345678",
      username: "testuser",
      discriminator: "1234",
      avatar: "abc123",
      bot: false,
      global_name: "Test User",
    });
    expect(result.success).toBe(true);
    expect(result.data?.global_name).toBe("Test User");
  });

  test("accepts null avatar and global_name", () => {
    const result = DiscordAuthorSchema.safeParse({
      id: "123456789012345678",
      username: "testuser",
      avatar: null,
      global_name: null,
    });
    expect(result.success).toBe(true);
  });

  test("rejects author without id", () => {
    const result = DiscordAuthorSchema.safeParse({
      username: "testuser",
    });
    expect(result.success).toBe(false);
  });

  test("rejects author without username", () => {
    const result = DiscordAuthorSchema.safeParse({
      id: "123456789012345678",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty id", () => {
    const result = DiscordAuthorSchema.safeParse({
      id: "",
      username: "testuser",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty username", () => {
    const result = DiscordAuthorSchema.safeParse({
      id: "123456789012345678",
      username: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("DiscordMemberSchema", () => {
  test("accepts valid member with nick", () => {
    const result = DiscordMemberSchema.safeParse({
      nick: "Nickname",
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid member with roles", () => {
    const result = DiscordMemberSchema.safeParse({
      roles: ["123456", "789012"],
    });
    expect(result.success).toBe(true);
  });

  test("accepts null nick", () => {
    const result = DiscordMemberSchema.safeParse({
      nick: null,
    });
    expect(result.success).toBe(true);
  });

  test("accepts empty object", () => {
    const result = DiscordMemberSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("DiscordAttachmentSchema", () => {
  test("accepts valid attachment with required fields", () => {
    const result = DiscordAttachmentSchema.safeParse({
      id: "attachment123",
      url: "https://cdn.discordapp.com/attachments/123/456/file.png",
    });
    expect(result.success).toBe(true);
  });

  test("accepts valid attachment with all optional fields", () => {
    const result = DiscordAttachmentSchema.safeParse({
      id: "attachment123",
      filename: "image.png",
      url: "https://cdn.discordapp.com/attachments/123/456/file.png",
      content_type: "image/png",
      size: 1024,
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid URL", () => {
    const result = DiscordAttachmentSchema.safeParse({
      id: "attachment123",
      url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative size", () => {
    const result = DiscordAttachmentSchema.safeParse({
      id: "attachment123",
      url: "https://cdn.discordapp.com/file.png",
      size: -100,
    });
    expect(result.success).toBe(false);
  });

  test("rejects zero size", () => {
    const result = DiscordAttachmentSchema.safeParse({
      id: "attachment123",
      url: "https://cdn.discordapp.com/file.png",
      size: 0,
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty id", () => {
    const result = DiscordAttachmentSchema.safeParse({
      id: "",
      url: "https://cdn.discordapp.com/file.png",
    });
    expect(result.success).toBe(false);
  });
});

describe("VoiceAttachmentSchema", () => {
  test("accepts valid voice attachment", () => {
    const result = VoiceAttachmentSchema.safeParse({
      url: "https://blob.elizacloud.ai/voice/abc123.ogg",
      expires_at: "2024-01-15T12:00:00.000Z",
      size: 5000,
      content_type: "audio/ogg",
      filename: "voice-123.ogg",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid datetime format", () => {
    const result = VoiceAttachmentSchema.safeParse({
      url: "https://blob.elizacloud.ai/voice/abc123.ogg",
      expires_at: "invalid-date",
      size: 5000,
      content_type: "audio/ogg",
      filename: "voice-123.ogg",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing required fields", () => {
    const result = VoiceAttachmentSchema.safeParse({
      url: "https://blob.elizacloud.ai/voice/abc123.ogg",
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative size", () => {
    const result = VoiceAttachmentSchema.safeParse({
      url: "https://blob.elizacloud.ai/voice/abc123.ogg",
      expires_at: "2024-01-15T12:00:00.000Z",
      size: -1,
      content_type: "audio/ogg",
      filename: "voice-123.ogg",
    });
    expect(result.success).toBe(false);
  });
});

describe("MessageCreateDataSchema", () => {
  const validMessage = {
    id: "123456789012345678",
    channel_id: "987654321098765432",
    author: {
      id: "111222333444555666",
      username: "testuser",
    },
    content: "Hello, world!",
    timestamp: "2024-01-15T12:00:00.000Z",
  };

  test("accepts valid message with required fields", () => {
    const result = MessageCreateDataSchema.safeParse(validMessage);
    expect(result.success).toBe(true);
  });

  test("accepts valid message with guild_id", () => {
    const result = MessageCreateDataSchema.safeParse({
      ...validMessage,
      guild_id: "555666777888999000",
    });
    expect(result.success).toBe(true);
  });

  test("accepts null guild_id (DM)", () => {
    const result = MessageCreateDataSchema.safeParse({
      ...validMessage,
      guild_id: null,
    });
    expect(result.success).toBe(true);
  });

  test("accepts message with attachments", () => {
    const result = MessageCreateDataSchema.safeParse({
      ...validMessage,
      attachments: [
        {
          id: "att123",
          url: "https://cdn.discordapp.com/file.png",
          filename: "image.png",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts message with embeds", () => {
    const result = MessageCreateDataSchema.safeParse({
      ...validMessage,
      embeds: [
        {
          title: "Test Embed",
          description: "A test embed",
          url: "https://example.com",
          color: 0x00ff00,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts message with mentions", () => {
    const result = MessageCreateDataSchema.safeParse({
      ...validMessage,
      mentions: [
        {
          id: "222333444555666777",
          username: "mentioneduser",
          bot: false,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts message with referenced_message (reply)", () => {
    const result = MessageCreateDataSchema.safeParse({
      ...validMessage,
      referenced_message: {
        id: "999888777666555444",
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts message with voice_attachments", () => {
    const result = MessageCreateDataSchema.safeParse({
      ...validMessage,
      voice_attachments: [
        {
          url: "https://blob.elizacloud.ai/voice.ogg",
          expires_at: "2024-01-15T13:00:00.000Z",
          size: 5000,
          content_type: "audio/ogg",
          filename: "voice.ogg",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("accepts message with member data", () => {
    const result = MessageCreateDataSchema.safeParse({
      ...validMessage,
      member: {
        nick: "TestNick",
        roles: ["role1", "role2"],
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects message without id", () => {
    const { id, ...messageWithoutId } = validMessage;
    const result = MessageCreateDataSchema.safeParse(messageWithoutId);
    expect(result.success).toBe(false);
  });

  test("rejects message without channel_id", () => {
    const { channel_id, ...messageWithoutChannelId } = validMessage;
    const result = MessageCreateDataSchema.safeParse(messageWithoutChannelId);
    expect(result.success).toBe(false);
  });

  test("rejects message without author", () => {
    const { author, ...messageWithoutAuthor } = validMessage;
    const result = MessageCreateDataSchema.safeParse(messageWithoutAuthor);
    expect(result.success).toBe(false);
  });
});

describe("DiscordEventPayloadSchema", () => {
  test("validates connection_id as UUID", () => {
    const uuidSchema = DiscordEventPayloadSchema.shape.connection_id;
    expect(uuidSchema.safeParse("550e8400-e29b-41d4-a716-446655440000").success).toBe(true);
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  test("validates organization_id as UUID", () => {
    const uuidSchema = DiscordEventPayloadSchema.shape.organization_id;
    expect(uuidSchema.safeParse("6ba7b810-9dad-11d1-80b4-00c04fd430c8").success).toBe(true);
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  test("validates event_type as enum", () => {
    const eventTypeSchema = DiscordEventPayloadSchema.shape.event_type;
    expect(eventTypeSchema.safeParse("MESSAGE_CREATE").success).toBe(true);
    expect(eventTypeSchema.safeParse("INVALID_TYPE").success).toBe(false);
  });

  test("validates timestamp as datetime", () => {
    const timestampSchema = DiscordEventPayloadSchema.shape.timestamp;
    expect(timestampSchema.safeParse("2024-01-15T12:00:00.000Z").success).toBe(true);
    expect(timestampSchema.safeParse("not-a-date").success).toBe(false);
  });

  test("validates event_id is non-empty", () => {
    const eventIdSchema = DiscordEventPayloadSchema.shape.event_id;
    expect(eventIdSchema.safeParse("evt-12345").success).toBe(true);
    expect(eventIdSchema.safeParse("").success).toBe(false);
  });

  test("validates platform_connection_id is string", () => {
    const schema = DiscordEventPayloadSchema.shape.platform_connection_id;
    expect(schema.safeParse("conn-123").success).toBe(true);
  });

  test("validates guild_id is string", () => {
    const schema = DiscordEventPayloadSchema.shape.guild_id;
    expect(schema.safeParse("123456789").success).toBe(true);
  });

  test("validates channel_id is string", () => {
    const schema = DiscordEventPayloadSchema.shape.channel_id;
    expect(schema.safeParse("987654321").success).toBe(true);
  });
});

describe("ConnectionStatusUpdateSchema", () => {
  const validUpdate = {
    connection_id: "550e8400-e29b-41d4-a716-446655440000",
    pod_name: "discord-gateway-abc123",
    status: "connected",
  };

  test("accepts valid status update", () => {
    const result = ConnectionStatusUpdateSchema.safeParse(validUpdate);
    expect(result.success).toBe(true);
  });

  test("accepts all valid statuses", () => {
    const statuses = ["connecting", "connected", "disconnected", "error"];
    for (const status of statuses) {
      const result = ConnectionStatusUpdateSchema.safeParse({
        ...validUpdate,
        status,
      });
      expect(result.success).toBe(true);
    }
  });

  test("accepts error_message with error status", () => {
    const result = ConnectionStatusUpdateSchema.safeParse({
      ...validUpdate,
      status: "error",
      error_message: "Connection failed",
    });
    expect(result.success).toBe(true);
  });

  test("accepts bot_user_id with connected status", () => {
    const result = ConnectionStatusUpdateSchema.safeParse({
      ...validUpdate,
      status: "connected",
      bot_user_id: "123456789012345678",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid pod_name with special characters", () => {
    const result = ConnectionStatusUpdateSchema.safeParse({
      ...validUpdate,
      pod_name: "pod_with_underscore",
    });
    expect(result.success).toBe(false);
  });

  test("rejects pod_name over 253 characters", () => {
    const result = ConnectionStatusUpdateSchema.safeParse({
      ...validUpdate,
      pod_name: "a".repeat(254),
    });
    expect(result.success).toBe(false);
  });

  test("accepts pod_name at max 253 characters", () => {
    const result = ConnectionStatusUpdateSchema.safeParse({
      ...validUpdate,
      pod_name: "a".repeat(253),
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty pod_name", () => {
    const result = ConnectionStatusUpdateSchema.safeParse({
      ...validUpdate,
      pod_name: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid status", () => {
    const result = ConnectionStatusUpdateSchema.safeParse({
      ...validUpdate,
      status: "invalid-status",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid connection_id", () => {
    const result = ConnectionStatusUpdateSchema.safeParse({
      ...validUpdate,
      connection_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

describe("FailoverRequestSchema", () => {
  const validRequest = {
    claiming_pod: "discord-gateway-new",
    dead_pod: "discord-gateway-old",
  };

  test("accepts valid failover request", () => {
    const result = FailoverRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });

  test("accepts hyphenated pod names", () => {
    const result = FailoverRequestSchema.safeParse({
      claiming_pod: "discord-gateway-abc-123",
      dead_pod: "discord-gateway-xyz-456",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid claiming_pod name", () => {
    const result = FailoverRequestSchema.safeParse({
      ...validRequest,
      claiming_pod: "invalid_pod_name",
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid dead_pod name", () => {
    const result = FailoverRequestSchema.safeParse({
      ...validRequest,
      dead_pod: "pod.with.dots",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing claiming_pod", () => {
    const result = FailoverRequestSchema.safeParse({
      dead_pod: "discord-gateway-old",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing dead_pod", () => {
    const result = FailoverRequestSchema.safeParse({
      claiming_pod: "discord-gateway-new",
    });
    expect(result.success).toBe(false);
  });
});
