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
  await expect(page.getByTestId("apps-catalog-grid")).toBeVisible({
    timeout: 60_000,
  });
  const pluginViewerCard = page.getByTestId(
    "app-card--elizaos-app-plugin-viewer",
  );
  await expect(pluginViewerCard).toBeVisible({ timeout: 60_000 });
  await pluginViewerCard.click();
  await expect(page).toHaveURL(/\/plugins$/, { timeout: 60_000 });
  await assertReadyChecks(
    page,
    "plugins-viewer",
    [{ text: "Other Features" }],
    "any",
    90_000,
  );

  // Reload from root and re-navigate — Vite preview lacks SPA fallback
  await openAppPath(page, "/");
  await openAppPath(page, "/apps");
  await expect(page.getByTestId("apps-catalog-grid")).toBeVisible({
    timeout: 60_000,
  });
  await expect(pluginViewerCard).toBeVisible({ timeout: 60_000 });
  await pluginViewerCard.click();
  await expect(page).toHaveURL(/\/plugins$/, { timeout: 60_000 });
  await assertReadyChecks(
    page,
    "plugins-viewer-reload",
    [{ text: "Other Features" }],
    "any",
    90_000,
  );
});
