/**
 * Shared structural readiness boundary for screenshots of the landing routes.
 * It waits for the direct-entry navigation and mounted phone scene.
 */

import { expect, type Page } from "playwright/test";

export async function waitForLandingIntro(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector("header", { timeout: 20_000 });
  await expect(page.getByRole("link", { name: "Sign In" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Chat with Eliza" }),
  ).toBeVisible();

  await expect(page.locator("[data-phone-model]")).toHaveCount(1);
  await expect(page.locator("[data-phone-scene]")).toHaveCount(1);
}
