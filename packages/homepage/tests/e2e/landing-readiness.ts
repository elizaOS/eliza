/**
 * Shared readiness boundary for screenshots of the landing route. Every
 * viewport renders the same phone-first hero; mobile compacts the controls so
 * the framed conversation can use the remaining display height. Readiness is
 * fonts, the visible heading, and the demo having rendered messages. Under
 * Reduced motion renders its settled first room immediately (phase
 * "settled"); otherwise the five-room playback begins within seconds.
 */

import { expect, type Page } from "playwright/test";

const READINESS_TIMEOUT_MS = 30_000;

export async function waitForLandingIntro(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByRole("heading", { name: /one member every group chat needs/i }),
  ).toBeAttached({ timeout: READINESS_TIMEOUT_MS });

  const demo = page.locator(".landing-iphone");
  await expect
    .poll(async () => Number(await demo.getAttribute("data-demo-messages")), {
      timeout: READINESS_TIMEOUT_MS,
    })
    .toBeGreaterThanOrEqual(1);
}
