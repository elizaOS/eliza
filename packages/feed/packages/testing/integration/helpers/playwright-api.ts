/**
 * Playwright API Request Helper for Integration Tests
 *
 * Provides a Playwright APIRequestContext for making authenticated API calls
 * in integration tests. Uses the authenticated state from Playwright setup.
 *
 * @module testing/integration/helpers/playwright-api
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { type APIRequestContext, request } from "@playwright/test";

const authFile = path.join(__dirname, "../../../.playwright/auth.json");
const tokenFile = path.join(__dirname, "../../../.playwright/test-tokens.json");
const rawBaseURL =
  process.env.TEST_BASE_URL ||
  process.env.PLAYWRIGHT_BASE_URL ||
  process.env.TEST_API_URL ||
  process.env.API_URL ||
  "http://localhost:3000";
const baseURL = rawBaseURL.replace(/\/api$/, "");

let apiRequest: APIRequestContext | null = null;
let testUserId: string | null = null;

/**
 * Checks if Playwright authentication is available.
 *
 * Use this to conditionally skip tests when auth isn't set up.
 *
 * @returns `true` if auth file exists and tests can run
 */
export function isAuthAvailable(): boolean {
  return existsSync(authFile);
}

/**
 * Gets a descriptive reason why auth is not available.
 *
 * @returns Description of why auth is unavailable
 */
export function getAuthUnavailableReason(): string {
  if (!existsSync(authFile)) {
    return "Playwright auth not set up (run: bunx playwright test --project=setup)";
  }
  return "Unknown auth issue";
}

/**
 * Initializes Playwright API request context with authentication.
 *
 * @returns Promise resolving to API request context and test user ID
 */
export async function initPlaywrightAPI(): Promise<{
  apiRequest: APIRequestContext;
  testUserId: string;
}> {
  if (apiRequest && testUserId) {
    return { apiRequest, testUserId };
  }

  if (!existsSync(authFile)) {
    throw new Error(
      `Authentication state file not found: ${authFile}\n` +
        "Please run Playwright setup first:\n" +
        "  bunx playwright test --project=setup\n" +
        "  bunx playwright test --project=setup-integration-auth",
    );
  }

  let tokens: { TEST_USER_ID?: string; TEST_ACCESS_TOKEN?: string } | null =
    null;
  if (existsSync(tokenFile)) {
    try {
      tokens = JSON.parse(readFileSync(tokenFile, "utf-8"));
    } catch (error) {
      console.warn(`⚠️  Could not read token file: ${error}`);
    }
  }

  apiRequest = await request.newContext({
    storageState: authFile,
    baseURL: baseURL,
  });

  try {
    const response = await apiRequest.get(`${baseURL}/api/users/me`);
    if (response.ok()) {
      const userData = await response.json();
      testUserId = userData.user?.id || tokens?.TEST_USER_ID || null;
    } else {
      testUserId = tokens?.TEST_USER_ID || null;
    }
  } catch (error) {
    console.warn(`⚠️  Could not fetch user ID from API: ${error}`);
    testUserId = tokens?.TEST_USER_ID || null;
  }

  if (!testUserId) {
    throw new Error(
      "Could not determine test user ID. Please ensure:\n" +
        "1. Playwright auth setup has been run\n" +
        "2. User is authenticated\n" +
        "3. Token file exists at .playwright/test-tokens.json",
    );
  }

  return { apiRequest, testUserId };
}

/**
 * Cleans up Playwright API request context.
 */
export async function cleanupPlaywrightAPI(): Promise<void> {
  if (apiRequest) {
    await apiRequest.dispose();
    apiRequest = null;
  }
  testUserId = null;
}

/**
 * Gets the API base URL.
 *
 * @returns The API base URL string
 */
export function getAPIBaseURL(): string {
  return `${baseURL}/api`;
}
