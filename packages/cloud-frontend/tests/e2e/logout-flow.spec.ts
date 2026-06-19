// Logout lifecycle — the UI Sign-out path that had no behavioral coverage.
// Opens the dashboard user menu, clicks "Sign out", and asserts the real
// POST /api/auth/logout fires and the app navigates back to the public landing.
// Runs against the local dev build with VITE_PLAYWRIGHT_TEST_AUTH=true.

import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Logout flow uses local mocks; skipped in live-prod mode",
);

test.beforeEach(async ({ context }) => {
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
});

test("logout: Sign out fires POST /api/auth/logout and returns to landing", async ({
  page,
}) => {
  let logoutCalled = false;
  await page.route("**/api/auth/logout", (route) => {
    logoutCalled = true;
    return route.fulfill({ json: { success: true } });
  });

  // Generic success for the rest of the dashboard's render-time API calls.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      if (new URL(route.request().url()).pathname === "/api/auth/logout") {
        return route.fallback();
      }
      return route.fulfill({
        json: { success: true, data: [], items: [], balance: 100 },
      });
    },
  );

  await page.goto("/dashboard");
  await expect(page).not.toHaveURL(/\/login/);

  // Open the user menu (avatar trigger) and sign out.
  await page.getByRole("button", { name: /open user menu/i }).click();
  await page.getByRole("menuitem", { name: /sign out/i }).click();

  // The handler POSTs logout and navigates to "/" (replace).
  await expect.poll(() => logoutCalled, { timeout: 10_000 }).toBe(true);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
});
