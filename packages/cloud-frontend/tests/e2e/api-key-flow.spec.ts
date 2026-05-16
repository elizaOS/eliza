// API key flow — create → success dialog → copy → validate clipboard.
// Runs against the local dev build with VITE_PLAYWRIGHT_TEST_AUTH=true (so
// the test-auth cookie short-circuits the real auth flow). Mocks the
// /api/api-keys POST so the test does not touch any real backend.

import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "API key flow uses local mocks; skipped in live-prod mode",
);

const PLAINTEXT_KEY = "eliza_test_pk_abc123_DO_NOT_USE_IN_PROD";
const KEY_NAME = "Playwright integration";

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
  // Chromium needs explicit clipboard permission for navigator.clipboard.* to
  // resolve outside of an isolated test context. Firefox/WebKit ignore the
  // permission name — keep this scoped to chromium so it doesn't throw.
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "http://127.0.0.1:4173",
    });
  }
});

test("api-key: create → copy → clipboard contains the plaintext key", async ({
  page,
}) => {
  // 1. Listing call — empty list so the page renders the "create" CTA.
  await page.route("**/api/api-keys", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: { success: true, keys: [], summary: { total: 0, active: 0 } },
      });
    }
    if (route.request().method() === "POST") {
      return route.fulfill({
        json: {
          success: true,
          plainKey: PLAINTEXT_KEY,
          apiKey: {
            id: "key_1",
            name: KEY_NAME,
            description: "",
            preview: "eliza_test_pk_abc1…",
            permissions: ["agents:read"],
            rate_limit: 100,
            created_at: new Date().toISOString(),
            last_used_at: null,
            disabled: false,
          },
        },
      });
    }
    return route.fulfill({ json: { success: true } });
  });

  // Catch-all for any other /api/** call the page makes during render.
  await page.route("**/api/**", (route) => {
    if (route.request().url().includes("/api/api-keys"))
      return route.fallback();
    return route.fulfill({
      json: { success: true, data: [], items: [], balance: 100 },
    });
  });

  await page.goto("/dashboard/api-keys");
  await expect(page).not.toHaveURL(/\/login/);

  // 2. Open the create dialog. The empty-state CTA and the page-header CTA
  // both say "Create API Key" — pick the first visible one.
  await page
    .getByRole("button", { name: /create api key/i })
    .first()
    .click();

  // 3. Fill the name and submit.
  await page.locator("#api-key-name").fill(KEY_NAME);
  await page.getByRole("button", { name: /^create key$/i }).click();

  // 4. Success dialog should show the plaintext key in a readonly input.
  const successDialog = page.locator('[role="dialog"]', {
    hasText: /api key created successfully/i,
  });
  await expect(successDialog).toBeVisible({ timeout: 10_000 });
  await expect(
    successDialog.locator(`input[value="${PLAINTEXT_KEY}"]`),
  ).toBeVisible();

  // 5. Click the copy button (the icon-only button next to the readonly input).
  const copyButton = successDialog.getByRole("button").filter({
    has: page.locator("svg"),
  });
  // Drain any pre-existing clipboard value
  await page.evaluate(() => navigator.clipboard.writeText("__pre__"));
  await copyButton.first().click();

  // 6. Validate the clipboard contains the plaintext key.
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()), {
      timeout: 5_000,
      message: "clipboard never received the API key",
    })
    .toBe(PLAINTEXT_KEY);
});
