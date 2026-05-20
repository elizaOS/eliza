import { readdirSync, statSync } from "node:fs";
import pathModule from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

// In live-prod mode the mocked-API specs do not apply (cookies are scoped to
// 127.0.0.1, fixtures don't exist on real backends). Skip the whole file.
test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "cloud-routes.spec uses local mocks; live-prod runs cloud-routes-live.spec instead",
);

test.describe.configure({ mode: "serial" });

const MIN_NON_BLANK_SCREENSHOT_BYTES = 1_000;
const HERE = pathModule.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = pathModule.resolve(HERE, "../../content");

// Console messages we explicitly tolerate. Keep this list short and
// document each entry — anything that lands here is a regression candidate.
const CONSOLE_ERROR_ALLOWLIST: RegExp[] = [
  /Failed to load resource.*favicon/i,
  // Render telemetry is asserted by dedicated runtime tests; broad route smoke
  // keeps its signal on page errors, 4xx/5xx responses, not-found pages, and
  // blank renders.
  /^\[RenderTelemetry\]/,
  // Vite dev HMR ping noise when the dev server restarts during a test
  /\[vite\] connecting/i,
  /\[vite\] connected/i,
];

// Requests we don't fail on if they 4xx/5xx — e.g. optional analytics,
// third-party heartbeats. Keep this empty until proven necessary.
const NETWORK_FAILURE_ALLOWLIST: RegExp[] = [/\/__telemetry__/];

// Default <title> set by RootLayout's <Helmet>. Sub-pages that forget to
// set their own Helmet title fall back to this, which is the bug pattern we
// fix by hoisting <Helmet> above auth-loading short-circuits.
const HOMEPAGE_TITLE_FALLBACK = /Eliza Cloud - Launch Eliza/i;
const ROUTE_TITLE_RULES: Record<string, RegExp> = {
  "/": HOMEPAGE_TITLE_FALLBACK,
  "/os": HOMEPAGE_TITLE_FALLBACK,
  "/blog": HOMEPAGE_TITLE_FALLBACK,
  "/sandbox-proxy": HOMEPAGE_TITLE_FALLBACK,
};

function discoverDocsRoutes(): string[] {
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = pathModule.join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.endsWith(".mdx")) continue;
      const rel = pathModule
        .relative(CONTENT_DIR, fullPath)
        .replace(/\\/g, "/")
        .replace(/\.mdx$/, "");
      if (rel === "index") {
        routes.push("/docs");
      } else if (rel.endsWith("/index")) {
        routes.push(`/docs/${rel.slice(0, -"/index".length)}`);
      } else {
        routes.push(`/docs/${rel}`);
      }
    }
  };
  walk(CONTENT_DIR);
  return [...new Set(routes)].sort();
}

const docsRoutes = discoverDocsRoutes();

interface CapturedFailures {
  pageErrors: string[];
  consoleErrors: string[];
  failedResponses: Array<{ url: string; status: number }>;
}

function attachFailureCollectors(page: Page): CapturedFailures {
  const captured: CapturedFailures = {
    pageErrors: [],
    consoleErrors: [],
    failedResponses: [],
  };

  page.on("pageerror", (err) => {
    captured.pageErrors.push(err.message ?? String(err));
  });

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (CONSOLE_ERROR_ALLOWLIST.some((r) => r.test(text))) return;
    captured.consoleErrors.push(text);
  });

  page.on("response", (resp) => {
    const status = resp.status();
    if (status < 400) return;
    const url = resp.url();
    if (NETWORK_FAILURE_ALLOWLIST.some((r) => r.test(url))) return;
    captured.failedResponses.push({ url, status });
  });

  return captured;
}

function assertNoFailures(route: string, captured: CapturedFailures) {
  const lines: string[] = [];
  if (captured.pageErrors.length) {
    lines.push(
      `Uncaught page errors on ${route}:\n` +
        captured.pageErrors.map((e) => `  - ${e}`).join("\n"),
    );
  }
  if (captured.consoleErrors.length) {
    lines.push(
      `Console errors on ${route}:\n` +
        captured.consoleErrors.map((e) => `  - ${e}`).join("\n"),
    );
  }
  if (captured.failedResponses.length) {
    lines.push(
      `Failed responses on ${route}:\n` +
        captured.failedResponses
          .map((f) => `  - ${f.status} ${f.url}`)
          .join("\n"),
    );
  }
  if (lines.length) throw new Error(lines.join("\n\n"));
}

const publicRoutes = [
  "/",
  "/os",
  "/blog",
  "/login",
  "/terms-of-service",
  "/privacy-policy",
  ...docsRoutes,
  "/sandbox-proxy",
  "/bsc",
  "/chat/agent_1",
  "/auth/success?platform=github",
  "/auth/cli-login?session=cli_session_1",
  "/auth/error?reason=auth_failed",
  "/auth/callback/email",
  "/app-auth/authorize",
  "/invite/accept",
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
  "/dashboard/agents/agent_1/chat",
  "/dashboard/apps",
  "/dashboard/apps/app_1",
  "/dashboard/my-agents",
  "/dashboard/api-keys",
  "/dashboard/mcps",
  "/dashboard/documents",
  "/dashboard/analytics",
  "/dashboard/earnings",
  "/dashboard/affiliates",
  "/dashboard/invoices/inv_1",
  "/dashboard/chat",
  "/dashboard/containers",
  "/dashboard/containers/container_1",
  "/dashboard/containers/agents/agent_1",
  "/dashboard/api-explorer",
  "/dashboard/admin",
  "/dashboard/admin/infrastructure",
  "/dashboard/admin/metrics",
  "/dashboard/admin/redemptions",
];

// Legacy paths kept for inbound links; the real implementation redirects them
// to the canonical dashboard surface. Tested separately from the renders list.
// /dashboard/chat is intentionally not in this list — it's a smart route
// (redirects to an existing agent's chat OR shows an empty state) rather than
// a pure redirect.
const dashboardRedirects: Array<[from: string, toPattern: RegExp]> = [
  ["/dashboard/image", /\/dashboard\/api-explorer$/],
  ["/dashboard/video", /\/dashboard\/api-explorer$/],
  ["/dashboard/gallery", /\/dashboard\/api-explorer$/],
  ["/dashboard/voices", /\/dashboard\/api-explorer$/],
];

async function installApiMocks(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
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

      if (path.includes("/characters/agent_1/public")) {
        return route.fulfill({
          json: {
            success: true,
            data: {
              id: "agent_1",
              name: "Test Agent",
              username: "test-agent",
              avatarUrl: null,
              bio: "A shared test agent.",
              creatorUsername: "tester",
            },
          },
        });
      }

      if (path === "/api/v1/eliza/agents") {
        const now = new Date().toISOString();
        return route.fulfill({
          json: {
            success: true,
            data: [
              {
                id: "agent_1",
                agentName: "Test Agent",
                name: "Test Agent",
                status: "running",
                createdAt: now,
                updatedAt: now,
                lastHeartbeatAt: now,
                adminDetails: {
                  webUiUrl: "https://agent.example.test",
                },
              },
            ],
          },
        });
      }

      if (path === "/api/v1/eliza/agents/agent_1") {
        const now = new Date().toISOString();
        return route.fulfill({
          json: {
            success: true,
            data: {
              id: "agent_1",
              agentName: "Test Agent",
              name: "Test Agent",
              status: "running",
              createdAt: now,
              updatedAt: now,
              lastHeartbeatAt: now,
              adminDetails: {
                webUiUrl: "https://agent.example.test",
              },
            },
          },
        });
      }

      if (path.includes("/api/v1/cli-login/")) {
        return route.fulfill({
          json: {
            success: true,
            apiKeyPrefix: "eliza_test",
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

      if (path === "/api/v1/redemptions/balance") {
        return route.fulfill({
          json: {
            balance: {
              totalEarned: 250,
              availableBalance: 125,
              pendingBalance: 25,
              totalRedeemed: 100,
              totalPending: 25,
              totalConvertedToCredits: 0,
            },
            bySource: [
              { source: "agent", totalEarned: 150, count: 3 },
              { source: "miniapp", totalEarned: 100, count: 2 },
            ],
            recentEarnings: [
              {
                id: "earning_1",
                source: "agent",
                sourceId: "agent_1",
                amount: 25,
                description: "Test agent usage",
                createdAt: new Date().toISOString(),
              },
            ],
            limits: {
              minRedemptionUsd: 10,
              maxSingleRedemptionUsd: 1000,
              userDailyLimitUsd: 1000,
              userHourlyLimitUsd: 250,
            },
            eligibility: {
              canRedeem: true,
              dailyLimitRemaining: 1000,
            },
          },
        });
      }

      if (path === "/api/v1/redemptions/status") {
        return route.fulfill({
          json: {
            operational: true,
            networks: {
              base: { available: true },
              solana: { available: true },
              ethereum: { available: true },
              bnb: { available: true },
            },
          },
        });
      }

      if (path === "/api/v1/redemptions") {
        return route.fulfill({
          json: {
            redemptions: [],
          },
        });
      }

      if (path === "/api/v1/containers/container_1/deployments") {
        return route.fulfill({
          json: {
            success: true,
            data: {
              deployments: [
                {
                  id: "deployment_1",
                  status: "success",
                  cost: 1.25,
                  metadata: {
                    container_id: "container_1",
                    container_name: "Test Container",
                    desired_count: 1,
                    cpu: 256,
                    memory: 512,
                    port: 3000,
                    image_tag: "test",
                  },
                  deployed_at: new Date().toISOString(),
                  duration_ms: 1200,
                },
              ],
            },
          },
        });
      }

      if (path.endsWith("/models/status")) {
        return route.fulfill({
          json: {
            models: [
              { modelId: "openai/gpt-image-1", available: true },
              { modelId: "black-forest-labs/flux-pro", available: true },
              { modelId: "google/imagen-4", available: true },
            ],
            timestamp: Date.now(),
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

      if (path === "/api/analytics/breakdown") {
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(now.getDate() - 7);
        return route.fulfill({
          json: {
            success: true,
            data: {
              filters: {
                startDate: startDate.toISOString(),
                endDate: now.toISOString(),
                granularity: "day",
                timeRange: "weekly",
              },
              overallStats: {
                totalRequests: 12,
                totalInputTokens: 1200,
                totalOutputTokens: 800,
                totalCost: 0.42,
                successRate: 0.98,
              },
              timeSeriesData: [
                {
                  timestamp: startDate.toISOString(),
                  totalRequests: 12,
                  totalCost: 0.42,
                  inputTokens: 1200,
                  outputTokens: 800,
                  successRate: 0.98,
                  successRatePercent: 98,
                },
              ],
              costTrending: {
                currentDailyBurn: 0.06,
                previousDailyBurn: 0.04,
                burnChangePercent: 50,
                projectedMonthlyBurn: 1.8,
                daysUntilBalanceZero: null,
                monthlyBurnPercent: 2,
                monthlyBurnPercentClamped: 2,
                burnAlertThresholdExceeded: false,
              },
              providerBreakdown: [
                {
                  provider: "openai",
                  totalRequests: 12,
                  totalCost: 0.42,
                  totalTokens: 2000,
                  successRate: 0.98,
                  percentage: 100,
                },
              ],
              modelBreakdown: [
                {
                  model: "gpt-4.1-mini",
                  provider: "openai",
                  totalRequests: 12,
                  totalCost: 0.42,
                  totalTokens: 2000,
                  avgCostPerToken: 0.00021,
                  successRate: 0.98,
                },
              ],
              trends: {
                requestsChange: 10,
                costChange: 5,
                tokensChange: 8,
                successRateChange: 1,
                period: "previous week",
              },
              organization: {
                creditBalance: "100.00",
              },
            },
          },
        });
      }

      if (path === "/api/analytics/projections") {
        const now = new Date();
        const next = new Date(now);
        next.setDate(now.getDate() + 1);
        return route.fulfill({
          json: {
            success: true,
            data: {
              historicalData: [
                {
                  timestamp: now.toISOString(),
                  totalRequests: 12,
                  totalCost: 0.42,
                  inputTokens: 1200,
                  outputTokens: 800,
                  successRate: 0.98,
                  successRatePercent: 98,
                },
              ],
              projections: [
                {
                  timestamp: next.toISOString(),
                  projectedCost: 0.5,
                  projectedRequests: 14,
                  confidenceLower: 0.35,
                  confidenceUpper: 0.7,
                },
              ],
              alerts: [],
              creditBalance: 100,
            },
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
    },
  );
}

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
  ]);
}

async function captureRouteScreenshot(page: Page): Promise<Buffer> {
  let lastError: unknown;

  for (const fullPage of [true, false]) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await page.screenshot({ fullPage });
      } catch (error) {
        lastError = error;
        await page.waitForTimeout(150);
      }
    }
  }

  throw lastError;
}

test.beforeEach(async ({ page }) => {
  await installApiMocks(page);
});

for (const route of publicRoutes) {
  test(`public route renders: ${route}`, async ({ page }) => {
    const captured = attachFailureCollectors(page);
    // networkidle so lazy route chunks finish loading before we sample the
    // page title (otherwise sub-pages still on the Suspense fallback show
    // the global RootLayout <title> and trip the homepage-leak assertion).
    await page.goto(route, { waitUntil: "networkidle" });
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("text=Not found")).toHaveCount(0);
    const screenshot = await captureRouteScreenshot(page);
    expect(screenshot.length).toBeGreaterThan(MIN_NON_BLANK_SCREENSHOT_BYTES);

    // Title rule: each route should set a route-specific <title>; sub-pages
    // must not silently fall back to the homepage title.
    const pathKey = route.split("?")[0];
    const titleRule = ROUTE_TITLE_RULES[pathKey];
    if (pathKey !== "/" && !titleRule) {
      // Wait up to 5s for Helmet on the actual page to win over the global
      // RootLayout title. Lazy-loaded routes (Suspense + dynamic import)
      // need a beat after networkidle before their <Helmet> applies.
      await expect
        .poll(async () => page.title(), { timeout: 5_000 })
        .not.toMatch(HOMEPAGE_TITLE_FALLBACK);
    }
    const title = await page.title();
    if (titleRule) {
      expect(title, `unexpected title on ${route}: ${title}`).toMatch(
        titleRule,
      );
    }
    expect(title, `missing title on ${route}`).not.toHaveLength(0);

    assertNoFailures(route, captured);
  });
}

for (const route of dashboardRoutes) {
  test(`dashboard route renders: ${route}`, async ({ page }) => {
    await setTestAuth(page);
    const captured = attachFailureCollectors(page);
    await page.goto(route);
    await expect(page.locator("body")).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator("text=Not found")).toHaveCount(0);
    const screenshot = await page.screenshot({ fullPage: true });
    expect(screenshot.length).toBeGreaterThan(MIN_NON_BLANK_SCREENSHOT_BYTES);
    assertNoFailures(route, captured);
  });
}

test("legacy dashboard routes redirect to their canonical surfaces", async ({
  page,
}) => {
  await setTestAuth(page);
  await page.goto("/dashboard/build/foo?x=1");
  await expect(page).toHaveURL(/\/dashboard\/my-agents\?x=1$/);

  await page.goto("/dashboard/apps/create");
  await expect(page).toHaveURL(/\/dashboard\/apps$/);
});

for (const [from, toPattern] of dashboardRedirects) {
  test(`legacy dashboard redirect: ${from}`, async ({ page }) => {
    await setTestAuth(page);
    await page.goto(from);
    await expect(page).toHaveURL(toPattern);
  });
}

test("anonymous protected dashboard routes redirect to login", async ({
  context,
  page,
}) => {
  await context.clearCookies();
  await page.goto("/dashboard/agents");
  await expect(page).toHaveURL(/\/login\?returnTo=/);
});
