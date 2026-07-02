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
 *  1. Auth gate — unauthenticated request returns exactly 401 (the global
 *     auth middleware in `src/middleware/auth.ts` runs before any handler;
 *     these are not public paths).
 *  2. Happy path / behavior — for routes with a real handler we assert the
 *     bearer-authenticated response shape; Worker-boundary stubs
 *     (DockerSSHClient/node:fs blockers) answer exactly 501 not_yet_migrated.
 *  3. Validation — for routes that take a body, send a known-bad payload and
 *     assert 400.
 *
 * Admin routes additionally require a wallet-bound admin user. The e2e preload
 * seeds the local test user as admin (AGENT_TEST_BOOTSTRAP_ADMIN=true), then
 * this file exchanges the bootstrapped API key for a session cookie.
 *
 * Skip behavior: with REQUIRE_E2E_SERVER=0 and no reachable Worker (or no
 * bootstrapped TEST_API_KEY) every test in this file reports as a counted,
 * named `skip` — never a silent pass.
 */

import { describe, expect, test } from "bun:test";
import {
  api,
  bearerHeaders,
  exchangeApiKeyForSession,
  getBaseUrl,
  isServerReachable,
  memberBearerHeaders,
} from "./_helpers/api";

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
if (!serverReachable) {
  console.warn(
    `[group-e-agent-admin] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-e-agent-admin] TEST_API_KEY is not set; the preload could not " +
      "bootstrap a test API key. Tests will SKIP.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);

const adminSessionCookie = process.env.AGENT_TEST_ADMIN_SESSION?.trim() || null;
// The admin-session exchange requires PLAYWRIGHT_TEST_AUTH=true on the target
// Worker (always true in the run-e2e-batches lane). Failing while the Worker
// is up is a harness defect — fail loud, don't skip.
const sessionCookie: string | null =
  serverReachable && hasTestApiKey
    ? adminSessionCookie || (await exchangeApiKeyForSession())
    : null;

function adminHeaders(): Record<string, string> {
  if (!sessionCookie) {
    throw new Error(
      "Admin session cookie missing; ensure the e2e preload exchanged the bootstrapped API key.",
    );
  }
  return { Cookie: sessionCookie, "Content-Type": "application/json" };
}

const FAKE_UUID = "00000000-0000-4000-8000-000000000000";

/**
 * Assert the global auth middleware rejected an unauthenticated request with
 * exactly 401. (403 would mean a handler ran; 404 would mean the route is not
 * mounted at all — both are regressions.)
 */
function expectAuthGate(status: number, path: string): void {
  if (status !== 401) {
    throw new Error(`Expected 401 from unauthenticated ${path}, got ${status}`);
  }
  expect(status).toBe(401);
}

describeE2E("Group E: admin / redemptions", () => {
  test("GET /api/admin/redemptions rejects unauthenticated", async () => {
    const res = await api.get("/api/admin/redemptions");
    expectAuthGate(res.status, "GET /api/admin/redemptions");
  });

  test("GET /api/admin/redemptions rejects non-admin bearer with 403", async () => {
    const res = await api.get("/api/admin/redemptions", {
      headers: memberBearerHeaders(),
    });
    // The seeded member key authenticates fine (so not 401) but lacks the
    // admin role → the route's own gate answers 403.
    expect(res.status).toBe(403);
  });

  test("POST /api/admin/redemptions rejects invalid body with 400 (admin) or 401/403 (non-admin)", async () => {
    const headers = adminHeaders();
    const res = await api.post(
      "/api/admin/redemptions",
      { redemptionId: "not-a-uuid", action: "approve" },
      { headers },
    );
    expect(res.status).toBe(400);
  });

  test("GET /api/admin/redemptions returns redemption list for admin", async () => {
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

describeE2E("Group E: admin / ai-pricing", () => {
  test("GET /api/v1/admin/ai-pricing rejects unauthenticated", async () => {
    const res = await api.get("/api/v1/admin/ai-pricing");
    expectAuthGate(res.status, "GET /api/v1/admin/ai-pricing");
  });

  test("GET /api/v1/admin/ai-pricing rejects non-admin bearer", async () => {
    const res = await api.get("/api/v1/admin/ai-pricing", {
      headers: memberBearerHeaders(),
    });
    expect(res.status).toBe(403);
  });

  test("PUT /api/v1/admin/ai-pricing rejects invalid body", async () => {
    const headers = adminHeaders();
    const res = await api.put(
      "/api/v1/admin/ai-pricing",
      {
        billingSource: "not-a-real-source",
        provider: "",
        model: "",
        unitPrice: -1,
      },
      { headers },
    );
    expect(res.status).toBe(400);
  });

  test("GET /api/v1/admin/ai-pricing returns pricing entries for admin", async () => {
    const res = await api.get("/api/v1/admin/ai-pricing", {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pricing?: unknown[];
      refreshRuns?: unknown[];
    };
    expect(Array.isArray(body.pricing)).toBe(true);
    expect(Array.isArray(body.refreshRuns)).toBe(true);
  });
});

describeE2E("Group E: admin / cloud-observability", () => {
  test("GET /api/v1/admin/cloud-observability rejects unauthenticated", async () => {
    const res = await api.get("/api/v1/admin/cloud-observability");
    expectAuthGate(res.status, "GET /api/v1/admin/cloud-observability");
  });

  test("GET /api/v1/admin/cloud-observability returns request telemetry for admin", async () => {
    const res = await api.get("/api/v1/admin/cloud-observability?limit=25", {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      data?: {
        requests?: unknown[];
        slowRequests?: unknown[];
        slowDb?: unknown[];
        duplicateReadRequests?: unknown[];
        burstyRequests?: unknown[];
      };
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data?.requests)).toBe(true);
    expect(Array.isArray(body.data?.slowRequests)).toBe(true);
    expect(Array.isArray(body.data?.slowDb)).toBe(true);
    expect(Array.isArray(body.data?.duplicateReadRequests)).toBe(true);
    expect(Array.isArray(body.data?.burstyRequests)).toBe(true);
  });
});

describeE2E("Group E: admin / docker-containers (live + 501 stubs)", () => {
  test("GET /api/v1/admin/docker-containers rejects unauthenticated", async () => {
    const res = await api.get("/api/v1/admin/docker-containers");
    expectAuthGate(res.status, "GET /api/v1/admin/docker-containers");
  });

  test("GET /api/v1/admin/docker-containers rejects non-super-admin bearer", async () => {
    const res = await api.get("/api/v1/admin/docker-containers", {
      headers: memberBearerHeaders(),
    });
    expect(res.status).toBe(403);
  });

  test("GET /api/v1/admin/docker-containers rejects invalid status filter (admin)", async () => {
    const res = await api.get(
      "/api/v1/admin/docker-containers?status=garbage",
      {
        headers: adminHeaders(),
      },
    );
    // ValidationError(400): status is not in the allowed set (the seeded
    // session is super-admin, so the role gate never fires here).
    expect(res.status).toBe(400);
  });

  test("GET /api/v1/admin/docker-containers/:id/logs is gated before route handling", async () => {
    const unauthed = await api.get(
      `/api/v1/admin/docker-containers/${FAKE_UUID}/logs`,
    );
    expectAuthGate(unauthed.status, "GET docker-containers/:id/logs (unauth)");

    const authed = await api.get(
      `/api/v1/admin/docker-containers/${FAKE_UUID}/logs`,
      {
        headers: bearerHeaders(),
      },
    );
    expect(authed.status).toBe(501);
    const body = (await authed.json()) as { error?: string };
    expect(body.error).toBe("not_yet_migrated");
  });

  test("GET /api/v1/admin/docker-containers/audit returns the Worker boundary fallback", async () => {
    const unauthed = await api.get("/api/v1/admin/docker-containers/audit");
    expectAuthGate(unauthed.status, "GET docker-containers/audit (unauth)");

    const authed = await api.get("/api/v1/admin/docker-containers/audit", {
      headers: bearerHeaders(),
    });
    expect(authed.status).toBe(501);
  });

  test("POST /api/v1/admin/infrastructure/containers/actions rejects unauthenticated and returns the Worker boundary fallback", async () => {
    const unauthed = await api.post(
      "/api/v1/admin/infrastructure/containers/actions",
      {
        action: "restart",
        containerId: FAKE_UUID,
      },
    );
    expectAuthGate(
      unauthed.status,
      "POST infrastructure/containers/actions (unauth)",
    );

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

describeE2E("Group E: advertising / accounts", () => {
  test("GET /api/v1/advertising/accounts/:id rejects unauthenticated", async () => {
    const res = await api.get(`/api/v1/advertising/accounts/${FAKE_UUID}`);
    expectAuthGate(res.status, "GET advertising/accounts/:id");
  });

  test("GET /api/v1/advertising/accounts/:id returns 404 for unknown id", async () => {
    const res = await api.get(`/api/v1/advertising/accounts/${FAKE_UUID}`, {
      headers: bearerHeaders(),
    });
    // FAKE_UUID is well-formed, so validation passes and the ownership
    // lookup misses → 404.
    expect(res.status).toBe(404);
  });

  test("DELETE /api/v1/advertising/accounts/:id rejects unauthenticated", async () => {
    const res = await api.delete(`/api/v1/advertising/accounts/${FAKE_UUID}`);
    expectAuthGate(res.status, "DELETE advertising/accounts/:id");
  });

  test("POST /api/v1/advertising/accounts/:id/media rejects unauthenticated", async () => {
    const res = await api.post(
      `/api/v1/advertising/accounts/${FAKE_UUID}/media`,
      {
        type: "image",
        url: "https://example.com/creative.png",
      },
    );
    expectAuthGate(res.status, "POST advertising/accounts/:id/media");
  });

  test("POST /api/v1/advertising/accounts/:id/media rejects invalid body with 400", async () => {
    const res = await api.post(
      `/api/v1/advertising/accounts/${FAKE_UUID}/media`,
      { type: "audio", url: "not-a-url" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });

  test("GET /api/v1/advertising/accounts/:id/media rejects missing status query", async () => {
    const res = await api.get(
      `/api/v1/advertising/accounts/${FAKE_UUID}/media`,
      {
        headers: bearerHeaders(),
      },
    );
    expect(res.status).toBe(400);
  });
});

describeE2E("Group E: advertising / campaigns", () => {
  test("GET /api/v1/advertising/campaigns/:id rejects unauthenticated", async () => {
    const res = await api.get(`/api/v1/advertising/campaigns/${FAKE_UUID}`);
    expectAuthGate(res.status, "GET advertising/campaigns/:id");
  });

  test("GET /api/v1/advertising/campaigns/:id returns 404 for unknown id", async () => {
    const res = await api.get(`/api/v1/advertising/campaigns/${FAKE_UUID}`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test("PATCH /api/v1/advertising/campaigns/:id rejects invalid body with 400", async () => {
    const res = await api.patch(
      `/api/v1/advertising/campaigns/${FAKE_UUID}`,
      { budgetAmount: "not-a-number", startDate: "definitely-not-an-iso-date" },
      { headers: bearerHeaders() },
    );
    // The schema rejects the body before any campaign lookup runs.
    expect(res.status).toBe(400);
  });

  test("DELETE /api/v1/advertising/campaigns/:id rejects unauthenticated", async () => {
    const res = await api.delete(`/api/v1/advertising/campaigns/${FAKE_UUID}`);
    expectAuthGate(res.status, "DELETE advertising/campaigns/:id");
  });

  test("GET /api/v1/advertising/campaigns/:id/analytics rejects unauthenticated", async () => {
    const res = await api.get(
      `/api/v1/advertising/campaigns/${FAKE_UUID}/analytics`,
    );
    expectAuthGate(res.status, "GET advertising/campaigns/:id/analytics");
  });

  test("GET /api/v1/advertising/campaigns/:id/analytics rejects bad date range with 400", async () => {
    const res = await api.get(
      `/api/v1/advertising/campaigns/${FAKE_UUID}/analytics?startDate=2024-12-31T00:00:00Z&endDate=2024-01-01T00:00:00Z`,
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("date");
  });

  test("GET /api/v1/advertising/campaigns/:id/creatives rejects unauthenticated", async () => {
    const res = await api.get(
      `/api/v1/advertising/campaigns/${FAKE_UUID}/creatives`,
    );
    expectAuthGate(res.status, "GET advertising/campaigns/:id/creatives");
  });

  test("POST /api/v1/advertising/campaigns/:id/creatives rejects invalid body with 400", async () => {
    const res = await api.post(
      `/api/v1/advertising/campaigns/${FAKE_UUID}/creatives`,
      { name: 0, type: "not-a-real-type" },
      { headers: bearerHeaders() },
    );
    // The creative schema rejects the body before any campaign lookup runs.
    expect(res.status).toBe(400);
  });

  test("POST /api/v1/advertising/campaigns/:id/pause rejects unauthenticated", async () => {
    const res = await api.post(
      `/api/v1/advertising/campaigns/${FAKE_UUID}/pause`,
    );
    expectAuthGate(res.status, "POST advertising/campaigns/:id/pause");
  });

  test("POST /api/v1/advertising/campaigns/:id/start rejects unauthenticated", async () => {
    const res = await api.post(
      `/api/v1/advertising/campaigns/${FAKE_UUID}/start`,
    );
    expectAuthGate(res.status, "POST advertising/campaigns/:id/start");
  });

  test("POST /api/v1/advertising/campaigns/:id/start returns 404 for unknown campaign", async () => {
    const res = await api.post(
      `/api/v1/advertising/campaigns/${FAKE_UUID}/start`,
      undefined,
      {
        headers: bearerHeaders(),
      },
    );
    // FAKE_UUID is well-formed; the campaign lookup misses → 404.
    expect(res.status).toBe(404);
  });
});

describeE2E("Group E: advertising / creatives", () => {
  test("GET /api/v1/advertising/creatives/:id rejects unauthenticated", async () => {
    const res = await api.get(`/api/v1/advertising/creatives/${FAKE_UUID}`);
    expectAuthGate(res.status, "GET advertising/creatives/:id");
  });

  test("PATCH /api/v1/advertising/creatives/:id rejects invalid body with 400", async () => {
    const res = await api.patch(
      `/api/v1/advertising/creatives/${FAKE_UUID}`,
      { media: [{ url: "not-a-url" }] },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(400);
  });

  test("DELETE /api/v1/advertising/creatives/:id rejects unauthenticated", async () => {
    const res = await api.delete(`/api/v1/advertising/creatives/${FAKE_UUID}`);
    expectAuthGate(res.status, "DELETE advertising/creatives/:id");
  });
});

describeE2E("Group E: training / vertex tune Worker boundary", () => {
  test("POST /api/training/vertex/tune rejects unauthenticated", async () => {
    const res = await api.post("/api/training/vertex/tune", {
      datasetUri: "gs://demo",
    });
    expectAuthGate(res.status, "POST training/vertex/tune");
  });

  test("POST /api/training/vertex/tune returns 501 (node:fs blocker)", async () => {
    const res = await api.post(
      "/api/training/vertex/tune",
      { datasetUri: "gs://demo" },
      { headers: bearerHeaders() },
    );
    // Worker boundary stub (node:fs blocker) — exactly 501 until migrated.
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe("not_yet_migrated");
  });

  test("GET /api/training/vertex/tune rejects unauthenticated", async () => {
    const res = await api.get("/api/training/vertex/tune");
    expectAuthGate(res.status, "GET training/vertex/tune");
  });
});

describeE2E("Group E: session-cookie sanity check", () => {
  test("can exchange API key for session cookie (sanity that base harness works)", async () => {
    const freshCookie = await exchangeApiKeyForSession();
    expect(freshCookie).toMatch(/^[^=]+=.+/);
  });
});

describeE2E("Group E: admin / docker control-plane forwarding", () => {
  test("POST /api/v1/admin/docker-nodes/:nodeId/health-check forwards to the control plane", async () => {
    const unauthed = await api.post(
      `/api/v1/admin/docker-nodes/${FAKE_UUID}/health-check`,
    );
    expectAuthGate(
      unauthed.status,
      "POST docker-nodes/:nodeId/health-check (unauth)",
    );

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
    ]).toContain(body.code ?? "");
  });
});
