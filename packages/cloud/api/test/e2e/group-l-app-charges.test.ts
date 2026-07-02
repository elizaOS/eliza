/**
 * Group L — App charges + app update + the #10423 monetization attribution
 * money chain.
 *
 * Skip behavior: with REQUIRE_E2E_SERVER=0 and no reachable Worker (or no
 * bootstrapped TEST_API_KEY) every test in this file reports as a counted,
 * named `skip` — never a silent pass. The #10423 live-inference test
 * additionally skips loudly unless the Worker can actually forward an
 * inference (provider key in this env, or E2E_LIVE_INFERENCE=1 when the
 * target Worker is known to hold one — e.g. staging).
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  api,
  bearerHeaders,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";
import {
  countAiRequestDebitsSince,
  countAppEarningsSince,
} from "./_helpers/ledger";
import { approveAppInDb } from "./_helpers/review";

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
if (!serverReachable) {
  console.warn(
    `[group-l-app-charges] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-l-app-charges] TEST_API_KEY is not set; the preload could not " +
      "bootstrap a test API key. Tests will SKIP.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker/key is absent.
const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);

// The #10423 attribution test drives a REAL /api/v1/chat/completions forward,
// which needs a provider key on the Worker. The local lane shares this
// process env with wrangler dev; a remote target (staging) opts in via
// E2E_LIVE_INFERENCE=1.
const liveInferenceAvailable = Boolean(
  process.env.OPENAI_API_KEY?.trim() ||
    process.env.AI_GATEWAY_API_KEY?.trim() ||
    process.env.E2E_LIVE_INFERENCE === "1",
);
if (!liveInferenceAvailable) {
  console.warn(
    "[group-l-app-charges] no provider key (OPENAI_API_KEY / " +
      "AI_GATEWAY_API_KEY) and E2E_LIVE_INFERENCE!=1 — the #10423 live " +
      "attribution test will SKIP.",
  );
}

const createdAppIds: string[] = [];

async function createTestApp(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await api.post(
    "/api/v1/apps",
    {
      name: `Dollar Charge ${suffix}`,
      description: "One dollar app charge regression test",
      app_url: "https://example.com/app",
      website_url: "https://example.com",
      allowed_origins: ["https://example.com"],
      skipGitHubRepo: true,
      ...overrides,
    },
    { headers: bearerHeaders() },
  );

  expect(res.status).toBe(200);
  const body = (await res.json()) as { app?: { id?: string } };
  expect(body.app?.id).toBeTruthy();
  const appId = body.app?.id as string;
  createdAppIds.push(appId);
  // Charges require a compliance-approved app (#10732). This suite exercises the
  // charge/settlement path, not the review gate, so approve the app directly.
  await approveAppInDb(appId);
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

describeE2E("App charge requests", () => {
  test("auth gate: rejects one dollar charge creation without credentials", async () => {
    const res = await api.post(
      "/api/v1/apps/00000000-0000-4000-8000-000000000000/charges",
      {
        amount: 1,
      },
    );
    expect(res.status).toBe(401);
  });

  test("happy path: creates a five dollar card/crypto charge with callback metadata", async () => {
    const appId = await createTestApp();

    const res = await api.post(
      `/api/v1/apps/${appId}/charges`,
      {
        amount: 5,
        description: "Agent says: sure, please send me $5",
        providers: ["stripe", "oxapay"],
        callback_url: "https://example.com/payment-callback",
        callback_secret: "test-callback-secret",
        callback_channel: {
          source: "cloud",
          roomId: "00000000-0000-4000-8000-000000000001",
          agentId: "00000000-0000-4000-8000-000000000002",
        },
        callback_metadata: {
          initiatedBy: "group-l-app-charges",
        },
      },
      { headers: bearerHeaders() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      charge?: {
        id?: string;
        appId?: string;
        amountUsd?: number;
        paymentUrl?: string;
        status?: string;
        providers?: string[];
        metadata?: Record<string, unknown>;
      };
    };

    expect(body.success).toBe(true);
    expect(body.charge?.appId).toBe(appId);
    expect(body.charge?.amountUsd).toBe(5);
    expect(body.charge?.status).toBe("requested");
    expect(body.charge?.providers).toEqual(["stripe", "oxapay"]);
    expect(body.charge?.paymentUrl).toContain(`/payment/app-charge/${appId}/`);
    expect(body.charge?.metadata?.callback_secret).toBeUndefined();
    expect(body.charge?.metadata?.callback_secret_set).toBe(true);

    const publicRes = await api.get(
      `/api/v1/apps/${appId}/charges/${body.charge?.id}`,
    );
    expect(publicRes.status).toBe(200);
    const publicBody = (await publicRes.json()) as {
      charge?: { amountUsd?: number; metadata?: Record<string, unknown> };
      app?: { id?: string; name?: string };
    };
    expect(publicBody.charge?.amountUsd).toBe(5);
    expect(publicBody.app?.id).toBe(appId);
    expect(publicBody.charge?.metadata?.callback_secret).toBeUndefined();

    const listRes = await api.get(`/api/v1/apps/${appId}/charges?limit=5`, {
      headers: bearerHeaders(),
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      charges?: Array<{ id?: string; amountUsd?: number; paymentUrl?: string }>;
    };
    const listed = listBody.charges?.find(
      (charge) => charge.id === body.charge?.id,
    );
    expect(listed?.amountUsd).toBe(5);
    expect(listed?.paymentUrl).toBe(body.charge?.paymentUrl);
  });

  test("validation: rejects charges below one dollar", async () => {
    const appId = await createTestApp();
    const res = await api.post(
      `/api/v1/apps/${appId}/charges`,
      { amount: 0.99 },
      { headers: bearerHeaders() },
    );

    expect(res.status).toBe(400);
  });
});

// -------- POST /api/v1/apps/check-name -------------------------------------

describeE2E("POST /api/v1/apps/check-name", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.post("/api/v1/apps/check-name", { name: "anything" });
    expect(res.status).toBe(401);
  });

  test("happy path: a fresh name is available; a taken name is not", async () => {
    const fresh = `check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const freshRes = await api.post(
      "/api/v1/apps/check-name",
      { name: fresh },
      { headers: bearerHeaders() },
    );
    expect(freshRes.status).toBe(200);
    expect(((await freshRes.json()) as { available?: boolean }).available).toBe(
      true,
    );

    // After creating an app, querying its exact name reports unavailable.
    const appId = await createTestApp();
    const detail = await api.get(`/api/v1/apps/${appId}`, {
      headers: bearerHeaders(),
    });
    const takenName = ((await detail.json()) as { app?: { name?: string } }).app
      ?.name;
    if (takenName) {
      const takenRes = await api.post(
        "/api/v1/apps/check-name",
        { name: takenName },
        { headers: bearerHeaders() },
      );
      expect(takenRes.status).toBe(200);
      expect(
        ((await takenRes.json()) as { available?: boolean }).available,
      ).toBe(false);
    }
  });
});

// -------- PUT /api/v1/apps/:id (update) ------------------------------------

describeE2E("PUT /api/v1/apps/:id", () => {
  test("auth gate: 401 without credentials", async () => {
    const res = await api.put(
      "/api/v1/apps/00000000-0000-4000-8000-000000000000",
      { description: "x" },
    );
    expect(res.status).toBe(401);
  });

  test("happy path: updates a freshly created app", async () => {
    const appId = await createTestApp();
    const res = await api.put(
      `/api/v1/apps/${appId}`,
      { description: "updated by group-l PUT test" },
      { headers: bearerHeaders() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      app?: { id?: string; description?: string };
    };
    expect(body.success).toBe(true);
    expect(body.app?.id).toBe(appId);
    expect(body.app?.description).toBe("updated by group-l PUT test");
  });

  test("validation: 404 for an unknown id", async () => {
    const res = await api.put(
      "/api/v1/apps/00000000-0000-4000-8000-000000000000",
      { description: "x" },
      { headers: bearerHeaders() },
    );
    // A syntactically valid UUID that isn't in the DB → 404 (400 is reserved
    // for malformed ids, covered by group-i).
    expect(res.status).toBe(404);
  });

  // #10423 item 3 — per-app monetization attribution end-to-end. Proves the
  // money chain the issue requires: a monetized app's inference charge lands on
  // the app's credits and the creator's earnings (not just the caller's org).
  // The platform-authoritative ELIZA_APP_ID injection into deployed containers
  // (items 1-2) is unit/integration-tested in #10433; this asserts the live
  // billing attribution via the X-App-Id inference header. Skip-gated like every
  // group-* e2e — runs in the staging lane with TEST_API_KEY + a provider key.
  test.skipIf(!liveInferenceAvailable)(
    "monetized app: an inference charge attributes to the app's credits + creator earnings (#10423)",
    async () => {
      // 1) create the app monetized from the start. Enabling monetization via a
      //    follow-up PUT races the app service's Redis SWR cache (~5 min TTL by
      //    design, apps.ts:108): getAuthorizedMonetizedAppForUser can read the
      //    pre-toggle row and silently skip attribution. Monetization-at-create
      //    means the first cache fill is already monetized — and matches how the
      //    create flows (dashboard + plugin) actually create monetized apps.
      const markupPct = 25;
      const appId = await createTestApp({
        monetization_enabled: true,
        inference_markup_percentage: markupPct,
      });

      // 2) baseline the caller-org LEDGER + the app's creator earnings. The
      //    attributed inference debits the calling org's credits (base + markup)
      //    unless the caller holds a funded per-app wallet (app_credit_balances)
      //    — which this fresh test user never does. The balance ENDPOINT serves
      //    a 5-min-cached value by design, so the debit is asserted against the
      //    credit_transactions ledger (the source of truth) instead.
      const ledgerBaselineAt = new Date();

      // The earnings endpoint must at least SERVE for the creator (its value
      // rides the same ~5-min app-row cache, so the increase itself is asserted
      // from the app_earnings_transactions ledger below).
      const baselineEarningsRes = await api.get(
        `/api/v1/apps/${appId}/earnings`,
        { headers: bearerHeaders() },
      );
      expect(baselineEarningsRes.status).toBe(200);

      // 3) drive a real inference attributed to the app via the X-App-Id header.
      const inferenceRes = await api.post(
        "/api/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          // Providers enforce a 16-token minimum on max_output_tokens; 8 made
          // the forward 400 upstream (surfaced as a Worker 500) on staging.
          max_tokens: 32,
          messages: [{ role: "user", content: "Say hi in one word." }],
        },
        {
          headers: {
            ...bearerHeaders(),
            "X-App-Id": appId,
          },
        },
      );
      // If the staging Worker has no configured provider key the forward 502s —
      // that's an env gap, not an attribution failure, so assert 200 explicitly.
      expect(inferenceRes.status).toBe(200);
      const usage = (
        (await inferenceRes.json()) as {
          usage?: { total_tokens?: number };
        }
      ).usage;
      expect(usage?.total_tokens).toBeGreaterThan(0);

      // 4) reconcile fires post-response in the settle chain — poll briefly for the
      //    debit + the creator-earnings credit to land.
      let orgDebitLanded = false;
      let earningsIncreased = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        if (!orgDebitLanded) {
          orgDebitLanded =
            (await countAiRequestDebitsSince(ledgerBaselineAt)) > 0;
        }

        // The earnings ENDPOINT reads the app row through the same ~5-min SWR
        // cache, so poll the app_earnings_transactions ledger (the actual money
        // artifact #11021's two-leg dedupe writes) instead.
        if (!earningsIncreased) {
          earningsIncreased =
            (await countAppEarningsSince(appId, ledgerBaselineAt)) > 0;
        }

        if (orgDebitLanded && earningsIncreased) break;
      }

      // The org paid (base + markup, visible in the ledger) AND the creator
      // earned the markup — i.e. the charge attributed to the app, not just
      // consumed the caller's credits invisibly.
      expect(orgDebitLanded).toBe(true);
      expect(earningsIncreased).toBe(true);
    },
  );
});
