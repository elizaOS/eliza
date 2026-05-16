import { expect, type Page, test } from "@playwright/test";

const MIN_NON_BLANK_SCREENSHOT_BYTES = 1_000;

const publicRoutes = [
  "/",
  "/login",
  "/os",
  "/terms-of-service",
  "/privacy-policy",
  "/blog",
  "/docs",
  "/payment/pay_req_1",
  "/payment/app-charge/app_1/charge_1",
  "/payment/success?payment_request_id=pay_req_1",
  "/sensitive-requests/req_1",
  "/approve/approval_1",
  "/ballot/ballot_1?token=test-token",
];

const dashboardRoutes = [
  "/dashboard",
  "/dashboard/account",
  "/dashboard/settings",
  "/dashboard/billing",
  "/dashboard/billing/success",
  "/dashboard/agents",
  "/dashboard/agents/agent_1",
  "/dashboard/apps",
  "/dashboard/apps/app_1",
  "/dashboard/my-agents",
  "/dashboard/api-keys",
  "/dashboard/mcps",
  "/dashboard/voices",
  "/dashboard/documents",
  "/dashboard/analytics",
  "/dashboard/earnings",
  "/dashboard/affiliates",
  "/dashboard/invoices/inv_1",
  "/dashboard/image",
  "/dashboard/video",
  "/dashboard/gallery",
  "/dashboard/containers",
  "/dashboard/containers/container_1",
  "/dashboard/containers/agents/agent_1",
  "/dashboard/chat",
  "/dashboard/api-explorer",
  "/dashboard/admin",
  "/dashboard/admin/infrastructure",
  "/dashboard/admin/metrics",
  "/dashboard/admin/redemptions",
];

async function installApiMocks(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.includes("/approval-requests/")) {
      return route.fulfill({
        json: {
          success: true,
          approvalRequest: {
            id: "approval_1",
            organizationId: "org_1",
            agentId: "agent_1",
            userId: "user_1",
            challengeKind: "generic",
            challengePayload: { message: "Approve this test request" },
            expectedSignerIdentityId: null,
            status: "pending",
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            metadata: null,
          },
        },
      });
    }

    if (path.includes("/ballots/")) {
      return route.fulfill({
        json: {
          success: true,
          ballot: {
            id: "ballot_1",
            organizationId: "org_1",
            purpose: "Choose a test option",
            threshold: 1,
            status: "open",
            participants: [{ identityId: "identity_1", label: "Tester" }],
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            createdAt: new Date().toISOString(),
          },
        },
      });
    }

    if (path.includes("/sensitive-requests/")) {
      return route.fulfill({
        json: {
          success: true,
          request: {
            id: "req_1",
            kind: "secret",
            status: "pending",
            title: "Sensitive request",
            prompt: "Enter a test secret",
            fields: [{ id: "secret", label: "Secret", type: "password" }],
          },
        },
      });
    }

    if (path.endsWith("/models")) {
      return route.fulfill({
        json: {
          object: "list",
          data: [
            {
              id: "gpt-4.1-mini",
              name: "GPT 4.1 Mini",
              provider: "openai",
              type: "text",
            },
          ],
        },
      });
    }

    return route.fulfill({
      json: {
        success: true,
        data: [],
        items: [],
        agents: [],
        apps: [],
        containers: [],
        balance: 100,
        user: { id: "user_1", email: "test@example.com" },
      },
    });
  });
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
  await installApiMocks(page);
});

for (const route of publicRoutes) {
  test(`public route renders: ${route}`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("text=Not found")).toHaveCount(0);
    const screenshot = await page.screenshot({ fullPage: true });
    expect(screenshot.length).toBeGreaterThan(MIN_NON_BLANK_SCREENSHOT_BYTES);
  });
}

for (const route of dashboardRoutes) {
  test(`dashboard route renders: ${route}`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator("body")).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator("text=Not found")).toHaveCount(0);
    const screenshot = await page.screenshot({ fullPage: true });
    expect(screenshot.length).toBeGreaterThan(MIN_NON_BLANK_SCREENSHOT_BYTES);
  });
}

test("legacy dashboard routes redirect to their canonical surfaces", async ({
  page,
}) => {
  await page.goto("/dashboard/build/foo?x=1");
  await expect(page).toHaveURL(/\/dashboard\/chat\?x=1$/);

  await page.goto("/dashboard/apps/create");
  await expect(page).toHaveURL(/\/dashboard\/apps$/);
});

test("anonymous protected dashboard routes redirect to login", async ({
  context,
  page,
}) => {
  await context.clearCookies();
  await page.goto("/dashboard/agents");
  await expect(page).toHaveURL(/\/login\?returnTo=/);
});
