/**
 * Playwright UI-smoke spec for the View Switching Core Matrix app flow using
 * the real renderer fixture.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  ALL_REQUIRED_VIEW_SWITCH_TARGETS,
  CORE_VIEW_SWITCH_PAIRS,
  type CoreViewSwitchTarget,
  SETTINGS_SECTION_SWITCH_PAIRS,
} from "./view-switching-core-matrix";

const MATRIX_TIMEOUT_MS = 180_000;
const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, {
    "eliza:developerMode": "1",
    "eliza:previewMode": "1",
  });
  await installDefaultAppRoutes(page);
});

async function dispatchNavigate(
  page: Page,
  target: CoreViewSwitchTarget,
): Promise<void> {
  await page.evaluate(
    (detail) => {
      window.dispatchEvent(new CustomEvent("eliza:navigate:view", { detail }));
    },
    {
      viewId: target.id,
      viewPath: target.path,
      viewLabel: target.label,
      viewType: "gui",
      alwaysOnTop: false,
    },
  );
}

async function expectNavigationPath(
  page: Page,
  target: CoreViewSwitchTarget,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => `${window.location.pathname}${window.location.hash}`,
        ),
      {
        timeout: 30_000,
        message: `expected active route ${target.id} (${target.path})`,
      },
    )
    .toBe(target.path);
}

async function navigateAndAssertUrl(
  page: Page,
  target: CoreViewSwitchTarget,
): Promise<void> {
  await dispatchNavigate(page, target);
  await expectNavigationPath(page, target);
}

async function waitForNavigateBusReady(page: Page): Promise<void> {
  await expect(page.locator(CHAT_COMPOSER_SELECTOR).first()).toBeVisible({
    timeout: 60_000,
  });
}

test("every required view-switch target mounts from the agent navigation bus", async ({
  page,
}) => {
  test.setTimeout(MATRIX_TIMEOUT_MS);
  await openAppPath(page, "/chat");
  await waitForNavigateBusReady(page);

  for (const target of ALL_REQUIRED_VIEW_SWITCH_TARGETS) {
    await navigateAndAssertUrl(page, target);
    if (target.readySelector) {
      await expect(page.locator(target.readySelector).first()).toBeVisible({
        timeout: 60_000,
      });
    }
  }
});

test("agent navigation switches every required core view to every other core view", async ({
  page,
}) => {
  test.setTimeout(MATRIX_TIMEOUT_MS);
  await openAppPath(page, "/chat");
  await waitForNavigateBusReady(page);

  for (const { source, target } of CORE_VIEW_SWITCH_PAIRS) {
    await navigateAndAssertUrl(page, source);
    await navigateAndAssertUrl(page, target);
  }
});

test("agent navigation switches every settings subsection to every other settings subsection", async ({
  page,
}) => {
  test.setTimeout(MATRIX_TIMEOUT_MS);
  await openAppPath(page, "/settings");
  await waitForNavigateBusReady(page);

  for (const { source, target } of SETTINGS_SECTION_SWITCH_PAIRS) {
    await navigateAndAssertUrl(page, source);
    await navigateAndAssertUrl(page, target);
  }
});
