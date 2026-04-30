import { expect, type Locator, type Page, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const MAC_CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

test.use({
  userAgent: MAC_CHROME_USER_AGENT,
  viewport: { width: 1440, height: 900 },
});

async function seedElectrobunRuntime(page: Page) {
  await page.addInitScript(() => {
    const w = window as Window & {
      __electrobunWindowId?: number;
      __ELIZA_ELECTROBUN_RPC__?: unknown;
    };
    w.__electrobunWindowId = 1;
    w.__ELIZA_ELECTROBUN_RPC__ = {
      offMessage: () => undefined,
      onMessage: () => undefined,
      request: {},
    };
  });
}

async function getAppRegion(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const webkitStyle = style as CSSStyleDeclaration & {
      webkitAppRegion?: string;
    };
    return (
      webkitStyle.webkitAppRegion ||
      style.getPropertyValue("-webkit-app-region")
    ).trim();
  });
}

async function clickLocatorAtVerticalFraction(
  page: Page,
  locator: Locator,
  fraction: number,
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, "Expected clickable titlebar control bounds").not.toBeNull();
  if (!box) return;

  await page.mouse.click(box.x + box.width / 2, box.y + box.height * fraction);
}

test.beforeEach(async ({ page }) => {
  await seedElectrobunRuntime(page);
  await seedAppStorage(page);
});

test("desktop titlebar keeps navigation clickable and title area draggable", async ({
  page,
}) => {
  await openAppPath(page, "/chat");

  const html = page.locator("html");
  await expect(html).toHaveClass(/eliza-electrobun-frameless/);
  await expect(html).toHaveClass(/eliza-electrobun-custom-titlebar/);

  const titlebar = page.getByTestId("desktop-window-titlebar");
  await expect(titlebar).toBeVisible();
  await expect.poll(() => getAppRegion(titlebar)).toBe("drag");

  const appsButton = page.getByTestId("header-nav-button-apps");
  await expect(appsButton).toBeVisible();
  await expect.poll(() => getAppRegion(appsButton)).toBe("no-drag");
  await clickLocatorAtVerticalFraction(page, appsButton, 0.18);
  await expect(page).toHaveURL(/\/apps$/);

  await openAppPath(page, "/chat");

  const settingsButton = page.getByTestId("header-settings-button");
  await expect(settingsButton).toBeVisible();
  await expect.poll(() => getAppRegion(settingsButton)).toBe("no-drag");
  await clickLocatorAtVerticalFraction(page, settingsButton, 0.5);
  await expect(page).toHaveURL(/\/settings$/);

  await openAppPath(page, "/chat");

  const titleDragZone = page.getByTestId("desktop-window-titlebar-drag-zone");
  await expect(titleDragZone).toBeVisible();
  await expect.poll(() => getAppRegion(titlebar)).toBe("drag");

  const box = await titleDragZone.boundingBox();
  expect(box, "Expected draggable title bounds").not.toBeNull();
  if (!box) return;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();

  await expect(page).toHaveURL(/\/chat$/);
});
