/**
 * Real-browser coverage for CLI authentication completion across ordinary tabs,
 * orphaned login tabs, and named popup handoffs. The renderer and router are
 * exact-head local bytes; Steward authentication and the completion endpoint
 * use the repository's documented browser-test seams.
 */

import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { seedStewardSession } from "./helpers/test-auth";

const PROVIDERS = {
  passkey: false,
  email: true,
  sms: false,
  siwe: false,
  siws: false,
  google: false,
  discord: false,
  github: false,
  twitter: false,
  oauth: [],
};

const TEST_AUTH_ENABLED =
  process.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
  process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true";

async function installManagedOriginProxy(
  context: BrowserContext,
  localBaseUrl: string,
  onComplete: (sessionId: string) => void,
): Promise<string> {
  const local = new URL(localBaseUrl);
  const managed = new URL(localBaseUrl);
  managed.hostname = "cloud.eliza.app";

  await context.route(`${managed.origin}/**`, async (route) => {
    const target = new URL(route.request().url());
    target.protocol = local.protocol;
    target.hostname = local.hostname;
    target.port = local.port;
    const response = await route.fetch({ url: target.toString() });
    await route.fulfill({ response });
  });
  await context.route("**/auth/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PROVIDERS),
    });
  });
  await context.route("**/api/auth/cli-session/*/complete", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const sessionId = path.split("/").at(-2);
    if (!sessionId) throw new Error(`Missing CLI session id in ${path}`);
    onComplete(sessionId);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ keyPrefix: "ek_test_browser" }),
    });
  });

  return managed.origin;
}

async function armAuthenticatedCloudPage(
  page: Page,
  managedOrigin: string,
): Promise<void> {
  await page.context().addCookies([
    {
      name: "eliza-test-auth",
      value: "1",
      domain: "cloud.eliza.app",
      path: "/",
      sameSite: "Lax",
    },
  ]);
  await seedStewardSession(page, {
    jwt: true,
    userId: "22222222-2222-4222-8222-222222222222",
    email: "cli-auth-browser@test.local",
  });
  await page.goto(`${managedOrigin}/terms-of-service`);
}

test.describe("CLI auth completion handoff", () => {
  test.skip(
    !TEST_AUTH_ENABLED,
    "requires VITE_PLAYWRIGHT_TEST_AUTH=true in the renderer build",
  );

  test("ordinary success replays into an orphaned login tab", async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("Playwright baseURL is required");
    const completed: string[] = [];
    const managedOrigin = await installManagedOriginProxy(
      page.context(),
      baseURL,
      (sessionId) => completed.push(sessionId),
    );
    await armAuthenticatedCloudPage(page, managedOrigin);

    await page.goto(`${managedOrigin}/auth/cli-login?session=sess-browser-tab`);
    await expect(
      page.getByRole("heading", { name: "Authorize CLI Sign-In?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Authorize" }).click();

    await expect(
      page.getByRole("heading", { name: "Authentication Complete!" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Return to App" }),
    ).toHaveAttribute("href", "/");
    await expect(
      page.getByRole("button", { name: "Close window" }),
    ).toHaveCount(0);
    expect(completed).toEqual(["sess-browser-tab"]);

    const orphan = await page.context().newPage();
    const returnTo = encodeURIComponent(
      `/auth/cli-login?session=sess-browser-tab`,
    );
    await orphan.goto(`${managedOrigin}/login?returnTo=${returnTo}`);
    await expect(
      orphan.getByRole("heading", { name: "You're signed in" }),
    ).toBeVisible();
    await expect(
      orphan.getByRole("link", { name: "Return to App" }),
    ).toHaveAttribute("href", "/");
    await expect(
      orphan.getByRole("button", { name: "Close window" }),
    ).toHaveCount(0);
    expect(completed).toEqual(["sess-browser-tab"]);
  });

  test("named popup completes once, closes, and leaves replayable terminal state", async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("Playwright baseURL is required");
    const completed: string[] = [];
    const managedOrigin = await installManagedOriginProxy(
      page.context(),
      baseURL,
      (sessionId) => completed.push(sessionId),
    );
    await armAuthenticatedCloudPage(page, managedOrigin);

    const popupPromise = page.waitForEvent("popup");
    await page.evaluate((url) => {
      window.open(url, "eliza-cloud-auth", "popup,width=520,height=720");
    }, `${managedOrigin}/auth/cli-login?session=sess-browser-popup`);
    const popup = await popupPromise;
    await expect(
      popup.getByRole("heading", { name: "Authorize CLI Sign-In?" }),
    ).toBeVisible();
    await popup.getByRole("button", { name: "Authorize" }).click();
    await popup.waitForEvent("close");
    expect(completed).toEqual(["sess-browser-popup"]);

    const replay = await page.context().newPage();
    await replay.goto(
      `${managedOrigin}/auth/cli-login?session=sess-browser-popup`,
    );
    await expect(
      replay.getByRole("heading", { name: "Authentication Complete!" }),
    ).toBeVisible();
    await expect(
      replay.getByRole("link", { name: "Return to App" }),
    ).toHaveAttribute("href", "/");
    expect(completed).toEqual(["sess-browser-popup"]);
  });
});
