/**
 * Shared structural readiness boundary for screenshots of the animated landing
 * routes. It waits for the final shader, camera, and terminal chat state so
 * capture timing is independent of host load and animation duration.
 */

import { expect, type Page } from "playwright/test";

export async function waitForLandingIntro(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector("header", { timeout: 20_000 });

  const tryButton = page.getByRole("button", { name: "Try Now" }).first();
  await tryButton.waitFor({ timeout: 15_000 });
  await expect
    .poll(
      async () =>
        Number(
          await tryButton.evaluate(
            (element) => getComputedStyle(element).opacity,
          ),
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0.98);

  await expect(page.locator("[data-shader-background]")).toHaveAttribute(
    "data-shader-background",
    "settled",
    { timeout: 20_000 },
  );

  const phoneState = page.locator("[data-phone-model]");
  await expect(phoneState).toHaveAttribute("data-phone-model", "settled", {
    timeout: 20_000,
  });
  await expect(phoneState).toHaveAttribute("data-chat-phase", "terminal");
  await expect(phoneState).toHaveAttribute("data-chat-rendered-messages", "5");
  await expect(phoneState).toHaveAttribute("data-chat-total-messages", "5");
}
