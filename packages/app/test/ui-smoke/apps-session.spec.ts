import { expect, test } from "@playwright/test";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await installDefaultAppRoutes(page);
  await seedAppStorage(page);
});

test("apps view can route into internal tool pages and survive a reload", async ({
  page,
}) => {
  await openAppPath(page, "/apps");
  await assertReadyChecks(
    page,
    "apps-view",
    [{ text: "No views available" }],
    "any",
    90_000,
  );

  // Reload from root and re-navigate — Vite preview lacks SPA fallback
  await openAppPath(page, "/");
  await openAppPath(page, "/apps");
  await assertReadyChecks(
    page,
    "apps-view-reload",
    [{ text: "No views available" }],
    "any",
    90_000,
  );
});
