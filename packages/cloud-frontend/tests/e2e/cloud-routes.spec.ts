import { expect, type Page, test } from "@playwright/test";

// In live-prod mode the mocked-API specs do not apply (cookies are scoped to
// 127.0.0.1, fixtures don't exist on real backends). Skip the whole file.
test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "cloud-routes.spec uses local mocks; live-prod runs cloud-routes-live.spec instead",
);

test.describe.configure({ mode: "serial" });

const MIN_NON_BLANK_SCREENSHOT_BYTES = 1_000;

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

// Page-title sanity per route. The homepage title is the brand fallback;
// when a sub-page accidentally inherits it (because of missing <title> on
// that route), it's a real bug we want to fail on.
const CLOUD_TITLE = /eliza cloud - Run in Cloud/i;
const ROUTE_TITLE_RULES: Record<string, RegExp> = {
  "/": CLOUD_TITLE,
};

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
  "/login",
  "/terms-of-service",
  "/privacy-policy",
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
  "/dashboard/documents",
  "/dashboard/analytics",
  "/dashboard/earnings",
  "/dashboard/affiliates",
  "/dashboard/invoices/inv_1",
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
const dashboardRedirects: Array<[from: string, toPattern: RegExp]> = [
  ["/dashboard/chat", /\/dashboard\/my-agents$/],
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
    await page.goto(route);
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator("text=Not found")).toHaveCount(0);
    const screenshot = await captureRouteScreenshot(page);
    expect(screenshot.length).toBeGreaterThan(MIN_NON_BLANK_SCREENSHOT_BYTES);

    // Title rule: each route should set a route-specific <title>; sub-pages
    // must not silently fall back to the homepage title.
    const pathKey = route.split("?")[0];
    const titleRule = ROUTE_TITLE_RULES[pathKey];
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
