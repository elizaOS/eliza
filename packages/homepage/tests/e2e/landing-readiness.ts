/**
 * Shared readiness boundary for screenshots of the landing route. The page is
 * static DOM + CSS, so readiness is fonts plus the hero content and the
 * chat-bubble entrance animation reaching its terminal opacity.
 */

import { expect, type Page } from "playwright/test";

const READINESS_TIMEOUT_MS = 30_000;

export async function waitForLandingIntro(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByRole("heading", { name: /Get 4 hours of your time back/ }),
  ).toBeVisible({ timeout: READINESS_TIMEOUT_MS });

  const lastBubble = page.locator(".landing-bubble").last();
  await expect
    .poll(
      async () =>
        Number(
          await lastBubble.evaluate(
            (element) => getComputedStyle(element).opacity,
          ),
        ),
      { timeout: READINESS_TIMEOUT_MS },
    )
    .toBeGreaterThan(0.98);
}
