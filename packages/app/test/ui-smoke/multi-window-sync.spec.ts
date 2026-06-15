import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

// Same-origin cross-window state sync (e.g. a synced UI preference broadcast
// between two open windows of the SAME app) is not yet wired in the renderer.
// There is no packages/ui/src/state/useTabSync.ts and no BroadcastChannel usage
// in the app today, so window B has no mechanism to observe a preference change
// made in window A without a manual reload.
//
// This spec is intentionally written against the DESIRED behavior and skipped
// via test.skip so it activates explicitly once the cross-window sync layer
// (packages/ui/src/state/useTabSync.ts — another agent is adding it) ships.
//
// Activation checklist when useTabSync lands:
//   1. Confirm the synced control exposes data-testid="theme-toggle" with an
//      aria-pressed reflection (or update the selectors below to match the real
//      synced control + its reflected state), and that toggling it broadcasts
//      across windows via BroadcastChannel.
//   2. Replace `test.skip` with `test`.

const SYNC_TIMEOUT_MS = 10_000;
const READY_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';

async function openSyncedWindow(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/chat");
  await expect(page.locator(READY_SELECTOR)).toBeVisible({ timeout: 60_000 });
  return page;
}

test.skip("a synced preference toggled in window A propagates to window B", async ({
  browser,
}) => {
  // Two windows = two pages in the SAME browser context so they share the
  // same-origin BroadcastChannel that useTabSync will use.
  const context = await browser.newContext();
  try {
    const windowA = await openSyncedWindow(context);
    const windowB = await openSyncedWindow(context);

    const toggleA = windowA.getByTestId("theme-toggle");
    const toggleB = windowB.getByTestId("theme-toggle");
    await expect(toggleA).toBeVisible();
    await expect(toggleB).toBeVisible();

    // Capture B's current state, flip the preference in A, then assert B
    // reflects the change without any reload — purely via cross-window sync.
    const before = await toggleB.getAttribute("aria-pressed");
    await toggleA.click();

    await expect
      .poll(() => toggleB.getAttribute("aria-pressed"), {
        timeout: SYNC_TIMEOUT_MS,
      })
      .not.toBe(before);

    const after = await toggleB.getAttribute("aria-pressed");
    await expect(toggleA).toHaveAttribute("aria-pressed", after ?? "");
  } finally {
    await context.close();
  }
});
