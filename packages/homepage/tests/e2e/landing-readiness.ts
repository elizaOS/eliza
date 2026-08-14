/**
 * Shared readiness boundary for screenshots of the landing route. Desktop
 * renders the hero composition; under 640 px the page becomes a full-screen
 * conversation, so the heading is present for assistive tech but not painted.
 * Readiness is therefore fonts, the heading in the DOM, and the demo having
 * rendered messages. Under reduced motion the demo renders its settled intro
 * immediately (phase "settled"); otherwise playback appends within seconds.
 */

import { expect, type Page } from "playwright/test";

const READINESS_TIMEOUT_MS = 30_000;

export async function waitForLandingIntro(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await expect(
    page.getByRole("heading", { name: /Four hours of your time back/ }),
  ).toBeAttached({ timeout: READINESS_TIMEOUT_MS });

  const demo = page.locator(".landing-iphone");
  await expect
    .poll(async () => Number(await demo.getAttribute("data-demo-messages")), {
      timeout: READINESS_TIMEOUT_MS,
    })
    .toBeGreaterThanOrEqual(1);
}
