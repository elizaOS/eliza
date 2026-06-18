import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

/**
 * Screenshot-driven walkthrough of the full Tutorial tour + Help view, for
 * manual visual verification. Captures every key state to /tmp/tut-shots so the
 * spotlight glow, targeting, cards, and Help layout can be eyeballed. Drives the
 * real chat detents where possible; falls back to the card's Continue button.
 */

const SHOTS = "/tmp/tut-shots";

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function cardText(page: Page): Promise<string> {
  return (await page.getByTestId("tutorial-card").textContent()) ?? "";
}

// Click the card's Continue button if present (label varies per step).
async function clickContinue(page: Page): Promise<boolean> {
  const card = page.getByTestId("tutorial-card");
  const btn = card.getByRole("button").last();
  if (await btn.isVisible().catch(() => false)) {
    const label = (await btn.textContent())?.toLowerCase() ?? "";
    if (!label.includes("voice") && !label.includes("text")) {
      await btn.click().catch(() => {});
      return true;
    }
  }
  return false;
}

test("full tutorial walkthrough + Help — screenshots", async ({ page }) => {
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/chat");

  // 1. Home screen with the pinned tiles.
  await expect(page.getByTestId("home-tile-tutorial")).toBeVisible({
    timeout: 25_000,
  });
  await shot(page, "01-home-tiles");

  // 2. Tutorial launcher.
  await page.getByTestId("home-tile-tutorial").click();
  await expect(page.getByTestId("tutorial-launcher")).toBeVisible();
  await shot(page, "02-launcher");

  // 3. Start the tour → welcome card (spotlight overlay).
  await page.getByTestId("tutorial-start-text").click();
  await expect(page.getByTestId("tutorial-card")).toBeVisible();
  expect(await cardText(page)).toMatch(/Step 1 of/);
  await shot(page, "03-step1-welcome");

  // 4. Continue → meet-chat. Regression: it must NOT auto-skip (the chat starts
  // in "peek", so a chatOpen-only check would instantly complete) — it shows a
  // real step-2 card with the spotlight on the composer.
  await clickContinue(page);
  await expect(page.getByTestId("tutorial-card")).toContainText(
    /This is your chat/i,
  );
  await shot(page, "04-step2-meet-chat-spotlight");

  // 5. Drive the chat: tap the pill to open it (best-effort).
  await page
    .getByTestId("chat-pill")
    .click({ timeout: 3000 })
    .catch(() => {});
  await page.waitForTimeout(1200);
  await shot(page, "05-after-open-chat");

  // 6. Walk the remaining steps via Continue, screenshotting each, until "done".
  for (let i = 0; i < 8; i++) {
    const txt = await cardText(page).catch(() => "");
    if (!txt) break;
    await shot(page, `06-walk-${i}`);
    // Try driving the chat grabber on the expand/minimize steps.
    await page
      .getByTestId("chat-sheet-grabber")
      .click({ timeout: 800 })
      .catch(() => {});
    await page.waitForTimeout(400);
    const advanced = await clickContinue(page);
    if (!advanced) {
      // auto-only step that didn't advance — record and bail the loop.
      await shot(page, `06-stuck-${i}`);
    }
    await page.waitForTimeout(500);
    if (
      (await page
        .getByTestId("tutorial-card")
        .count()
        .catch(() => 0)) === 0
    ) {
      break; // tour finished
    }
  }
  await shot(page, "07-after-walk");

  // 8. Voice mode toggle on a fresh tour.
  await page.evaluate(() => {
    try {
      localStorage.removeItem("eliza:tutorial-completed");
    } catch {}
  });
  await openAppPath(page, "/tutorial");
  await page.getByTestId("tutorial-start-voice").click();
  await expect(page.getByTestId("tutorial-card")).toBeVisible();
  await shot(page, "08-voice-mode");
  await page
    .getByText("Skip tutorial")
    .click({ timeout: 3000 })
    .catch(() => {});

  // 9. Help view: open, search, expand, deep-link.
  await openAppPath(page, "/help");
  await expect(page.getByTestId("help-view")).toBeVisible();
  await shot(page, "09-help-home");
  await page.getByTestId("help-search").fill("voice");
  await page.waitForTimeout(300);
  await shot(page, "10-help-search-voice");
  const firstEntry = page.locator('[data-testid^="help-entry-"]').first();
  await firstEntry.click();
  await page.waitForTimeout(300);
  await shot(page, "11-help-entry-expanded");

  // 10. Help category filter.
  await page.getByRole("button", { name: "AI models" }).click();
  await page.waitForTimeout(300);
  await shot(page, "12-help-category-ai-models");

  expect(true).toBe(true);
});

test("auto-launch screenshot for a brand-new user", async ({ page }) => {
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("tutorial-card")).toBeVisible({
    timeout: 25_000,
  });
  await page.screenshot({ path: `${SHOTS}/13-auto-launch.png` });
});
