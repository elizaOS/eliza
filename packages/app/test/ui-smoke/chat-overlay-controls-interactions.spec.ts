// Interaction coverage for the continuous-chat overlay — the REAL web chat
// surface (the per-message copy/edit/delete action rail lives on the desktop-only
// full ChatView, which the web app never renders). Drives the overlay's own
// controls: fullscreen toggle and agent-voice mute. Keyless against the stub.

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

test("chat overlay: the fullscreen toggle expands and restores the overlay", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });

  const fullscreen = page.getByTestId("chat-composer-fullscreen");
  await expect(fullscreen).toBeVisible({ timeout: 15_000 });
  await fullscreen.click();
  await expect(overlay).toHaveAttribute("data-fullscreen", "true", {
    timeout: 10_000,
  });
  await fullscreen.click();
  await expect(overlay).not.toHaveAttribute("data-fullscreen", "true", {
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
