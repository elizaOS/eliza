/**
 * Cross-tenant IDOR regression for POST /api/my-agents/characters/:id/clone
 * (#10554, finding 1).
 *
 * `charactersService.getById` is NOT org/visibility-scoped, so the route must
 * gate clonability: a caller may clone a character only if they own it, or it is
 * public/template. Cloning another org's PRIVATE character would copy back its
 * system prompt / knowledge / settings (cross-tenant IP disclosure), so that
 * case must 404 (a 404, not 403, to avoid an existence oracle). These tests drive
 * the REAL route handler; only the data/auth boundaries are mocked.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import type { UserCharacter } from "@/db/repositories/characters";

const CALLER_ID = "00000000-0000-0000-0000-0000000000c1";
const OTHER_OWNER_ID = "00000000-0000-0000-0000-0000000000ff";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: CALLER_ID,
  organization_id: "00000000-0000-0000-0000-0000000000a1",
}));
const getById = mock(async (): Promise<UserCharacter | undefined> => undefined);
const create = mock(async (input: Record<string, unknown>) => ({
  ...buildCharacter(),
  id: "00000000-0000-0000-0000-0000000000cc",
  username: "clone-1",
  ...input,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: { getById, create },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

function buildCharacter(overrides: Partial<UserCharacter> = {}): UserCharacter {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    organization_id: "00000000-0000-0000-0000-0000000000b9",
    user_id: OTHER_OWNER_ID,
    name: "Private Agent",
    username: "private-agent",
    system: "PROPRIETARY SYSTEM PROMPT — do not leak.",
    bio: "I am a private agent.",
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
    is_public: false,
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

const { default: cloneRoute } = await import("./route");

const app = new Hono();
app.route("/characters/:id/clone", cloneRoute);

async function postClone(characterId: string): Promise<Response> {
  return app.fetch(
    new Request(`https://api.example.test/characters/${characterId}/clone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-Key": "test-key",
      },
      body: JSON.stringify({}),
    }),
  );
}

describe("clone character route — cross-tenant IDOR guard", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    getById.mockClear();
    create.mockClear();
  });

  test("404s when cloning another org's PRIVATE character (IDOR closed)", async () => {
    getById.mockResolvedValueOnce(
      buildCharacter({
        user_id: OTHER_OWNER_ID,
        is_public: false,
        is_template: false,
      }),
    );

    const response = await postClone("00000000-0000-0000-0000-000000000001");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Character not found",
    });
    // Critically: the private config is never copied into the caller's namespace.
    expect(create).not.toHaveBeenCalled();
  });

  test("404s when the character does not exist", async () => {
    getById.mockResolvedValueOnce(undefined);

    const response = await postClone("00000000-0000-0000-0000-000000000001");

    expect(response.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  test("clones a PUBLIC character owned by another org", async () => {
    getById.mockResolvedValueOnce(
      buildCharacter({
        user_id: OTHER_OWNER_ID,
        is_public: true,
        is_template: false,
      }),
    );

    const response = await postClone("00000000-0000-0000-0000-000000000001");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: CALLER_ID }),
    );
  });

  test("clones a TEMPLATE character owned by another org", async () => {
    getById.mockResolvedValueOnce(
      buildCharacter({
        user_id: OTHER_OWNER_ID,
        is_public: false,
        is_template: true,
      }),
    );

    const response = await postClone("00000000-0000-0000-0000-000000000001");

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("clones the caller's OWN private character", async () => {
    getById.mockResolvedValueOnce(
      buildCharacter({
        user_id: CALLER_ID,
        is_public: false,
        is_template: false,
      }),
    );

    const response = await postClone("00000000-0000-0000-0000-000000000001");

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: CALLER_ID }),
    );
  });
});
