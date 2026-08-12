/**
 * Hosted-browser regression coverage for invalid public authentication
 * callbacks, including landmark, heading, safe destination, and keyboard
 * recovery contracts.
 */

import { expect, test } from "@playwright/test";
import { installDefaultAppRoutes } from "./helpers";

const INVALID_CALLBACKS = [
  {
    name: "CLI login without a session",
    path: "/auth/cli-login",
    heading: "Authentication Error",
  },
  {
    name: "email callback without an email",
    path: "/auth/callback/email?token=email-smoke-token",
    heading: "Sign-in failed",
  },
  {
    name: "OIDC continuation without a request id",
    path: "/oidc/continue",
    heading: "Authentication Error",
  },
] as const;

test.beforeEach(async ({ page }) => {
  await installDefaultAppRoutes(page);
});

for (const callback of INVALID_CALLBACKS) {
  test(`${callback.name} provides an accessible recovery action`, async ({
    page,
  }) => {
    await page.goto(callback.path, { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(
      page.getByRole("heading", { level: 1, name: callback.heading }),
    ).toBeVisible();
    const recovery = page.getByRole("link", { name: "Sign In Again" });
    await expect(recovery).toHaveAttribute("href", "/login");
    await page.keyboard.press("Tab");
    await expect(recovery).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/login$/);
  });
}
