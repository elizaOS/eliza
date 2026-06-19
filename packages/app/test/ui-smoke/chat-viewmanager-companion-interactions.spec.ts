// Button-level interaction coverage for controls the existing view-manager /
// companion specs don't drive: the view catalog refresh and the companion TUI
// controls. Keyless against the stub; asserts each control DOES something.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("view catalog: Refresh re-queries the views list", async ({ page }) => {
  let viewsReqs = 0;
  page.on("request", (req) => {
    if (/\/api\/views(?:\?|$)/.test(req.url())) viewsReqs += 1;
  });

  await openAppPath(page, "/views");
  await expect(page.getByTestId("views-catalog-section").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => viewsReqs).toBeGreaterThan(0);

  const before = viewsReqs;
  await page
    .getByRole("button", { name: /refresh views/i })
    .first()
    .click();
  await expect.poll(() => viewsReqs).toBeGreaterThan(before);
});

async function readViewState(page: Page): Promise<Record<string, unknown>> {
  const raw = await page
    .locator("[data-view-state]")
    .first()
    .getAttribute("data-view-state");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

test("companion TUI: toggling emotes flips the view state", async ({
  page,
}) => {
  await openAppPath(page, "/companion/tui");
  const emotes = page.locator('[data-agent-id="tui-toggle-emotes"]');
  await expect(emotes).toBeVisible({ timeout: 60_000 });

  const before = (await readViewState(page)).emotePickerOpen;
  await emotes.click();
  await expect
    .poll(async () => (await readViewState(page)).emotePickerOpen)
    .not.toBe(before);
});
