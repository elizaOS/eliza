// Local walkthrough recording for cleanup/u17a (not committed).
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
  test.describe(`u17a walkthrough ${vp.name}`, () => {
    test.use({
      viewport: vp.viewport,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
    });
    test(`u17a ${vp.name}: navigation, settings, bug report`, async ({
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
        `u17a (${vp.name}): Electrobun desktop tab bar, desktop fused-wake bridge and bug-report desktop paths removed. Startup reached chat.`,
      );

      // Agent navigation, including the actions that used to open desktop tabs.
      await caption(page, "Agent navigate (pin-tab) to Notes: no desktop tab bar, view opens.");
      await navigate(page, {
        viewId: "notes",
        viewPath: "/notes",
        viewLabel: "Notes",
        viewType: "gui",
        action: "pin-tab",
      });
      await expect(page).toHaveURL(/\/notes(?:[?#]|$)/, { timeout: 30_000 });
      await expect(page.getByTestId("simple-notes-view").first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        page.getByRole("toolbar", { name: "Desktop view tabs" }),
      ).toHaveCount(0);
      await page.waitForTimeout(1200);

      await caption(page, "Agent navigate to Inbox, then close: returns to chat.");
      await navigate(page, {
        viewId: "inbox",
        viewPath: "/inbox",
        viewLabel: "Inbox",
        viewType: "gui",
      });
      await expect(page).toHaveURL(/\/inbox(?:[?#]|$)/, { timeout: 30_000 });
      await page.waitForTimeout(1200);
      await navigate(page, { action: "close", viewId: "inbox" });
      await expect(page.locator(COMPOSER).first()).toBeVisible({
        timeout: 30_000,
      });
      await page.waitForTimeout(800);

      await caption(page, "Agent split-view: documents and calendar side by side.");
      await navigate(page, {
        action: "split-view",
        viewId: "documents",
        viewPath: "/character/documents",
        viewLabel: "Knowledge",
        viewType: "gui",
        views: ["documents", "calendar"],
        layout: "horizontal",
      });
      await expect(page).toHaveURL(/\/views(?:[?#]|$)/, { timeout: 30_000 });
      await expect(page.getByTestId("view-layout-surface")).toBeVisible({
        timeout: 60_000,
      });
      await page.waitForTimeout(1500);
      await navigate(page, { action: "close-all", viewId: "__all__" });
      await expect(page.locator(COMPOSER).first()).toBeVisible({
        timeout: 30_000,
      });

      await caption(page, "Settings > Voice still renders (wake toggle unchanged on web/mobile).");
      await openAppPath(page, "/settings#voice");
      await expect(page.locator("body")).toContainText(/Voice/i, {
        timeout: 60_000,
      });
      await page.waitForTimeout(2000);

      await caption(page, "Command palette > Report Bug: web form only, logs textarea, no desktop diagnostics buttons.");
      await openAppPath(page, "/chat");
      await expect(page.locator(COMPOSER).first()).toBeVisible({
        timeout: 60_000,
      });
      await page.evaluate(() =>
        document.dispatchEvent(new CustomEvent("eliza:command-palette")),
      );
      const palette = page.getByRole("dialog").first();
      await expect(palette).toBeVisible({ timeout: 15_000 });
      await page.keyboard.type("Report Bug", { delay: 40 });
      await page.keyboard.press("Enter");
      const description = page.locator("#bug-report-description");
      await expect(description).toBeVisible({ timeout: 15_000 });
      await description.fill("Walkthrough: verifying the bug report form");
      await page.getByRole("button", { name: /Add logs/i }).click();
      await expect(page.locator("#bug-report-logs-panel")).toBeVisible();
      await page.locator("#bug-report-logs-panel").fill("example log line");
      await expect(
        page.getByRole("button", { name: /Open logs folder|Save bundle|Copy diagnostics/i }),
      ).toHaveCount(0);
      await page.waitForTimeout(2000);
      await caption(page, `u17a (${vp.name}) walkthrough complete.`);
    });
  });
}
