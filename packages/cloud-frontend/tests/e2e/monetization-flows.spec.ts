// Creator-monetization write-flow coverage that had no behavioral tests. Both
// flows live on the app-detail page /dashboard/apps/:id:
//   4. Markup save (Monetize tab)   → PUT /api/v1/apps/:id/monetization
//   5. Earnings withdraw (Earnings tab) → POST /api/v1/apps/:id/earnings/withdraw
//
// Runs against the local dev build with VITE_PLAYWRIGHT_TEST_AUTH=true (the
// eliza-test-auth cookie short-circuits real auth); every /api/* call is mocked.
// Each test drives the real control and asserts the exact mutation request.

import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Monetization write flows use local mocks; skipped in live-prod mode",
);

// The app-detail page validates the :id is a UUID before fetching, so use one.
const APP_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "22222222-2222-4222-8222-222222222222";

interface Captured {
  method: string;
  path: string;
  body: unknown;
}

function appPayload() {
  const now = new Date().toISOString();
  return {
    app: {
      id: APP_ID,
      name: "Monetized App",
      description: "An app under test",
      slug: "monetized-app",
      organization_id: ORG_ID,
      created_by_user_id: USER_ID,
      app_url: "https://monetized.example.com",
      allowed_origins: [],
      api_key_id: null,
      affiliate_code: null,
      referral_bonus_credits: null,
      total_requests: 0,
      total_users: 0,
      total_credits_used: null,
      logo_url: null,
      website_url: null,
      contact_email: null,
      metadata: {},
      deployment_status: "not_deployed",
      production_url: null,
      last_deployed_at: null,
      github_repo: null,
      linked_character_ids: null,
      monetization_enabled: true,
      inference_markup_percentage: 0,
      purchase_share_percentage: 10,
      platform_offset_amount: 1,
      custom_pricing_enabled: null,
      total_creator_earnings: null,
      total_platform_revenue: null,
      discord_automation: null,
      telegram_automation: null,
      twitter_automation: null,
      promotional_assets: null,
      user_database_status: "none",
      user_database_uri: null,
      user_database_project_id: null,
      user_database_branch_id: null,
      user_database_region: null,
      user_database_error: null,
      email_notifications: null,
      response_notifications: null,
      is_active: true,
      is_approved: true,
      created_at: now,
      updated_at: now,
      last_used_at: null,
    },
  };
}

// app-monetization-settings.tsx reads { success, monetization: { ... } }.
function monetizationPayload() {
  return {
    success: true,
    monetization: {
      monetizationEnabled: true,
      inferenceMarkupPercentage: 0,
      purchaseSharePercentage: 10,
      platformOffsetAmount: 1,
      totalCreatorEarnings: 0,
    },
  };
}

// app-earnings-dashboard.tsx reads { success, earnings: { summary, breakdown, chartData, recentTransactions }, monetization }.
// withdrawableBalance must clear payoutThreshold so the "Withdraw Now" CTA shows.
function earningsPayload() {
  return {
    success: true,
    testData: false,
    monetization: { enabled: true },
    earnings: {
      summary: {
        totalLifetimeEarnings: 120,
        totalInferenceEarnings: 80,
        totalPurchaseEarnings: 40,
        pendingBalance: 0,
        withdrawableBalance: 100,
        totalWithdrawn: 0,
        payoutThreshold: 25,
      },
      breakdown: {
        today: {
          period: "today",
          inferenceEarnings: 0,
          purchaseEarnings: 0,
          total: 0,
        },
        thisWeek: {
          period: "week",
          inferenceEarnings: 0,
          purchaseEarnings: 0,
          total: 0,
        },
        thisMonth: {
          period: "month",
          inferenceEarnings: 0,
          purchaseEarnings: 0,
          total: 0,
        },
        allTime: {
          period: "all",
          inferenceEarnings: 80,
          purchaseEarnings: 40,
          total: 120,
        },
      },
      chartData: [],
      recentTransactions: [],
    },
  };
}

function userPayload() {
  const now = new Date().toISOString();
  return {
    success: true,
    data: {
      id: USER_ID,
      email: "creator@example.com",
      email_verified: true,
      wallet_address: null,
      wallet_chain_type: null,
      wallet_verified: false,
      name: "Creator",
      avatar: null,
      organization_id: ORG_ID,
      role: "owner",
      steward_user_id: "steward_1",
      telegram_id: null,
      telegram_username: null,
      telegram_first_name: null,
      telegram_photo_url: null,
      discord_id: null,
      discord_username: null,
      discord_global_name: null,
      discord_avatar_url: null,
      whatsapp_id: null,
      whatsapp_name: null,
      phone_number: null,
      phone_verified: null,
      is_anonymous: false,
      anonymous_session_id: null,
      expires_at: null,
      nickname: null,
      work_function: null,
      preferences: null,
      email_notifications: true,
      response_notifications: true,
      is_active: true,
      created_at: now,
      updated_at: now,
      organization: {
        id: ORG_ID,
        name: "Creator Org",
        slug: "creator-org",
        billing_email: "creator@example.com",
        credit_balance: "100.000000",
        is_active: true,
        created_at: now,
        updated_at: now,
      },
    },
  };
}

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    {
      name: "eliza-test-auth",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "steward_session_token",
      "playwright-test-token",
    );
  });
});

/** Mocks the app-detail page render + records mutation requests into `sink`. */
async function installAppRoutes(
  page: import("@playwright/test").Page,
  sink: Captured[],
) {
  const record = (route: import("@playwright/test").Route) => {
    const req = route.request();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    sink.push({
      method: req.method(),
      path: new URL(req.url()).pathname,
      body,
    });
  };

  // The earnings GET (and its `**` glob also matches the /withdraw POST path).
  // Register it FIRST so the more-specific /withdraw recorder below wins:
  // Playwright runs route handlers last-registered-first, so the withdraw
  // recorder must be registered AFTER this glob or the glob swallows the POST.
  await page.route(`**/api/v1/apps/${APP_ID}/earnings**`, (route) =>
    route.fulfill({ json: earningsPayload() }),
  );

  // Withdraw — registered after the earnings glob so it takes priority for the
  // POST mutation and records it.
  await page.route(
    `**/api/v1/apps/${APP_ID}/earnings/withdraw`,
    async (route) => {
      record(route);
      return route.fulfill({ json: { success: true, newBalance: 0 } });
    },
  );

  await page.route(`**/api/v1/apps/${APP_ID}/monetization`, async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      return route.fulfill({ json: monetizationPayload() });
    }
    record(route);
    return route.fulfill({ json: { success: true } });
  });

  // The app record itself (must be after the more-specific sub-routes above).
  await page.route(`**/api/v1/apps/${APP_ID}`, (route) =>
    route.fulfill({ json: appPayload() }),
  );

  await page.route("**/api/v1/user", (route) =>
    route.fulfill({ json: userPayload() }),
  );

  // Catch-all for every other /api/* render-time call. Playwright runs route
  // handlers last-registered-first, so this fires before the specific mocks
  // above — fall back to them for their exact paths/prefixes (otherwise this
  // generic `data: []` response shadows /api/v1/user and /api/v1/apps/:id and
  // the app-detail page renders "No organization" / never loads the app).
  const isSpecific = (pathname: string) =>
    pathname === "/api/v1/user" ||
    pathname === `/api/v1/apps/${APP_ID}` ||
    pathname === `/api/v1/apps/${APP_ID}/monetization` ||
    pathname.startsWith(`/api/v1/apps/${APP_ID}/earnings`);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      if (isSpecific(new URL(route.request().url()).pathname)) {
        return route.fallback();
      }
      return route.fulfill({
        json: { success: true, data: [], items: [], balance: 100 },
      });
    },
  );
}

// The /dashboard/apps surface auto-starts a first-run onboarding tour whose
// backdrop intercepts clicks; dismiss it before interacting.
async function dismissTour(page: import("@playwright/test").Page) {
  await page
    .getByRole("button", { name: /skip tour/i })
    .first()
    .click({ timeout: 8000 })
    .catch(() => {});
}

test("monetization: set markup + Save → PUT /api/v1/apps/:id/monetization", async ({
  page,
}) => {
  const calls: Captured[] = [];
  await installAppRoutes(page, calls);

  await page.goto(`/dashboard/apps/${APP_ID}?tab=monetization`);
  await expect(page).not.toHaveURL(/\/login/);
  await dismissTour(page);

  // Inference markup is a preset-button group; clicking 50% sets it + marks the
  // form dirty so the Save button enables (it's disabled until hasChanges).
  const markup50 = page.getByRole("button", { name: /^50%$/ }).first();
  await expect(markup50).toBeVisible({ timeout: 20_000 });
  await markup50.click();

  const save = page.getByRole("button", { name: /save changes/i }).first();
  await expect(save).toBeEnabled({ timeout: 10_000 });
  await save.click();

  await expect.poll(() => calls.find((c) => c.method === "PUT")).toBeTruthy();
  const put = calls.find((c) => c.method === "PUT");
  expect(put?.path).toBe(`/api/v1/apps/${APP_ID}/monetization`);
  expect(put?.body).toMatchObject({
    monetizationEnabled: true,
    inferenceMarkupPercentage: 50,
    purchaseSharePercentage: 10,
  });
});

test("earnings: withdraw dialog → POST /api/v1/apps/:id/earnings/withdraw { amount }", async ({
  page,
}) => {
  const calls: Captured[] = [];
  await installAppRoutes(page, calls);

  await page.goto(`/dashboard/apps/${APP_ID}?tab=earnings`);
  await expect(page).not.toHaveURL(/\/login/);
  await dismissTour(page);

  // withdrawableBalance (100) >= payoutThreshold (25) → "Withdraw Now" shows.
  const openWithdraw = page
    .getByRole("button", { name: /withdraw now/i })
    .first();
  await expect(openWithdraw).toBeVisible({ timeout: 20_000 });
  await openWithdraw.click();

  // The dialog seeds the amount input with the full withdrawable balance and
  // exposes a "Withdraw All" max button. Use it, then confirm.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  const amountInput = dialog.locator("#withdraw-amount");
  await amountInput.fill("40");
  // "Withdraw All" resets to the full balance (100.00) — exercise the max path.
  await dialog.getByRole("button", { name: /withdraw all/i }).click();
  await expect(amountInput).toHaveValue("100.00");

  // The confirm CTA label includes the amount: "Withdraw $100.00".
  await dialog.getByRole("button", { name: /^withdraw \$/i }).click();

  await expect.poll(() => calls.find((c) => c.method === "POST")).toBeTruthy();
  const post = calls.find((c) => c.method === "POST");
  expect(post?.path).toBe(`/api/v1/apps/${APP_ID}/earnings/withdraw`);
  expect(post?.body).toMatchObject({ amount: 100 });

  // The POST mutation (path + body) is the behavioral assertion. The
  // "Withdrawal Complete!" success dialog renders only for the brief window
  // between the POST resolving and onSuccess → handleWithdrawSuccess →
  // fetchEarnings() flipping the dashboard's isLoading back to true, which
  // unmounts the whole dashboard subtree (including this dialog) behind a
  // loading spinner before remounting it fresh in the "confirm" state. That
  // confirmation copy is therefore not reliably observable in the harness, so
  // we scope the assertion to the mutation boundary above rather than racing
  // the refetch-driven remount.
});
