// Interaction coverage for the continuous-chat overlay — the REAL web chat
// surface (the per-message copy/edit/delete action rail lives on the desktop-only
// full ChatView, which the web app never renders). Drives the overlay's own
// controls: the pull-up chat (open on send / collapse on Escape / collapse on
// click-out) and the attach picker. Keyless against the stub.

import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  // Opt out of the once-ever first-run tour so its spotlight doesn't pop over
  // the chat mid-test (this suite exercises the chat overlay, not the tour).
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
});

test("chat overlay: sending opens the chat, click-out collapses, Escape collapses", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });

  // Collapsed at rest (just the input); sending a line springs the chat open.
  await expect(overlay).not.toHaveAttribute("data-open", "true");
  const composer = page.getByTestId("chat-composer-textarea");
  await composer.fill("open the chat");
  await page.getByTestId("chat-composer-action").click();
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 15_000,
  });

  // Sending leaves the composer focused (keyboard up). Tapping the dimming
  // scrim is a two-step gesture by design: the FIRST tap only drops the
  // keyboard (returning to the prior detent), the SECOND tap collapses the
  // chat back to the input. (See ContinuousChatOverlay: composerFocusedAtPress
  // + dismissKeyboardToPriorState — "first tap drops keyboard, second closes".)
  const backdrop = page.getByTestId("chat-sheet-backdrop");
  await backdrop.click({ position: { x: 14, y: 14 }, force: true });
  await backdrop.click({ position: { x: 14, y: 14 }, force: true });
  await expect(overlay).not.toHaveAttribute("data-open", "true", {
    timeout: 10_000,
  });

  // Typing re-opens it; Escape collapses again in a single keystroke.
  await composer.fill("and again");
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 10_000,
  });
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

test("chat overlay: transcript text is selectable and the old transcribe toggle is absent", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });

  await expect(page.getByTestId("chat-composer-transcribe")).toHaveCount(0);

  const prompt = "show selectable transcript text";
  const composer = page.getByTestId("chat-composer-textarea");
  await composer.fill(prompt);
  await page.getByTestId("chat-composer-action").click();

  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("thread-line").first()).toBeVisible({
    timeout: 15_000,
  });

  const selectable = page.locator('[data-chat-selectable="true"]').first();
  await expect(selectable).toBeVisible();
  await expect(selectable).toHaveCSS("user-select", "text");

  const selectedText = await selectable.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection?.toString() ?? "";
  });
  expect(selectedText.trim().length).toBeGreaterThan(0);
});
