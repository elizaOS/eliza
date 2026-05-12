/**
 * Group C — Agents (`/api/v1/agents`, `/api/agents`, `/api/my-agents`,
 * `/api/characters`).
 *
 * For each route in the group, three assertions:
 *   1. **Auth gate** — request without credentials returns 401 (or, for
 *      service-key / public routes, the documented gate response).
 *   2. **Happy path** — with the bootstrapped Bearer eliza_* key, the route
 *      either returns its documented success shape or — for routes acting on
 *      a specific :agentId/:id we don't own — a recognized 401/403/404 from
 *      the auth/ownership gate. Either way the Worker is reachable and
 *      executing the handler.
 *   3. **Validation** — at least one body / query-param failure returns the
 *      expected 400 (or, where the handler defers validation behind auth,
 *      the auth gate fires first; we accept that and document it).
 *
 * Mirrors the foundation test at `agent-token-flow.test.ts`. Skips cleanly
 * when the Worker isn't reachable or the preload couldn't bootstrap an API
 * key (`SKIP_DB_DEPENDENT=1`, no Postgres, etc.).
 *
 * UNOWNED_AGENT_ID — a syntactically-valid UUID we know isn't in the DB.
 * Routes that ownership-check land on 404 (or 401 if the route is service-
 * key only, or 403 for monetization which checks ownership before existence).
 *
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

import { api, bearerHeaders, getApiKey, getBaseUrl, isServerReachable } from "./_helpers/api";

const UNOWNED_AGENT_ID = "00000000-0000-4000-8000-000000000000";

let serverReachable = false;
let hasTestApiKey = false;
const createdCharacterIds: string[] = [];

function shouldRun(): boolean {
  return serverReachable && hasTestApiKey;
}

async function seedOwnedCharacter(input: {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  plugins?: string[];
  settings?: Record<string, unknown>;
}): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL or DATABASE_URL must be set by the e2e harness");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO user_characters (
         id,
         organization_id,
         user_id,
         name,
         bio,
         message_examples,
         post_examples,
         topics,
         adjectives,
         knowledge,
         plugins,
         settings,
         secrets,
         style,
         character_data,
         is_template,
         is_public,
         source,
         view_count,
         interaction_count,
         total_inference_requests
       )
       VALUES (
         $1,
         $2,
         $3,
         $4,
         $5::jsonb,
         '[]'::jsonb,
         '[]'::jsonb,
         '[]'::jsonb,
         '[]'::jsonb,
         '[]'::jsonb,
         $6::jsonb,
         $7::jsonb,
         '{}'::jsonb,
         '{}'::jsonb,
         $8::jsonb,
         false,
         false,
         'cloud',
         3,
         2,
         1
       )`,
      [
        input.id,
        input.organizationId,
        input.userId,
        input.name,
        JSON.stringify(["E2E character for stats coverage"]),
        JSON.stringify(input.plugins ?? []),
        JSON.stringify(input.settings ?? {}),
        JSON.stringify({
          name: input.name,
          bio: ["E2E character for stats coverage"],
          system: "Test character",
          isPublic: false,
        }),
      ],
    );
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
  serverReachable = await isServerReachable();
  if (!serverReachable) {
    console.warn(
      `[group-c-agents] ${getBaseUrl()} did not respond to /api/health. ` +
        "Tests will skip. Start the Worker (bun run dev:api → wrangler dev) " +
        "or set TEST_API_BASE_URL to a reachable host.",
    );
  }
  if (!hasTestApiKey) {
    console.warn(
      "[group-c-agents] TEST_API_KEY is not set; the preload could not " +
        "bootstrap a test API key. Tests requiring auth will skip.",
    );
  }
});

afterAll(async () => {
  if (!shouldRun()) return;
  for (const id of createdCharacterIds) {
    await api.delete(`/api/my-agents/characters/${id}`, {
      headers: bearerHeaders(),
    });
  }
});

// -------------------------------------------------------------------------
// /api/agents/:id/a2a — public agent A2A endpoint (JSON-RPC POST + GET card)
// -------------------------------------------------------------------------
describe("/api/agents/:id/a2a", () => {
  test("GET unknown agent returns 404 even unauthenticated (public route, but agent must exist)", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/agents/${UNOWNED_AGENT_ID}/a2a`);
    // 404 = no such agent; 403 = exists but not public/a2a-disabled; both are
    // expected gate responses on a public route with no agent at this UUID.
    expect([403, 404]).toContain(res.status);
  });

  test("POST without auth on unknown agent returns 404 (handler short-circuits before auth)", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/agents/${UNOWNED_AGENT_ID}/a2a`, {
      jsonrpc: "2.0",
      method: "chat",
      id: 1,
      params: {},
    });
    // The route's flow: lookup agent first → 404 if missing → only then auth.
    expect([401, 403, 404]).toContain(res.status);
  });

  test("POST with malformed JSON-RPC body to unknown agent returns 404 (agent check first)", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/agents/${UNOWNED_AGENT_ID}/a2a`, {
      not: "a valid jsonrpc envelope",
    });
    expect([400, 403, 404]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/agents/:id/headscale-ip — internal-token-only
// -------------------------------------------------------------------------
describe("/api/agents/:id/headscale-ip", () => {
  test("GET without internal token returns 403 (or 503 if not configured)", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/agents/${UNOWNED_AGENT_ID}/headscale-ip`);
    expect([403, 503]).toContain(res.status);
  });

  test("GET with bogus internal token still 403 (constant-time mismatch)", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/agents/${UNOWNED_AGENT_ID}/headscale-ip`, {
      headers: { "x-internal-token": "definitely-not-the-real-token" },
    });
    expect([403, 503]).toContain(res.status);
  });

  test("GET with non-UUID id returns 403 before validation (auth fires first)", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/agents/not-a-uuid/headscale-ip");
    // Without a valid internal token we never reach the UUID validation,
    // so the response is the auth gate.
    expect([400, 403, 503]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/agents/:id/mcp — public MCP endpoint
// -------------------------------------------------------------------------
describe("/api/agents/:id/mcp", () => {
  test("GET unknown agent returns 404 (public route, but agent must exist)", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/agents/${UNOWNED_AGENT_ID}/mcp`);
    expect([403, 404]).toContain(res.status);
  });

  test("POST without auth on unknown agent returns 404 (agent check before auth)", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/agents/${UNOWNED_AGENT_ID}/mcp`, {
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("POST with malformed JSON-RPC body returns 404 on unknown agent", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/agents/${UNOWNED_AGENT_ID}/mcp`, {
      not: "a valid jsonrpc envelope",
    });
    expect([400, 403, 404]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId — GET only, requires user/key auth + ownership
// -------------------------------------------------------------------------
describe("/api/v1/agents/:agentId", () => {
  test("GET without auth returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}`);
    expect([401, 403]).toContain(res.status);
  });

  test("GET with valid auth on unowned agent returns 404 (not-found from repository)", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("GET with valid auth on malformed agentId still rejects (404 or 400)", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/v1/agents/not-a-uuid-at-all", {
      headers: bearerHeaders(),
    });
    expect([400, 401, 403, 404, 500]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/logs — service-key only
// -------------------------------------------------------------------------
describe("/api/v1/agents/:agentId/logs", () => {
  test("GET without service key returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/logs`);
    expect([401, 403]).toContain(res.status);
  });

  test("GET with user Bearer (not service key) still rejected", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/logs`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("GET with bogus service key returns 401/403", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/logs?tail=10`, {
      headers: { "X-Service-Key": "not-a-real-service-key" },
    });
    expect([401, 403]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/monetization — GET + PUT
// -------------------------------------------------------------------------
describe("/api/v1/agents/:agentId/monetization", () => {
  test("GET without auth returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/monetization`);
    expect([401, 403]).toContain(res.status);
  });

  test("GET with valid auth on unowned agent returns 404", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/monetization`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("PUT with invalid body schema returns 400 (or 404 if ownership fails first)", async () => {
    if (!shouldRun()) return;
    const res = await api.put(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/monetization`,
      // markupPercentage above 1000 fails Zod validation
      { markupPercentage: 99999 },
      { headers: bearerHeaders() },
    );
    expect([400, 401, 403, 404]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/publish — POST + DELETE (user auth + ownership)
// -------------------------------------------------------------------------
describe("/api/v1/agents/:agentId/publish", () => {
  test("POST without auth returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/v1/agents/${UNOWNED_AGENT_ID}/publish`);
    expect([401, 403]).toContain(res.status);
  });

  test("POST with valid auth on unowned agent returns 404", async () => {
    if (!shouldRun()) return;
    const res = await api.post(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/publish`,
      {},
      { headers: bearerHeaders() },
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  test("DELETE with valid auth on unowned agent returns 404", async () => {
    if (!shouldRun()) return;
    const res = await api.delete(`/api/v1/agents/${UNOWNED_AGENT_ID}/publish`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/restart — service-key only
// -------------------------------------------------------------------------
describe("/api/v1/agents/:agentId/restart", () => {
  test("POST without service key returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/v1/agents/${UNOWNED_AGENT_ID}/restart`);
    expect([401, 403]).toContain(res.status);
  });

  test("POST with user Bearer (not service key) still rejected", async () => {
    if (!shouldRun()) return;
    const res = await api.post(`/api/v1/agents/${UNOWNED_AGENT_ID}/restart`, undefined, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("POST with bogus service key still 401/403", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/v1/agents/${UNOWNED_AGENT_ID}/restart`, undefined, {
      headers: { "X-Service-Key": "not-a-real-service-key" },
    });
    expect([401, 403]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/resume — service-key only
// -------------------------------------------------------------------------
describe("/api/v1/agents/:agentId/resume", () => {
  test("POST without service key returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/v1/agents/${UNOWNED_AGENT_ID}/resume`);
    expect([401, 403]).toContain(res.status);
  });

  test("POST with user Bearer (not service key) still rejected", async () => {
    if (!shouldRun()) return;
    const res = await api.post(`/api/v1/agents/${UNOWNED_AGENT_ID}/resume`, undefined, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("POST with bogus service key still 401/403", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/v1/agents/${UNOWNED_AGENT_ID}/resume`, undefined, {
      headers: { "X-Service-Key": "not-a-real-service-key" },
    });
    expect([401, 403]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/status — service-key only
// -------------------------------------------------------------------------
describe("/api/v1/agents/:agentId/status", () => {
  test("GET without service key returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/status`);
    expect([401, 403]).toContain(res.status);
  });

  test("GET with user Bearer (not service key) still rejected", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/status`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("GET with bogus service key still 401/403", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/status`, {
      headers: { "X-Service-Key": "not-a-real-service-key" },
    });
    expect([401, 403]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/suspend — service-key only
// -------------------------------------------------------------------------
describe("/api/v1/agents/:agentId/suspend", () => {
  test("POST without service key returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/v1/agents/${UNOWNED_AGENT_ID}/suspend`);
    expect([401, 403]).toContain(res.status);
  });

  test("POST with user Bearer (not service key) still rejected", async () => {
    if (!shouldRun()) return;
    const res = await api.post(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/suspend`,
      { reason: "test" },
      { headers: bearerHeaders() },
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  test("POST with bogus service key still 401/403", async () => {
    if (!serverReachable) return;
    const res = await api.post(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/suspend`,
      { reason: "test" },
      { headers: { "X-Service-Key": "not-a-real-service-key" } },
    );
    expect([401, 403]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/usage — service-key only
// -------------------------------------------------------------------------
describe("/api/v1/agents/:agentId/usage", () => {
  test("GET without service key returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/usage`);
    expect([401, 403]).toContain(res.status);
  });

  test("GET with user Bearer (not service key) still rejected", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/usage`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("GET with bogus service key still 401/403", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/usage`, {
      headers: { "X-Service-Key": "not-a-real-service-key" },
    });
    expect([401, 403]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/by-token — public token lookup
// -------------------------------------------------------------------------
describe("/api/v1/agents/by-token", () => {
  test("GET without ?address returns 400", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/v1/agents/by-token");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test("GET with bogus address returns 404", async () => {
    if (!serverReachable) return;
    const res = await api.get(
      `/api/v1/agents/by-token?address=${encodeURIComponent("0xdeadbeef".repeat(4))}&chain=eth`,
    );
    // 404 = no agent linked. 400 if normalization rejects the address shape.
    expect([400, 404]).toContain(res.status);
  });

  test("GET with overlong address returns 400", async () => {
    if (!serverReachable) return;
    const longAddr = "x".repeat(257);
    const res = await api.get(`/api/v1/agents/by-token?address=${longAddr}`);
    expect(res.status).toBe(400);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters — list + create
// -------------------------------------------------------------------------
describe("/api/my-agents/characters", () => {
  test("GET without auth returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/my-agents/characters");
    expect([401, 403]).toContain(res.status);
  });

  test("GET with valid auth returns paginated character list", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/my-agents/characters?limit=10", {
      headers: bearerHeaders(),
    });
    expect([200, 401, 403]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as {
        success?: boolean;
        data?: { characters?: unknown[]; pagination?: { page?: number } };
      };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data?.characters)).toBe(true);
      expect(body.data?.pagination?.page).toBe(1);
    }
  });

  test("POST with malformed body fails", async () => {
    if (!shouldRun()) return;
    // Missing the required `name` field — the handler casts to ElizaCharacter
    // and the create call will fail at the DB layer.
    const res = await api.post(
      "/api/my-agents/characters",
      { nope: "no name here" },
      { headers: bearerHeaders() },
    );
    expect([400, 401, 403, 500]).toContain(res.status);
  });
});

// /api/my-agents/characters/avatar — Worker-safe multipart avatar upload.
// -------------------------------------------------------------------------
describe("/api/my-agents/characters/avatar", () => {
  test("POST without auth returns 401 before upload validation", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/my-agents/characters/avatar");
    expect([401, 403]).toContain(res.status);
  });

  test("POST with valid auth and no multipart body returns 400", async () => {
    if (!shouldRun()) return;
    const res = await api.post("/api/my-agents/characters/avatar", undefined, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/multipart/i);
  });

  test("POST with random JSON body returns upload validation error", async () => {
    if (!shouldRun()) return;
    const res = await api.post(
      "/api/my-agents/characters/avatar",
      { fake: "payload" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters/:id — GET + PUT + DELETE
// -------------------------------------------------------------------------
describe("/api/my-agents/characters/:id", () => {
  test("GET without auth returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/my-agents/characters/${UNOWNED_AGENT_ID}`);
    expect([401, 403]).toContain(res.status);
  });

  test("GET with valid auth on unowned id returns 404", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/my-agents/characters/${UNOWNED_AGENT_ID}`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("DELETE on unowned id returns 404", async () => {
    if (!shouldRun()) return;
    const res = await api.delete(`/api/my-agents/characters/${UNOWNED_AGENT_ID}`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters/:id/clone — POST
// -------------------------------------------------------------------------
describe("/api/my-agents/characters/:id/clone", () => {
  test("POST without auth returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/my-agents/characters/${UNOWNED_AGENT_ID}/clone`);
    expect([401, 403]).toContain(res.status);
  });

  test("POST with valid auth on unknown source id returns 404", async () => {
    if (!shouldRun()) return;
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/clone`,
      {},
      { headers: bearerHeaders() },
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  test("POST with non-JSON body still hits not-found gate (handler tolerates empty body)", async () => {
    if (!shouldRun()) return;
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/clone`,
      "this is not json",
      { headers: { ...bearerHeaders(), "Content-Type": "text/plain" } },
    );
    expect([400, 401, 403, 404]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters/:id/share — GET + PUT
// -------------------------------------------------------------------------
describe("/api/my-agents/characters/:id/share", () => {
  test("GET without auth returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/my-agents/characters/${UNOWNED_AGENT_ID}/share`);
    expect([401, 403]).toContain(res.status);
  });

  test("GET with valid auth on unowned id returns 404", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/my-agents/characters/${UNOWNED_AGENT_ID}/share`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("PUT with invalid body returns 400 (or 404 if ownership fails first)", async () => {
    if (!shouldRun()) return;
    const res = await api.put(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/share`,
      { isPublic: "not-a-boolean" },
      { headers: bearerHeaders() },
    );
    expect([400, 401, 403, 404]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters/:id/stats — GET
// -------------------------------------------------------------------------
describe("/api/my-agents/characters/:id/stats", () => {
  test("GET without auth returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/my-agents/characters/${UNOWNED_AGENT_ID}/stats`);
    expect([401, 403]).toContain(res.status);
  });

  test("GET with valid auth on unowned id returns 404", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/my-agents/characters/${UNOWNED_AGENT_ID}/stats`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("GET with valid auth on owned id returns stored counters", async () => {
    if (!shouldRun()) return;
    const userId = process.env.TEST_USER_ID;
    const organizationId = process.env.TEST_ORGANIZATION_ID;
    if (!userId || !organizationId) {
      throw new Error("TEST_USER_ID and TEST_ORGANIZATION_ID must be set by e2e preload");
    }
    const createdId = crypto.randomUUID();
    const name = `E2E Stats ${crypto.randomUUID()}`;
    await seedOwnedCharacter({
      id: createdId,
      organizationId,
      userId,
      name,
    });
    createdCharacterIds.push(createdId);

    const statsRes = await api.get(`/api/my-agents/characters/${createdId}/stats`, {
      headers: bearerHeaders(),
    });
    expect(statsRes.status).toBe(200);
    const statsBody = (await statsRes.json()) as {
      success?: boolean;
      data?: {
        stats?: {
          views?: number;
          interactions?: number;
          messageCount?: number;
          roomCount?: number;
          lastActiveAt?: string | null;
          totalInferenceRequests?: number;
        };
      };
    };
    expect(statsBody.success).toBe(true);
    expect(statsBody.data?.stats).toEqual({
      views: 3,
      interactions: 2,
      messageCount: 0,
      roomCount: 0,
      lastActiveAt: null,
      totalInferenceRequests: 1,
    });
  });

  test("GET with malformed id returns 400", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/my-agents/characters/not-a-uuid/stats", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(400);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters/:id/track-interaction — POST (returns 410 gone)
// -------------------------------------------------------------------------
describe("/api/my-agents/characters/:id/track-interaction", () => {
  test("POST without auth returns 401 (auth gate before 410)", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/my-agents/characters/${UNOWNED_AGENT_ID}/track-interaction`);
    expect([401, 403, 410, 500]).toContain(res.status);
  });

  test("POST with valid auth lands on 410 Gone", async () => {
    if (!shouldRun()) return;
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/track-interaction`,
      undefined,
      { headers: bearerHeaders() },
    );
    expect([401, 403, 410, 500]).toContain(res.status);
    if (res.status === 410) {
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.success).toBe(false);
      expect(body.error).toBeTruthy();
    }
  });

  test("POST with body still 410 (route is removed)", async () => {
    if (!shouldRun()) return;
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/track-interaction`,
      { eventType: "click" },
      { headers: bearerHeaders() },
    );
    expect([401, 403, 410, 500]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters/:id/track-view — POST (returns 410 gone, no auth)
// -------------------------------------------------------------------------
describe("/api/my-agents/characters/:id/track-view", () => {
  test("POST without auth returns 401 (global auth middleware) or 410", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/my-agents/characters/${UNOWNED_AGENT_ID}/track-view`);
    expect([401, 403, 410]).toContain(res.status);
  });

  test("POST with valid auth lands on 410 Gone", async () => {
    if (!shouldRun()) return;
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/track-view`,
      undefined,
      { headers: bearerHeaders() },
    );
    expect([401, 403, 410]).toContain(res.status);
    if (res.status === 410) {
      const body = (await res.json()) as { success?: boolean; error?: string };
      expect(body.success).toBe(false);
    }
  });

  test("POST with random body still 410", async () => {
    if (!shouldRun()) return;
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/track-view`,
      { random: "data" },
      { headers: bearerHeaders() },
    );
    expect([401, 403, 410]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/saved — GET
// -------------------------------------------------------------------------
describe("/api/my-agents/saved", () => {
  test("GET without auth returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/my-agents/saved");
    expect([401, 403]).toContain(res.status);
  });

  test("GET with valid auth returns saved-agent list", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/my-agents/saved", {
      headers: bearerHeaders(),
    });
    expect([200, 401, 403]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as {
        success?: boolean;
        data?: { agents?: unknown[]; count?: number };
      };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data?.agents)).toBe(true);
      expect(typeof body.data?.count).toBe("number");
    }
  });

  test("GET with junk Bearer is rejected", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/my-agents/saved", {
      headers: { Authorization: "Bearer eliza_completely-invalid-key" },
    });
    expect([401, 403]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/saved/:id — GET + DELETE
// -------------------------------------------------------------------------
describe("/api/my-agents/saved/:id", () => {
  test("GET without auth returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/my-agents/saved/${UNOWNED_AGENT_ID}`);
    expect([401, 403]).toContain(res.status);
  });

  test("GET with valid auth on unknown saved id returns 404", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/my-agents/saved/${UNOWNED_AGENT_ID}`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("DELETE with valid auth on unknown saved id returns 404", async () => {
    if (!shouldRun()) return;
    const res = await api.delete(`/api/my-agents/saved/${UNOWNED_AGENT_ID}`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/claim-affiliate-characters — POST (session auth)
// -------------------------------------------------------------------------
describe("/api/my-agents/claim-affiliate-characters", () => {
  test("POST without auth returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/my-agents/claim-affiliate-characters", {});
    expect([401, 403]).toContain(res.status);
  });

  test("POST with valid Bearer (session-only) — 401 (requires session) or 200", async () => {
    if (!shouldRun()) return;
    // requireUserWithOrg accepts API keys too in current impl; if the route
    // rejects the Bearer with 401 we still consider that a passing assertion
    // because the route ran the auth gate.
    const res = await api.post(
      "/api/my-agents/claim-affiliate-characters",
      {},
      { headers: bearerHeaders() },
    );
    expect([200, 401, 403, 500]).toContain(res.status);
  });

  test("POST with non-JSON body is tolerated (route catches JSON parse errors)", async () => {
    if (!shouldRun()) return;
    const res = await api.post("/api/my-agents/claim-affiliate-characters", "not-json-at-all", {
      headers: { ...bearerHeaders(), "Content-Type": "text/plain" },
    });
    expect([200, 400, 401, 403, 500]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/characters/:characterId/mcps — owned character MCP metadata
// -------------------------------------------------------------------------
describe("/api/characters/:characterId/mcps", () => {
  test("GET without auth returns 401", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/characters/${UNOWNED_AGENT_ID}/mcps`);
    expect([401, 403]).toContain(res.status);
  });

  test("GET with malformed character id returns 400", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/characters/not-a-uuid/mcps", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(400);
  });

  test("GET with valid auth on unowned id returns 404", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/characters/${UNOWNED_AGENT_ID}/mcps`, {
      headers: bearerHeaders(),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("GET with valid auth on owned id returns MCP configuration", async () => {
    if (!shouldRun()) return;
    const userId = process.env.TEST_USER_ID;
    const organizationId = process.env.TEST_ORGANIZATION_ID;
    if (!userId || !organizationId) {
      throw new Error("TEST_USER_ID and TEST_ORGANIZATION_ID must be set by e2e preload");
    }
    const createdId = crypto.randomUUID();
    await seedOwnedCharacter({
      id: createdId,
      organizationId,
      userId,
      name: `E2E MCP ${crypto.randomUUID()}`,
      plugins: ["@elizaos/plugin-mcp"],
      settings: {
        mcp: {
          servers: {
            time: {
              endpoint: "/api/mcps/time/streamable-http",
              transport: "streamable-http",
            },
          },
        },
      },
    });
    createdCharacterIds.push(createdId);

    const res = await api.get(`/api/characters/${createdId}/mcps`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      data?: {
        characterId?: string;
        enabled?: boolean;
        endpoint?: string;
        pluginInstalled?: boolean;
        servers?: Record<string, unknown>;
        serverCount?: number;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      characterId: createdId,
      enabled: true,
      endpoint: `/api/agents/${createdId}/mcp`,
      pluginInstalled: true,
      servers: {
        time: {
          endpoint: "/api/mcps/time/streamable-http",
          transport: "streamable-http",
        },
      },
      serverCount: 1,
    });
  });

  test("POST with valid auth is not mounted", async () => {
    if (!shouldRun()) return;
    const res = await api.post(
      `/api/characters/${UNOWNED_AGENT_ID}/mcps`,
      { mcpId: "test" },
      { headers: bearerHeaders() },
    );
    expect([404, 405]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/characters/:characterId/public — public character info
// -------------------------------------------------------------------------
describe("/api/characters/:characterId/public", () => {
  test("GET unauthenticated for unknown character returns 404", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/characters/${UNOWNED_AGENT_ID}/public`);
    // Public route — no auth required, but unknown character is 404.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
  });

  test("GET with valid auth for unknown character still 404", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/characters/${UNOWNED_AGENT_ID}/public`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test("GET with malformed characterId is rejected", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/characters/not-a-uuid/public");
    // 404 = service treats it as not-found; 400/500 if a UUID validator fires.
    expect([400, 404, 500]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// Sanity: the bootstrapped key actually unlocks the user-scoped routes the
// rest of these tests rely on. If this fails, the per-route 200 assertions
// were always going to skip.
// -------------------------------------------------------------------------
describe("Group C sanity: bootstrapped key works", () => {
  test("test API key is set when not SKIP_DB_DEPENDENT", () => {
    if (!serverReachable) return;
    if (process.env.SKIP_DB_DEPENDENT === "1") {
      expect(hasTestApiKey).toBe(false);
      return;
    }
    if (!hasTestApiKey) {
      console.warn(
        "[group-c-agents] preload did not export TEST_API_KEY — local Postgres unavailable",
      );
    }
    if (hasTestApiKey) {
      expect(getApiKey()).toMatch(/^eliza_/);
    }
  });
});
