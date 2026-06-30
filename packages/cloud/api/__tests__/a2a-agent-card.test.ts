/**
 * Unit tests for `generateAgentCard` in `agents/[id]/a2a/route.ts`.
 *
 * The agent card is the public A2A discovery document. The function is pure
 * input → output, so we can verify monetization-conditional fields and bio
 * coercion without standing up a Worker.
 */

import { describe, expect, test } from "bun:test";

import type { UserCharacter } from "@/db/repositories/characters";

import { generateAgentCard } from "../agents/[id]/a2a/route";

function buildCharacter(overrides: Partial<UserCharacter> = {}): UserCharacter {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    organization_id: "00000000-0000-0000-0000-000000000002",
    user_id: "00000000-0000-0000-0000-000000000003",
    name: "Test Agent",
    username: null,
    system: null,
    bio: "I help with things.",
    message_examples: [],
    post_examples: [],
    topics: [],
    adjectives: [],
    knowledge: [],
    plugins: [],
    settings: {},
    secrets: {},
    style: {},
    character_data: {},
    is_template: false,
    is_public: true,
    avatar_url: null,
    category: null,
    tags: [],
    featured: false,
    view_count: 0,
    interaction_count: 0,
    popularity_score: 0,
    source: "cloud",
    token_address: null,
    token_chain: null,
    token_name: null,
    token_ticker: null,
    erc8004_registered: false,
    erc8004_network: null,
    erc8004_agent_id: null,
    erc8004_agent_uri: null,
    erc8004_tx_hash: null,
    erc8004_registered_at: null,
    monetization_enabled: false,
    inference_markup_percentage: "0.00",
    payout_wallet_address: null,
    total_inference_requests: 0,
    total_creator_earnings: "0.0000",
    total_platform_revenue: "0.0000",
    a2a_enabled: true,
    mcp_enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

const BASE_URL = "https://www.elizacloud.ai";

describe("generateAgentCard", () => {
  test("joins an array bio with newlines", () => {
    const character = buildCharacter({
      bio: ["First line.", "Second line."],
    });
    const card = generateAgentCard(character, BASE_URL);
    expect(card.description).toBe("First line.\nSecond line.");
  });

  test("uses string bio as-is", () => {
    const character = buildCharacter({ bio: "Hi there." });
    const card = generateAgentCard(character, BASE_URL);
    expect(card.description).toBe("Hi there.");
  });

  test("falls back to default avatar when none is set", () => {
    const card = generateAgentCard(buildCharacter(), BASE_URL);
    expect(card.image).toBe(`${BASE_URL}/default-avatar.png`);
  });

  test("uses the character avatar when set", () => {
    const card = generateAgentCard(
      buildCharacter({ avatar_url: "https://cdn.example.com/me.png" }),
      BASE_URL,
    );
    expect(card.image).toBe("https://cdn.example.com/me.png");
  });

  test("omits markupPercentage when monetization is disabled", () => {
    const card = generateAgentCard(
      buildCharacter({
        monetization_enabled: false,
        inference_markup_percentage: "25.00",
      }),
      BASE_URL,
    );
    for (const skill of card.skills) {
      expect(skill.pricing).not.toHaveProperty("markupPercentage");
    }
  });

  test("omits markupPercentage when markup is 0 even if monetization is enabled", () => {
    const card = generateAgentCard(
      buildCharacter({
        monetization_enabled: true,
        inference_markup_percentage: "0.00",
      }),
      BASE_URL,
    );
    for (const skill of card.skills) {
      expect(skill.pricing).not.toHaveProperty("markupPercentage");
    }
  });

  test("includes markupPercentage on every skill when monetized", () => {
    const card = generateAgentCard(
      buildCharacter({
        monetization_enabled: true,
        inference_markup_percentage: "40.00",
      }),
      BASE_URL,
    );
    expect(card.skills.length).toBeGreaterThanOrEqual(2);
    for (const skill of card.skills) {
      // The TypeScript type widens the union; assert on the runtime shape.
      const pricing = skill.pricing as { markupPercentage?: number };
      expect(pricing.markupPercentage).toBe(40);
    }
  });

  test("does NOT expose internal creator/org ids on the public card; has a single bearer auth scheme", () => {
    const character = buildCharacter({
      user_id: "11111111-1111-1111-1111-111111111111",
      organization_id: "22222222-2222-2222-2222-222222222222",
    });
    const card = generateAgentCard(character, BASE_URL);
    // SECURITY: this card is served unauthenticated (CORS *, cached). It must
    // NOT leak the creator's internal user_id/organization_id (deanonymization).
    expect((card as Record<string, unknown>).contact).toBeUndefined();
    expect(card.authentication.schemes).toHaveLength(1);
    expect(card.authentication.schemes[0]?.scheme).toBe("bearer");
  });
});
