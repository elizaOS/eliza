/**
 * Playwright UI-smoke spec for the Cloud Console Routes app flow using the
 * real renderer fixture.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  seedAppStorage,
} from "./helpers";
import { installCloudApiStubs } from "./helpers/cloud-audit-fixtures";
import { seedStewardSession } from "./helpers/test-auth";

const TEST_AUTH_ENABLED =
  process.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
  process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true";

async function installAdminModerationRoutes(page: Page): Promise<void> {
  await page.route("**/api/v1/admin/moderation**", async (route) => {
    if (route.request().method() === "HEAD") {
      await route.fulfill({
        status: 204,
        headers: {
          "x-admin-role": "super_admin",
          "x-is-admin": "true",
        },
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        admins: { admins: [] },
        overview: {
          adminCount: 1,
          bannedUsers: 0,
          flaggedUsers: 0,
          totalViolations: 0,
        },
        users: { bannedUsers: [], flaggedUsers: [] },
        violations: { violations: [] },
      }),
    });
  });
}

async function installMcpRoutes(
  page: Page,
  expectedToken: string,
): Promise<{ requestUrls: string[] }> {
  const requestUrls: string[] = [];

  await page.route("**/api/v1/mcps**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }

    expect(request.headers().authorization).toBe(`Bearer ${expectedToken}`);

    const url = new URL(request.url());
    const scope = url.searchParams.get("scope") ?? "own";
    requestUrls.push(`${url.pathname}?scope=${scope}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mcps: [],
        total: 0,
        scope,
        filters: {},
        pagination: { limit: 50, offset: 0 },
      }),
    });
  });

  await page.route("**/api/mcp/list", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }

    requestUrls.push(new URL(request.url()).pathname);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mcps: [],
        total: 0,
        categories: [],
      }),
    });
  });

  return { requestUrls };
}

test.describe("cloud console route wiring", () => {
  test.skip(
    !TEST_AUTH_ENABLED,
    "set VITE_PLAYWRIGHT_TEST_AUTH=true so StewardProvider renders the local test-auth route shell",
  );

  let stewardToken: string;

  test.beforeEach(async ({ page }) => {
    installPageDiagnosticsGuard(page);
    await installDefaultAppRoutes(page);
    await installCloudApiStubs(page);
    await seedAppStorage(page);
    stewardToken = await seedStewardSession(page, {
      jwt: true,
      subject: "cloud-console-route-smoke-user",
      email: "cloud-console-route-smoke@agent.local",
    });
  });

  test("registers /cloud/analytics instead of falling through to the cloud 404", async ({
    page,
  }) => {
    await page.goto("/cloud/analytics", { waitUntil: "domcontentloaded" });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const server = localStorage.getItem("elizaos:active-server");
          return server ? JSON.parse(server).kind : null;
        }),
      )
      .toBe("local");
    await expect(page.locator("[data-app-shell-root]")).toBeVisible();
    await expect(page.getByTestId("view-header")).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Analytics", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Total requests" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Not found$/ }),
    ).toHaveCount(0);
    await expectNoPageDiagnostics(page, "cloud analytics route");
  });

  test("admin gate accepts a persisted Steward token without raw SDK context", async ({
    page,
  }) => {
    await installAdminModerationRoutes(page);

    await page.goto("/cloud/admin", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: "Admin Panel" }),
    ).toBeVisible();
    await expect(page.getByText("Sign in required")).toHaveCount(0);
    await expectNoPageDiagnostics(page, "cloud admin persisted token gate");
  });

  test("MCPs route loads registry data with only a persisted Steward token", async ({
    page,
  }) => {
    const mcpApi = await installMcpRoutes(page, stewardToken);

    await page.goto("/cloud/mcps", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByText("You haven't registered any MCP servers yet."),
    ).toBeVisible();
    await expect
      .poll(() => mcpApi.requestUrls)
      .toEqual(
        expect.arrayContaining([
          "/api/v1/mcps?scope=own",
          "/api/v1/mcps?scope=public",
          "/api/mcp/list",
        ]),
      );
    await expectNoPageDiagnostics(page, "cloud MCPs persisted token gate");
  });
});

test.describe("signed-out cloud console routing", () => {
  test("preserves a protected Cloud deep link through the same-origin login returnTo", async ({
    page,
  }) => {
    installPageDiagnosticsGuard(page);
    await installDefaultAppRoutes(page);
    await installCloudApiStubs(page);
    await seedAppStorage(page);

    await page.goto(
      "/cloud/agents/565f9cb3-3836-4954-8ef5-cfa8d033dbc0?from=manual#status",
      { waitUntil: "domcontentloaded" },
    );

    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      })
      .toBe(
        "/login?returnTo=%2Fcloud%2Fagents%2F565f9cb3-3836-4954-8ef5-cfa8d033dbc0%3Ffrom%3Dmanual%23status",
      );
    await expect(
      page.getByRole("heading", { name: "Sign in", level: 1 }),
    ).toBeVisible();
    await expectNoPageDiagnostics(page, "signed-out Cloud login returnTo");
  });
});
