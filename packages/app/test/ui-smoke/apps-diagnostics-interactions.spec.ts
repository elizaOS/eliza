// Real interaction coverage for the built-in diagnostic page-views (logs,
// memories). all-pages-clicksafe only proves these routes *render* without a
// crash; the view-interaction ratchet only covers plugin-manifest views, so
// their actual controls were never clicked or asserted. This spec drives the
// controls and asserts they DO something — search filters, refresh re-queries —
// against the deterministic stub, closing the "diagnostic buttons never clicked"
// gap in the keyless lane.

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

test("logs page search really filters entries and clear restores them", async ({
  page,
}) => {
  await openAppPath(page, "/apps/logs");
  const view = page.getByTestId("logs-view");
  await expect(view).toBeVisible({ timeout: 60_000 });

  // The stub serves exactly one log entry ("smoke API ready", source "smoke").
  const entries = page.getByTestId("log-entry");
  await expect(entries).toHaveCount(1);

  // Client-side filter: a non-matching query must hide the entry.
  const search = view.getByRole("textbox").first();
  await search.fill("zzqq-no-such-log-line");
  await expect(entries).toHaveCount(0);

  // A matching query brings it back — proving the box really filters.
  await search.fill("smoke");
  await expect(entries).toHaveCount(1);

  // Clear filters resets the query and restores the full list.
  await view.getByRole("button", { name: /clear/i }).click();
  await expect(search).toHaveValue("");
  await expect(entries).toHaveCount(1);
});

test("logs page refresh re-queries the log source", async ({ page }) => {
  let logRequests = 0;
  page.on("request", (req) => {
    if (/\/api\/logs(?:\?|$)/.test(req.url())) logRequests += 1;
  });

  await openAppPath(page, "/apps/logs");
  await expect(page.getByTestId("logs-view")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("log-entry")).toHaveCount(1);

  const before = logRequests;
  await page
    .getByTestId("logs-view")
    .getByRole("button", { name: /refresh/i })
    .click();
  await expect.poll(() => logRequests).toBeGreaterThan(before);
});

test("memory viewer queries memory data and the Browse toggle switches the surface", async ({
  page,
}) => {
  const memoryRequests: string[] = [];
  page.on("request", (req) => {
    if (/\/api\/memories\//.test(req.url())) memoryRequests.push(req.url());
  });

  await openAppPath(page, "/apps/memories");
  await expect(page.getByTestId("memory-viewer-view")).toBeVisible({
    timeout: 60_000,
  });

  // The page must actually query memory data on load — not just render a shell.
  await expect.poll(() => memoryRequests.length).toBeGreaterThan(0);

  // The Browse view-mode toggle must switch the surface AND issue a browse query.
  const browseBefore = memoryRequests.filter((url) =>
    /\/api\/memories\/browse/.test(url),
  ).length;
  await page.getByTestId("memory-view-browse").click();
  await expect(page.getByTestId("memory-browser")).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(
      () =>
        memoryRequests.filter((url) => /\/api\/memories\/browse/.test(url))
          .length,
    )
    .toBeGreaterThan(browseBefore);
});
