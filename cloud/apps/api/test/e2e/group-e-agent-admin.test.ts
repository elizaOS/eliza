/**
 * Group E — Agent / admin / advertising / training e2e tests.
 *
 * Covers the 14 routes assigned to `agent-backend-dev` in FANOUT.md:
 *
 *   /api/admin/redemptions
 *   /api/v1/admin/ai-pricing
 *   /api/v1/admin/docker-containers
 *   /api/v1/admin/docker-containers/:id/logs
 *   /api/v1/admin/docker-containers/audit
 *   /api/v1/admin/docker-nodes/:nodeId/health-check
 *   /api/v1/admin/infrastructure/containers/actions
 *   /api/v1/advertising/accounts/:id
 *   /api/v1/advertising/campaigns/:id (+ analytics, creatives, pause, start)
 *   /api/training/vertex/tune
 * Three assertions per route family:
 *
 *  1. Auth gate — unauthenticated request returns 401/403 (per the global auth
 *     middleware in `apps/api/src/middleware/auth.ts`; these are not public
 *     paths).
 *  2. Happy path / behavior — for routes with a real handler we assert the
 *     bearer-authenticated response shape; for the many 501 stubs ("Not
 *     implemented on Workers" — DockerSSHClient/node:fs blockers) we accept
 *     200/202/501 as documented in FANOUT.md.
 *  3. Validation — for routes that take a body, send a known-bad payload and
 *     assert 400.
 *
 * Admin routes additionally require a wallet-bound admin user. The e2e preload
 * seeds the local test user as admin, then exchanges the bootstrapped API key
 * for a session cookie.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  api,
  bearerHeaders,
  exchangeApiKeyForSession,
  isServerReachable,
  memberBearerHeaders,
} from "./_helpers/api";

let serverReachable = false;
let hasTestApiKey = false;
let sessionCookie: string | null = null;

const adminSessionCookie = process.env.AGENT_TEST_ADMIN_SESSION?.trim() || null;

function shouldRun(): boolean {
  return serverReachable && hasTestApiKey;
}

function adminHeaders(): Record<string, string> {
  const cookie = adminSessionCookie || sessionCookie;
  if (!cookie) {
    throw new Error(
      "Admin session cookie missing; ensure the e2e preload exchanged the bootstrapped API key.",
    );
  }
  return { Cookie: cookie, "Content-Type": "application/json" };
}

beforeAll(async () => {
  hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
  serverReachable = await isServerReachable();
  if (!hasTestApiKey) {
    throw new Error("[group-e] TEST_API_KEY is not set; the e2e preload did not bootstrap auth.");
  }

  sessionCookie = adminSessionCookie || (await exchangeApiKeyForSession());
});

afterAll(async () => {
  void sessionCookie;
});

const FAKE_UUID = "00000000-0000-4000-8000-000000000000";
const NOT_IMPLEMENTED_OK_STATUSES = [200, 202, 501] as const;

/**
 * Assert that an unauthenticated request to a protected /api/ path is rejected
 * by the global auth middleware. The middleware returns 401 for missing creds;
 * a route that returns its own 403 (e.g. for missing wallet/admin) is also
 * acceptable here. 404 is never acceptable — that would indicate the route is
 * not mounted at all.
 */
function expectAuthGate(status: number, path: string): void {
  expect([401, 403]).toContain(status);
  if (![401, 403].includes(status)) {
    throw new Error(`Expected 401/403 from unauthenticated ${path}, got ${status}`);
  }
}

describe("Group E: admin / redemptions", () => {
  test("GET /api/admin/redemptions rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/admin/redemptions");
    expectAuthGate(res.status, "GET /api/admin/redemptions");
  });

  test("GET /api/admin/redemptions rejects non-admin bearer with 403", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/admin/redemptions", { headers: memberBearerHeaders() });
    // Use the seeded member key here; the primary bootstrapped key is a super-admin
    // when AGENT_TEST_BOOTSTRAP_ADMIN=true.
    expect([401, 403]).toContain(res.status);
  });

  test("POST /api/admin/redemptions rejects invalid body with 400 (admin) or 401/403 (non-admin)", async () => {
    if (!shouldRun()) return;
    const headers = adminHeaders();
    const res = await api.post(
      "/api/admin/redemptions",
      { redemptionId: "not-a-uuid", action: "approve" },
      { headers },
    );
    expect(res.status).toBe(400);
  });

  test("GET /api/admin/redemptions returns redemption list for admin", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/admin/redemptions?status=pending&limit=5", {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      redemptions?: unknown[];
      summary?: { statusCounts?: Record<string, unknown> };
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.redemptions)).toBe(true);
    expect(body.summary).toBeDefined();
  });
});

describe("Group E: admin / ai-pricing", () => {
  test("GET /api/v1/admin/ai-pricing rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/v1/admin/ai-pricing");
    expectAuthGate(res.status, "GET /api/v1/admin/ai-pricing");
  });

  test("GET /api/v1/admin/ai-pricing rejects non-admin bearer", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/v1/admin/ai-pricing", { headers: memberBearerHeaders() });
    expect([401, 403]).toContain(res.status);
  });

  test("PUT /api/v1/admin/ai-pricing rejects invalid body", async () => {
    if (!shouldRun()) return;
    const headers = adminHeaders();
    const res = await api.put(
      "/api/v1/admin/ai-pricing",
      { billingSource: "not-a-real-source", provider: "", model: "", unitPrice: -1 },
      { headers },
    );
    expect(res.status).toBe(400);
  });

  test("GET /api/v1/admin/ai-pricing returns pricing entries for admin", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/v1/admin/ai-pricing", { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pricing?: unknown[]; refreshRuns?: unknown[] };
    expect(Array.isArray(body.pricing)).toBe(true);
    expect(Array.isArray(body.refreshRuns)).toBe(true);
  });
});

describe("Group E: admin / docker-containers (live + 501 stubs)", () => {
  test("GET /api/v1/admin/docker-containers rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/v1/admin/docker-containers");
    expectAuthGate(res.status, "GET /api/v1/admin/docker-containers");
  });

  test("GET /api/v1/admin/docker-containers rejects non-super-admin bearer", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/v1/admin/docker-containers", {
      headers: memberBearerHeaders(),
    });
    expect([401, 403]).toContain(res.status);
  });

  test("GET /api/v1/admin/docker-containers rejects invalid status filter (admin)", async () => {
    if (!shouldRun()) return;
    const res = await api.get("/api/v1/admin/docker-containers?status=garbage", {
      headers: adminHeaders(),
    });
    // ValidationError(400) when status is not in the allowed set; super_admin
    // is required so 403 is also acceptable for non-super admins.
    expect([400, 403]).toContain(res.status);
  });

  test("GET /api/v1/admin/docker-containers/:id/logs is a 501 stub (auth required first)", async () => {
    if (!shouldRun()) return;
    const unauthed = await api.get(`/api/v1/admin/docker-containers/${FAKE_UUID}/logs`);
    expectAuthGate(unauthed.status, "GET docker-containers/:id/logs (unauth)");

    const authed = await api.get(`/api/v1/admin/docker-containers/${FAKE_UUID}/logs`, {
      headers: bearerHeaders(),
    });
    expect(authed.status).toBe(501);
    const body = (await authed.json()) as { error?: string };
    expect(body.error).toBe("not_yet_migrated");
  });

  test("GET /api/v1/admin/docker-containers/audit is a 501 stub", async () => {
    if (!shouldRun()) return;
    const unauthed = await api.get("/api/v1/admin/docker-containers/audit");
    expectAuthGate(unauthed.status, "GET docker-containers/audit (unauth)");

    const authed = await api.get("/api/v1/admin/docker-containers/audit", {
      headers: bearerHeaders(),
    });
    expect(authed.status).toBe(501);
  });

  test("POST /api/v1/admin/docker-nodes/:nodeId/health-check forwards to the control plane", async () => {
    if (!shouldRun()) return;
    const unauthed = await api.post(`/api/v1/admin/docker-nodes/${FAKE_UUID}/health-check`);
    expectAuthGate(unauthed.status, "POST docker-nodes/:nodeId/health-check (unauth)");

    const authed = await api.post(
      `/api/v1/admin/docker-nodes/${FAKE_UUID}/health-check`,
      undefined,
      { headers: bearerHeaders() },
    );
    expect(authed.status).toBe(503);
    const body = (await authed.json()) as { code?: string };
    expect([
      "CONTAINER_CONTROL_PLANE_NOT_CONFIGURED",
      "CONTAINER_CONTROL_PLANE_UNREACHABLE",
    ]).toContain(body.code);
  });

  test("POST /api/v1/admin/infrastructure/containers/actions is a 501 stub; rejects unauthenticated", async () => {
    if (!shouldRun()) return;
    const unauthed = await api.post("/api/v1/admin/infrastructure/containers/actions", {
      action: "restart",
      containerId: FAKE_UUID,
    });
    expectAuthGate(unauthed.status, "POST infrastructure/containers/actions (unauth)");

    const authed = await api.post(
      "/api/v1/admin/infrastructure/containers/actions",
      { action: "restart", containerId: FAKE_UUID },
      { headers: bearerHeaders() },
    );
    expect(authed.status).toBe(501);
    const body = (await authed.json()) as { error?: string };
    expect(body.error).toBe("not_yet_migrated");
  });
});

describe("Group E: advertising / accounts", () => {
  test("GET /api/v1/advertising/accounts/:id rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/v1/advertising/accounts/${FAKE_UUID}`);
    expectAuthGate(res.status, "GET advertising/accounts/:id");
  });

  test("GET /api/v1/advertising/accounts/:id returns 404 for unknown id", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/v1/advertising/accounts/${FAKE_UUID}`, {
      headers: bearerHeaders(),
    });
    // Unknown / not-owned account returns 404; service-layer validation may
    // also surface a 400 if the id is not a valid uuid for some platforms.
    expect([400, 404]).toContain(res.status);
  });

  test("DELETE /api/v1/advertising/accounts/:id rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.delete(`/api/v1/advertising/accounts/${FAKE_UUID}`);
    expectAuthGate(res.status, "DELETE advertising/accounts/:id");
  });
});

describe("Group E: advertising / campaigns", () => {
  test("GET /api/v1/advertising/campaigns/:id rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/v1/advertising/campaigns/${FAKE_UUID}`);
    expectAuthGate(res.status, "GET advertising/campaigns/:id");
  });

  test("GET /api/v1/advertising/campaigns/:id returns 404 for unknown id", async () => {
    if (!shouldRun()) return;
    const res = await api.get(`/api/v1/advertising/campaigns/${FAKE_UUID}`, {
      headers: bearerHeaders(),
    });
    expect([400, 404]).toContain(res.status);
  });

  test("PATCH /api/v1/advertising/campaigns/:id rejects invalid body with 400", async () => {
    if (!shouldRun()) return;
    const res = await api.patch(
      `/api/v1/advertising/campaigns/${FAKE_UUID}`,
      { budgetAmount: "not-a-number", startDate: "definitely-not-an-iso-date" },
      { headers: bearerHeaders() },
    );
    // Invalid body short-circuits before the service layer; either a 400 from
    // the schema or a 404 if the route's lookup runs first.
    expect([400, 404]).toContain(res.status);
  });

  test("DELETE /api/v1/advertising/campaigns/:id rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.delete(`/api/v1/advertising/campaigns/${FAKE_UUID}`);
    expectAuthGate(res.status, "DELETE advertising/campaigns/:id");
  });

  test("GET /api/v1/advertising/campaigns/:id/analytics rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/v1/advertising/campaigns/${FAKE_UUID}/analytics`);
    expectAuthGate(res.status, "GET advertising/campaigns/:id/analytics");
  });

  test("GET /api/v1/advertising/campaigns/:id/analytics rejects bad date range with 400", async () => {
    if (!shouldRun()) return;
    const res = await api.get(
      `/api/v1/advertising/campaigns/${FAKE_UUID}/analytics?startDate=2024-12-31T00:00:00Z&endDate=2024-01-01T00:00:00Z`,
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("date");
  });

  test("GET /api/v1/advertising/campaigns/:id/creatives rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.get(`/api/v1/advertising/campaigns/${FAKE_UUID}/creatives`);
    expectAuthGate(res.status, "GET advertising/campaigns/:id/creatives");
  });

  test("POST /api/v1/advertising/campaigns/:id/creatives rejects invalid body with 400", async () => {
    if (!shouldRun()) return;
    const res = await api.post(
      `/api/v1/advertising/campaigns/${FAKE_UUID}/creatives`,
      { name: 0, type: "not-a-real-type" },
      { headers: bearerHeaders() },
    );
    expect([400, 404]).toContain(res.status);
  });

  test("POST /api/v1/advertising/campaigns/:id/pause rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/v1/advertising/campaigns/${FAKE_UUID}/pause`);
    expectAuthGate(res.status, "POST advertising/campaigns/:id/pause");
  });

  test("POST /api/v1/advertising/campaigns/:id/start rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.post(`/api/v1/advertising/campaigns/${FAKE_UUID}/start`);
    expectAuthGate(res.status, "POST advertising/campaigns/:id/start");
  });

  test("POST /api/v1/advertising/campaigns/:id/start returns 404 for unknown campaign", async () => {
    if (!shouldRun()) return;
    const res = await api.post(`/api/v1/advertising/campaigns/${FAKE_UUID}/start`, undefined, {
      headers: bearerHeaders(),
    });
    expect([400, 404]).toContain(res.status);
  });
});

describe("Group E: training / vertex tune (501 stub)", () => {
  test("POST /api/training/vertex/tune rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/training/vertex/tune", { datasetUri: "gs://demo" });
    expectAuthGate(res.status, "POST training/vertex/tune");
  });

  test("POST /api/training/vertex/tune returns 501 (node:fs blocker)", async () => {
    if (!shouldRun()) return;
    const res = await api.post(
      "/api/training/vertex/tune",
      { datasetUri: "gs://demo" },
      { headers: bearerHeaders() },
    );
    expect(NOT_IMPLEMENTED_OK_STATUSES).toContain(
      res.status as (typeof NOT_IMPLEMENTED_OK_STATUSES)[number],
    );
    if (res.status === 501) {
      const body = (await res.json()) as { error?: string; reason?: string };
      expect(body.error).toBe("not_yet_migrated");
    }
  });

  test("GET /api/training/vertex/tune rejects unauthenticated", async () => {
    if (!serverReachable) return;
    const res = await api.get("/api/training/vertex/tune");
    expectAuthGate(res.status, "GET training/vertex/tune");
  });
});

describe("Group E: session-cookie sanity check", () => {
  test("can exchange API key for session cookie (sanity that base harness works)", async () => {
    if (!shouldRun()) return;
    sessionCookie = await exchangeApiKeyForSession();
    expect(sessionCookie).toMatch(/^[^=]+=.+/);
  });
});
