/**
 * Playwright test extension wiring the cloud stack as a worker-scoped fixture.
 *
 * One stack boot per worker. Per-test we seed a fresh user + inject the
 * playwright-test-session cookie before the page navigates.
 */

import crypto from "node:crypto";
import { test as base, expect, type Page } from "@playwright/test";
import { PLAYWRIGHT_TEST_AUTH_SECRET } from "../fixtures/env";
import { type SeededUser, seedTestUser } from "../fixtures/seed";
import { type StackHandle, startCloudStack } from "../fixtures/stack";

function buildPlaywrightSessionToken(
  userId: string,
  organizationId: string,
): string {
  const claims = {
    userId,
    organizationId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", PLAYWRIGHT_TEST_AUTH_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export interface CloudStackFixtures {
  stack: StackHandle;
}

export interface CloudTestFixtures {
  seededUser: SeededUser;
  authenticatedPage: Page;
}

export const test = base.extend<CloudTestFixtures, CloudStackFixtures>({
  stack: [
    async ({}, use) => {
      const handle = await startCloudStack();
      try {
        await use(handle);
      } finally {
        await handle.stop();
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],

  seededUser: async ({ stack: _stack }, use) => {
    // _stack ensures DATABASE_URL pointed at PGlite is live before we seed.
    const user = await seedTestUser();
    await use(user);
  },

  authenticatedPage: async ({ page, seededUser, stack }, use) => {
    const token = buildPlaywrightSessionToken(
      seededUser.userId,
      seededUser.organizationId,
    );
    if (stack.frontendSkipped || !stack.urls.frontend) {
      // Explicit, actionable failure instead of a silent pass or a cryptic
      // `new URL("")` "Invalid URL" crash when the frontend was never booted
      // (#9151). A frontend-dependent spec cannot meaningfully run here.
      throw new Error(
        "[cloud-e2e] authenticatedPage requires a running frontend, but it was " +
          `not booted: ${stack.frontendSkipReason ?? "no frontend URL"} ` +
          "Repoint the harness to packages/app's web dev (#9151), or run this " +
          "spec only when the frontend is available.",
      );
    }
    const frontendUrl = new URL(stack.urls.frontend);
    await page.context().addCookies([
      {
        name: "eliza-test-auth",
        value: "1",
        domain: frontendUrl.hostname,
        path: "/",
      },
      {
        name: "eliza-test-session",
        value: token,
        domain: frontendUrl.hostname,
        path: "/",
      },
    ]);
    await use(page);
  },
});

export { expect };
