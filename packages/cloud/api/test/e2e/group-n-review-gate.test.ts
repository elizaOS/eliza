/**
 * Group N — App compliance-review gate (#10732, live e2e).
 *
 * Exercises the automated binary allow/ban review gate and its enforcement:
 *
 *   POST /api/v1/apps/:id/review         — submit for automated review
 *   GET  /api/v1/apps/:id/review         — current review status + latest decision
 *   PUT  /api/v1/apps/:id/monetization   — 403 unless review_status = approved
 *   POST /api/v1/apps/:id/charges        — 403 unless review_status = approved
 *
 * Route handlers under test:
 *   packages/cloud/api/v1/apps/[id]/review/route.ts
 *   packages/cloud/api/v1/apps/[id]/monetization/route.ts
 *   packages/cloud/api/v1/apps/[id]/charges/route.ts
 * Gate logic:
 *   packages/cloud/shared/src/lib/services/app-review.ts
 *
 * Deterministic assertions (no model needed): draft apps are blocked, and a
 * prohibited listing is banned by the keyword pre-filter. The live-model
 * "clean listing → approved → monetize" path runs only when a provider key is
 * present (`hasReviewModel()`); the always-available proof that the gate opens
 * on approval uses a direct DB approval.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  api,
  bearerHeaders,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";
import { approveAppInDb, hasReviewModel } from "./_helpers/review";

let serverReachable = false;
let hasTestApiKey = false;
const createdAppIds: string[] = [];

function shouldRunAuthed(): boolean {
  return serverReachable && hasTestApiKey;
}

async function createApp(name: string, description: string): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await api.post(
    "/api/v1/apps",
    {
      name: `${name} ${suffix}`,
      description,
      app_url: "https://example.com/app",
      website_url: "https://example.com",
      allowed_origins: ["https://example.com"],
      skipGitHubRepo: true,
    },
    { headers: bearerHeaders() },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { app?: { id?: string } };
  const appId = body.app?.id as string;
  expect(appId).toBeTruthy();
  createdAppIds.push(appId);
  return appId;
}

beforeAll(async () => {
  hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
  serverReachable = await isServerReachable();
  if (!serverReachable) {
    console.warn(
      `[group-n-review-gate] ${getBaseUrl()} did not respond. Tests will skip.`,
    );
  }
});

afterAll(async () => {
  if (!shouldRunAuthed()) return;
  for (const appId of createdAppIds) {
    await api.delete(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, {
      headers: bearerHeaders(),
    });
  }
});

describe("App compliance-review gate", () => {
  test("auth gate: submit review without credentials is rejected", async () => {
    if (!serverReachable) return;
    const res = await api.post(
      "/api/v1/apps/00000000-0000-4000-8000-000000000000/review",
      {},
    );
    expect([401, 403]).toContain(res.status);
  });

  test("a newly created app starts in review_status=draft", async () => {
    if (!shouldRunAuthed()) return;
    const appId = await createApp(
      "Draft App",
      "A brand new app awaiting review",
    );
    const res = await api.get(`/api/v1/apps/${appId}/review`, {
      headers: bearerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { review_status?: string };
    expect(body.review_status).toBe("draft");
  });

  test("draft app CANNOT enable monetization (403)", async () => {
    if (!shouldRunAuthed()) return;
    const appId = await createApp(
      "Unreviewed Monetizer",
      "wants to monetize before review",
    );
    const res = await api.put(
      `/api/v1/apps/${appId}/monetization`,
      { monetizationEnabled: true },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      review_status?: string;
      error?: string;
    };
    expect(body.review_status).toBe("draft");
  });

  test("draft app CANNOT create a charge (403)", async () => {
    if (!shouldRunAuthed()) return;
    const appId = await createApp(
      "Unreviewed Charger",
      "wants to charge before review",
    );
    const res = await api.post(
      `/api/v1/apps/${appId}/charges`,
      { amount: 5 },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(403);
  });

  test("prohibited listing is BANNED by the pre-filter (no model needed)", async () => {
    if (!shouldRunAuthed()) return;
    // Keyword the deterministic pre-filter catches → ban, no LLM call.
    const appId = await createApp(
      "Card Shop",
      "We sell stolen credit cards and cvv dumps to anyone who pays.",
    );
    const res = await api.post(
      `/api/v1/apps/${appId}/review`,
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      review?: {
        disposition?: string;
        review_status?: string;
        matched_categories?: string[];
      };
    };
    expect(body.review?.disposition).toBe("ban");
    expect(body.review?.review_status).toBe("rejected");
    expect(body.review?.matched_categories).toContain("fraud_scams");

    // Still blocked after a ban.
    const mon = await api.put(
      `/api/v1/apps/${appId}/monetization`,
      { monetizationEnabled: true },
      { headers: bearerHeaders() },
    );
    expect(mon.status).toBe(403);
  });

  test("approval opens the gate: approved app CAN monetize and charge", async () => {
    if (!shouldRunAuthed()) return;
    const appId = await createApp(
      "Recipe Finder",
      "Find dinner recipes from your pantry.",
    );

    // Deterministic proof the gate keys off review_status: approve directly.
    await approveAppInDb(appId);
    // approveAppInDb writes Postgres directly, bypassing appsService's
    // invalidate-on-mutation — so the app row cached at creation (getById, TTL
    // 300s) still reads `draft` and the monetization gate 403s for up to 5 min
    // against a Redis-backed staging Worker. A benign API PATCH goes through
    // appsService.update → invalidateCache, evicting the stale row. (Safe:
    // review_content_hash is null so the material-change re-gate is skipped.
    // The REAL review path self-invalidates as of the app-review fix.)
    const bust = await api.patch(
      `/api/v1/apps/${appId}`,
      { logo_url: "https://example.com/logo.png" },
      { headers: bearerHeaders() },
    );
    expect(bust.status).toBe(200);

    const mon = await api.put(
      `/api/v1/apps/${appId}/monetization`,
      { monetizationEnabled: true, purchaseSharePercentage: 20 },
      { headers: bearerHeaders() },
    );
    expect(mon.status).toBe(200);

    const charge = await api.post(
      `/api/v1/apps/${appId}/charges`,
      { amount: 5, description: "unlock premium recipes" },
      { headers: bearerHeaders() },
    );
    expect(charge.status).toBe(200);
    const chargeBody = (await charge.json()) as {
      success?: boolean;
      charge?: { status?: string };
    };
    expect(chargeBody.success).toBe(true);
    expect(chargeBody.charge?.status).toBe("requested");
  });

  test("live classifier approves a clean listing (model-gated)", async () => {
    if (!shouldRunAuthed() || !hasReviewModel()) return;
    const appId = await createApp(
      "PixelPad",
      "A collaborative pixel-art drawing canvas for hobbyists.",
    );
    const res = await api.post(
      `/api/v1/apps/${appId}/review`,
      {},
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      review?: {
        disposition?: string;
        review_status?: string;
        model?: string | null;
      };
    };
    expect(body.review?.disposition).toBe("allow");
    expect(body.review?.review_status).toBe("approved");

    // The gate is now open for a real (model-approved) app.
    const mon = await api.put(
      `/api/v1/apps/${appId}/monetization`,
      { monetizationEnabled: true },
      { headers: bearerHeaders() },
    );
    expect(mon.status).toBe(200);
  });
});
