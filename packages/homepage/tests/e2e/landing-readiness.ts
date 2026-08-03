/**
 * Shared readiness boundary for screenshots of the animated landing routes.
 * The signal is emitted only after the Three.js phone paints its final intro
 * message, which keeps capture timing independent of host load.
 */

import type { Page } from "playwright/test";

export async function waitForLandingIntro(page: Page) {
  await page.locator('[data-intro-ready="true"]').waitFor({
    state: "visible",
    timeout: 60_000,
  });
}
