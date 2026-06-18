// Interaction coverage for the Electrobun desktop workspace controls. Keyless web
// normally shows the "desktop tools only on Electrobun" fallback; injecting
// `__electrobunWindowId` makes `isElectrobunRuntime()` true so the real control
// surface renders. We drive the client-side console filter (no native bridge
// needed) to prove the surface is interactive, not just rendered.

import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as Record<string, number>).__electrobunWindowId = 1;
  });
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("desktop workspace: renders real controls and the console filter accepts input", async ({
  page,
}) => {
  await openAppPath(page, "/desktop");

  // Under the injected Electrobun runtime the real diagnostics control renders
  // (not the web-only fallback card).
  const refresh = page
    .locator(
      '[data-agent-id="desktop-refresh-diagnostics"], [data-testid="desktop-refresh-diagnostics"]',
    )
    .first();
  await expect(refresh).toBeVisible({ timeout: 60_000 });

  // The console filter is a client-side input — driving it needs no native RPC.
  const filter = page
    .locator(
      '[data-agent-id="desktop-console-filter"], [data-testid="desktop-console-filter"]',
    )
    .first();
  await expect(filter).toBeVisible({ timeout: 15_000 });
  await filter.fill("error");
  await expect(filter).toHaveValue("error");
});
