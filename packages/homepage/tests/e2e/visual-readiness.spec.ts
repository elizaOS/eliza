/**
 * Browser contracts for the semantic boundaries that make homepage captures
 * reproducible. The landing route is static DOM + CSS, so the contracts here
 * are alias equivalence, terminal chat-mockup state, and viewport containment.
 */

import { expect, test } from "playwright/test";
import { waitForLandingIntro } from "./landing-readiness";

const FIXED_TIME = new Date("2026-01-15T14:30:00.000Z");

test.use({
  reducedMotion: "reduce",
  timezoneId: "UTC",
  viewport: { width: 1280, height: 720 },
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test.describe(`landing alias equivalence - ${viewport.name}`, () => {
    test.use({ viewport });

    test("landing and leaderboard aliases render the same hero", async ({
      page,
    }) => {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await waitForLandingIntro(page);
      const landingHero = await page.locator(".landing-hero-copy").innerText();

      await page.goto("/leaderboard", { waitUntil: "domcontentloaded" });
      await waitForLandingIntro(page);
      const leaderboardHero = await page
        .locator(".landing-hero-copy")
        .innerText();

      expect(leaderboardHero).toEqual(landingHero);
    });
  });
}

test("phone mockup reaches its terminal four-bubble state", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForLandingIntro(page);

  const bubbles = page.locator(".landing-bubble");
  await expect(bubbles).toHaveCount(4);
  for (const bubble of await bubbles.all()) {
    await expect
      .poll(async () =>
        Number(
          await bubble.evaluate((element) => getComputedStyle(element).opacity),
        ),
      )
      .toBeGreaterThan(0.98);
  }
});

test("landing has no horizontal overflow at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForLandingIntro(page);

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
});
