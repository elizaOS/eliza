import { expect, type Page, test } from "@playwright/test";
import {
  type BadApiResponse,
  expectDashboardShell,
  expectNoBadApiResponses,
  expectRouteResponseOk,
  installDashboardSessionAuth,
  trackBadApiResponses,
} from "../fixtures/page-helpers";

// @eliza-live-audit allow-route-fixtures
// Admin page smoke tests isolate route rendering from admin service data setup.

const ADMIN_PAGES = [
  { path: "/dashboard/admin", heading: "Admin Panel" },
  { path: "/dashboard/admin/metrics", heading: "Engagement Metrics" },
  { path: "/dashboard/admin/infrastructure", heading: "Infrastructure" },
  { path: "/dashboard/admin/redemptions", heading: "Redemption Management" },
] as const;

function json(data: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  };
}

async function mockAdminApis(page: Page): Promise<void> {
  const now = new Date().toISOString();
  const userProfile = {
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
      steward_user_id: "22222222-2222-4222-8222-222222222222",
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
        updated_at: now,
      },
    },
  };

  await page.route("**/api/v1/user", async (route) => {
    await route.fulfill(json(userProfile));
  });

  await page.route("**/api/credits/balance**", async (route) => {
    await route.fulfill(json({ balance: 100 }));
  });

  await page.route("**/api/users/me", async (route) => {
    await route.fulfill(
      json({
        user: {
          id: "22222222-2222-4222-8222-222222222222",
          email: "local-live-test-user@agent.local",
          organization_id: "11111111-1111-4111-8111-111111111111",
          organization: {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Local Live Test Organization",
            is_active: true,
          },
          is_active: true,
          role: "owner",
          steward_id: "22222222-2222-4222-8222-222222222222",
          wallet_address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          is_anonymous: false,
        },
      }),
    );
  });

  await page.route("**/api/v1/admin/moderation**", async (route) => {
    const request = route.request();
    if (request.method() === "HEAD") {
      await route.fulfill({
        status: 204,
        headers: {
          "X-Is-Admin": "true",
          "X-Admin-Role": "super_admin",
        },
      });
      return;
    }

    const url = new URL(request.url());
    const view = url.searchParams.get("view");
    if (view === "overview" || !view) {
      await route.fulfill(
        json({
          recentViolations: [],
          totalViolations: 0,
          flaggedUsers: 0,
          bannedUsers: 0,
          adminCount: 1,
          currentAdmin: {
            wallet: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            role: "super_admin",
          },
        }),
      );
      return;
    }

    if (view === "admins") {
      await route.fulfill(json({ admins: [] }));
      return;
    }

    if (view === "users") {
      await route.fulfill(json({ flaggedUsers: [], bannedUsers: [] }));
      return;
    }

    if (view === "violations") {
      await route.fulfill(json({ violations: [] }));
      return;
    }

    await route.fulfill(json({}));
  });

  await page.route("**/api/v1/admin/metrics**", async (route) => {
    await route.fulfill(
      json({
        dau: 0,
        wau: 0,
        mau: 0,
        newSignupsToday: 0,
        newSignups7d: 0,
        avgMessagesPerUser: 0,
        platformBreakdown: {},
        oauthRate: {
          total_users: 0,
          connected_users: 0,
          rate: 0,
          byService: {},
        },
        dailyTrend: [],
        retentionCohorts: [],
      }),
    );
  });

  await page.route("**/api/v1/admin/docker-nodes", async (route) => {
    await route.fulfill(json({ success: true, data: { nodes: [] } }));
  });

  await page.route("**/api/v1/admin/infrastructure", async (route) => {
    await route.fulfill(
      json({
        success: true,
        data: {
          refreshedAt: now,
          summary: {
            totalNodes: 0,
            enabledNodes: 0,
            healthyNodes: 0,
            degradedNodes: 0,
            offlineNodes: 0,
            unknownNodes: 0,
            totalCapacity: 0,
            allocatedSlots: 0,
            availableSlots: 0,
            utilizationPct: 0,
            totalContainers: 0,
            runningContainers: 0,
            stoppedContainers: 0,
            errorContainers: 0,
            healthyContainers: 0,
            attentionContainers: 0,
            failedContainers: 0,
            missingContainers: 0,
            staleContainers: 0,
          },
          incidents: [],
          nodes: [],
          containers: [],
        },
      }),
    );
  });

  await page.route("**/api/v1/admin/headscale", async (route) => {
    await route.fulfill(
      json({
        success: true,
        data: {
          user: "playwright",
          vpnNodes: [],
          summary: { total: 0, online: 0, offline: 0 },
          queriedAt: now,
        },
      }),
    );
  });

  await page.route("**/api/admin/redemptions**", async (route) => {
    await route.fulfill(
      json({
        redemptions: [],
        stats: {
          pending: 0,
          approved: 0,
          processing: 0,
          completed: 0,
          failed: 0,
          totalPendingUsd: 0,
        },
      }),
    );
  });

  await page.route("**/api/v1/redemptions/status", async (route) => {
    await route.fulfill(
      json({
        operational: true,
        networks: {},
        wallets: {
          evm: { configured: false },
          solana: { configured: false },
        },
      }),
    );
  });
}

test.describe("Admin auth gate", () => {
  test("/dashboard/admin redirects through the client router when unauthenticated", async ({
    page,
  }) => {
    const response = await page.goto("/dashboard/admin", { waitUntil: "domcontentloaded" });
    expectRouteResponseOk(response, "/dashboard/admin");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fdashboard%2Fadmin$/);
  });
});

test.describe("Admin Pages", () => {
  let badApiResponses: BadApiResponse[] = [];

  test.beforeEach(async ({ page, baseURL }) => {
    badApiResponses = trackBadApiResponses(page, baseURL);
    await installDashboardSessionAuth(page, baseURL);
    await mockAdminApis(page);
  });

  test.afterEach(async ({ page }) => {
    await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
    expectNoBadApiResponses(badApiResponses, "admin routes");
  });

  for (const { path, heading } of ADMIN_PAGES) {
    test(`${path} renders the admin dashboard shell`, async ({ page }) => {
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expectRouteResponseOk(response, path);
      await expectDashboardShell(page);
      await expect(page).toHaveURL(new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    });
  }
});
