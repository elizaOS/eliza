/**
 * E2E: Agent Publishing with Monetization
 *
 * Tests the agent publish/unpublish flow including monetization
 * settings and protocol endpoint (A2A, MCP) generation.
 *
 * Character creation uses POST /api/v1/app/agents (the actual endpoint).
 * NOT /api/my-agents/characters which is GET-only.
 *
 * Requires: TEST_API_KEY env var pointing at a live Cloud account.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as api from "../helpers/api-client";
import { createTestAgent, deleteTestAgent } from "../helpers/app-lifecycle";
import { readJson } from "../helpers/json-body";
import { NONEXISTENT_UUID } from "../helpers/test-data";

setDefaultTimeout(30_000);

type PublishedAgent = {
  isPublic: boolean;
  monetizationEnabled?: boolean;
  markupPercentage?: number;
  a2aEnabled?: boolean;
  mcpEnabled?: boolean;
  a2aEndpoint?: string;
  mcpEndpoint?: string;
};

type PublishAgentResponse = {
  success?: boolean;
  agent: PublishedAgent;
};

type AgentMonetizationResponse = {
  success?: boolean;
  monetization: {
    enabled: boolean;
    markupPercentage: number;
    isPublic: boolean;
  };
};

describe("Agent Publishing", () => {
  let agentId: string;

  function requireAgentId(): string {
    expect(agentId).toBeDefined();
    return agentId;
  }

  beforeAll(async () => {
    const { response, agentId: id } = await createTestAgent();
    if (response.status === 201 || response.status === 200) {
      agentId = id!;
    }
  });

  afterAll(async () => {
    if (agentId) {
      await deleteTestAgent(agentId).catch(() => {});
    }
  });

  // ── Create agent verification ───────────────────────────────────
  test("POST /api/v1/app/agents creates a character", async () => {
    expect(agentId).toBeDefined();
    expect(typeof agentId).toBe("string");
  });

  // ── Publish agent ───────────────────────────────────────────────
  test("POST /api/v1/agents/[id]/publish publishes agent", async () => {
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

    const body = await readJson<PublishAgentResponse>(response);
    expect(body.success).toBe(true);
    expect(body.agent).toBeDefined();
    expect(body.agent.isPublic).toBe(true);
    expect(body.agent.monetizationEnabled).toBe(true);
    expect(body.agent.markupPercentage).toBe(50);
    expect(body.agent.a2aEnabled).toBe(true);
    expect(body.agent.mcpEnabled).toBe(true);

    // Protocol endpoints should be returned
    expect(typeof body.agent.a2aEndpoint).toBe("string");
    expect(typeof body.agent.mcpEndpoint).toBe("string");
  });

  // ── Re-publish is idempotent ────────────────────────────────────
  test("re-publishing an already public agent returns 200", async () => {
    const agent = requireAgentId();

    const response = await api.post(
      `/api/v1/agents/${agent}/publish`,
      { enableMonetization: true, markupPercentage: 75 },
      { authenticated: true },
    );
    expect(response.status).toBe(200);
  });

  // ── Get monetization settings ───────────────────────────────────
  test("GET /api/v1/agents/[id]/monetization returns settings", async () => {
    const agent = requireAgentId();

    const response = await api.get(`/api/v1/agents/${agent}/monetization`, {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<AgentMonetizationResponse>(response);
    expect(body.success).toBe(true);
    expect(body.monetization).toBeDefined();
    expect(typeof body.monetization.enabled).toBe("boolean");
    expect(typeof body.monetization.markupPercentage).toBe("number");
    expect(typeof body.monetization.isPublic).toBe("boolean");
    expect(body.monetization.isPublic).toBe(true);
  });

  // ── Update monetization settings ────────────────────────────────
  test("PUT /api/v1/agents/[id]/monetization updates settings", async () => {
    const agent = requireAgentId();

    const response = await api.put(
      `/api/v1/agents/${agent}/monetization`,
      {
        monetizationEnabled: true,
        markupPercentage: 100,
        payoutWalletAddress: "0x0000000000000000000000000000000000000000",
      },
      { authenticated: true },
    );
    expect(response.status).toBe(200);

    const body = await readJson<AgentMonetizationResponse>(response);
    expect(body.success).toBe(true);
    expect(body.monetization.markupPercentage).toBe(100);
  });

  // ── Unpublish agent ─────────────────────────────────────────────
  test("DELETE /api/v1/agents/[id]/publish unpublishes agent", async () => {
    const agent = requireAgentId();

    const response = await api.del(`/api/v1/agents/${agent}/publish`, {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<PublishAgentResponse>(response);
    expect(body.success).toBe(true);
    expect(body.agent.isPublic).toBe(false);
  });

  // ── Monetization disabled after unpublish ───────────────────────
  test("monetization disabled after unpublish", async () => {
    const agent = requireAgentId();

    const response = await api.get(`/api/v1/agents/${agent}/monetization`, {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<AgentMonetizationResponse>(response);
    expect(body.monetization.enabled).toBe(false);
    expect(body.monetization.isPublic).toBe(false);
  });

  // ── Re-publish after unpublish ──────────────────────────────────
  test("agent can be re-published after unpublish", async () => {
    const agent = requireAgentId();

    const response = await api.post(
      `/api/v1/agents/${agent}/publish`,
      { enableMonetization: false },
      { authenticated: true },
    );
    expect(response.status).toBe(200);

    const body = await readJson<PublishAgentResponse>(response);
    expect(body.agent.isPublic).toBe(true);
    // Monetization should be off since we set enableMonetization: false
    expect(body.agent.monetizationEnabled).toBe(false);
  });
});

// ── Error cases ─────────────────────────────────────────────────────
describe("Agent Publishing — Error Cases", () => {
  test("publish nonexistent agent returns 404", async () => {
    const response = await api.post(
      `/api/v1/agents/${NONEXISTENT_UUID}/publish`,
      {},
      { authenticated: true },
    );
    expect([403, 404]).toContain(response.status);
  });

  test("publish requires auth", async () => {
    const response = await api.post(`/api/v1/agents/${NONEXISTENT_UUID}/publish`, {});
    expect([401, 403]).toContain(response.status);
  });

  test("monetization on nonexistent agent returns error", async () => {
    const response = await api.get(`/api/v1/agents/${NONEXISTENT_UUID}/monetization`, {
      authenticated: true,
    });
    expect([403, 404]).toContain(response.status);
  });

  test("POST /api/v1/app/agents validates name", async () => {
    const response = await api.post("/api/v1/app/agents", { name: "" }, { authenticated: true });
    expect(response.status).toBe(400);
  });

  test("POST /api/v1/app/agents requires auth", async () => {
    const response = await api.post("/api/v1/app/agents", { name: "Test" });
    expect([401, 403]).toContain(response.status);
  });
});
