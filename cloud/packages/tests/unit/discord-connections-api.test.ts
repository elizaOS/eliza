/**
 * Discord Connections API Unit Tests
 *
 * Tests for the Discord connections API schema validation.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { DiscordConnectionMetadataSchema } from "@/db/schemas/discord-connections";

// Recreate the schemas from the API route for testing
const CreateConnectionSchema = z.object({
  applicationId: z.string().min(1, "Application ID is required"),
  botToken: z.string().min(1, "Bot token is required"),
  characterId: z.string().uuid("Character ID must be a valid UUID"),
  intents: z.number().int().positive().optional(),
  metadata: DiscordConnectionMetadataSchema,
});

const UpdateConnectionSchema = z.object({
  characterId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
  metadata: DiscordConnectionMetadataSchema,
});

describe("CreateConnectionSchema", () => {
  const validPayload = {
    applicationId: "1234567890123456789",
    botToken: "MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.ABCDEF.abcdefghijklmnopqrstuvwxyz",
    characterId: "550e8400-e29b-41d4-a716-446655440000",
  };

  test("accepts valid payload with required fields", () => {
    const result = CreateConnectionSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  test("accepts valid payload with all fields", () => {
    const result = CreateConnectionSchema.safeParse({
      ...validPayload,
      intents: 38401,
      metadata: {
        responseMode: "always",
        enabledChannels: ["123456789"],
        disabledChannels: ["987654321"],
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing applicationId", () => {
    const { applicationId, ...payload } = validPayload;
    const result = CreateConnectionSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("rejects empty applicationId", () => {
    const result = CreateConnectionSchema.safeParse({
      ...validPayload,
      applicationId: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing botToken", () => {
    const { botToken, ...payload } = validPayload;
    const result = CreateConnectionSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("rejects empty botToken", () => {
    const result = CreateConnectionSchema.safeParse({
      ...validPayload,
      botToken: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing characterId", () => {
    const { characterId, ...payload } = validPayload;
    const result = CreateConnectionSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("rejects invalid characterId (not UUID)", () => {
    const result = CreateConnectionSchema.safeParse({
      ...validPayload,
      characterId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative intents", () => {
    const result = CreateConnectionSchema.safeParse({
      ...validPayload,
      intents: -1,
    });
    expect(result.success).toBe(false);
  });

  test("rejects zero intents", () => {
    const result = CreateConnectionSchema.safeParse({
      ...validPayload,
      intents: 0,
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-integer intents", () => {
    const result = CreateConnectionSchema.safeParse({
      ...validPayload,
      intents: 38401.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("UpdateConnectionSchema", () => {
  test("accepts empty payload (no updates)", () => {
    const result = UpdateConnectionSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("accepts valid characterId update", () => {
    const result = UpdateConnectionSchema.safeParse({
      characterId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  test("accepts null characterId (remove character)", () => {
    const result = UpdateConnectionSchema.safeParse({
      characterId: null,
    });
    expect(result.success).toBe(true);
  });

  test("accepts isActive update", () => {
    const result = UpdateConnectionSchema.safeParse({
      isActive: false,
    });
    expect(result.success).toBe(true);
  });

  test("accepts metadata update", () => {
    const result = UpdateConnectionSchema.safeParse({
      metadata: {
        responseMode: "mention",
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts all fields together", () => {
    const result = UpdateConnectionSchema.safeParse({
      characterId: "550e8400-e29b-41d4-a716-446655440000",
      isActive: true,
      metadata: {
        responseMode: "keyword",
        keywords: ["help", "bot"],
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid characterId (not UUID)", () => {
    const result = UpdateConnectionSchema.safeParse({
      characterId: "invalid",
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-boolean isActive", () => {
    const result = UpdateConnectionSchema.safeParse({
      isActive: "true",
    });
    expect(result.success).toBe(false);
  });
});

describe("DiscordConnectionMetadataSchema", () => {
  test("accepts empty metadata", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("accepts undefined metadata", () => {
    const result = DiscordConnectionMetadataSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  test("accepts responseMode: always", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({
      responseMode: "always",
    });
    expect(result.success).toBe(true);
  });

  test("accepts responseMode: mention", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({
      responseMode: "mention",
    });
    expect(result.success).toBe(true);
  });

  test("accepts responseMode: keyword with keywords", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({
      responseMode: "keyword",
      keywords: ["help", "bot", "assist"],
    });
    expect(result.success).toBe(true);
  });

  test("rejects responseMode: keyword without keywords", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({
      responseMode: "keyword",
    });
    expect(result.success).toBe(false);
  });

  test("rejects responseMode: keyword with empty keywords array", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({
      responseMode: "keyword",
      keywords: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid responseMode", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({
      responseMode: "invalid",
    });
    expect(result.success).toBe(false);
  });

  test("accepts enabledChannels array", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({
      enabledChannels: ["123456789", "987654321"],
    });
    expect(result.success).toBe(true);
  });

  test("accepts disabledChannels array", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({
      disabledChannels: ["123456789"],
    });
    expect(result.success).toBe(true);
  });

  test("accepts all fields together", () => {
    const result = DiscordConnectionMetadataSchema.safeParse({
      responseMode: "keyword",
      keywords: ["help"],
      enabledChannels: ["123"],
      disabledChannels: ["456"],
    });
    expect(result.success).toBe(true);
  });
});
