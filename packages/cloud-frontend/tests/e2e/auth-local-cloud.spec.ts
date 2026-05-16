import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const apiBaseUrl =
  process.env.TEST_API_BASE_URL?.trim() ||
  process.env.PLAYWRIGHT_API_URL?.trim() ||
  "http://127.0.0.1:8787";

const apiKey = process.env.TEST_API_KEY?.trim();

async function requireLocalCloud() {
  test.skip(!apiKey, "TEST_API_KEY is required for local cloud auth e2e");

  const health = await fetch(`${apiBaseUrl}/api/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  test.skip(
    !health.ok,
    `local cloud API is not reachable at ${apiBaseUrl}/api/health`,
  );
}

async function installLocalCloudSession(context: BrowserContext) {
  if (!apiKey) throw new Error("TEST_API_KEY is required");

  const response = await fetch(`${apiBaseUrl}/api/test/auth/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `failed to exchange API key for test session: ${response.status} ${body.slice(
        0,
        300,
      )}`,
    );
  }

  const json = (await response.json()) as {
    token?: string;
    cookieName?: string;
    user?: { id?: string; organizationId?: string };
  };
  if (!json.token || !json.user?.id || !json.user.organizationId) {
    throw new Error("test session response is missing token or user claims");
  }

  await context.addCookies([
    {
      name: json.cookieName ?? "eliza-test-session",
      value: json.token,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
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

  return json.user;
}

test.describe("local app to cloud authentication", () => {
  test.beforeEach(async () => {
    await requireLocalCloud();
  });

  async function expectDashboardRendered(page: Page) {
    await expect(
      page.getByRole("heading", { level: 1, name: "Dashboard" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("Something went wrong", { exact: false }),
    ).toHaveCount(0);
    await expect(
      page.getByText("TooltipProvider", { exact: false }),
    ).toHaveCount(0);
  }

  test("redirects anonymous dashboard visitors to login", async ({
    context,
    page,
  }) => {
    await context.clearCookies();

    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/login\?returnTo=/);
    await expect(page.locator("body")).toBeVisible();
  });

  test("uses a real Worker session cookie for dashboard and API requests", async ({
    context,
    page,
  }) => {
    const user = await installLocalCloudSession(context);

    const dashboardResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/dashboard") &&
        response.status() === 200,
    );
    const balanceResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/credits/balance") &&
        response.status() === 200,
    );

    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/dashboard$/);
    await expectDashboardRendered(page);
    await Promise.all([dashboardResponse, balanceResponse]);

    const apiResult = await page.evaluate(async () => {
      const [dashboard, balance] = await Promise.all([
        fetch("/api/v1/dashboard", { credentials: "include" }),
        fetch("/api/credits/balance", { credentials: "include" }),
      ]);
      return {
        dashboardStatus: dashboard.status,
        dashboardBody: await dashboard.json(),
        balanceStatus: balance.status,
        balanceBody: await balance.json(),
      };
    });

    expect(apiResult.dashboardStatus).toBe(200);
    expect(apiResult.balanceStatus).toBe(200);
    expect(apiResult.dashboardBody.user).toBeTruthy();
    expect(apiResult.balanceBody.balance).toBeDefined();
    expect(user.id).toBeTruthy();
    expect(user.organizationId).toBeTruthy();
  });

  test("logout clears the server session and protected APIs reject afterwards", async ({
    context,
    page,
  }) => {
    await installLocalCloudSession(context);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expectDashboardRendered(page);

    const logoutResponse = await page.evaluate(async () => {
      const response = await fetch("/api/auth/steward-session", {
        method: "DELETE",
        credentials: "include",
      });
      return { status: response.status, body: await response.json() };
    });
    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.body.ok).toBe(true);

    await context.clearCookies();
    const rejected = await page.evaluate(async () => {
      const response = await fetch("/api/v1/dashboard", {
        credentials: "include",
      });
      return { status: response.status, body: await response.json() };
    });

    expect(rejected.status).toBe(401);
    expect(rejected.body.code).toBe("authentication_required");
  });
});
