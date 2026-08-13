/**
 * Shared readiness boundary for screenshots of the landing route. The page is
 * static DOM + CSS around a scripted iMessage demo; readiness is fonts, the
 * hero heading, and the demo having rendered messages. Under reduced motion
 * the demo renders its settled intro immediately (phase "settled"); otherwise
 * playback appends messages within a few seconds.
 */

import { expect, type Page } from "playwright/test";

const READINESS_TIMEOUT_MS = 30_000;

export async function waitForLandingIntro(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByRole("heading", { name: /personal Eliza starts/ }),
  ).toBeVisible({ timeout: READINESS_TIMEOUT_MS });

  const demo = page.locator(".landing-iphone");
  await expect
    .poll(async () => Number(await demo.getAttribute("data-demo-messages")), {
      timeout: READINESS_TIMEOUT_MS,
    })
    .toBeGreaterThanOrEqual(1);
}
