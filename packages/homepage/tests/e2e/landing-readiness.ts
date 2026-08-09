/**
 * Shared structural readiness boundary for screenshots of the animated landing
 * routes. It waits for the final shader, camera, and terminal chat state so
 * capture timing is independent of host load and animation duration.
 *
 * Budgets are sized for the worst supported host: the self-hosted fleet runs
 * several jobs against one software GPU, and renderer starvation can stall
 * rAF-driven progress for tens of seconds at a time. Every wait is bounded by
 * a real state transition, so the generous budget costs nothing on healthy
 * hosts.
 */

import { expect, type Page } from "playwright/test";

const READINESS_TIMEOUT_MS = 90_000;

export async function waitForLandingIntro(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector("header", { timeout: READINESS_TIMEOUT_MS });

  const tryButton = page.getByRole("button", { name: "Try Now" }).first();
  await tryButton.waitFor({ timeout: READINESS_TIMEOUT_MS });
  await expect
    .poll(
      async () =>
        Number(
          await tryButton.evaluate(
            (element) => getComputedStyle(element).opacity,
          ),
        ),
      { timeout: READINESS_TIMEOUT_MS },
    )
    .toBeGreaterThan(0.98);

  await expect(page.locator("[data-shader-background]")).toHaveAttribute(
    "data-shader-background",
    "settled",
    { timeout: READINESS_TIMEOUT_MS },
  );

  const phoneState = page.locator("[data-phone-model]");
  await expect(phoneState).toHaveAttribute("data-phone-model", "settled", {
    timeout: READINESS_TIMEOUT_MS,
  });
  await expect(phoneState).toHaveAttribute("data-chat-phase", "terminal");
  await expect(phoneState).toHaveAttribute("data-chat-rendered-messages", "5");
  await expect(phoneState).toHaveAttribute("data-chat-total-messages", "5");
}
