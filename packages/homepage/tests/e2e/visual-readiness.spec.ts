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

test("reduced motion renders the settled friends room and all room labels", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForLandingIntro(page);

  // Reduced motion skips playback but keeps every scenario discoverable in the
  // room strip and renders one complete, stable friends-room snapshot.
  const demo = page.locator(".landing-iphone");
  await expect(demo).toHaveAttribute("data-demo-phase", "settled");
  await expect(demo).toHaveAttribute("data-demo-scenario", "friends");
  await expect(demo).toHaveAttribute("data-demo-scenarios", "5");
  await expect(demo).toHaveAttribute(
    "data-demo-visited",
    "friends,co-parenting,household,trip,community",
  );
  await expect(demo).toHaveAttribute("data-demo-messages", "12");
  await expect(page.locator(".landing-scenario-strip li")).toHaveCount(5);
  await expect(page.locator(".landing-demo-card")).toHaveCount(2);
  await expect(page.getByText(/of 5$/, { exact: false })).toHaveCount(0);

  const assistantMessages = await page
    .locator(".landing-bubble--eliza")
    .allTextContents();
  expect(assistantMessages).toContain(
    "Saturday after 7 works so far. Jamie still needs to answer.",
  );
  const messageAuthors = await page
    .locator(".landing-message-author")
    .allTextContents();
  expect(new Set(messageAuthors)).toEqual(
    new Set(["Maya", "Leo", "Priya", "Jamie", "Eliza"]),
  );
  await expect(page.locator(".landing-group-avatar")).toHaveCount(4);
  await expect(page.locator(".landing-group-avatar").last()).toHaveAttribute(
    "src",
    "/brand/logos/logo_white_orangebg.svg",
  );
  await expect(page.locator('img[src="/elizapfp.webp"]')).toHaveCount(0);
  expect(await page.locator(".landing-message-avatar").count()).toBeGreaterThan(
    5,
  );
  await expect(page.locator(".landing-demo-card").first()).toHaveCSS(
    "background-color",
    "rgb(242, 242, 247)",
  );
  await expect(
    page.locator(".landing-message-author", { hasText: "Eliza" }).first(),
  ).toHaveCSS("color", "rgb(118, 118, 124)");
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
