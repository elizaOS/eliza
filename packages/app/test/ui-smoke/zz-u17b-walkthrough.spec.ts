// Local walkthrough recording for cleanup/u17b (not committed).
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const COMPOSER =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';

async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    let el = document.getElementById("__walkthrough_caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "__walkthrough_caption";
      el.setAttribute(
        "style",
        "position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;padding:8px 12px;border-radius:8px;background:rgba(0,0,0,.82);color:#fff;font:600 14px/1.35 system-ui,sans-serif;pointer-events:none",
      );
      document.body.appendChild(el);
    }
    el.textContent = value;
  }, text);
  await page.waitForTimeout(1600);
}

async function navigate(page: Page, detail: Record<string, unknown>) {
  await page.evaluate((d) => {
    window.dispatchEvent(new CustomEvent("eliza:navigate:view", { detail: d }));
  }, detail);
}

const viewports = [
  { name: "web", viewport: { width: 1440, height: 900 }, mobile: false },
  { name: "mobile", viewport: { width: 390, height: 844 }, mobile: true },
];

for (const vp of viewports) {
  test.describe(`u17b walkthrough ${vp.name}`, () => {
    test.use({
      viewport: vp.viewport,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
    });
    test(`u17b ${vp.name}: startup, tabs, settings, removed /desktop`, async ({
      page,
    }) => {
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);
      await openAppPath(page, "/chat");
      await expect(page.locator(COMPOSER).first()).toBeVisible({
        timeout: 60_000,
      });
      await caption(
        page,
        `u17b (${vp.name}): Desktop workspace route and Electrobun shell bootstrap removed. Startup reached chat.`,
      );

      await caption(page, "Navigate across tabs: Views launcher.");
      await openAppPath(page, "/views");
      await expect(page).toHaveURL(/\/views(?:[?#]|$)/);
      await page.waitForTimeout(1500);

      await caption(page, "Agent navigate to Notes.");
      await navigate(page, {
        viewId: "notes",
        viewPath: "/notes",
        viewLabel: "Notes",
        viewType: "gui",
      });
      await expect(page.getByTestId("simple-notes-view").first()).toBeVisible({
        timeout: 60_000,
      });
      await page.waitForTimeout(1200);

      await caption(page, "Settings: sections still render (no Desktop workspace entry).");
      await openAppPath(page, "/settings");
      await expect(page.getByTestId("settings-shell").first()).toBeVisible({
        timeout: 60_000,
      });
      await page.waitForTimeout(1500);
      await openAppPath(page, "/settings#voice");
      await page.waitForTimeout(1500);

      await caption(page, "/desktop is no longer a route: the shell shows its not-found state.");
      await openAppPath(page, "/desktop");
      await expect(page.getByTestId("app-route-not-found")).toBeVisible({
        timeout: 60_000,
      });
      await page.waitForTimeout(2000);

      await caption(page, "Back to chat.");
      await openAppPath(page, "/chat");
      await expect(page.locator(COMPOSER).first()).toBeVisible({
        timeout: 60_000,
      });
      await caption(page, `u17b (${vp.name}) walkthrough complete.`);
    });
  });
}
