/**
 * Playwright UI-smoke spec for the Ui Smoke app flow using the real renderer
 * fixture.
 */
import { expect, test } from "@playwright/test";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("chat, apps, and settings routes render through the real shell", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  // The chat tab now routes through the single global chat overlay
  // surface. The ready signal is the overlay plus the interactive composer.
  await assertReadyChecks(
    page,
    "chat shell",
    [
      {
        selector: '[data-testid="continuous-chat-overlay"]',
      },
      {
        selector:
          '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]',
      },
    ],
    "all",
  );

  await openAppPath(page, "/apps");
  await expect(page).toHaveURL(/\/apps$/);
  // /apps (no slug) now routes to the launcher surface
  // (App.tsx renderAppsSurface → HomeScreenMount initialPage="launcher"); the
  // old standalone Views catalog (heading + chat-search hint + view-card tiles)
  // no longer renders on this route. The page-render proof is the launcher
  // page with at least one launchable view tile.
  await expect(page.getByTestId("launcher")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-testid^="launcher-tile-"]').first(),
  ).toBeVisible();

  await openAppPath(page, "/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("settings-shell")).toBeVisible();
  await openSettingsSection(page, /^Capabilities\b/);
  const capabilitiesSection = page.locator("#capabilities");
  await capabilitiesSection.scrollIntoViewIfNeeded();
  await expect(capabilitiesSection).toBeVisible();
  // The section wraps both an h1 section title and an h3 subsection of the same
  // name, so scope to the first match (section-rendered proof, not uniqueness).
  await expect(
    capabilitiesSection.getByText("Capabilities", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    capabilitiesSection.getByRole("switch", { name: "Enable Computer Use" }),
  ).toBeVisible();
  await openSettingsSection(page, /^App Permissions\b/);
  await expect(page.locator("#app-permissions")).toBeVisible();
  await expect(
    page
      .locator("#app-permissions")
      .getByText("App Permissions", { exact: true })
      .first(),
  ).toBeVisible();
});
