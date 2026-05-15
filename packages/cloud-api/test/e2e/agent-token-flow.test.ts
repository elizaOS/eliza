/**
 * Agent token flow — foundation e2e test for the Hono Worker.
 *
 * Proves the user-stated requirement: "an agent can get a token and use the
 * API end-to-end." Walks the canonical journey:
 *
 *   1.  Probe /api/health on the configured base URL.
 *   2.  Bootstrap a test org + user + API key against the live DB
 *       (ensureLocalTestAuth seeds rows; the same key is what /api/test/auth/session
 *       trades for a session cookie).
 *   3.  Use the API key with `Authorization: Bearer eliza_*` to read user state.
 *   4.  Use the API key to read credit balance.
 *   5.  Trade the API key for a session cookie via /api/test/auth/session.
 *   6.  Use the session cookie to manage API keys (POST /api/v1/api-keys —
 *       session-only, agents cannot create keys with their own keys).
 *   7.  Use the *new* key to confirm the freshly-issued token is valid.
 *
 * Skip behavior:
 *   - If TEST_API_BASE_URL / TEST_BASE_URL is unreachable, every test skips
 *     with a clear message. Operator has to start `wrangler dev` (or the
 *     Next.js dev server) and re-run.
 *   - Some assertions accept a small set of statuses (200/201) because the
 *     Hono Worker and the legacy Next.js implementation differ in shape on
 *     a few edges; we want a single test that runs against either.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  api,
  bearerHeaders,
  exchangeApiKeyForSession,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";

let serverReachable = false;
let hasTestApiKey = false;
let sessionCookie: string | null = null;
const createdApiKeyIds: string[] = [];

function shouldRun(): boolean {
  return serverReachable && hasTestApiKey;
}

beforeAll(async () => {
  hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
  serverReachable = await isServerReachable();
  if (!serverReachable) {
    console.warn(
      `[agent-token-flow] ${getBaseUrl()} did not respond to /api/health. ` +
        "Tests will skip. Start the Worker (bun run dev:api → wrangler dev) " +
        "or set TEST_API_BASE_URL to a reachable host.",
    );
  }
  if (!hasTestApiKey) {
    console.warn(
      "[agent-token-flow] TEST_API_KEY is not set; the preload could not bootstrap " +
        "a test API key. Tests requiring auth will skip.",
    );
  }
});

afterAll(async () => {
  if (!serverReachable || !sessionCookie) return;
  for (const id of createdApiKeyIds) {
    await api.delete(`/api/v1/api-keys/${id}`, {
      headers: { Cookie: sessionCookie, ...bearerHeaders() },
    });
  }
});

describe("Foundation: agent token flow", () => {
  test("server responds at /api/health", async () => {
    if (!serverReachable) return; // health check doesn't need API key
    const res = await api.get("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("ok");
  });

  test("Bearer eliza_* unlocks GET /api/v1/user", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/v1/user", { headers: bearerHeaders() });
    expect([200, 401, 403]).toContain(res.status);
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(
        `Expected 200 from /api/v1/user with Bearer eliza_*, got ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    const body = (await res.json()) as { id?: string; email?: string };
    expect(body.id ?? body.email).toBeTruthy();
  });

  test("Bearer eliza_* unlocks GET /api/v1/credits/balance", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/v1/credits/balance", { headers: bearerHeaders() });
    expect([200, 401, 403]).toContain(res.status);
    if (res.status !== 200) {
      const body = await res.text();
      throw new Error(
        `Expected 200 from /api/v1/credits/balance, got ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    const body = (await res.json()) as { balance?: number | string };
    expect(body.balance).toBeDefined();
  });

  test("API key trades for a session cookie via /api/test/auth/session", async () => {
    if (!shouldRun()) return;
    sessionCookie = await exchangeApiKeyForSession();
    expect(sessionCookie).toMatch(/^[^=]+=.+/);
  });

  test("session cookie unlocks GET /api/v1/api-keys (session-only path)", async () => {
    if (!shouldRun()) return;
    if (!sessionCookie) throw new Error("session cookie not set — earlier step failed");
    const res = await api.get("/api/v1/api-keys", { headers: { Cookie: sessionCookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys?: unknown[]; apiKeys?: unknown[] };
    const list = body.keys ?? body.apiKeys ?? [];
    expect(Array.isArray(list)).toBe(true);
  });

  test("session cookie can create a new API key, and that key works as Bearer", async () => {
    if (!shouldRun()) return;
    if (!sessionCookie) throw new Error("session cookie not set — earlier step failed");

    const createRes = await api.post(
      "/api/v1/api-keys",
      {
        name: `agent-token-flow-${Date.now()}`,
        description: "Foundation e2e test — created and revoked in afterAll.",
        permissions: ["read"],
        rate_limit: 60,
      },
      { headers: { Cookie: sessionCookie } },
    );

    expect([200, 201]).toContain(createRes.status);
    const created = (await createRes.json()) as {
      apiKey?: { id?: string };
      plainKey?: string;
    };
    expect(created.apiKey?.id).toBeTruthy();
    expect(created.plainKey).toMatch(/^eliza_/);

    if (created.apiKey?.id) createdApiKeyIds.push(created.apiKey.id);

    const verifyRes = await api.get("/api/v1/user", {
      headers: {
        Authorization: `Bearer ${created.plainKey}`,
        "Content-Type": "application/json",
      },
    });
    expect(verifyRes.status).toBe(200);
  });
});
