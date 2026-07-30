/**
 * Real-input navigation and stable locators for the composed Home/Launcher
 * surface used by app UI-smoke specs.
 */
import { expect, type Locator, type Page } from "@playwright/test";

type LauncherPage = "home" | "launcher";
type LauncherInput = "auto" | "mouse" | "touch";

export function launcherGrid(page: Page): Locator {
  return page
    .getByTestId("home-launcher-launcher-page")
    .getByTestId("launcher-page-window");
}

async function railGestureY(
  page: Page,
  target: Locator,
  currentPage: LauncherPage,
): Promise<number> {
  const box = await target.boundingBox();
  if (!box) throw new Error(`${currentPage} launcher page has no bounding box`);
  if (currentPage === "launcher") return box.y + box.height * 0.14;

  // Notification rows own their own horizontal dismiss gesture. Starting in
  // the header keeps launcher navigation on the parent rail on narrow screens.
  const notificationCenter = page.getByTestId("home-notification-center");
  const notificationBox =
    (await notificationCenter.count()) > 0
      ? await notificationCenter.boundingBox()
      : null;
  return notificationBox && notificationBox.y > box.y
    ? (box.y + notificationBox.y) / 2
    : box.y + box.height * 0.14;
}

async function dragRail(
  page: Page,
  currentPage: LauncherPage,
  input: LauncherInput,
): Promise<void> {
  const target = page.getByTestId(`home-launcher-${currentPage}-page`);
  await expect(target).toBeVisible({ timeout: 15_000 });
  const box = await target.boundingBox();
  if (!box) throw new Error(`${currentPage} launcher page has no bounding box`);

  const direction = currentPage === "home" ? -1 : 1;
  const startX = box.x + box.width * (currentPage === "home" ? 0.72 : 0.28);
  const endX = startX + direction * box.width * 0.54;
  const y = await railGestureY(page, target, currentPage);
  const touchCapable = await page.evaluate(
    () =>
      navigator.maxTouchPoints > 0 ||
      window.matchMedia("(pointer: coarse)").matches,
  );
  if (input === "touch" && !touchCapable) {
    throw new Error(
      "launcher navigation requested touch input in a non-touch context",
    );
  }

  if (input === "touch" || (input === "auto" && touchCapable)) {
    const client = await page.context().newCDPSession(page);
    try {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: startX, y, id: 1, radiusX: 4, radiusY: 4 }],
      });
      for (let step = 1; step <= 8; step += 1) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            {
              x: startX + ((endX - startX) * step) / 8,
              y,
              id: 1,
              radiusX: 4,
              radiusY: 4,
            },
          ],
        });
      }
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    } finally {
      await client.detach();
    }
    return;
  }

  await page.mouse.move(startX, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(startX + ((endX - startX) * step) / 8, y);
  }
  await page.mouse.up();
}

export async function navigateHomeLauncher(
  page: Page,
  targetPage: LauncherPage,
  options: { input?: LauncherInput } = {},
): Promise<Locator> {
  const surface = page.getByTestId("home-launcher-surface");
  await expect(surface).toBeVisible({ timeout: 15_000 });
  const currentPage = await surface.getAttribute("data-page");
  if (currentPage !== "home" && currentPage !== "launcher") {
    throw new Error(`unexpected Home/Launcher page state: ${currentPage}`);
  }

  if (currentPage !== targetPage) {
    await dragRail(page, currentPage, options.input ?? "auto");
  }

  await expect(surface).toHaveAttribute("data-page", targetPage, {
    timeout: 10_000,
  });
  const target = page.getByTestId(`home-launcher-${targetPage}-page`);
  await expect(target).toBeVisible({ timeout: 15_000 });

  // Store state updates before the visual settle. Geometry is the screenshot
  // contract; descendant widgets can carry intentionally infinite animations.
  await page.waitForFunction(
    (pageName) => {
      const rail = document.querySelector('[data-testid="home-launcher-rail"]');
      const surface = document.querySelector(
        '[data-testid="home-launcher-surface"]',
      );
      if (!rail || !surface) return false;
      const expectedLeft = pageName === "launcher" ? -surface.clientWidth : 0;
      return Math.abs(rail.getBoundingClientRect().left - expectedLeft) <= 1;
    },
    targetPage,
    { timeout: 5_000 },
  );

  if (targetPage === "launcher") {
    const grid = launcherGrid(page);
    await expect(
      grid.locator('[data-testid^="launcher-tile-"]').first(),
    ).toBeVisible({ timeout: 15_000 });
    return grid;
  }
  return target;
}
