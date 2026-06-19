import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

/**
 * Full, screenshot-driven verification of the Tutorial + Help.
 *  - Runs the ENTIRE tutorial to completion, screenshotting every step.
 *  - Verifies the tour navigates to the real Settings view mid-run (reachedSettings).
 *  - Verifies Help is driven by the floating chat (placeholder override + live
 *    filter + auto-expanded best match + deep-link).
 * Screenshots land in /tmp/tut-shots for manual review.
 */

const SHOTS = "/tmp/tut-shots";

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

test("the tutorial runs all the way to completion (every step screenshotted)", async ({
  page,
}) => {
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/chat");

  // The /tutorial launcher starts the overlay directly (the splash with its own
  // "Start" button was removed — the overlay's welcome step is the one intro).
  await page.getByTestId("home-tile-tutorial").click({ timeout: 25_000 });

  const card = page.getByTestId("tutorial-card");
  const cont = page.getByTestId("tutorial-continue");
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(card).toBeVisible();

  const stepsSeen = new Set<string>();
  let reachedSettings = false;
  for (let i = 0; i < 14; i++) {
    if ((await card.count()) === 0) break; // tour finished
    const txt = (await card.textContent().catch(() => "")) ?? "";
    const stepNum = txt.match(/Step (\d+) of/)?.[1] ?? `x${i}`;
    stepsSeen.add(stepNum);
    await shot(page, `step-${pad(i)}-of-${stepNum}`);

    // When the "ask to navigate" step lands on Settings, confirm the tour
    // ACTUALLY switched screens (the real Settings view is showing).
    if (/You're in Settings/i.test(txt)) {
      await expect(page.getByText("Models & Providers")).toBeVisible({
        timeout: 6000,
      });
      reachedSettings = true;
      await shot(page, "nav-settings-view");
    }

    // Drive the real action where we can: the "ask to navigate" step types +
    // sends the command, gesture steps tap the grabber/pill.
    if (/open settings/i.test(txt)) {
      await composer.fill("open settings").catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
    } else if (/handle|pill|bigger|shrink|bring it back/i.test(txt)) {
      await page
        .getByTestId("chat-sheet-grabber")
        .click({ timeout: 500 })
        .catch(() => {});
      await page
        .getByTestId("chat-pill")
        .click({ timeout: 500 })
        .catch(() => {});
    }

    // Advance: the Continue button is immediate on manual steps and appears
    // after ~6s on gesture steps. Wait for it, then click.
    await cont.waitFor({ state: "visible", timeout: 9000 }).catch(() => {});
    if ((await cont.count()) > 0) {
      await cont.click({ timeout: 2000 }).catch(() => {});
    }
    await page.waitForTimeout(450);
  }

  // The whole tour completed and dismissed itself.
  await expect(card).toHaveCount(0);
  await shot(page, "step-99-complete");
  // It visited most of the ten steps (some auto-advance instantly).
  expect(stepsSeen.size).toBeGreaterThanOrEqual(8);
  // And it actually navigated to the real Settings view mid-tour.
  expect(reachedSettings).toBe(true);
});

test("Help is searched through the floating chat", async ({ page }) => {
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/help");
  await expect(page.getByTestId("help-view")).toBeVisible({ timeout: 25_000 });
  await shot(page, "help-01-home");

  // The chat composer is Help's search box (placeholder override).
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toHaveAttribute(
    "placeholder",
    /question about eliza/i,
  );

  // Typing a question filters the knowledge base + pulls up the best match.
  await composer.fill("how do I change the model");
  await page.waitForTimeout(500);
  await shot(page, "help-02-filtered");
  const entry = page.getByTestId("help-entry-change-model");
  await expect(entry).toBeVisible();
  // Auto-expanded → its answer + the deep-link button are shown.
  await expect(entry).toContainText(/AI Model/i);
  await expect(
    entry.getByRole("button", { name: /Open AI Model settings/i }),
  ).toBeVisible();
  await shot(page, "help-03-auto-expanded");
});
