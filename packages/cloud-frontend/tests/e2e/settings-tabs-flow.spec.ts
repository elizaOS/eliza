import { expect, type Page, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "settings-tabs-flow.spec uses local mocks; live-prod runs cloud-routes-live.spec instead",
);
test.describe.configure({ timeout: 90_000 });

const NOW = "2026-05-20T12:00:00.000Z";
const STEWARD_TOKEN_KEY = "steward_session_token";
const STEWARD_AUTHED_COOKIE = "steward-authed";
const FAKE_STEWARD_TOKEN = [
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0",
  "eyJ1c2VySWQiOiJ1c2VyXzEiLCJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJleHAiOjQxMDI0NDQ4MDB9",
  "signature",
].join(".");

const CURRENT_USER = {
  id: "user_1",
  email: "test@example.com",
  email_verified: true,
  wallet_address: "0x0000000000000000000000000000000000000001",
  wallet_chain_type: "evm",
  wallet_verified: true,
  name: "Test User",
  avatar: null,
  organization_id: "org_1",
  role: "owner",
  steward_user_id: null,
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
  phone_verified: false,
  is_anonymous: false,
  anonymous_session_id: null,
  expires_at: null,
  nickname: "Tester",
  work_function: "engineering",
  preferences: "Prefer concise status updates.",
  email_notifications: true,
  response_notifications: true,
  is_active: true,
  created_at: NOW,
  updated_at: NOW,
  organization: {
    id: "org_1",
    name: "Eliza QA",
    slug: "eliza-qa",
    billing_email: "billing@example.com",
    credit_balance: "123.45",
    is_active: true,
    created_at: NOW,
    updated_at: NOW,
  },
};

async function setTestAuth(page: Page) {
  await page.context().addCookies([
    {
      name: "eliza-test-auth",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
    {
      name: STEWARD_AUTHED_COOKIE,
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  await page.addInitScript(
    ({ tokenKey, token }) => {
      window.localStorage.setItem(tokenKey, token);
    },
    { tokenKey: STEWARD_TOKEN_KEY, token: FAKE_STEWARD_TOKEN },
  );
}

async function installSettingsMocks(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;

      if (path === "/api/v1/user") {
        if (request.method() === "PATCH") {
          const body = request.postDataJSON() as Partial<typeof CURRENT_USER>;
          return route.fulfill({
            json: {
              success: true,
              data: {
                ...CURRENT_USER,
                ...body,
                updated_at: NOW,
              },
            },
          });
        }
        return route.fulfill({
          json: { success: true, data: CURRENT_USER },
        });
      }

      if (path === "/api/stats/account") {
        return route.fulfill({
          json: {
            success: true,
            data: {
              totalGenerations: 12,
              totalGenerationsBreakdown: { images: 7, videos: 5 },
              apiCalls24h: 42,
              apiCalls24hSuccessful: 41,
              imageGenerationsAllTime: 121,
              videoRendersAllTime: 13,
            },
          },
        });
      }

      if (path === "/api/credits/transactions") {
        return route.fulfill({
          json: { transactions: [{ amount: "-3.25" }, { amount: "25" }] },
        });
      }

      if (path === "/api/sessions/current") {
        return route.fulfill({
          json: {
            success: true,
            data: {
              credits_used: 4.5,
              requests_made: 18,
              tokens_consumed: 9800,
            },
          },
        });
      }

      if (path === "/api/quotas/usage") {
        return route.fulfill({
          json: {
            success: true,
            data: {
              global: {
                used: 18,
                limit: 100,
                usedPercent: 18,
                usedPercentClamped: 18,
              },
              modelSpecific: {
                "eliza-test-model": {
                  used: 4,
                  limit: 25,
                  usedPercent: 16,
                  usedPercentClamped: 16,
                },
              },
            },
          },
        });
      }

      if (path === "/api/credits/balance") {
        return route.fulfill({ json: { balance: 123.45 } });
      }

      if (path === "/api/invoices/list") {
        return route.fulfill({
          json: {
            invoices: [
              {
                id: "inv_1",
                date: NOW,
                total: "25.00",
                status: "paid",
                type: "card",
                creditsAdded: 25,
              },
            ],
          },
        });
      }

      if (path === "/api/crypto/status") {
        return route.fulfill({
          json: {
            enabled: false,
            directWallet: { enabled: false },
          },
        });
      }

      if (path === "/api/v1/billing/settings") {
        return route.fulfill({
          json: {
            settings: {
              autoTopUp: {
                enabled: false,
                amount: 25,
                threshold: 10,
                hasPaymentMethod: false,
              },
              limits: {
                minAmount: 5,
                maxAmount: 1000,
                minThreshold: 1,
                maxThreshold: 500,
              },
            },
          },
        });
      }

      if (path === "/api/v1/api-keys") {
        return route.fulfill({
          json: {
            keys: [
              {
                id: "key_1",
                name: "Settings tab key",
                description: "Visible in settings",
                key_prefix: "eliza_test_pk_sett",
                is_active: true,
                permissions: ["agents:read"],
                usage_count: 3,
                rate_limit: 1000,
                created_at: NOW,
                last_used_at: null,
                expires_at: null,
              },
            ],
          },
        });
      }

      if (path === "/api/analytics/overview") {
        return route.fulfill({
          json: {
            success: true,
            data: {
              totalRequests: 42,
              successfulRequests: 41,
              failedRequests: 1,
              successRate: 97.62,
              totalCost: 9.75,
              avgCostPerRequest: 0.2321,
              avgTokensPerRequest: 544,
              totalTokens: 22848,
              dailyBurn: 1.39,
              timeRange: "daily",
              periodStart: "2026-05-14T00:00:00.000Z",
              periodEnd: NOW,
            },
          },
        });
      }

      if (path === "/api/organizations/members") {
        return route.fulfill({
          json: {
            success: true,
            data: [
              {
                id: "user_1",
                email: "test@example.com",
                name: "Test User",
                role: "owner",
                wallet_address: CURRENT_USER.wallet_address,
                wallet_chain_type: "evm",
                created_at: NOW,
              },
            ],
          },
        });
      }

      if (path === "/api/organizations/invites") {
        return route.fulfill({ json: { success: true, data: [] } });
      }

      return route.fulfill({
        json: {
          success: true,
          data: [],
          items: [],
          connections: [],
          connected: false,
          configured: false,
          balance: 123.45,
          user: CURRENT_USER,
        },
      });
    },
  );
}

test.beforeEach(async ({ page }) => {
  await setTestAuth(page);
  await installSettingsMocks(page);
});

test("settings tabs: desktop navigation renders each tab surface", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dashboard/settings", { waitUntil: "domcontentloaded" });

  const main = page.locator("#main");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText("Full name")).toBeVisible({ timeout: 20_000 });
  await expect(main.getByRole("button", { name: "General" })).toBeVisible();
  await expect(page.locator('input[value="Test User"]')).toBeVisible();

  await main.getByRole("button", { name: "Account" }).click();
  await expect(page.getByText("Total Generations")).toBeVisible();
  await expect(page.getByText("API Calls (24h)")).toBeVisible();

  await main.getByRole("button", { name: "Connections" }).click();
  await expect(page.getByText("Messaging & Communication")).toBeVisible();
  await expect(page.getByText("Social Media Connections")).toBeVisible();

  await main.getByRole("button", { name: "Usage" }).click();
  await expect(page.getByText("Credits Remaining")).toBeVisible();
  await expect(page.getByText("Current Session")).toBeVisible();

  await main.getByRole("button", { name: "Billing" }).click();
  await expect(page.getByText("Credit Balance")).toBeVisible();
  await expect(page.getByText("Add credits to your account")).toBeVisible();

  await main.getByRole("button", { name: "APIs" }).click();
  await expect(main.getByRole("heading", { name: "API keys" })).toBeVisible();
  await expect(page.getByText("Settings tab key")).toBeVisible();

  await main.getByRole("button", { name: "Analytics" }).click();
  await expect(page.getByText("Controls")).toBeVisible();
  await expect(page.getByText("Total Requests")).toBeVisible();

  await main.getByRole("button", { name: "Organization" }).click();
  await expect(page.getByText("ELIZA QA")).toBeVisible();
  await expect(page.getByText("Team Members")).toBeVisible();
  await expect(page.getByText("test@example.com")).toBeVisible();
});

test("settings tabs: account analytics CTA and mobile tab dropdown switch tabs", async ({
  page,
}) => {
  await page.goto("/dashboard/settings?tab=account", {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: "View analytics" }).click();
  await expect(page.getByText("Total Requests")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/dashboard/settings", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Full name")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("combobox").filter({ hasText: "General" }).click();
  await page.getByRole("option", { name: "Connections" }).click();

  await expect(page.getByText("Messaging & Communication")).toBeVisible();
  await expect(page.getByText("Social Media Connections")).toBeVisible();
});

test("settings tabs: general form edits inputs, dropdown, switches, and saves", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/dashboard/settings", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Full name")).toBeVisible({ timeout: 20_000 });

  await page.locator('input[value="Test User"]').fill("Settings Flow User");
  await page.locator('input[value="Tester"]').fill("SettingsFlow");
  await page
    .getByPlaceholder(/when learning new concepts/i)
    .fill("Prefer direct answers with concrete next steps.");

  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Software Developer" }).click();

  const switches = page.getByRole("switch");
  await expect(switches).toHaveCount(2);
  await switches.nth(0).click();
  await switches.nth(1).click();

  const saveRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/v1/user" && request.method() === "PATCH";
  });
  await page.getByRole("button", { name: "Save changes" }).click();
  const request = await saveRequest;

  expect(request.postDataJSON()).toMatchObject({
    name: "Settings Flow User",
    nickname: "SettingsFlow",
    work_function: "developer",
    preferences: "Prefer direct answers with concrete next steps.",
    response_notifications: false,
    email_notifications: false,
  });

  await expect(page.getByText("Full name")).toBeVisible({ timeout: 20_000 });
});
