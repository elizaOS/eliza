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

  if (devSession) {
    const tokenData = {
      TEST_USER_ID: devSession.userId,
      TEST_ACCESS_TOKEN: devSession.accessToken,
      updatedAt: new Date().toISOString(),
      baseURL: baseURL,
    };

    writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2));

    console.log(`✅ Dev auth tokens extracted and saved to ${tokenFile}`);
    console.log(`   User ID: ${devSession.userId}`);
    console.log(`   Token: ${devSession.accessToken.substring(0, 20)}...`);
    console.log(`   Updated: ${tokenData.updatedAt}`);
    return;
  }

  // Wait for Privy SDK to be ready
  console.log("⏳ Waiting for Privy SDK to initialize...");
  await page.waitForFunction(
    () => {
      if (typeof window === "undefined") return false;
      const privy = (
        window as {
          privy?: {
            ready?: boolean;
            getAccessToken?: () => Promise<string | null>;
          };
        }
      ).privy;
      return (
        privy?.ready === true && typeof privy.getAccessToken === "function"
      );
    },
    { timeout: 30000 },
  );

  console.log("✅ Privy SDK is ready");

  // Extract access token and user ID from browser
  console.log("🔑 Extracting authentication tokens...");
  const { accessToken, userId } = await page.evaluate(async (apiUrl) => {
    const privy = (
      window as { privy?: { getAccessToken?: () => Promise<string | null> } }
    ).privy;
    if (!privy?.getAccessToken) {
      throw new Error("Privy SDK getAccessToken not available");
    }

    const token = await privy.getAccessToken();
    if (!token) {
      throw new Error(
        "Could not get access token - user may not be authenticated",
      );
    }

    // Get user ID from API
    const response = await fetch(`${apiUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error(
        `API request failed: ${response.status} ${response.statusText}`,
      );
    }

    const userData = await response.json();
    return {
      accessToken: token,
      userId: userData.user?.id || null,
    };
  }, baseURL);

  if (!accessToken) {
    throw new Error("Failed to extract access token");
  }

  if (!userId) {
    throw new Error("Failed to extract user ID");
  }

  // Save tokens for integration tests
  const tokenData = {
    TEST_USER_ID: userId,
    TEST_ACCESS_TOKEN: accessToken,
    updatedAt: new Date().toISOString(),
    baseURL: baseURL,
  };

  writeFileSync(tokenFile, JSON.stringify(tokenData, null, 2));

  console.log(`✅ Auth tokens extracted and saved to ${tokenFile}`);
  console.log(`   User ID: ${userId}`);
  console.log(`   Token: ${accessToken.substring(0, 20)}...`);
  console.log(`   Updated: ${tokenData.updatedAt}`);
});
