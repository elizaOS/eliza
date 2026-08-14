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
  // The project-level contextOptions override swallows test.use's
  // reducedMotion in this runner; emulate it explicitly so the landing demo
  // renders its settled snapshot.
  await page.emulateMedia({ reducedMotion: "reduce" });
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
      const landingHero = await page
        .locator("h1")
        .evaluate((el) => el.textContent);

      await page.goto("/leaderboard", { waitUntil: "domcontentloaded" });
      await waitForLandingIntro(page);
      const leaderboardHero = await page
        .locator("h1")
        .evaluate((el) => el.textContent);

      expect(leaderboardHero).toEqual(landingHero);
    });
  });
}

test("reduced motion renders the settled intro conversation", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForLandingIntro(page);

  // This spec runs with reducedMotion: "reduce", so the demo must skip
  // playback and render the whole intro at once: a stable snapshot for
  // screenshot determinism.
  const demo = page.locator(".landing-iphone");
  await expect(demo).toHaveAttribute("data-demo-phase", "settled");
  await expect(demo).toHaveAttribute("data-demo-messages", "18");
  await expect(page.locator(".landing-demo-card")).toHaveCount(3);

  const assistantMessages = await page
    .locator(".landing-bubble--eliza")
    .allTextContents();
  expect(assistantMessages).toContain(
    "Looks like you've got 2 important emails you haven't followed up on.",
  );
  expect(assistantMessages).toContain(
    "One looks like an important work thing. Should I draft a reply?",
  );
  expect(assistantMessages.join(" ")).not.toContain("—");
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

test("landing keeps the document scrollbar slim and translucent", async ({
  page,
}) => {
  await page.goto("/");

  await expect
    .poll(() =>
      page.evaluate(
        () => getComputedStyle(document.documentElement).scrollbarWidth,
      ),
    )
    .toBe("thin");
  await expect
    .poll(() =>
      page.evaluate(
        () => getComputedStyle(document.documentElement).scrollbarColor,
      ),
    )
    .toContain("rgba(17, 17, 17, 0.3)");
});
