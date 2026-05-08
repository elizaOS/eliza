import { expect, type Page, test } from "@playwright/test";
import {
  type BadApiResponse,
  expectCustomDashboardShell,
  expectDashboardShell,
  expectNoBadApiResponses,
  expectNoHorizontalOverflow,
  expectRouteResponseOk,
  installDashboardSessionAuth,
  trackBadApiResponses,
} from "../fixtures/page-helpers";

// @eliza-live-audit allow-route-fixtures
// Dashboard page smoke tests isolate route rendering from dashboard service data setup.

const TEST_ID = "00000000-0000-4000-8000-000000000000";
const TEST_INVOICE_ID = "inv_000000000000000000000000";

const STANDARD_DASHBOARD_ROUTES = [
  "/dashboard",
  "/dashboard/account",
  "/dashboard/settings",
  "/dashboard/billing",
  "/dashboard/billing/success",
  "/dashboard/agents",
  "/dashboard/apps",
  "/dashboard/my-agents",
  "/dashboard/api-keys",
  "/dashboard/api-explorer",
  "/dashboard/mcps",
  "/dashboard/voices",
  "/dashboard/knowledge",
  "/dashboard/analytics",
  "/dashboard/earnings",
  "/dashboard/affiliates",
  "/dashboard/image",
  "/dashboard/video",
  "/dashboard/gallery",
  "/dashboard/containers",
] as const;

const CUSTOM_DASHBOARD_ROUTES = ["/dashboard/chat"] as const;

const RESPONSIVE_VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const RESPONSIVE_DASHBOARD_ROUTES = [
  "/dashboard",
  "/dashboard/apps",
  "/dashboard/api-explorer",
  "/dashboard/containers",
  "/dashboard/chat",
] as const;

const REDIRECT_DASHBOARD_ROUTES = [
  {
    route: "/dashboard/apps/create",
    path: "/dashboard/apps/create",
    finalUrl: /\/dashboard\/apps(?:[?#]|$)/,
  },
] as const;

const DYNAMIC_ROUTE_FALLBACKS = [
  {
    route: "/dashboard/apps/:id",
    path: `/dashboard/apps/${TEST_ID}`,
    finalUrl: /\/dashboard\/apps(?:\/00000000-0000-4000-8000-000000000000)?(?:[?#]|$)/,
  },
  {
    route: "/dashboard/agents/:id",
    path: `/dashboard/agents/${TEST_ID}`,
    finalUrl: /\/dashboard\/agents(?:[?#]|$)/,
  },
  {
    route: "/dashboard/containers/:id",
    path: `/dashboard/containers/${TEST_ID}`,
    finalUrl: /\/dashboard\/containers(?:[?#]|$)/,
  },
  {
    route: "/dashboard/containers/agents/:id",
    path: `/dashboard/containers/agents/${TEST_ID}`,
    finalUrl: /\/dashboard\/containers(?:[?#]|$)/,
  },
] as const;

function json(data: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  };
}

async function mockAppDetail(page: Page): Promise<void> {
  await page.route(`**/api/v1/apps/${TEST_ID}`, async (route) => {
    await route.fulfill(
      json({
        app: {
          id: TEST_ID,
          organization_id: "11111111-1111-4111-8111-111111111111",
          name: "Playwright App",
          description: "Route smoke test app",
          app_url: "https://example.test/app",
          website_url: "https://example.test",
          contact_email: "support@example.test",
          allowed_origins: ["https://example.test"],
          production_url: null,
          deployment_status: "draft",
          total_users: 0,
          total_requests: 0,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      }),
    );
  });
  await page.route(`**/api/v1/apps/${TEST_ID}/monetization`, async (route) => {
    await route.fulfill(
      json({
        success: true,
        monetization: {
          monetizationEnabled: false,
          totalCreatorEarnings: 0,
        },
      }),
    );
  });
}

async function mockContainerDetail(page: Page): Promise<void> {
  const now = new Date().toISOString();

  await page.route(`**/api/v1/containers/${TEST_ID}`, async (route) => {
    await route.fulfill(
      json({
        success: true,
        data: {
          id: TEST_ID,
          name: "playwright-container",
          description: "Route smoke test container",
          status: "running",
          load_balancer_url: null,
          node_id: null,
          volume_path: null,
          port: 3000,
          desired_count: 1,
          cpu: 1,
          memory: 512,
          last_deployed_at: null,
          created_at: now,
          error_message: null,
        },
      }),
    );
  });
  await page.route(`**/api/v1/containers/${TEST_ID}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;

    if (pathname.endsWith("/deployments")) {
      await route.fulfill(json({ success: true, data: { deployments: [] } }));
      return;
    }

    if (pathname.endsWith("/metrics")) {
      await route.fulfill(
        json({
          success: true,
          data: {
            metrics: {
              cpu_utilization: 0,
              memory_utilization: 0,
              network_rx_bytes: 0,
              network_tx_bytes: 0,
              task_count: 1,
              healthy_task_count: 1,
              timestamp: now,
            },
          },
        }),
      );
      return;
    }

    if (pathname.endsWith("/logs")) {
      await route.fulfill(json({ success: true, data: { logs: [], message: null } }));
      return;
    }

    await route.fulfill(json({ success: true, data: {} }));
  });
}

async function mockAgentDetail(page: Page): Promise<void> {
  await page.route(`**/api/v1/eliza/agents/${TEST_ID}`, async (route) => {
    await route.fulfill(
      json({
        success: true,
        data: {
          id: TEST_ID,
          agentName: "Playwright Agent",
          status: "running",
          databaseStatus: "ready",
          lastBackupAt: null,
          lastHeartbeatAt: new Date().toISOString(),
          errorMessage: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          token_address: null,
          token_chain: null,
          token_name: null,
          token_ticker: null,
          bridgeUrl: null,
          errorCount: 0,
          walletAddress: null,
          walletProvider: null,
          walletStatus: "none",
          adminDetails: null,
        },
      }),
    );
  });
  await page.route(`**/api/v1/eliza/agents/${TEST_ID}/backups`, async (route) => {
    await route.fulfill(json({ success: true, data: [] }));
  });
  await page.route(`**/api/compat/agents/${TEST_ID}/logs**`, async (route) => {
    await route.fulfill(json({ success: true, data: "" }));
  });
}

async function mockInvoiceDetail(page: Page): Promise<void> {
  const now = new Date().toISOString();
  await page.route("**/api/v1/user", async (route) => {
    await route.fulfill(
      json({
        success: true,
        data: {
          id: "22222222-2222-4222-8222-222222222222",
          email: "local-live-test-user@agent.local",
          name: "Local Live Test User",
          organization_id: "11111111-1111-4111-8111-111111111111",
          avatar: null,
          nickname: null,
          work_function: null,
          preferences: null,
          response_notifications: true,
          email_notifications: true,
          role: "owner",
          email_verified: true,
          wallet_address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          wallet_chain_type: "evm",
          wallet_verified: true,
          is_active: true,
          created_at: now,
          updated_at: now,
          organization: {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Local Live Test Organization",
            slug: "local-live-test-organization",
            credit_balance: "100",
            billing_email: "billing@example.test",
            is_active: true,
            created_at: now,
          },
        },
      }),
    );
  });
  await page.route(`**/api/invoices/${TEST_INVOICE_ID}`, async (route) => {
    await route.fulfill(
      json({
        invoice: {
          id: TEST_INVOICE_ID,
          stripeInvoiceId: "in_playwright",
          stripeCustomerId: "cus_playwright",
          stripePaymentIntentId: null,
          amountDue: 100,
          amountPaid: 100,
          currency: "usd",
          status: "paid",
          invoiceType: "credits",
          invoiceNumber: "PW-0001",
          invoicePdf: null,
          hostedInvoiceUrl: null,
          creditsAdded: 100,
          metadata: {},
          createdAt: now,
          updatedAt: now,
          paidAt: now,
        },
      }),
    );
  });
}

async function mockDashboardRouteApis(page: Page): Promise<void> {
  const now = new Date().toISOString();
  const testOrganization = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Local Live Test Organization",
    slug: "local-live-test-organization",
    billing_email: null,
    credit_balance: "100.000000",
    is_active: true,
    created_at: now,
    updated_at: now,
  };
  const testUser = {
    id: "22222222-2222-4222-8222-222222222222",
    email: "local-live-test-user@agent.local",
    email_verified: true,
    wallet_address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    wallet_chain_type: "evm",
    wallet_verified: true,
    name: "Local Live Test User",
    avatar: null,
    organization_id: testOrganization.id,
    role: "admin",
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
    organization: testOrganization,
  };
  const modelCatalog = [
    {
      id: "openai/gpt-5.4-mini",
      object: "model",
      created: 0,
      owned_by: "openai",
      name: "GPT-5.4 Mini",
      description: "Route smoke test language model",
      type: "language",
    },
  ];
  const analyticsBreakdown = {
    filters: {
      startDate: now,
      endDate: now,
      granularity: "day",
      timeRange: "weekly",
    },
    overallStats: {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      successRate: 1,
    },
    timeSeriesData: [],
    costTrending: {
      currentDailyBurn: 0,
      previousDailyBurn: 0,
      burnChangePercent: 0,
      projectedMonthlyBurn: 0,
      daysUntilBalanceZero: null,
    },
    providerBreakdown: [],
    modelBreakdown: [],
    trends: {
      requestsChange: 0,
      costChange: 0,
      tokensChange: 0,
      successRateChange: 0,
      period: "weekly",
    },
    organization: {
      creditBalance: "100",
    },
  };

  await page.route("**/api/v1/models**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/v1/models/status") {
      const payload = request.postDataJSON() as { modelIds?: string[] };
      const modelIds = Array.isArray(payload.modelIds) ? payload.modelIds : [];

      await route.fulfill(
        json({
          models: modelIds.map((modelId) => ({
            modelId,
            available: true,
          })),
          timestamp: Date.now(),
        }),
      );
      return;
    }

    if (pathname === "/api/v1/models") {
      await route.fulfill(
        json({
          object: "list",
          data: modelCatalog,
        }),
      );
      return;
    }

    await route.fallback();
  });

  await page.route("**/api/v1/eliza/agents", async (route) => {
    await route.fulfill(json({ success: true, data: [] }));
  });

  await page.route("**/api/v1/containers", async (route) => {
    await route.fulfill(json({ success: true, data: [] }));
  });

  await page.route("**/api/v1/user", async (route) => {
    await route.fulfill(json({ success: true, data: testUser }));
  });

  await page.route("**/api/credits/balance**", async (route) => {
    await route.fulfill(json({ balance: 100 }));
  });

  await page.route("**/api/v1/dashboard", async (route) => {
    await route.fulfill(json({ user: { name: testUser.name }, agents: [] }));
  });

  await page.route("**/api/my-agents/characters", async (route) => {
    await route.fulfill(json({ success: true, data: { characters: [] } }));
  });

  await page.route("**/api/my-agents/saved", async (route) => {
    await route.fulfill(json({ success: true, data: { agents: [] } }));
  });

  await page.route("**/api/my-agents/claim-affiliate-characters", async (route) => {
    await route.fulfill(json({ success: true, claimed: [] }));
  });

  await page.route("**/api/v1/api-keys", async (route) => {
    await route.fulfill(json({ keys: [] }));
  });

  await page.route("**/api/v1/api-keys/explorer", async (route) => {
    await route.fulfill(
      json({
        apiKey: {
          id: "33333333-3333-4333-8333-333333333333",
          name: "API Explorer Key",
          description: "Route smoke test API key",
          key_prefix: "eliza_test_l",
          key: "eliza_test_local_live_infra_key",
          created_at: now,
          is_active: true,
          usage_count: 0,
          last_used_at: null,
        },
        isNew: false,
      }),
    );
  });

  await page.route("**/api/v1/pricing/summary**", async (route) => {
    await route.fulfill(json({ pricing: {} }));
  });

  await page.route("**/api/v1/voice/list**", async (route) => {
    await route.fulfill(
      json({
        success: true,
        voices: [],
        total: 0,
        limit: 50,
        offset: 0,
        hasMore: false,
      }),
    );
  });

  await page.route("**/api/v1/referrals", async (route) => {
    await route.fulfill(
      json({
        code: "PLAYWRIGHT",
        total_referrals: 0,
        is_active: true,
      }),
    );
  });

  await page.route("**/api/analytics/breakdown**", async (route) => {
    await route.fulfill(json({ success: true, data: analyticsBreakdown }));
  });

  await page.route("**/api/analytics/projections**", async (route) => {
    await route.fulfill(
      json({
        success: true,
        data: {
          historicalData: [],
          projections: [],
          alerts: [],
          creditBalance: 100,
        },
      }),
    );
  });

  await page.route("**/api/v1/gallery**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;

    if (pathname === "/api/v1/gallery/stats") {
      await route.fulfill(json({ totalImages: 0, totalVideos: 0, totalSize: 0 }));
      return;
    }

    if (pathname === "/api/v1/gallery" || pathname === "/api/v1/gallery/explore") {
      await route.fulfill(json({ items: [] }));
      return;
    }

    await route.fulfill(json({ success: true }));
  });

  await page.route("**/api/v1/video/usage", async (route) => {
    await route.fulfill(
      json({
        totalRenders: 0,
        monthlyCredits: 0,
        averageDuration: 0,
      }),
    );
  });

  await page.route("**/api/v1/video/featured", async (route) => {
    await route.fulfill(json({ video: null }));
  });

  await page.route("**/api/eliza/rooms**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/eliza/rooms" && request.method() === "GET") {
      await route.fulfill(json({ rooms: [] }));
      return;
    }

    if (pathname === "/api/eliza/rooms" && request.method() === "POST") {
      await route.fulfill(json({ roomId: "playwright-builder-room" }));
      return;
    }

    if (pathname.endsWith("/welcome")) {
      await route.fulfill(json({ success: true }));
      return;
    }

    await route.fulfill(json({ messages: [], metadata: {} }));
  });
}

async function mockMissingDynamicRecord(page: Page, route: string): Promise<void> {
  if (route === "/dashboard/apps/:id") {
    await page.route(`**/api/v1/apps/${TEST_ID}`, async (matchedRoute) => {
      await matchedRoute.fulfill(
        json({
          success: false,
          error: "App not found",
        }),
      );
    });
    return;
  }

  if (route === "/dashboard/containers/:id") {
    await page.route(`**/api/v1/containers/${TEST_ID}`, async (matchedRoute) => {
      await matchedRoute.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Container not found" }),
      });
    });
    return;
  }

  if (route === "/dashboard/agents/:id" || route === "/dashboard/containers/agents/:id") {
    await page.route(`**/api/v1/eliza/agents/${TEST_ID}`, async (matchedRoute) => {
      await matchedRoute.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Agent not found" }),
      });
    });
  }
}

test.describe("Dashboard Pages", () => {
  let badApiResponses: BadApiResponse[] = [];

  test.beforeEach(async ({ page, baseURL }) => {
    badApiResponses = trackBadApiResponses(page, baseURL);
    await installDashboardSessionAuth(page, baseURL);
    await mockDashboardRouteApis(page);
  });

  test.afterEach(async ({ page }) => {
    await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
    expectNoBadApiResponses(badApiResponses, "dashboard routes");
  });

  for (const path of STANDARD_DASHBOARD_ROUTES) {
    test(`${path} renders the dashboard shell`, async ({ page }) => {
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expectRouteResponseOk(response, path);
      await expectDashboardShell(page);
      await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    });
  }

  for (const path of CUSTOM_DASHBOARD_ROUTES) {
    test(`${path} renders its custom dashboard shell`, async ({ page }) => {
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expectRouteResponseOk(response, path);
      await expectCustomDashboardShell(page);
      await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    });
  }

  for (const { route, path, finalUrl } of REDIRECT_DASHBOARD_ROUTES) {
    test(`${route} redirects to the mounted dashboard route`, async ({ page }) => {
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expectRouteResponseOk(response, path);
      await expectDashboardShell(page);
      await expect(page).toHaveURL(finalUrl);
    });
  }

  for (const { route, path, finalUrl } of DYNAMIC_ROUTE_FALLBACKS) {
    test(`${route} handles missing records inside the dashboard router`, async ({ page }) => {
      await mockMissingDynamicRecord(page, route);

      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expectRouteResponseOk(response, path);
      await expectDashboardShell(page);
      await expect(page).toHaveURL(finalUrl);
    });
  }

  for (const viewport of RESPONSIVE_VIEWPORTS) {
    for (const path of RESPONSIVE_DASHBOARD_ROUTES) {
      test(`${path} has no horizontal overflow at ${viewport.name} width`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const response = await page.goto(path, { waitUntil: "domcontentloaded" });
        expectRouteResponseOk(response, path);
        await expect(page.locator("main")).toBeVisible();
        await expectNoHorizontalOverflow(page, `${path} ${viewport.name}`);
      });
    }
  }

  test("/dashboard/apps/:id renders the app detail route with API data", async ({
    page,
    baseURL,
  }) => {
    await installDashboardSessionAuth(page, baseURL);
    await mockAppDetail(page);

    const path = `/dashboard/apps/${TEST_ID}`;
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    expectRouteResponseOk(response, path);
    await expectDashboardShell(page);
    await expect(page.getByRole("button", { name: "Overview" })).toBeVisible();
    await expect(page.getByText("Playwright App").first()).toBeVisible();
  });

  test("/dashboard/containers/:id renders the container detail route with API data", async ({
    page,
    baseURL,
  }) => {
    await installDashboardSessionAuth(page, baseURL);
    await mockContainerDetail(page);

    const path = `/dashboard/containers/${TEST_ID}`;
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    expectRouteResponseOk(response, path);
    await expectDashboardShell(page);
    await expect(page.getByRole("heading", { name: "playwright-container" })).toBeVisible();
  });

  test("/dashboard/agents/:id renders the Eliza agent detail route with API data", async ({
    page,
    baseURL,
  }) => {
    await installDashboardSessionAuth(page, baseURL);
    await mockAgentDetail(page);

    const path = `/dashboard/agents/${TEST_ID}`;
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    expectRouteResponseOk(response, path);
    await expectDashboardShell(page);
    await expect(page.getByRole("heading", { name: "Playwright Agent" })).toBeVisible();
  });

  test("/dashboard/containers/agents/:id renders the container agent detail route with API data", async ({
    page,
    baseURL,
  }) => {
    await installDashboardSessionAuth(page, baseURL);
    await mockAgentDetail(page);

    const path = `/dashboard/containers/agents/${TEST_ID}`;
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    expectRouteResponseOk(response, path);
    await expectDashboardShell(page);
    await expect(page.getByRole("heading", { name: "Playwright Agent" })).toBeVisible();
  });

  test("/dashboard/invoices/:id renders the invoice detail route with API data", async ({
    page,
    baseURL,
  }) => {
    await installDashboardSessionAuth(page, baseURL);
    await mockInvoiceDetail(page);

    const path = `/dashboard/invoices/${TEST_INVOICE_ID}`;
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    expectRouteResponseOk(response, path);
    await expectDashboardShell(page);
    await expect(page.getByRole("heading", { name: "Invoice Details" })).toBeVisible();
  });

  test("sidebar navigation uses mounted React Router dashboard paths", async ({
    page,
    baseURL,
  }) => {
    await installDashboardSessionAuth(page, baseURL);

    const response = await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    expectRouteResponseOk(response, "/dashboard");
    await expectDashboardShell(page);

    await page.locator("aside").getByRole("link", { name: "My Apps" }).click();
    await expect(page).toHaveURL(/\/dashboard\/apps$/);
    await expectDashboardShell(page);

    await page.locator("aside").getByRole("link", { name: "Billing" }).click();
    await expect(page).toHaveURL(/\/dashboard\/billing$/);
    await expectDashboardShell(page);

    await page.locator("aside").getByRole("link", { name: "Dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expectDashboardShell(page);
  });
});
