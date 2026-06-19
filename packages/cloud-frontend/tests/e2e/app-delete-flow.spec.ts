// Application deletion — the apps-list row action: Open actions → Delete App →
// confirm → DELETE /api/v1/apps/:id. Completes the app lifecycle (create spec
// covers the other end). Runs against the local dev build with
// VITE_PLAYWRIGHT_TEST_AUTH=true; all /api/** calls are mocked.

import { expect, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "App delete flow uses local mocks; skipped in live-prod mode",
);

const APP_ID = "app_del_1";

function existingApp() {
  return {
    id: APP_ID,
    name: "Doomed App",
    app_url: "https://doomed.example.com",
    allowed_origins: ["https://doomed.example.com"],
    is_active: true,
    monetization_enabled: false,
    total_users: 0,
    total_requests: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

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
  // Mark the apps-page onboarding tour seen so its full-screen scrim never
  // mounts to intercept clicks (the only tour, id "apps", path /dashboard/apps).
  await context.addInitScript(() => {
    localStorage.setItem(
      "eliza-onboarding",
      JSON.stringify({ completedTours: ["apps"], skippedTours: ["apps"] }),
    );
  });
});

test("app: Delete App row action sends DELETE for the app id", async ({
  page,
}) => {
  let deletedId: string | null = null;

  await page.route("**/api/v1/apps/*", (route) => {
    if (route.request().method() === "DELETE") {
      deletedId =
        new URL(route.request().url()).pathname.split("/").pop() ?? "";
      return route.fulfill({ json: { success: true } });
    }
    return route.fulfill({ json: { app: existingApp() } });
  });

  await page.route("**/api/v1/apps", (route) =>
    route.fulfill({ json: { apps: [existingApp()] } }),
  );

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

  // The row's action menu trigger is labelled "Open actions" (sr-only).
  await page
    .getByRole("button", { name: /open actions/i })
    .first()
    .click();
  await page.getByRole("menuitem", { name: /delete app/i }).click();

  // Confirm dialog: destructive "Delete" action.
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^delete$/i })
    .click();

  await expect.poll(() => deletedId, { timeout: 10_000 }).toBe(APP_ID);
});
