import { expect, test } from "@playwright/test";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSectionById,
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
  await expect(page.getByRole("heading", { name: "Views" })).toBeVisible();
  await expect(
    page.getByRole("searchbox", { name: "Search views…" }),
  ).toBeVisible();
  // The card's accessible name now includes status chips and provider/path
  // badges, so target the stable card testid instead of the button name.
  const companionCard = page.getByTestId("view-card-companion");
  await expect(companionCard).toBeVisible();
  await companionCard
    .locator('[data-agent-id="view-card-open-companion"]')
    .click();
  await expect(page).toHaveURL(/\/companion$/);

  await openAppPath(page, "/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("settings-shell")).toBeVisible();
  // The settings hub renders one section at a time, so open each section
  // through its hub tile and assert inside it.
  await openSettingsSectionById(page, "capabilities");
  const capabilitiesSection = page.locator("#capabilities");
  await expect(capabilitiesSection).toBeVisible();
  await expect(
    capabilitiesSection.getByRole("heading", { name: "Capabilities" }),
  ).toBeVisible();
  await expect(
    capabilitiesSection.getByRole("switch", { name: "Enable Computer Use" }),
  ).toBeVisible();

  await openSettingsSectionById(page, "permissions");
  const permissionsSection = page.locator("#permissions");
  await expect(permissionsSection).toBeVisible();
  await expect(
    permissionsSection.getByRole("heading", { name: "Permissions" }),
  ).toBeVisible();
});
