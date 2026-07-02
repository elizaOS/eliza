import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const OUT_DIR = path.join(
  process.cwd(),
  ".github",
  "issue-evidence",
  "9144-default-launcher-dock",
);

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(OUT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 4,
  });
}

async function writeEvidenceFile(name: string, body: string): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, name), body);
}

async function installLauncherEvidenceRoutes(page: Page): Promise<void> {
  await page.route("**/api/avatar/vrm", async (route) => {
    const method = route.request().method();
    if (method !== "HEAD" && method !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 204 });
  });
}

async function tileIds(scope: Locator): Promise<string[]> {
  return scope.locator('[data-testid^="launcher-tile-"]').evaluateAll((nodes) =>
    nodes
      .map((node) => node.getAttribute("data-testid") ?? "")
      .filter(Boolean)
      .map((id) => id.replace("launcher-tile-", "")),
  );
}

async function advanceLauncherPage(
  page: Page,
): Promise<"pointer-swipe" | "edge-button"> {
  const pageWindow = page.getByTestId("launcher-page-window");
  const secondPage = page.getByTestId("launcher-page-1");
  const box = await pageWindow.boundingBox();
  if (!box) throw new Error("launcher page window is not laid out");
  const y = box.y + box.height * 0.52;
  const startX = box.x + box.width * 0.82;
  const endX = box.x + box.width * 0.16;
  const pointer = {
    bubbles: true,
    cancelable: true,
    pointerId: 9144,
    pointerType: "touch",
    isPrimary: true,
    buttons: 1,
  };
  await pageWindow.dispatchEvent("pointerdown", {
    ...pointer,
    clientX: startX,
    clientY: y,
  });
  await pageWindow.dispatchEvent("pointermove", {
    ...pointer,
    clientX: box.x + box.width * 0.55,
    clientY: y + 2,
  });
  await pageWindow.dispatchEvent("pointermove", {
    ...pointer,
    clientX: endX,
    clientY: y + 2,
  });
  await pageWindow.dispatchEvent("pointerup", {
    ...pointer,
    buttons: 0,
    clientX: endX,
    clientY: y + 2,
  });
  const swiped = await secondPage
    .evaluate((node) => node.getAttribute("aria-hidden") === "false")
    .catch(() => false);
  if (swiped) return "pointer-swipe";

  const next = page.getByTestId("launcher-pager-edge-next");
  if ((await next.count()) === 0) {
    throw new Error(
      "launcher pointer swipe did not advance and no next pager button rendered",
    );
  }
  await next.click();
  return "edge-button";
}

/**
 * Interaction-level coverage for the iOS-like view catalog (Launcher, #8796).
 *
 * Unlike builtin-views-visual.spec (which only asserts each view boots without
 * crashing), this drives the catalog's actual controls — seeded default dock,
 * swipe paging, and tap-to-launch — against a live app boot. Run with
 * E2E_RECORD=1 to capture a video walkthrough.
 */
test.describe("launcher catalog interactions", () => {
  for (const viewport of [
    { name: "desktop", size: { width: 1440, height: 1000 } },
    { name: "mobile", size: { width: 390, height: 844 } },
  ] as const) {
    test(`default dock, swipe paging, and dock Chat launch on ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      const consoleLines: string[] = [];
      const pageErrors: string[] = [];
      const httpErrors: string[] = [];
      page.on("console", (message) =>
        consoleLines.push(`${message.type()}: ${message.text()}`),
      );
      page.on("pageerror", (e) => pageErrors.push(e.message));
      page.on("response", (response) => {
        if (response.status() < 400) return;
        httpErrors.push(
          `${response.status()} ${response.request().method()} ${response.url()}`,
        );
      });

      await page.setViewportSize(viewport.size);
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);
      await installLauncherEvidenceRoutes(page);
      await openAppPath(page, "/views");

      await expect(page.getByTestId("launcher")).toBeVisible({
        timeout: 60_000,
      });
      const dock = page.getByTestId("launcher-dock");
      const firstPage = page.getByTestId("launcher-page-0");
      await expect(dock).toBeVisible();
      await expect(dock.getByTestId("launcher-tile-chat")).toBeVisible();
      await expect(dock.getByTestId("launcher-tile-settings")).toBeVisible();
      await expect(firstPage.getByTestId("launcher-tile-chat")).toHaveCount(0);
      await expect(firstPage.getByTestId("launcher-tile-settings")).toHaveCount(
        0,
      );
      await expect(
        firstPage.locator('[data-testid^="launcher-tile-"]').first(),
      ).toBeVisible();
      await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Done" })).toHaveCount(0);

      await page.waitForTimeout(300);
      await screenshot(page, `${viewport.name}-launcher-default-dock`);
      const dockTileIds = await tileIds(dock);
      const firstPageTileIds = await tileIds(firstPage);

      const secondPage = page.getByTestId("launcher-page-1");
      let pageAdvanceMethod: "pointer-swipe" | "edge-button" | "single-page" =
        "single-page";
      if ((await secondPage.count()) > 0) {
        pageAdvanceMethod = await advanceLauncherPage(page);
        await expect(secondPage).toHaveAttribute("aria-hidden", "false");
        await page.waitForTimeout(300);
        await screenshot(page, `${viewport.name}-launcher-after-swipe`);
      }

      await dock.getByTestId("launcher-tile-chat").locator("button").click();
      await expect
        .poll(() => new URL(page.url()).hash + new URL(page.url()).pathname)
        .toContain("/chat");
      await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();
      await page.waitForTimeout(300);
      await screenshot(page, `${viewport.name}-dock-chat-launched`);

      const evidence = {
        viewport: viewport.name,
        dockTiles: dockTileIds,
        firstPageTiles: firstPageTileIds,
        pageAdvanceMethod,
        finalUrl: page.url(),
        pageErrors,
        httpErrors,
        consoleLines,
      };
      expect(evidence.dockTiles.slice(0, 2)).toEqual(["chat", "settings"]);
      expect(evidence.firstPageTiles).not.toContain("chat");
      expect(evidence.firstPageTiles).not.toContain("settings");
      expect(pageErrors, "no uncaught page errors").toEqual([]);
      expect(httpErrors, "no HTTP error responses").toEqual([]);

      await writeEvidenceFile(
        `${viewport.name}-launcher-observations.json`,
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
      await testInfo.attach(`${viewport.name} launcher observations`, {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      });
    });
  }
});
