/**
 * Shared structural readiness boundary for screenshots of the animated landing
 * routes. It waits for the final shader, camera, and terminal chat state so
 * capture timing is independent of host load and animation duration.
 */

import { expect, type Page } from "playwright/test";

export async function waitForLandingIntro(page: Page, timeoutMs = 20_000) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector("header", { timeout: timeoutMs });

  const tryButton = page.getByRole("button", { name: "Try Now" }).first();
  await tryButton.waitFor({ timeout: timeoutMs });
  await expect
    .poll(
      async () =>
        Number(
          await tryButton.evaluate(
            (element) => getComputedStyle(element).opacity,
          ),
        ),
      { timeout: timeoutMs },
    )
    .toBeGreaterThan(0.98);

  await expect(page.locator("[data-shader-background]")).toHaveAttribute(
    "data-shader-background",
    "settled",
    { timeout: timeoutMs },
  );

  const phoneState = page.locator("[data-phone-model]");
  await expect(phoneState).toHaveAttribute("data-phone-model", "settled", {
    timeout: timeoutMs,
  });
  await expect(phoneState).toHaveAttribute("data-chat-phase", "terminal");
  await expect(phoneState).toHaveAttribute("data-chat-rendered-messages", "5");
  await expect(phoneState).toHaveAttribute("data-chat-total-messages", "5");
}
