/**
 * Group N — App compliance-review gate (#10732, live e2e).
 *
 * Exercises automated allow/ban review and the independent retirement of
 * creator monetization. Review status remains observable, but no status may
 * reopen the retired monetization endpoint: authenticated attempts return
 * HTTP 410 with the typed creator_monetization_retired refusal.
 *
 * The live classifier case runs only when a provider key is available.
 * Deterministic cases cover draft, rejected, and directly approved apps.
 *
 * Skip behavior: with REQUIRE_E2E_SERVER=0 and no reachable Worker (or no
 * bootstrapped TEST_API_KEY) every test in this file reports as a counted,
 * named `skip` — never a silent pass.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  api,
  bearerHeaders,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";
import { approveAppInDb, hasReviewModel } from "./_helpers/review";

const MAX_COLD_ADMISSION_ATTEMPTS = 3;

async function submitReviewAfterColdAdmission(
  appId: string,
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_COLD_ADMISSION_ATTEMPTS; attempt += 1) {
    const response = await api.post(
      `/api/v1/apps/${appId}/review`,
      {},
      { headers: bearerHeaders() },
    );
    if (response.status !== 503) {
      return response;
    }

    const body = (await response.clone().json()) as {
      success?: boolean;
      error?: string;
      code?: string;
      details?: { retryable?: boolean; retryAfterSeconds?: number };
    };
    expect(body).toEqual({
      success: false,
      error: "Generative admission cache is warming; retry shortly",
      code: "service_unavailable",
      details: { retryable: true, retryAfterSeconds: 1 },
    });

    if (attempt < MAX_COLD_ADMISSION_ATTEMPTS) {
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfterSeconds = retryAfterHeader
        ? Number(retryAfterHeader)
        : body.details?.retryAfterSeconds;
      expect(Number.isFinite(retryAfterSeconds)).toBe(true);
      expect(retryAfterSeconds).toBeGreaterThan(0);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.ceil((retryAfterSeconds ?? 1) * 1_000)),
      );
    }
  }

  throw new Error("Cold admission retry loop exited without a response");
}

async function expectMonetizationRetired(response: Response): Promise<void> {
  expect(response.status).toBe(410);
  expect(await response.json()).toMatchObject({
    success: false,
    code: "creator_monetization_retired",
    details: {
      capability: "app_monetization",
      statement: "/api/v1/earnings/statement",
    },
  });
}

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
if (!serverReachable) {
  console.warn(
    `[group-n-review-gate] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-n-review-gate] TEST_API_KEY is not set; the preload could not " +
      "bootstrap a test API key. Tests will SKIP.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);

const createdAppIds: string[] = [];

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

afterAll(async () => {
  if (!serverReachable || !hasTestApiKey) return;
  for (const appId of createdAppIds) {
    await api.delete(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, {
      headers: bearerHeaders(),
    });
  }
});

describeE2E("App compliance-review gate", () => {
  test("auth gate: submit review without credentials is rejected", async () => {
    const res = await api.post(
      "/api/v1/apps/00000000-0000-4000-8000-000000000000/review",
      {},
    );
    // /api/v1/apps/* is not in publicPathPrefixes → the global auth
    // middleware rejects with 401 before any handler-level 403 can apply.
    expect(res.status).toBe(401);
  });

  test("a newly created app starts in review_status=draft", async () => {
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

  test("draft app cannot enable retired monetization", async () => {
    const appId = await createApp(
      "Unreviewed Monetizer",
      "wants to monetize before review",
    );
    const res = await api.put(
      `/api/v1/apps/${appId}/monetization`,
      { monetizationEnabled: true },
      { headers: bearerHeaders() },
    );
    await expectMonetizationRetired(res);
  });

  test("prohibited listing is BANNED by the pre-filter (no model needed)", async () => {
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
    await expectMonetizationRetired(mon);
  });

  test("approval cannot reopen retired creator monetization", async () => {
    const appId = await createApp(
      "Recipe Finder",
      "Find dinner recipes from your pantry.",
    );

    // Prove retirement also applies to an approved app.
    await approveAppInDb(appId);

    // Evict the creation-time cache after the direct database approval.
    const bust = await api.patch(
      `/api/v1/apps/${appId}`,
      { logo_url: "https://example.com/logo.png" },
      { headers: bearerHeaders() },
    );
    expect(bust.status).toBe(200);
    const review = await api.get(`/api/v1/apps/${appId}/review`, {
      headers: bearerHeaders(),
    });
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({ review_status: "approved" });

    const mon = await api.put(
      `/api/v1/apps/${appId}/monetization`,
      { monetizationEnabled: true, purchaseSharePercentage: 20 },
      { headers: bearerHeaders() },
    );
    await expectMonetizationRetired(mon);
  });

  // Loud, counted skip when no review-model provider key is present.
  test.skipIf(!hasReviewModel())(
    "live classifier approves a clean listing (model-gated)",
    async () => {
      const appId = await createApp(
        "PixelPad",
        "A collaborative pixel-art drawing canvas for hobbyists.",
      );
      const res = await submitReviewAfterColdAdmission(appId);
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

      const mon = await api.put(
        `/api/v1/apps/${appId}/monetization`,
        { monetizationEnabled: true },
        { headers: bearerHeaders() },
      );
      await expectMonetizationRetired(mon);
    },
  );
});
