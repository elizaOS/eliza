// Interaction coverage for the continuous-chat overlay — the REAL web chat
// surface (the per-message copy/edit/delete action rail lives on the desktop-only
// full ChatView, which the web app never renders). Drives the overlay's own
// controls: the pull-up history sheet (open on send / close on Escape /
// click-out is a no-op) and the attach picker. Keyless against the stub.

import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("chat overlay: sending opens the history sheet, click-out is a no-op, Escape closes", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });

  // The sheet rests closed; sending a line springs it open.
  await expect(overlay).not.toHaveAttribute("data-open", "true");
  const composer = page.getByTestId("chat-composer-textarea");
  await composer.fill("open the history sheet");
  await page.getByTestId("chat-composer-action").click();
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 15_000,
  });

  // Clicking the dimmed view behind must NOT close it — only a pull-down on the
  // grabber or Escape dismisses the sheet (the scrim has no click handler).
  await page
    .getByTestId("chat-sheet-backdrop")
    .click({ position: { x: 14, y: 14 }, force: true });
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 5_000,
  });

  // Escape closes it.
  await composer.press("Escape");
  await expect(overlay).not.toHaveAttribute("data-open", "true", {
    timeout: 10_000,
  });
});

test("chat overlay: the attach control opens an image picker", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("continuous-chat-overlay")).toBeVisible({
    timeout: 60_000,
  });

  const attach = page.getByTestId("chat-composer-attach");
  await expect(attach).toBeVisible({ timeout: 15_000 });
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10_000 }),
    attach.click(),
  ]);
  expect(chooser).toBeTruthy();
});
