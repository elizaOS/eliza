/**
 * Integration Tests Authentication Setup
 *
 * This setup script extracts authentication tokens from Playwright's authenticated
 * browser context and saves them for use in integration tests. This allows integration
 * tests to use the same authentication state as E2E tests without manual token management.
 *
 * Prerequisites:
 * - E2E auth setup must run first (tests/e2e/auth.setup.ts)
 * - Server must be running
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test as setup } from "@playwright/test";
import { PLAYWRIGHT_DEV_AUTH_STORAGE_KEY } from "../e2e/dev-auth";

const authFile = path.join(__dirname, "../../../.playwright/auth.json");
const tokenFile = path.join(__dirname, "../../../.playwright/test-tokens.json");
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_BASE_URL ||
  process.env.TEST_API_URL?.replace(/\/api$/, "") ||
  "http://127.0.0.1:3400";

setup("extract auth tokens for integration tests", async ({ page }) => {
  // Check if auth state exists (from E2E setup)
  if (!existsSync(authFile)) {
    throw new Error(
      `Authentication state file not found: ${authFile}\n` +
        "Please run E2E auth setup first: bunx playwright test --project=setup",
    );
  }

  // Load authenticated state
  await page.goto(baseURL);

  const devSession = await page.evaluate((storageKey) => {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { userId?: unknown }).userId !== "string" ||
      typeof (parsed as { accessToken?: unknown }).accessToken !== "string"
    ) {
      return null;
    }

    return parsed as { userId: string; accessToken: string };
  }, PLAYWRIGHT_DEV_AUTH_STORAGE_KEY);

  if (!devSession) {
    throw new Error(
      "Steward dev auth session not found in browser storage. Run the Playwright setup project first.",
    );
  }

  const tokenData = {
    TEST_USER_ID: devSession.userId,
    TEST_ACCESS_TOKEN: devSession.accessToken,
    updatedAt: new Date().toISOString(),
    baseURL: baseURL,
  };

  writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2));

  console.log(`✅ Steward auth tokens extracted and saved to ${tokenFile}`);
  console.log(`   User ID: ${devSession.userId}`);
  console.log(`   Token: ${devSession.accessToken.substring(0, 20)}...`);
  console.log(`   Updated: ${tokenData.updatedAt}`);
});
