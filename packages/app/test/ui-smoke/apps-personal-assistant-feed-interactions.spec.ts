/**
 * Playwright UI-smoke spec for the Apps Personal Assistant Feed Interactions
 * app flow using the real renderer fixture.
 */
import { test } from "@playwright/test";
import {
  assertReadyChecks,
  hideContinuousChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await hideContinuousChatOverlay(page);
  await seedAppStorage(page, {
    "eliza:ui-theme": "dark",
    "elizaos:ui-theme": "dark",
  });
  await installDefaultAppRoutes(page);
});

test("Feed route exposes reachable GUI state", async ({ page }) => {
  await openAppPath(page, "/feed");
  // The keyless no-run state is the real FeedSpatialView spawn pitch (the old
  // placeholder smoke-surface copy was replaced by the live trading surface).
  // Checks evaluate serially in "any" mode, so the live surface text leads.
  await assertReadyChecks(
    page,
    "feed gui no-run state",
    [{ text: "Ready to trade?" }, { text: "Feed" }],
    "any",
    90_000,
  );
});
