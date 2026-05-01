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
  await assertReadyChecks(
    page,
    "chat shell",
    [
      { selector: '[data-testid="conversations-sidebar"]' },
      { selector: '[data-testid="chat-composer-textarea"]' },
      { selector: '[data-testid="chat-widgets-bar"]' },
    ],
    "all",
  );

  await page.getByTestId("header-nav-button-apps").click();
  await expect(page).toHaveURL(/\/apps$/);
  await expect(page.getByTestId("apps-catalog-grid")).toBeVisible();

  await page.getByTestId("header-settings-button").click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("settings-shell")).toBeVisible();
  await openSettingsSection(page, /^Capabilities\b/);
  const capabilitiesSection = page.locator("#capabilities");
  await capabilitiesSection.scrollIntoViewIfNeeded();
  await expect(capabilitiesSection).toBeVisible();
  await expect(
    capabilitiesSection.getByText("Capabilities", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("#permissions")).toBeVisible();
  await expect(
    page.locator("#permissions").getByText("Permissions", { exact: true }),
  ).toBeVisible();
  await expect(
    capabilitiesSection.getByRole("switch", { name: "Enable Computer Use" }),
  ).toBeVisible();
});
