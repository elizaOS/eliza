/**
 * Tests for v1/agents provisionSchema input hygiene (max-length constraints).
 *
 * Validates that oversized token fields are rejected at the schema level
 * before reaching any service logic.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

// Re-define the schema inline (mirrors app/api/v1/agents/route.ts) to avoid
// importing the route module which has heavy service dependencies.
const provisionSchema = z.object({
  tokenContractAddress: z.string().min(1).max(256),
  chain: z.string().min(1).max(50),
  chainId: z.number().int().positive(),
  tokenName: z.string().min(1).max(200),
  tokenTicker: z.string().min(1).max(30),
  launchType: z.enum(["native", "imported"]),
  character: z
    .object({
      name: z.string().min(1).max(200),
      bio: z.string().max(5000).optional(),
      avatar: z.string().url().max(2048).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  billing: z
    .object({
      mode: z.enum(["owner_credits", "waifu_treasury_subsidy", "hybrid"]),
      initialReserveUsd: z.number().nonnegative().optional(),
    })
    .optional(),
  webhookUrl: z.string().url().max(2048).optional(),
});

function validPayload() {
  return {
    tokenContractAddress: "0x" + "a".repeat(40),
    chain: "base",
    chainId: 8453,
    tokenName: "Test Token",
    tokenTicker: "TEST",
    launchType: "native" as const,
  };
}

describe("v1/agents provisionSchema max-length constraints", () => {
  test("accepts valid minimal payload", () => {
    expect(provisionSchema.safeParse(validPayload()).success).toBe(true);
  });

  test("accepts valid payload with all optional fields", () => {
    const full = {
      ...validPayload(),
      character: {
        name: "Agent Zero",
        bio: "A helpful agent.",
        avatar: "https://example.com/avatar.png",
        config: { mode: "turbo" },
      },
      billing: { mode: "hybrid" as const, initialReserveUsd: 10 },
      webhookUrl: "https://hooks.example.com/cb",
    };
    expect(provisionSchema.safeParse(full).success).toBe(true);
  });

  test("rejects tokenContractAddress > 256 chars", () => {
    const result = provisionSchema.safeParse({
      ...validPayload(),
      tokenContractAddress: "0x" + "a".repeat(300),
    });
    expect(result.success).toBe(false);
  });

  test("rejects chain > 50 chars", () => {
    const result = provisionSchema.safeParse({
      ...validPayload(),
      chain: "x".repeat(51),
    });
    expect(result.success).toBe(false);
  });

  test("rejects tokenName > 200 chars", () => {
    const result = provisionSchema.safeParse({
      ...validPayload(),
      tokenName: "T".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  test("rejects tokenTicker > 30 chars", () => {
    const result = provisionSchema.safeParse({
      ...validPayload(),
      tokenTicker: "T".repeat(31),
    });
    expect(result.success).toBe(false);
  });

  test("rejects character.name > 200 chars", () => {
    const result = provisionSchema.safeParse({
      ...validPayload(),
      character: { name: "N".repeat(201) },
    });
    expect(result.success).toBe(false);
  });

  test("rejects character.bio > 5000 chars", () => {
    const result = provisionSchema.safeParse({
      ...validPayload(),
      character: { name: "Agent", bio: "B".repeat(5001) },
    });
    expect(result.success).toBe(false);
  });

  test("accepts character.bio at exactly 5000 chars", () => {
    const result = provisionSchema.safeParse({
      ...validPayload(),
      character: { name: "Agent", bio: "B".repeat(5000) },
    });
    expect(result.success).toBe(true);
  });

  test("rejects character.avatar that is not a URL", () => {
    const result = provisionSchema.safeParse({
      ...validPayload(),
      character: { name: "Agent", avatar: "not-a-url" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects webhookUrl > 2048 chars", () => {
    const result = provisionSchema.safeParse({
      ...validPayload(),
      webhookUrl: "https://example.com/" + "a".repeat(2048),
    });
    expect(result.success).toBe(false);
  });

  test("accepts Solana-length address (44 chars base58)", () => {
    const result = provisionSchema.safeParse({
      ...validPayload(),
      tokenContractAddress: "So11111111111111111111111111111111111111112",
    });
    expect(result.success).toBe(true);
  });

  test("accepts EVM-length address (42 chars hex)", () => {
    const result = provisionSchema.safeParse({
      ...validPayload(),
      tokenContractAddress: "0x" + "a".repeat(40),
    });
    expect(result.success).toBe(true);
  });
});
