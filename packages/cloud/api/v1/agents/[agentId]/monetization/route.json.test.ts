/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const AGENT_ID = "00000000-0000-4000-8000-0000000000cc";
const agent = {
  id: AGENT_ID,
  user_id: "user-1",
  organization_id: "org-1",
  monetization_enabled: false,
  inference_markup_percentage: 10,
  payout_wallet_address: null,
  is_public: false,
};

const updateSettings = mock(async () => ({ success: true }));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/services/agent-monetization", () => ({
  agentMonetizationService: {
    getAgentMonetization: async () => null,
    updateSettings,
  },
}));

mock.module("@/lib/services/characters/characters", () => ({
  charactersService: {
    getById: async () => agent,
    invalidateCache: async () => undefined,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:agentId", route);

describe("PUT /api/v1/agents/:agentId/monetization malformed JSON", () => {
  test("returns 400 instead of 500 and never updates settings", async () => {
    const response = await app.request(`/${AGENT_ID}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  test("canonical JSON still updates settings", async () => {
    const response = await app.request(`/${AGENT_ID}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markupPercentage: 10 }),
    });
    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalled();
  });
});
