/**
 * Playwright authentication setup.
 *
 * Creates a Steward-backed development session once and saves it for E2E tests.
 */

import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import { installPlaywrightDevAuth } from "./dev-auth";

const authFile = path.join(__dirname, "../../../.playwright/auth.json");
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_BASE_URL ||
  process.env.TEST_API_URL?.replace(/\/api$/, "") ||
  "http://127.0.0.1:3400";

setup("authenticate as admin", async ({ page }) => {
  setup.setTimeout(60_000);

  const response = await page.request.get(`${baseURL}/api/health`);
  if (!response.ok()) {
    throw new Error(
      `Server is not responding at ${baseURL}; health returned ${response.status()}`,
    );
  }

  await installPlaywrightDevAuth(page, baseURL);
  await page.goto("/admin?dev=true", { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/admin**", { timeout: 10_000 });

  const accessDenied = await page
    .getByText("Access Denied")
    .isVisible({ timeout: 2_000 })
    .catch(() => false);
  if (accessDenied) {
    throw new Error("Admin access denied for Steward development auth session");
  }

  await expect(
    page.getByRole("heading", { name: "Admin Dashboard" }),
  ).toBeVisible({
    timeout: 15_000,
  });

  await page.context().storageState({ path: authFile });
});
