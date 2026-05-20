import { expect, type Page, test } from "playwright/test";

const TEST_TOKEN = "homepage-e2e-token";

test.describe.configure({ mode: "serial" });

const mockUser = {
  id: "user_homepage_e2e",
  telegram_id: "123456",
  telegram_username: "homepage_e2e",
  telegram_first_name: "Homepage",
  discord_id: null,
  discord_username: null,
  discord_global_name: null,
  discord_avatar_url: null,
  whatsapp_id: null,
  whatsapp_name: null,
  phone_number: null,
  name: "Homepage E2E",
  avatar: null,
  organization_id: "org_homepage_e2e",
  created_at: "2026-01-01T00:00:00.000Z",
};

async function installHomepageApiMocks(page: Page) {
  let linkedPhone: string | null = null;

  await page.route("https://www.elizacloud.ai/api/eliza-app/**/chat", (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            id: "assistant-welcome",
            role: "assistant",
            content: "Your AI space is ready.",
          },
        ],
        containerStatus: "ready",
      },
    }),
  );

  await page.route("https://www.elizacloud.ai/api/eliza-app/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/eliza-app/user/me") {
      return route.fulfill({
        json: {
          user: { ...mockUser, phone_number: linkedPhone },
          organization: {
            id: "org_homepage_e2e",
            name: "Homepage E2E Org",
            credit_balance: "42.50",
          },
        },
      });
    }

    if (path === "/api/eliza-app/user/phone") {
      const body = route.request().postDataJSON() as { phone_number?: unknown };
      linkedPhone = String(body.phone_number ?? "");
      return route.fulfill({
        json: { success: true, phone_number: linkedPhone },
      });
    }

    if (path === "/api/eliza-app/auth/telegram") {
      return route.fulfill({
        json: {
          success: true,
          user: {
            id: mockUser.id,
            telegram_id: mockUser.telegram_id,
            telegram_username: mockUser.telegram_username,
            phone_number: "+15555550123",
            name: mockUser.name,
            organization_id: mockUser.organization_id,
          },
          session: {
            token: TEST_TOKEN,
            expires_at: "2026-12-31T00:00:00.000Z",
          },
          is_new_user: true,
        },
      });
    }

    return route.fulfill({ status: 404, json: { error: "Unhandled mock" } });
  });
}

async function seedAuthenticatedSession(page: Page) {
  await page.addInitScript((token) => {
    window.localStorage.setItem("eliza_app_session", token as string);
  }, TEST_TOKEN);
  await page.evaluate((token) => {
    window.localStorage.setItem("eliza_app_session", token as string);
  }, TEST_TOKEN);
}

test.beforeEach(async ({ page }) => {
  await installHomepageApiMocks(page);
});

test("login routes anonymous and authenticated users to the correct next page", async ({
  page,
}) => {
  await page.goto("/login");
  await expect(page).toHaveURL(/\/get-started$/);
  await expect(
    page.getByRole("heading", { name: "Anywhere you want her to be." }),
  ).toBeVisible();

  await seedAuthenticatedSession(page);
  await page.goto("/login");
  await expect(page).toHaveURL(/\/connected$/);
  await expect(page.getByRole("heading", { name: "Connected." })).toBeVisible();
});

test("get-started covers method selection, phone input, country dropdown, and direct messaging options", async ({
  page,
}) => {
  await page.goto("/get-started");
  await expect(
    page.getByRole("heading", { name: "Anywhere you want her to be." }),
  ).toBeVisible();

  await page.getByRole("button", { name: /^iMessage$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Ready to chat!" }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText(
    "I also want to use Telegram",
  );

  await page.getByRole("button", { name: "Back" }).dispatchEvent("click");
  await page.getByRole("button", { name: /^WhatsApp$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Chat on WhatsApp!" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Back" }).dispatchEvent("click");
  await page.getByRole("button", { name: /^Telegram$/ }).dispatchEvent("click");
  await expect(
    page.getByRole("heading", { name: "Connect with Telegram" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Connect Telegram/i }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Back" }).dispatchEvent("click");
  await page.getByRole("button", { name: /^Discord$/ }).dispatchEvent("click");
  await expect(page.locator("main")).toContainText("Discord not configured");
});

test("connected page exercises account menu, copy controls, link-phone form, and connection buttons", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedAuthenticatedSession(page);
  await page.goto("/connected");

  await expect(page.getByRole("heading", { name: "Connected." })).toBeVisible();
  await expect(page.getByText("$42.50")).toBeVisible();

  await page.getByLabel("Open user menu").click();
  await expect(page.getByText("Homepage E2E")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByLabel("Copy Telegram link").click({ force: true });
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("t.me/");

  await page.getByRole("button", { name: /^iMessage$/ }).click();
  await page.getByLabel("Choose country").selectOption("CA");
  await page.getByLabel("Phone number").fill("416 555 0123");
  await page.getByRole("button", { name: "Link Phone" }).click();
  await expect(page.getByLabel("Phone number", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /iMessage \+1 \(415\) 961-1510/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Connect Discord" }).click();
  await expect(page).toHaveURL(/\/get-started\?method=discord&link=true/);
});

test("leaderboard/onboarding page renders its animated shell and primary entrypoint", async ({
  page,
}) => {
  await page.goto("/leaderboard");

  await expect(page.locator("main")).toBeVisible();
  await expect(page.getByLabel("Eliza")).toBeVisible({ timeout: 20_000 });
});
