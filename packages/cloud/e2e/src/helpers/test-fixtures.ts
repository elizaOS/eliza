/**
 * Playwright test extension wiring the cloud stack as a worker-scoped fixture.
 *
 * One stack boot per worker. Per-test the `seededUser` identity is minted by the
 * REAL SIWE login handshake against the booted cloud-api (nonce → sign → verify
 * → find-or-create wallet account), then elevated to the suite's privileged
 * baseline (admin + funded org). So every spec authenticates with a credential
 * the genuine login path produced — not a direct DB-inserted key. We then inject
 * the playwright-test-session cookie for that identity before the page navigates.
 */

import crypto from "node:crypto";
import { test as base, expect, type Page } from "@playwright/test";
import { PLAYWRIGHT_TEST_AUTH_SECRET } from "../fixtures/env";
import type { SeededUser } from "../fixtures/seed";
import {
  type StackHandle,
  type StartCloudStackOptions,
  startCloudStack,
} from "../fixtures/stack";
import { loginAsSeededUser } from "./wallet-login";

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
  stackOptions: StartCloudStackOptions;
}

export interface CloudTestFixtures {
  seededUser: SeededUser;
  authenticatedPage: Page;
}

export const test = base.extend<CloudTestFixtures, CloudStackFixtures>({
  stackOptions: [{}, { scope: "worker", option: true }],

  stack: [
    async ({ stackOptions }, use) => {
      const handle = await startCloudStack(stackOptions);
      try {
        await use(handle);
      } finally {
        await handle.stop();
      }
    },
    { scope: "worker", timeout: 240_000 },
  ],

  seededUser: async ({ stack }, use) => {
    // Drive the real login path against the booted cloud-api, then elevate to
    // the privileged baseline. `stack` also guarantees DATABASE_URL is pointed
    // at the live PGlite bridge the elevation writes to.
    const user = await loginAsSeededUser(stack.urls.api);
    await use(user);
  },

  authenticatedPage: async ({ page, seededUser, stack }, use) => {
    // The stack was started with `frontend: false` (no apex web dev booted), so
    // there is no page to authenticate against. Skip explicitly instead of
    // crashing on `new URL("")` — a reader sees a clear skip, not an opaque
    // TypeError.
    test.skip(
      !stack.urls.frontend,
      "frontend not booted (stack started with frontend: false)",
    );
    const token = buildPlaywrightSessionToken(
      seededUser.userId,
      seededUser.organizationId,
    );
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
