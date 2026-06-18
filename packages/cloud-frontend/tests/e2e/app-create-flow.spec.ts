// Application creation — the create-app dialog: name availability check
// (POST /api/v1/apps/check-name) → create (POST /api/v1/apps) → reveal the new
// app's API key. Had zero behavioral coverage. Runs against the local dev build
// with VITE_PLAYWRIGHT_TEST_AUTH=true; all /api/** calls are mocked.

import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "App create flow uses local mocks; skipped in live-prod mode",
);

const NEW_APP_NAME = "Playwright App";
const NEW_APP_URL = "https://playwright.example.com";
const NEW_APP_ID = "app_pw_1";
const NEW_APP_KEY = "eliza_app_pk_PLAYWRIGHT_DO_NOT_USE";

test.beforeEach(async ({ context, browserName }) => {
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
  // Mark the apps-page onboarding tour seen so its full-screen scrim never
  // mounts to intercept clicks (the only tour, id "apps", path /dashboard/apps).
  await context.addInitScript(() => {
    localStorage.setItem(
      "eliza-onboarding",
      JSON.stringify({ completedTours: ["apps"], skippedTours: ["apps"] }),
    );
  });
  if (browserName === "chromium") {
    const origin = new URL(
      process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:4173",
    ).origin;
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin,
    });
  }
});

test("app: create dialog → check-name → POST /api/v1/apps → reveals API key", async ({
  page,
}) => {
  let createBody: unknown = null;
  let checkNameCalled = false;

  await page.route("**/api/v1/apps/check-name", (route) => {
    checkNameCalled = true;
    return route.fulfill({ json: { available: true } });
  });

  await page.route("**/api/v1/apps", (route) => {
    if (route.request().method() === "POST") {
      createBody = route.request().postDataJSON();
      return route.fulfill({
        json: {
          app: {
            id: NEW_APP_ID,
            name: NEW_APP_NAME,
            app_url: NEW_APP_URL,
          },
          apiKey: NEW_APP_KEY,
        },
      });
    }
    // GET list — empty so the page shows the create CTA cleanly.
    return route.fulfill({ json: { apps: [] } });
  });

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith("/api/v1/apps")) return route.fallback();
      return route.fulfill({
        json: { success: true, data: [], items: [], apps: [], balance: 100 },
      });
    },
  );

  await page.goto("/dashboard/apps");
  await expect(page).not.toHaveURL(/\/login/);

  // The "Create App" button lives inside a collapsed "Advanced" <details>
  // disclosure — open every disclosure, then click the now-visible button.
  await page.evaluate(() => {
    for (const d of Array.from(document.querySelectorAll("details"))) {
      (d as HTMLDetailsElement).open = true;
    }
  });
  await page
    .getByRole("button", { name: /create app/i })
    .first()
    .click();

  // Fill the form. The name field debounces a check-name request.
  await page.locator("#app-name").fill(NEW_APP_NAME);
  await page.locator("#app-url").fill(NEW_APP_URL);
  await expect.poll(() => checkNameCalled, { timeout: 5_000 }).toBe(true);

  // Submit. The dialog's own "Create App" button is the last one on the page.
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /create app/i }).click();

  // The created state surfaces the new app's API key.
  await expect.poll(() => createBody, { timeout: 10_000 }).toBeTruthy();
  expect(createBody).toMatchObject({
    name: NEW_APP_NAME,
    app_url: NEW_APP_URL,
  });
  await expect(dialog.locator(`input[value="${NEW_APP_KEY}"]`)).toBeVisible({
    timeout: 10_000,
  });
});
