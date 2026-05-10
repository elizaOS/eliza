/**
 * E2E: Full Mini App Lifecycle
 *
 * Tests the complete journey an agent/developer takes to create,
 * configure, monetize, and manage a mini app via the Cloud API.
 *
 * Requires: TEST_API_KEY env var pointing at a live Cloud account.
 *
 * Flow:
 *   check name → create app → verify → update → enable monetization →
 *   verify monetization → check earnings → get public info →
 *   list apps → delete → verify deleted
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as api from "../helpers/api-client";
import {
  createTestApp,
  deleteTestApp,
  enableMonetization,
  getEarnings,
  getMonetization,
  getPublicAppInfo,
  testAppPayload,
} from "../helpers/app-lifecycle";
import { readJson } from "../helpers/json-body";

setDefaultTimeout(30_000);

type AppSummary = {
  id: string;
  name?: string;
  description?: string;
  is_active?: boolean;
};

type CheckNameResponse = {
  success: boolean;
  available: boolean;
  slug?: string;
};

type AppResponse = {
  success: boolean;
  app: AppSummary;
};

type AppListResponse = { apps?: AppSummary[] } | AppSummary[];

type EarningsHistoryResponse = {
  success: boolean;
};

type RegenerateApiKeyResponse = {
  success: boolean;
  apiKey: string;
};

type DeleteAppResponse = {
  success: boolean;
};

describe("Mini App Lifecycle", () => {
  let appId: string;
  let appApiKey: string;
  const payload = testAppPayload();

  afterAll(async () => {
    if (appId) {
      await deleteTestApp(appId).catch(() => {});
    }
  });

  // ── Step 1: Check name availability ─────────────────────────────
  test("POST /api/v1/apps/check-name validates availability", async () => {
    const response = await api.post(
      "/api/v1/apps/check-name",
      { name: payload.name },
      { authenticated: true },
    );
    expect(response.status).toBe(200);

    const body = await readJson<CheckNameResponse>(response);
    expect(body.success).toBe(true);
    expect(body.available).toBe(true);
    expect(typeof body.slug).toBe("string");
  });

  // ── Step 2: Create app ──────────────────────────────────────────
  test("POST /api/v1/apps creates an app with API key", async () => {
    const { response, body } = await createTestApp({
      name: payload.name,
      description: payload.description,
      app_url: payload.app_url,
    });
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.app).toBeDefined();
    expect(body.app.name).toBe(payload.name);
    expect(body.app.id).toBeDefined();
    expect(typeof body.apiKey).toBe("string");

    appId = body.app.id;
    appApiKey = body.apiKey;
  });

  // ── Step 3: Verify created app ──────────────────────────────────
  test("GET /api/v1/apps/[id] returns created app", async () => {
    const response = await api.get(`/api/v1/apps/${appId}`, {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<AppResponse>(response);
    expect(body.success).toBe(true);
    expect(body.app.id).toBe(appId);
    expect(body.app.name).toBe(payload.name);
    expect(body.app.is_active).toBe(true);
  });

  // ── Step 4: Check name is now taken ─────────────────────────────
  test("POST /api/v1/apps/check-name detects conflict", async () => {
    const response = await api.post(
      "/api/v1/apps/check-name",
      { name: payload.name },
      { authenticated: true },
    );
    expect(response.status).toBe(200);

    const body = await readJson<CheckNameResponse>(response);
    expect(body.success).toBe(true);
    expect(body.available).toBe(false);
  });

  // ── Step 5: Update app details ──────────────────────────────────
  test("PUT /api/v1/apps/[id] updates app metadata", async () => {
    const response = await api.put(
      `/api/v1/apps/${appId}`,
      {
        description: "Updated by E2E test",
        website_url: "https://updated.example.com",
        contact_email: "e2e@test.local",
      },
      { authenticated: true },
    );
    expect(response.status).toBe(200);

    const body = await readJson<AppResponse>(response);
    expect(body.success).toBe(true);
    expect(body.app.description).toBe("Updated by E2E test");
  });

  // ── Step 6: Enable monetization ─────────────────────────────────
  test("PUT /api/v1/apps/[id]/monetization enables earnings", async () => {
    const { response, body } = await enableMonetization(appId, {
      inferenceMarkupPercentage: 50,
      purchaseSharePercentage: 10,
    });
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  // ── Step 7: Verify monetization persisted ───────────────────────
  test("GET /api/v1/apps/[id]/monetization returns settings", async () => {
    const { response, body } = await getMonetization(appId);
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.monetization).toBeDefined();
    expect(body.monetization.monetizationEnabled).toBe(true);
    expect(body.monetization.inferenceMarkupPercentage).toBe(50);
    expect(body.monetization.purchaseSharePercentage).toBe(10);
  });

  // ── Step 8: Check earnings (should be zero for new app) ─────────
  test("GET /api/v1/apps/[id]/earnings returns earnings structure", async () => {
    const { response, body } = await getEarnings(appId);
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.earnings).toBeDefined();
    expect(body.earnings.summary).toBeDefined();
    expect(typeof body.earnings.summary.totalLifetimeEarnings).toBe("number");
    expect(body.earnings.summary.totalLifetimeEarnings).toBe(0);
    expect(body.monetization).toBeDefined();
    expect(body.monetization.enabled).toBe(true);
  });

  // ── Step 9: Get public app info ─────────────────────────────────
  test("GET /api/v1/apps/[id]/public returns public info", async () => {
    const { response, body } = await getPublicAppInfo(appId);
    // Public endpoint requires is_active && is_approved
    // Newly created apps default to both true
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.app).toBeDefined();
    expect(body.app.id).toBe(appId);
    expect(body.app.name).toBe(payload.name);
  });

  // ── Step 10: Verify app appears in list ─────────────────────────
  test("GET /api/v1/apps includes the new app", async () => {
    const response = await api.get("/api/v1/apps", { authenticated: true });
    expect(response.status).toBe(200);

    const body = await readJson<AppListResponse>(response);
    const apps = Array.isArray(body) ? body : (body.apps ?? []);
    expect(Array.isArray(apps)).toBe(true);

    const found = apps.find((a) => a.id === appId);
    expect(found).toBeDefined();
  });

  // ── Step 11: Update monetization markup ─────────────────────────
  test("PUT /api/v1/apps/[id]/monetization updates markup", async () => {
    const { response, body } = await enableMonetization(appId, {
      inferenceMarkupPercentage: 100,
      purchaseSharePercentage: 15,
    });
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);

    // Verify update persisted
    const { body: verify } = await getMonetization(appId);
    expect(verify.monetization.inferenceMarkupPercentage).toBe(100);
    expect(verify.monetization.purchaseSharePercentage).toBe(15);
  });

  // ── Step 12: Disable monetization ───────────────────────────────
  test("PUT /api/v1/apps/[id]/monetization can disable", async () => {
    const response = await api.put(
      `/api/v1/apps/${appId}/monetization`,
      { monetizationEnabled: false },
      { authenticated: true },
    );
    expect(response.status).toBe(200);

    const { body } = await getMonetization(appId);
    expect(body.monetization.monetizationEnabled).toBe(false);
  });

  // ── Step 13: Earnings history (empty for new app) ───────────────
  test("GET /api/v1/apps/[id]/earnings/history returns history", async () => {
    const response = await api.get(`/api/v1/apps/${appId}/earnings/history`, {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<EarningsHistoryResponse>(response);
    expect(body.success).toBe(true);
  });

  // ── Step 14: Regenerate app API key ─────────────────────────────
  test("POST /api/v1/apps/[id]/regenerate-api-key rotates key", async () => {
    const response = await api.post(
      `/api/v1/apps/${appId}/regenerate-api-key`,
      {},
      { authenticated: true },
    );
    // Accept 200 or 404 (endpoint may not exist on all deployments)
    expect([200, 404]).toContain(response.status);

    if (response.status === 200) {
      const body = await readJson<RegenerateApiKeyResponse>(response);
      expect(body.success).toBe(true);
      expect(typeof body.apiKey).toBe("string");
      expect(body.apiKey).not.toBe(appApiKey);
    }
  });

  // ── Step 15: Delete app ─────────────────────────────────────────
  test("DELETE /api/v1/apps/[id] removes the app", async () => {
    const response = await api.del(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, {
      authenticated: true,
    });
    expect(response.status).toBe(200);

    const body = await readJson<DeleteAppResponse>(response);
    expect(body.success).toBe(true);
  });

  // ── Step 16: Verify deleted ─────────────────────────────────────
  test("GET /api/v1/apps/[id] returns 404 after delete", async () => {
    const response = await api.get(`/api/v1/apps/${appId}`, {
      authenticated: true,
    });
    expect(response.status).toBe(404);

    // Prevent afterAll from trying to delete again
    appId = "";
  });
});

// ── Error cases ─────────────────────────────────────────────────────
describe("Mini App Lifecycle — Error Cases", () => {
  test("POST /api/v1/apps rejects invalid payload", async () => {
    const response = await api.post("/api/v1/apps", { name: "" }, { authenticated: true });
    expect(response.status).toBe(400);
  });

  test("POST /api/v1/apps rejects invalid URL", async () => {
    const response = await api.post(
      "/api/v1/apps",
      { name: "Test", app_url: "not-a-url" },
      { authenticated: true },
    );
    expect(response.status).toBe(400);
  });

  test("POST /api/v1/apps requires auth", async () => {
    const response = await api.post("/api/v1/apps", testAppPayload());
    expect([401, 403]).toContain(response.status);
  });

  test("GET /api/v1/apps requires auth", async () => {
    const response = await api.get("/api/v1/apps");
    expect([401, 403]).toContain(response.status);
  });
});
