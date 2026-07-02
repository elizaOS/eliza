import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { expect, type Page, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
} from "./helpers";

const TEST_AUTH_ENABLED =
  process.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
  process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true";

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

async function seedStewardToken(page: Page): Promise<void> {
  const token = makeJwt({
    sub: "cloud-console-route-smoke-user",
    email: "cloud-console-route-smoke@agent.local",
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: STEWARD_TOKEN_KEY, value: token },
  );
}

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

test.describe("cloud console route wiring", () => {
  test.skip(
    !TEST_AUTH_ENABLED,
    "set VITE_PLAYWRIGHT_TEST_AUTH=true so StewardProvider renders the local test-auth route shell",
  );

  test.beforeEach(async ({ page }) => {
    installPageDiagnosticsGuard(page);
    await installDefaultAppRoutes(page);
    await seedStewardToken(page);
  });

  test("registers /dashboard/analytics instead of falling through to the cloud 404", async ({
    page,
  }) => {
    await page.goto("/dashboard/analytics", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("status", { name: "Loading analytics" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /^Not found$/ }),
    ).toHaveCount(0);
    await expectNoPageDiagnostics(page, "dashboard analytics route");
  });

  test("admin gate accepts a persisted Steward token without raw SDK context", async ({
    page,
  }) => {
    await installAdminModerationRoutes(page);

    await page.goto("/dashboard/admin", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: "Admin Panel" }),
    ).toBeVisible();
    await expect(page.getByText("Sign in required")).toHaveCount(0);
    await expectNoPageDiagnostics(page, "dashboard admin persisted token gate");
  });
});
