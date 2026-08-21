/**
 * Playwright UI-smoke spec for the Launcher Cloud Gating app flow using the
 * real renderer fixture.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

/**
 * Rendered launcher evidence that the Cloud Applications studio never tiles.
 *
 * The launcher carries exactly ONE apps destination — the Projects tile. The
 * `cloud-apps` studio is folded into Projects (its view surfaces as a row in
 * the Projects Apps segment and via the /cloud-apps deep link), so `curateLauncherPages`
 * drops it unconditionally (`LAUNCHER_HIDDEN_IDS` in launcher-curation.ts,
 * unit-tested in launcher-curation.test.ts). This spec renders the REAL
 * launcher in both cloud states and captures the proof: with a `cloud-apps`
 * view present in the catalog, the tile must be absent whether
 * `/api/cloud/status` reports disconnected or connected, while the Projects
 * tile stays visible — on desktop (1280×800) and mobile (390×844).
 *
 * The `cloud-apps` registration is platform-gated (packages/app/src/
 * cloud-apps-view.ts registers it only on non-web shells, where the launcher is
 * the sole route to the Cloud Applications dashboard). The web smoke harness
 * therefore injects the same registry entry through `GET /api/views` — the
 * network half of the exact catalog merge the native app-shell registration
 * flows through (useAvailableViews merges network + app-shell entries before
 * `curateLauncherPages` ever sees them), so the curation path under test is the
 * real one, not a mock of it.
 *
 * Capture artifacts are written into Playwright's per-test output directory.
 * The walkthrough test also records the local-runtime navigation boundary:
 * the launcher keeps My Apps as its one apps entry, while Settings omits the
 * Cloud-only management group reserved for managed Cloud runtime targets.
 */

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

async function screenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.jpg`);
  await mkdir(testInfo.outputDir, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: screenshotPath,
    type: "jpeg",
    quality: 90,
    fullPage: false,
    attempts: 4,
  });
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/jpeg",
  });
}

/**
 * Append the `cloud-apps` view (the entry `packages/app/src/cloud-apps-view.ts`
 * registers on native shells) to the stub backend's GET /api/views response.
 * Field shape mirrors `appShellPageToViewEntry` in useAvailableViews.ts.
 */
async function injectCloudAppsView(page: Page): Promise<void> {
  await page.route("**/api/views", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(request.url());
    const viewType = url.searchParams.get("viewType");
    const response = await route.fetch();
    const body = (await response.json()) as { views?: unknown[] };
    if (!viewType || viewType === "gui") {
      body.views = [
        ...(Array.isArray(body.views) ? body.views : []),
        {
          id: "cloud-apps",
          label: "Cloud Apps",
          viewType: "gui",
          icon: "Grid3x3",
          path: "/cloud-apps",
          available: true,
          pluginName: "@elizaos/app",
          viewKind: "release",
          visibleInManager: true,
          builtin: false,
        },
      ];
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

interface CloudStatusState {
  connected: boolean;
}

/**
 * Stateful override of the cloud status/credits endpoints (registered after
 * installDefaultAppRoutes, so it wins route matching). Flipping
 * `state.connected` mid-test drives the disconnected → connected transition
 * the same way a completed real login does: through the status poll.
 */
async function installMutableCloudStatus(
  page: Page,
  state: CloudStatusState,
): Promise<void> {
  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: state.connected,
        enabled: state.connected,
        cloudVoiceProxyAvailable: false,
        hasApiKey: state.connected,
        ...(state.connected ? { userId: "ui-smoke-cloud-user" } : {}),
      }),
    });
  });
  await page.route("**/api/cloud/credits", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    if (!state.connected) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "not connected" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        balance: 100,
        low: false,
        critical: false,
        authRejected: false,
      }),
    });
  });
}

async function bootLauncher(
  page: Page,
  size: { width: number; height: number },
  state: CloudStatusState,
): Promise<void> {
  await page.setViewportSize(size);
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installMutableCloudStatus(page, state);
  await injectCloudAppsView(page);
  await openAppPath(page, "/views");
  await expect(page.getByTestId("launcher")).toBeVisible({ timeout: 60_000 });
  // The launcher owns curation; wait for the curated page tiles to paint.
  await expect(
    page.locator('[data-testid^="launcher-tile-"]').first(),
  ).toBeVisible({ timeout: 30_000 });
}

const cloudTile = (page: Page) => page.getByTestId("launcher-tile-cloud-apps");
const projectsTile = (page: Page) => page.getByTestId("launcher-tile-tasks");

test.describe("launcher: one apps tile — cloud-apps never tiles", () => {
  for (const viewport of VIEWPORTS) {
    test(`cloud INACTIVE hides the cloud-apps tile on ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      await bootLauncher(page, viewport, { connected: false });
      // The catalog HAS the cloud-apps view (injected above); the launcher must
      // still not surface it — Projects is the one apps destination.
      await expect(projectsTile(page)).toBeVisible();
      await expect(cloudTile(page)).toHaveCount(0);
      await screenshot(
        page,
        testInfo,
        `${viewport.name}-cloud-inactive-launcher`,
      );
    });

    test(`cloud ACTIVE still hides the cloud-apps tile on ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      await bootLauncher(page, viewport, { connected: true });
      // Signed in changes nothing for the studio tile: it is consolidated into
      // Projects (the Apps-segment Eliza Cloud row + the /cloud-apps deep link).
      await expect(projectsTile(page)).toBeVisible();
      await expect(cloudTile(page)).toHaveCount(0);
      await screenshot(
        page,
        testInfo,
        `${viewport.name}-cloud-active-launcher`,
      );
    });
  }

  test.describe("local runtime boundary walkthrough (recorded)", () => {
    // `test.use({ video })` is not allowed inside a describe group, so the
    // walkthrough records through its own context (recordVideo) instead.
    test("local runtime hides Cloud management and keeps one apps tile", async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({
        baseURL: testInfo.project.use.baseURL,
        viewport: { width: 1280, height: 800 },
        recordVideo: {
          dir: testInfo.outputPath("walkthrough-video"),
          size: { width: 1280, height: 800 },
        },
      });
      const page = await context.newPage();
      const state: CloudStatusState = { connected: false };
      await bootLauncher(page, { width: 1280, height: 800 }, state);
      await expect(projectsTile(page)).toBeVisible({ timeout: 30_000 });
      await expect(cloudTile(page)).toHaveCount(0);
      await screenshot(page, testInfo, "walkthrough-1-launcher-disconnected");

      // Cloud management belongs only to managed Cloud targets. Local and VPS
      // runtimes must not expose its group, Overview, or Agents destinations.
      await openAppPath(page, "/settings");
      await expect(page.getByTestId("settings-shell")).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        page.getByTestId("desktop-settings-navigation"),
      ).toBeVisible();
      await expect(
        page.getByTestId("desktop-settings-item-identity"),
      ).toBeVisible();
      await expect(
        page.getByTestId("desktop-settings-group-cloud"),
      ).toHaveCount(0);
      await expect(
        page.getByTestId("desktop-settings-item-cloud-overview"),
      ).toHaveCount(0);
      await expect(
        page.getByTestId("desktop-settings-item-cloud-agents"),
      ).toHaveCount(0);
      await screenshot(
        page,
        testInfo,
        "walkthrough-2-local-settings-without-cloud-management",
      );

      await openAppPath(page, "/views");
      await expect(page.getByTestId("launcher")).toBeVisible({
        timeout: 60_000,
      });
      // Navigating through local Settings must not change launcher curation.
      await expect(projectsTile(page)).toBeVisible({ timeout: 30_000 });
      await expect(cloudTile(page)).toHaveCount(0);
      await screenshot(page, testInfo, "walkthrough-3-local-launcher-return");

      // Persist the recording next to the screenshots.
      const video = page.video();
      await context.close();
      if (video) {
        const artifact = await saveBrowserVideoArtifact({
          video,
          testInfo,
          basename: "local-cloud-boundary-walkthrough",
        });
        await testInfo.attach("local Cloud boundary walkthrough", {
          path: artifact.path,
          contentType: artifact.contentType,
        });
        const notePath = testInfo.outputPath(
          "local-cloud-boundary-walkthrough.txt",
        );
        await writeFile(
          notePath,
          [
            "Recorded by launcher-cloud-gating.spec.ts (local Cloud boundary).",
            "Flow: local launcher with My Apps as its single apps tile → Settings",
            "without the managed-only Cloud group → launcher still shows only",
            "the My Apps tile (the studio lives inside My Apps).",
            "",
            "Repro: bun run --cwd packages/app test:e2e -- --project=chromium test/ui-smoke/launcher-cloud-gating.spec.ts",
          ].join("\n"),
        );
        await testInfo.attach("local Cloud boundary walkthrough notes", {
          path: notePath,
          contentType: "text/plain",
        });
      }
    });
  });
});
