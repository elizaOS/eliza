/**
 * Group C — Agents (`/api/v1/agents`, `/api/agents`, `/api/my-agents`,
 * `/api/characters`).
 *
 * For each route in the group, three assertions:
 *   1. **Auth gate** — request without credentials returns the exact
 *      documented gate status.
 *   2. **Happy path** — with the bootstrapped Bearer eliza_* key, the route
 *      returns its documented success shape, or — for routes acting on a
 *      :agentId/:id we don't own — the exact not-found/ownership status.
 *   3. **Validation** — at least one body / query-param failure returns the
 *      exact documented rejection.
 *
 * Every status assertion pins the single status the local Worker contract
 * produces (the CI lane runs this suite against `wrangler dev` with the
 * PGlite bridge — see run-e2e-batches.mjs). The only tolerated pairs are
 * genuinely env-keyed (named inline, e.g. HEADSCALE_INTERNAL_TOKEN).
 *
 * Skip behavior matches `agent-token-flow.test.ts`: with REQUIRE_E2E_SERVER=0
 * and no reachable Worker (or no bootstrapped TEST_API_KEY) every test in
 * this file reports as a counted, named `skip` — never a silent pass.
 *
 * UNOWNED_AGENT_ID — a syntactically-valid UUID we know isn't in the DB.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

import {
  api,
  bearerHeaders,
  getApiKey,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";

const UNOWNED_AGENT_ID = "00000000-0000-4000-8000-000000000000";

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
if (!serverReachable) {
  console.warn(
    `[group-c-agents] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-c-agents] TEST_API_KEY is not set; the preload could not " +
      "bootstrap a test API key. Tests will SKIP.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);

const createdCharacterIds: string[] = [];

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
    throw new Error(
      "TEST_DATABASE_URL or DATABASE_URL must be set by the e2e harness",
    );
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

afterAll(async () => {
  if (!serverReachable || !hasTestApiKey) return;
  for (const id of createdCharacterIds) {
    await api.delete(`/api/my-agents/characters/${id}`, {
      headers: bearerHeaders(),
    });
  }
});

// -------------------------------------------------------------------------
// /api/agents/:id/a2a — public agent A2A endpoint (JSON-RPC POST + GET card)
// -------------------------------------------------------------------------
describeE2E("/api/agents/:id/a2a", () => {
  test("GET unknown agent returns 404 even unauthenticated (public route, but agent must exist)", async () => {
    const res = await api.get(`/api/agents/${UNOWNED_AGENT_ID}/a2a`);
    expect(res.status).toBe(404);
  });

  test("POST without auth on unknown agent returns 404 (handler short-circuits before auth)", async () => {
    const res = await api.post(`/api/agents/${UNOWNED_AGENT_ID}/a2a`, {
      jsonrpc: "2.0",
      method: "chat",
      id: 1,
      params: {},
    });
    // The route's flow: lookup agent first → 404 if missing → only then auth.
    expect(res.status).toBe(404);
  });

  test("POST with malformed JSON-RPC body to unknown agent returns 404 (agent check first)", async () => {
    const res = await api.post(`/api/agents/${UNOWNED_AGENT_ID}/a2a`, {
      not: "a valid jsonrpc envelope",
    });
    expect(res.status).toBe(404);
  });
});

// -------------------------------------------------------------------------
// /api/agents/:id/headscale-ip — internal-token-only
// -------------------------------------------------------------------------
describeE2E("/api/agents/:id/headscale-ip", () => {
  // Env-keyed pair: with HEADSCALE_INTERNAL_TOKEN / CONTAINER_CONTROL_PLANE_TOKEN
  // configured a missing/bogus token is rejected 403; the keyless local harness
  // has neither configured, so the route answers 503 "not configured".
  test("GET without internal token returns 403 (503 when no internal token is configured)", async () => {
    const res = await api.get(`/api/agents/${UNOWNED_AGENT_ID}/headscale-ip`);
    expect([403, 503]).toContain(res.status);
  });

  test("GET with bogus internal token still 403 (503 when no internal token is configured)", async () => {
    const res = await api.get(`/api/agents/${UNOWNED_AGENT_ID}/headscale-ip`, {
      headers: { "x-internal-token": "definitely-not-the-real-token" },
    });
    expect([403, 503]).toContain(res.status);
  });

  test("GET with non-UUID id rejects before validation (auth gate fires first)", async () => {
    const res = await api.get("/api/agents/not-a-uuid/headscale-ip");
    // Without a valid internal token we never reach the UUID validation,
    // so the response is the auth gate (same env-keyed pair as above).
    expect([403, 503]).toContain(res.status);
  });
});

// -------------------------------------------------------------------------
// /api/agents/:id/mcp — public MCP endpoint
// -------------------------------------------------------------------------
describeE2E("/api/agents/:id/mcp", () => {
  test("GET unknown agent returns 404 (public route, but agent must exist)", async () => {
    const res = await api.get(`/api/agents/${UNOWNED_AGENT_ID}/mcp`);
    expect(res.status).toBe(404);
  });

  test("POST without auth on unknown agent returns 404 (agent check before auth)", async () => {
    const res = await api.post(`/api/agents/${UNOWNED_AGENT_ID}/mcp`, {
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    });
    expect(res.status).toBe(404);
  });

  test("POST with malformed JSON-RPC body returns 404 on unknown agent", async () => {
    const res = await api.post(`/api/agents/${UNOWNED_AGENT_ID}/mcp`, {
      not: "a valid jsonrpc envelope",
    });
    expect(res.status).toBe(404);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId — GET only, requires user/key auth + ownership
// -------------------------------------------------------------------------
describeE2E("/api/v1/agents/:agentId", () => {
  test("GET without auth returns 401", async () => {
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}`);
    expect(res.status).toBe(401);
  });

  test("GET with valid auth on unowned agent returns 404 (not-found from repository)", async () => {
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test("GET with valid auth on malformed agentId returns 500 (no UUID validation on this route)", async () => {
    const res = await api.get("/api/v1/agents/not-a-uuid-at-all", {
      headers: bearerHeaders(),
    });
    // Current contract: the raw id reaches the repository and the Postgres
    // uuid cast throws → 500. A route-layer UUID validator would make this a
    // 400; update this pin when one lands.
    expect(res.status).toBe(500);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/logs — service-key only
// -------------------------------------------------------------------------
describeE2E("/api/v1/agents/:agentId/logs", () => {
  test("GET without service key returns 401", async () => {
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/logs`);
    expect(res.status).toBe(401);
  });

  test("GET with user Bearer (not service key) returns 401", async () => {
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/logs`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(401);
  });

  test("GET with bogus service key returns 401", async () => {
    const res = await api.get(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/logs?tail=10`,
      {
        headers: { "X-Service-Key": "not-a-real-service-key" },
      },
    );
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/monetization — GET + PUT
// -------------------------------------------------------------------------
describeE2E("/api/v1/agents/:agentId/monetization", () => {
  test("GET without auth returns 401", async () => {
    const res = await api.get(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/monetization`,
    );
    expect(res.status).toBe(401);
  });

  test("GET with valid auth on unowned agent returns 404", async () => {
    const res = await api.get(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/monetization`,
      {
        headers: bearerHeaders(),
      },
    );
    expect(res.status).toBe(404);
  });

  test("PUT with invalid body schema returns 400 (Zod validation fires before ownership)", async () => {
    const res = await api.put(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/monetization`,
      // markupPercentage above 1000 fails Zod validation
      { markupPercentage: 99999 },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/publish — POST + DELETE (user auth + ownership)
// -------------------------------------------------------------------------
describeE2E("/api/v1/agents/:agentId/publish", () => {
  test("POST without auth returns 401", async () => {
    const res = await api.post(`/api/v1/agents/${UNOWNED_AGENT_ID}/publish`);
    expect(res.status).toBe(401);
  });

  test("POST with valid auth on unowned agent returns 404", async () => {
    const res = await api.post(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/publish`,
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });

  test("DELETE with valid auth on unowned agent returns 404", async () => {
    const res = await api.delete(`/api/v1/agents/${UNOWNED_AGENT_ID}/publish`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/restart — service-key only
// -------------------------------------------------------------------------
describeE2E("/api/v1/agents/:agentId/restart", () => {
  test("POST without service key returns 401", async () => {
    const res = await api.post(`/api/v1/agents/${UNOWNED_AGENT_ID}/restart`);
    expect(res.status).toBe(401);
  });

  test("POST with user Bearer (not service key) returns 401", async () => {
    const res = await api.post(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/restart`,
      undefined,
      {
        headers: bearerHeaders(),
      },
    );
    expect(res.status).toBe(401);
  });

  test("POST with bogus service key returns 401", async () => {
    const res = await api.post(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/restart`,
      undefined,
      {
        headers: { "X-Service-Key": "not-a-real-service-key" },
      },
    );
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/resume — service-key only
// -------------------------------------------------------------------------
describeE2E("/api/v1/agents/:agentId/resume", () => {
  test("POST without service key returns 401", async () => {
    const res = await api.post(`/api/v1/agents/${UNOWNED_AGENT_ID}/resume`);
    expect(res.status).toBe(401);
  });

  test("POST with user Bearer (not service key) returns 401", async () => {
    const res = await api.post(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/resume`,
      undefined,
      {
        headers: bearerHeaders(),
      },
    );
    expect(res.status).toBe(401);
  });

  test("POST with bogus service key returns 401", async () => {
    const res = await api.post(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/resume`,
      undefined,
      {
        headers: { "X-Service-Key": "not-a-real-service-key" },
      },
    );
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/status — service-key only
// -------------------------------------------------------------------------
describeE2E("/api/v1/agents/:agentId/status", () => {
  test("GET without service key returns 401", async () => {
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/status`);
    expect(res.status).toBe(401);
  });

  test("GET with user Bearer (not service key) returns 401", async () => {
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/status`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(401);
  });

  test("GET with bogus service key returns 401", async () => {
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/status`, {
      headers: { "X-Service-Key": "not-a-real-service-key" },
    });
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/suspend — service-key only
// -------------------------------------------------------------------------
describeE2E("/api/v1/agents/:agentId/suspend", () => {
  test("POST without service key returns 401", async () => {
    const res = await api.post(`/api/v1/agents/${UNOWNED_AGENT_ID}/suspend`);
    expect(res.status).toBe(401);
  });

  test("POST with user Bearer (not service key) returns 401", async () => {
    const res = await api.post(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/suspend`,
      { reason: "test" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(401);
  });

  test("POST with bogus service key returns 401", async () => {
    const res = await api.post(
      `/api/v1/agents/${UNOWNED_AGENT_ID}/suspend`,
      { reason: "test" },
      { headers: { "X-Service-Key": "not-a-real-service-key" } },
    );
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/:agentId/usage — service-key only
// -------------------------------------------------------------------------
describeE2E("/api/v1/agents/:agentId/usage", () => {
  test("GET without service key returns 401", async () => {
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/usage`);
    expect(res.status).toBe(401);
  });

  test("GET with user Bearer (not service key) returns 401", async () => {
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/usage`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(401);
  });

  test("GET with bogus service key returns 401", async () => {
    const res = await api.get(`/api/v1/agents/${UNOWNED_AGENT_ID}/usage`, {
      headers: { "X-Service-Key": "not-a-real-service-key" },
    });
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------
// /api/v1/agents/by-token — public token lookup
// -------------------------------------------------------------------------
describeE2E("/api/v1/agents/by-token", () => {
  test("GET without ?address returns 400", async () => {
    const res = await api.get("/api/v1/agents/by-token");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test("GET with well-formed unknown address returns 404 (no agent linked)", async () => {
    const res = await api.get(
      `/api/v1/agents/by-token?address=${encodeURIComponent("0xdeadbeef".repeat(4))}&chain=eth`,
    );
    expect(res.status).toBe(404);
  });

  test("GET with overlong address returns 400", async () => {
    const longAddr = "x".repeat(257);
    const res = await api.get(`/api/v1/agents/by-token?address=${longAddr}`);
    expect(res.status).toBe(400);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters — list + create
// -------------------------------------------------------------------------
describeE2E("/api/my-agents/characters", () => {
  test("GET without auth returns 401", async () => {
    const res = await api.get("/api/my-agents/characters");
    expect(res.status).toBe(401);
  });

  test("GET with valid auth returns paginated character list", async () => {
    const res = await api.get("/api/my-agents/characters?limit=10", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      data?: { characters?: unknown[]; pagination?: { page?: number } };
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data?.characters)).toBe(true);
    expect(body.data?.pagination?.page).toBe(1);
  });

  test("POST with malformed body returns 500 (create fails at the DB layer)", async () => {
    // Missing the required `name` field — the handler casts to ElizaCharacter
    // without route-layer validation, so the insert fails in the repository.
    // Current contract: 500. A route-layer validator would make this a 400;
    // update this pin when one lands.
    const res = await api.post(
      "/api/my-agents/characters",
      { nope: "no name here" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(500);
  });
});

// /api/my-agents/characters/avatar — Worker-safe multipart avatar upload.
// -------------------------------------------------------------------------
describeE2E("/api/my-agents/characters/avatar", () => {
  test("POST without auth returns 401 before upload validation", async () => {
    const res = await api.post("/api/my-agents/characters/avatar");
    expect(res.status).toBe(401);
  });

  test("POST with valid auth and no multipart body returns 400", async () => {
    const res = await api.post("/api/my-agents/characters/avatar", undefined, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/multipart/i);
  });

  test("POST with random JSON body returns upload validation error", async () => {
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
describeE2E("/api/my-agents/characters/:id", () => {
  test("GET without auth returns 401", async () => {
    const res = await api.get(`/api/my-agents/characters/${UNOWNED_AGENT_ID}`);
    expect(res.status).toBe(401);
  });

  test("GET with valid auth on unowned id returns 404", async () => {
    const res = await api.get(`/api/my-agents/characters/${UNOWNED_AGENT_ID}`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test("DELETE on unowned id returns 404", async () => {
    const res = await api.delete(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}`,
      {
        headers: bearerHeaders(),
      },
    );
    expect(res.status).toBe(404);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters/:id/clone — POST
// -------------------------------------------------------------------------
describeE2E("/api/my-agents/characters/:id/clone", () => {
  test("POST without auth returns 401", async () => {
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/clone`,
    );
    expect(res.status).toBe(401);
  });

  test("POST with valid auth on unknown source id returns 404", async () => {
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/clone`,
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });

  test("POST with non-JSON body still hits not-found gate (handler tolerates empty body)", async () => {
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/clone`,
      "this is not json",
      { headers: { ...bearerHeaders(), "Content-Type": "text/plain" } },
    );
    expect(res.status).toBe(404);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters/:id/share — GET + PUT
// -------------------------------------------------------------------------
describeE2E("/api/my-agents/characters/:id/share", () => {
  test("GET without auth returns 401", async () => {
    const res = await api.get(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/share`,
    );
    expect(res.status).toBe(401);
  });

  test("GET with valid auth on unowned id returns 404", async () => {
    const res = await api.get(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/share`,
      {
        headers: bearerHeaders(),
      },
    );
    expect(res.status).toBe(404);
  });

  test("PUT with invalid body on unowned id returns 404 (ownership fails before body validation)", async () => {
    const res = await api.put(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/share`,
      { isPublic: "not-a-boolean" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters/:id/stats — GET
// -------------------------------------------------------------------------
describeE2E("/api/my-agents/characters/:id/stats", () => {
  test("GET without auth returns 401", async () => {
    const res = await api.get(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/stats`,
    );
    expect(res.status).toBe(401);
  });

  test("GET with valid auth on unowned id returns 404", async () => {
    const res = await api.get(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/stats`,
      {
        headers: bearerHeaders(),
      },
    );
    expect(res.status).toBe(404);
  });

  test("GET with valid auth on owned id returns stored counters", async () => {
    const userId = process.env.TEST_USER_ID;
    const organizationId = process.env.TEST_ORGANIZATION_ID;
    if (!userId || !organizationId) {
      throw new Error(
        "TEST_USER_ID and TEST_ORGANIZATION_ID must be set by e2e preload",
      );
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

    const statsRes = await api.get(
      `/api/my-agents/characters/${createdId}/stats`,
      {
        headers: bearerHeaders(),
      },
    );
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
    const res = await api.get("/api/my-agents/characters/not-a-uuid/stats", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(400);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters/:id/track-interaction — POST (removed route)
// -------------------------------------------------------------------------
describeE2E("/api/my-agents/characters/:id/track-interaction", () => {
  test("POST without auth returns 401 (global auth middleware fires first)", async () => {
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/track-interaction`,
    );
    expect(res.status).toBe(401);
  });

  // Current contract for authed callers is 500, NOT the intended 410: the
  // handler calls requireUserWithOrg (session-only — it rejects eliza_* API
  // keys) inside a blanket try/catch that converts the auth rejection into
  // "Failed to track interaction" 500. Pinned so the contract is visible;
  // update to 410 if the handler drops the swallow (compare track-view).
  test("POST with API-key Bearer returns 500 (auth rejection swallowed by the route's catch)", async () => {
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/track-interaction`,
      undefined,
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  test("POST with body behaves the same (500 for API-key callers)", async () => {
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/track-interaction`,
      { eventType: "click" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(500);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/characters/:id/track-view — POST (returns 410 gone)
// -------------------------------------------------------------------------
describeE2E("/api/my-agents/characters/:id/track-view", () => {
  test("POST without auth returns 401 (global auth middleware fires first)", async () => {
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/track-view`,
    );
    expect(res.status).toBe(401);
  });

  test("POST with valid auth lands on 410 Gone", async () => {
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/track-view`,
      undefined,
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
  });

  test("POST with random body still 410", async () => {
    const res = await api.post(
      `/api/my-agents/characters/${UNOWNED_AGENT_ID}/track-view`,
      { random: "data" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(410);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/saved — GET
// -------------------------------------------------------------------------
describeE2E("/api/my-agents/saved", () => {
  test("GET without auth returns 401", async () => {
    const res = await api.get("/api/my-agents/saved");
    expect(res.status).toBe(401);
  });

  test("GET with valid auth returns saved-agent list", async () => {
    const res = await api.get("/api/my-agents/saved", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      data?: { agents?: unknown[]; count?: number };
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data?.agents)).toBe(true);
    expect(typeof body.data?.count).toBe("number");
  });

  test("GET with junk Bearer returns 401", async () => {
    const res = await api.get("/api/my-agents/saved", {
      headers: { Authorization: "Bearer eliza_completely-invalid-key" },
    });
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/saved/:id — GET + DELETE
// -------------------------------------------------------------------------
describeE2E("/api/my-agents/saved/:id", () => {
  test("GET without auth returns 401", async () => {
    const res = await api.get(`/api/my-agents/saved/${UNOWNED_AGENT_ID}`);
    expect(res.status).toBe(401);
  });

  test("GET with valid auth on unknown saved id returns 404", async () => {
    const res = await api.get(`/api/my-agents/saved/${UNOWNED_AGENT_ID}`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test("DELETE with valid auth on unknown saved id returns 404", async () => {
    const res = await api.delete(`/api/my-agents/saved/${UNOWNED_AGENT_ID}`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

// -------------------------------------------------------------------------
// /api/my-agents/claim-affiliate-characters — POST (session auth only)
// -------------------------------------------------------------------------
describeE2E("/api/my-agents/claim-affiliate-characters", () => {
  test("POST without auth returns 401", async () => {
    const res = await api.post("/api/my-agents/claim-affiliate-characters", {});
    expect(res.status).toBe(401);
  });

  test("POST with API-key Bearer returns 401 (route requires a session, rejects eliza_* keys)", async () => {
    const res = await api.post(
      "/api/my-agents/claim-affiliate-characters",
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(401);
  });

  test("POST with non-JSON body still hits the session gate first (401)", async () => {
    const res = await api.post(
      "/api/my-agents/claim-affiliate-characters",
      "not-json-at-all",
      {
        headers: { ...bearerHeaders(), "Content-Type": "text/plain" },
      },
    );
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------
// /api/characters/:characterId/mcps — owned character MCP metadata
// -------------------------------------------------------------------------
describeE2E("/api/characters/:characterId/mcps", () => {
  test("GET without auth returns 401", async () => {
    const res = await api.get(`/api/characters/${UNOWNED_AGENT_ID}/mcps`);
    expect(res.status).toBe(401);
  });

  test("GET with malformed character id returns 400", async () => {
    const res = await api.get("/api/characters/not-a-uuid/mcps", {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(400);
  });

  test("GET with valid auth on unowned id returns 404", async () => {
    const res = await api.get(`/api/characters/${UNOWNED_AGENT_ID}/mcps`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test("GET with valid auth on owned id returns MCP configuration", async () => {
    const userId = process.env.TEST_USER_ID;
    const organizationId = process.env.TEST_ORGANIZATION_ID;
    if (!userId || !organizationId) {
      throw new Error(
        "TEST_USER_ID and TEST_ORGANIZATION_ID must be set by e2e preload",
      );
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

  test("POST is not mounted — 404", async () => {
    const res = await api.post(
      `/api/characters/${UNOWNED_AGENT_ID}/mcps`,
      { mcpId: "test" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(404);
  });
});

// -------------------------------------------------------------------------
// /api/characters/:characterId/public — public character info
// -------------------------------------------------------------------------
describeE2E("/api/characters/:characterId/public", () => {
  test("GET unauthenticated for unknown character returns 404", async () => {
    const res = await api.get(`/api/characters/${UNOWNED_AGENT_ID}/public`);
    // Public route — no auth required, but unknown character is 404.
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
  });

  test("GET with valid auth for unknown character still 404", async () => {
    const res = await api.get(`/api/characters/${UNOWNED_AGENT_ID}/public`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test("GET with malformed characterId returns 400 (UUID validator)", async () => {
    const res = await api.get("/api/characters/not-a-uuid/public");
    expect(res.status).toBe(400);
  });
});

// -------------------------------------------------------------------------
// Sanity: the bootstrapped key actually unlocks the user-scoped routes the
// rest of these tests rely on. If this fails, the per-route 200 assertions
// were always going to skip.
// -------------------------------------------------------------------------
describeE2E("Group C sanity: bootstrapped key works", () => {
  test("test API key is set and eliza_-prefixed", () => {
    expect(getApiKey()).toMatch(/^eliza_/);
  });
});
