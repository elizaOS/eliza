import { expect, test } from "@playwright/test";
import { assertReadyChecks, openAppPath, seedAppStorage } from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
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

  await page.getByTestId("header-nav-button-settings").click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId("settings-shell")).toBeVisible();
});
