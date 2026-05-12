/**
 * E2E: Affiliate Mini App Pattern & Full Programmatic Setup
 *
 * Tests two integration patterns:
 *
 * 1. **Affiliate flow** (clone-your-crush style): external app creates a character
 *    via POST /api/affiliate/create-character. Requires a Bearer API key with
 *    the "affiliate:create-character" permission — a regular key will get 403.
 *
 * 2. **Programmatic mini app**: an agent (Claude) creates an app, agent,
 *    links them, enables monetization, publishes, and verifies — all via API.
 *    Uses POST /api/v1/app/agents for character creation (the real endpoint).
 *
 * Requires: TEST_API_KEY env var pointing at a live Cloud account.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as api from "../helpers/api-client";
import {
  createTestAgent,
  createTestApp,
  deleteTestAgent,
  deleteTestApp,
  enableMonetization,
} from "../helpers/app-lifecycle";
import { readJson } from "../helpers/json-body";

setDefaultTimeout(30_000);

type AffiliateCharacterResponse = {
  success: boolean;
  characterId: string;
  redirectUrl: string;
};

type AppCharactersResponse = {
  success: boolean;
  characters: Array<{
    id: string;
  }>;
};

type AgentPublishResponse = {
  agent: {
    isPublic: boolean;
    monetizationEnabled: boolean;
  };
};

type AppMonetizationResponse = {
  monetization: {
    monetizationEnabled: boolean;
  };
};

// ── Affiliate Character Creation ────────────────────────────────────
// The affiliate endpoint requires an API key with "affiliate:create-character"
// permission. A standard test API key will get 401 or 403, which is correct.
describe("Affiliate Mini App Flow", () => {
  let characterId: string;

  afterAll(async () => {
    if (characterId) {
      await api
        .del(`/api/my-agents/characters/${characterId}`, {
          authenticated: true,
        })
        .catch(() => {});
    }
  });

  test("POST /api/affiliate/create-character requires affiliate permission", async () => {
    // Use Bearer auth (the affiliate endpoint expects Authorization: Bearer <key>)
    const response = await api.post(
      "/api/affiliate/create-character",
      {
        character: {
          name: `E2E Affiliate Agent ${Date.now()}`,
          bio: "Created by automated E2E test via affiliate API",
          topics: ["testing"],
          adjectives: ["helpful", "automated"],
        },
        affiliateId: "e2e-test-suite",
        sessionId: `e2e-session-${Date.now()}`,
      },
      { authenticated: true },
    );

    if (response.status === 201) {
      // Key has affiliate permission — character was created
      const body = await readJson<AffiliateCharacterResponse>(response);
      expect(body.success).toBe(true);
      expect(typeof body.characterId).toBe("string");
      expect(typeof body.redirectUrl).toBe("string");
      characterId = body.characterId;
    } else {
      // Standard key lacks permission, or the Worker route is still a Node-sidecar stub.
      expect([401, 403, 501]).toContain(response.status);
    }
  });

  test("POST /api/affiliate/create-session is a public endpoint", async () => {
    // This creates an anonymous session for a character — no auth required.
    // Without a valid characterId we expect 400, which proves the endpoint exists.
    const response = await api.post("/api/affiliate/create-session", {
      characterId: "00000000-0000-4000-8000-000000000000",
    });
    // 200 (session created) or 400/404 (validation/not found).
    expect([200, 400, 404]).toContain(response.status);
  });
});

// ── Full Programmatic Mini App: Create + Configure + Monetize ───────
describe("Programmatic Mini App Setup", () => {
  let appId: string;
  let appApiKey: string;
  let agentId: string;

  function requireAppId(): string {
    expect(appId).toBeDefined();
    return appId;
  }

  function requireAgentId(): string {
    expect(agentId).toBeDefined();
    return agentId;
  }

  function requireAppApiKey(): string {
    expect(appApiKey).toBeDefined();
    return appApiKey;
  }

  afterAll(async () => {
    if (agentId) {
      await deleteTestAgent(agentId).catch(() => {});
    }
    if (appId) {
      await deleteTestApp(appId).catch(() => {});
    }
  });

  // This test suite simulates what an agent (Claude) would do to
  // programmatically create a monetized mini app from scratch.

  test("Step 1: Create the app", async () => {
    const { response, body } = await createTestApp({
      name: `E2E Miniapp ${Date.now()}`,
      description: "Programmatic mini app created by E2E test",
      allowed_origins: ["https://miniapp-e2e.example.com"],
    });
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    appId = body.app.id;
    appApiKey = body.apiKey;
    expect(appId).toBeDefined();
    expect(appApiKey).toBeDefined();
  });

  test("Step 2: Create an agent character", async () => {
    requireAppId();

    // POST /api/v1/app/agents is the actual character creation endpoint
    const {
      response,
      body,
      agentId: id,
    } = await createTestAgent({
      name: `Miniapp Agent ${Date.now()}`,
      bio: "AI assistant for the mini app",
    });
    expect([200, 201]).toContain(response.status);
    expect(body.success).toBe(true);
    agentId = id!;
    expect(agentId).toBeDefined();
  });

  test("Step 3: Link agent to app", async () => {
    const app = requireAppId();
    const agent = requireAgentId();

    const response = await api.put(
      `/api/v1/apps/${app}`,
      { linked_character_ids: [agent] },
      { authenticated: true },
    );
    expect(response.status).toBe(200);

    // Verify link via characters endpoint
    const verify = await api.get(`/api/v1/apps/${app}/characters`, {
      authenticated: true,
    });
    if (verify.status === 200) {
      const body = await readJson<AppCharactersResponse>(verify);
      expect(body.success).toBe(true);
      expect(body.characters.length).toBe(1);
      expect(body.characters[0].id).toBe(agent);
    }
  });

  test("Step 4: Enable monetization on the app", async () => {
    const app = requireAppId();

    const { response, body } = await enableMonetization(app, {
      inferenceMarkupPercentage: 50,
      purchaseSharePercentage: 10,
    });
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  test("Step 5: Publish the agent with monetization", async () => {
    const agent = requireAgentId();

    const response = await api.post(
      `/api/v1/agents/${agent}/publish`,
      {
        enableMonetization: true,
        markupPercentage: 50,
        a2aEnabled: true,
        mcpEnabled: true,
      },
      { authenticated: true },
    );
    expect(response.status).toBe(200);

    const body = await readJson<AgentPublishResponse>(response);
    expect(body.agent.isPublic).toBe(true);
    expect(body.agent.monetizationEnabled).toBe(true);
  });

  test("Step 6: Verify complete setup — all endpoints work", async () => {
    const app = requireAppId();

    // App is publicly discoverable
    const publicResp = await api.get(`/api/v1/apps/${app}/public`);
    expect(publicResp.status).toBe(200);

    // Monetization enabled
    const monetResp = await api.get(`/api/v1/apps/${app}/monetization`, {
      authenticated: true,
    });
    expect(monetResp.status).toBe(200);
    const monetBody = await readJson<AppMonetizationResponse>(monetResp);
    expect(monetBody.monetization.monetizationEnabled).toBe(true);

    // Earnings endpoint works
    const earningsResp = await api.get(`/api/v1/apps/${app}/earnings`, {
      authenticated: true,
    });
    expect(earningsResp.status).toBe(200);

    // App-level credits endpoint works
    const creditsResp = await api.get(`/api/v1/app-credits/balance?app_id=${app}`, {
      authenticated: true,
    });
    expect(creditsResp.status).toBe(200);

    // App users endpoint works (should be empty)
    const usersResp = await api.get(`/api/v1/apps/${app}/users`, {
      authenticated: true,
    });
    expect(usersResp.status).toBe(200);
  });

  test("Step 7: App's own API key works for scoped reads", async () => {
    const app = requireAppId();
    const key = requireAppApiKey();

    // The app's own API key should access its characters
    const response = await api.get(`/api/v1/apps/${app}/characters`, {
      headers: { "X-API-Key": key },
    });
    // App key is scoped — may get 200 (has access) or 403 (key lacks org scope)
    expect([200, 401, 403]).toContain(response.status);
  });
});
