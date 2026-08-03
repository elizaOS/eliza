/**
 * Exercises the production renderer's restricted-native catalog fallback from
 * leaked remote metadata through the signed Notes and Calendar registrations.
 */
import { expect, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  hideChatOverlay,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test("restricted native catalog mounts signed Notes and Calendar renderers", async ({
  page,
}, testInfo) => {
  installPageDiagnosticsGuard(page);
  await seedAppStorage(page);
  await hideChatOverlay(page);
  await installDefaultAppRoutes(page);

  const dynamicBundleRequests: string[] = [];
  page.on("request", (request) => {
    if (
      /\/api\/views\/(?:notes|simple-calendar)\/bundle\.js/.test(request.url())
    ) {
      dynamicBundleRequests.push(request.url());
    }
  });

  const registryPlatformHeaders: string[] = [];
  await page.route(/\/api\/views(?:\?.*)?$/, async (route) => {
    registryPlatformHeaders.push(
      route.request().headers()["x-eliza-platform"] ?? "missing",
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        views: [
          {
            id: "notes",
            label: "Notes",
            path: "/notes",
            pluginName: "@elizaos/plugin-simple-views",
            componentExport: "NotesView",
            bundleUrl: "/api/views/notes/bundle.js",
            available: true,
          },
          {
            id: "simple-calendar",
            label: "Calendar",
            path: "/simple-calendar",
            pluginName: "@elizaos/plugin-simple-views",
            componentExport: "SimpleCalendarView",
            bundleUrl: "/api/views/simple-calendar/bundle.js",
            available: true,
          },
        ],
      }),
    });
  });

  await openAppPath(page, "/views");
  const launcher = page.getByTestId("launcher");
  await expect(launcher).toBeVisible({ timeout: 60_000 });

  // Transition after the web-shaped registry response and intentionally do not
  // refetch it. The renderer must resolve the exact signed registration instead
  // of importing the stale bundle URL through the native WebView origin.
  await page.evaluate(() => {
    const capacitor = Reflect.get(window, "Capacitor");
    if (!capacitor || typeof capacitor !== "object") {
      throw new Error("Capacitor platform bridge is unavailable");
    }
    Reflect.set(capacitor, "getPlatform", () => "android");
  });

  dynamicBundleRequests.length = 0;
  const notesTile = launcher.getByTestId("launcher-tile-notes");
  await expect(notesTile).toBeVisible({ timeout: 60_000 });
  await notesTile.click();
  await expect(page.getByTestId("simple-notes-view")).toBeVisible({
    timeout: 60_000,
  });
  await testInfo.attach("signed-notes-renderer", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.waitForTimeout(500);

  await page.goBack();
  await expect(launcher).toBeVisible({ timeout: 60_000 });
  const calendarTile = launcher.getByTestId("launcher-tile-simple-calendar");
  await expect(calendarTile).toBeVisible({ timeout: 60_000 });
  await calendarTile.click();
  await expect(page.getByTestId("simple-calendar-view")).toBeVisible({
    timeout: 60_000,
  });
  await testInfo.attach("signed-calendar-renderer", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.waitForTimeout(500);

  expect(registryPlatformHeaders).toContain("web");
  expect(registryPlatformHeaders).not.toContain("android");
  expect(dynamicBundleRequests).toEqual([]);
  await expectNoPageDiagnostics(page, "restricted native Simple Views journey");
});
