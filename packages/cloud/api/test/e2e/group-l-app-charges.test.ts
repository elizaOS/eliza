import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  api,
  bearerHeaders,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";
import { approveAppInDb } from "./_helpers/review";

let serverReachable = false;
let hasTestApiKey = false;
const createdAppIds: string[] = [];

function shouldRunAuthed(): boolean {
  return serverReachable && hasTestApiKey;
}

async function createTestApp(): Promise<string> {
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

beforeAll(async () => {
  hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
  serverReachable = await isServerReachable();
  if (!serverReachable) {
    console.warn(
      `[group-l-app-charges] ${getBaseUrl()} did not respond to /api/health. Tests will skip.`,
    );
    return;
  }
  if (!hasTestApiKey) {
    console.warn(
      "[group-l-app-charges] TEST_API_KEY is not set; auth-required tests will skip.",
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

describe("App charge requests", () => {
  test("auth gate: rejects one dollar charge creation without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.post(
      "/api/v1/apps/00000000-0000-4000-8000-000000000000/charges",
      {
        amount: 1,
      },
    );
    expect(res.status).toBe(401);
  });

  test("happy path: creates a five dollar card/crypto charge with callback metadata", async () => {
    if (!shouldRunAuthed()) return;
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
    if (!shouldRunAuthed()) return;
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

describe("POST /api/v1/apps/check-name", () => {
  test("auth gate: 401 without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/v1/apps/check-name", { name: "anything" });
    expect(res.status).toBe(401);
  });

  test("happy path: a fresh name is available; a taken name is not", async () => {
    if (!shouldRunAuthed()) return;
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

describe("PUT /api/v1/apps/:id", () => {
  test("auth gate: 401 without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.put(
      "/api/v1/apps/00000000-0000-4000-8000-000000000000",
      { description: "x" },
    );
    expect(res.status).toBe(401);
  });

  test("happy path: updates a freshly created app", async () => {
    if (!shouldRunAuthed()) return;
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
    if (!shouldRunAuthed()) return;
    const res = await api.put(
      "/api/v1/apps/00000000-0000-4000-8000-000000000000",
      { description: "x" },
      { headers: bearerHeaders() },
    );
    expect([400, 404]).toContain(res.status);
  });

  // #10423 item 3 — per-app monetization attribution end-to-end. Proves the
  // money chain the issue requires: a monetized app's inference charge lands on
  // the app's credits and the creator's earnings (not just the caller's org).
  // The platform-authoritative ELIZA_APP_ID injection into deployed containers
  // (items 1-2) is unit/integration-tested in #10433; this asserts the live
  // billing attribution via the X-App-Id inference header. Skip-gated like every
  // group-* e2e — runs in the staging lane with TEST_API_KEY + a provider key.
  test("monetized app: an inference charge attributes to the app's credits + creator earnings (#10423)", async () => {
    if (!shouldRunAuthed()) return;

    // 1) create the app and enable monetization with a markup.
    const appId = await createTestApp();
    const markupPct = 25;
    const monetizeRes = await api.put(
      `/api/v1/apps/${appId}`,
      { monetization_enabled: true, inference_markup_percentage: markupPct },
      { headers: bearerHeaders() },
    );
    expect(monetizeRes.status).toBe(200);

    // 2) baseline the org credit balance + the app's creator earnings.
    const baselineBalanceRes = await api.get("/api/v1/app-credits/balance", {
      headers: bearerHeaders(),
    });
    expect(baselineBalanceRes.status).toBe(200);
    const baselineBalance = Number(
      ((await baselineBalanceRes.json()) as { credit_balance?: number })
        .credit_balance ?? 0,
    );

    const baselineEarningsRes = await api.get(
      `/api/v1/apps/${appId}/earnings`,
      { headers: bearerHeaders() },
    );
    expect(baselineEarningsRes.status).toBe(200);
    const baselineEarnings = Number(
      (
        (await baselineEarningsRes.json()) as {
          total_creator_earnings?: number;
        }
      ).total_creator_earnings ?? 0,
    );

    // 3) drive a real inference attributed to the app via the X-App-Id header.
    const inferenceRes = await api.post(
      "/api/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        max_tokens: 8,
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
    let balanceDropped = false;
    let earningsIncreased = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((r) => setTimeout(r, 750));
      const balanceRes = await api.get("/api/v1/app-credits/balance", {
        headers: bearerHeaders(),
      });
      const balanceNow = Number(
        ((await balanceRes.json()) as { credit_balance?: number })
          .credit_balance ?? baselineBalance,
      );
      if (balanceNow < baselineBalance) balanceDropped = true;

      const earningsRes = await api.get(`/api/v1/apps/${appId}/earnings`, {
        headers: bearerHeaders(),
      });
      const earningsNow = Number(
        ((await earningsRes.json()) as { total_creator_earnings?: number })
          .total_creator_earnings ?? baselineEarnings,
      );
      if (earningsNow > baselineEarnings) earningsIncreased = true;

      if (balanceDropped && earningsIncreased) break;
    }

    // The org paid (base + markup) AND the creator earned the markup — i.e. the
    // charge attributed to the app, not just consumed the caller's credits.
    expect(balanceDropped).toBe(true);
    expect(earningsIncreased).toBe(true);
  });
});
