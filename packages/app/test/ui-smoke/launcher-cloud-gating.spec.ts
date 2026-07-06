/**
 * Playwright UI-smoke spec for the Launcher Cloud Gating app flow using the
 * real renderer fixture.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

/**
 * Rendered launcher cloud-gating evidence (#10725 / #11342).
 *
 * The headline #10725 AC — "the launcher shows cloud views only when Eliza
 * Cloud is active" — is implemented in `curateLauncherPages` (launcher-curation
 * .ts, `LAUNCHER_CLOUD_IDS` + `cloudActive`) and unit-tested in
 * launcher-curation.test.ts (PR #10768). This spec renders the REAL launcher in
 * both states and captures the proof: with a `cloud-apps` view present in the
 * catalog, the tile must be absent while `/api/cloud/status` reports
 * disconnected and present once it reports connected — on desktop (1280×800)
 * and mobile (390×844).
 *
 * The `cloud-apps` registration is platform-gated (packages/app/src/
 * cloud-apps-view.ts registers it only on non-web shells, where the launcher is
 * the sole route to the Cloud Applications dashboard). The web smoke harness
 * therefore injects the same registry entry through `GET /api/views` — the
 * network half of the exact catalog merge the native app-shell registration
 * flows through (useAvailableViews merges network + app-shell entries before
 * `curateLauncherPages` ever sees them), so the gate under test is the real
 * curation path, not a mock of it.
 *
 * Capture artifacts are written into Playwright's per-test output directory.
 * The walkthrough test also records a video of the agent-first cloud setup
 * flow: launcher without the tile → Settings → Cloud → Connect → connected →
 * launcher with the tile.
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
          label: "Apps",
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
const chatTile = (page: Page) => page.getByTestId("launcher-tile-chat");

test.describe("launcher cloud gating (#10725)", () => {
  for (const viewport of VIEWPORTS) {
    test(`cloud INACTIVE hides the cloud-apps tile on ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      await bootLauncher(page, viewport, { connected: false });
      // The catalog HAS the cloud-apps view (injected above); the launcher must
      // still not surface it while cloud is disconnected.
      await expect(chatTile(page)).toBeVisible();
      await expect(cloudTile(page)).toHaveCount(0);
      await screenshot(
        page,
        testInfo,
        `${viewport.name}-cloud-inactive-launcher`,
      );
    });

    test(`cloud ACTIVE shows the cloud-apps tile on ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      await bootLauncher(page, viewport, { connected: true });
      await expect(chatTile(page)).toBeVisible();
      await expect(cloudTile(page)).toBeVisible({ timeout: 30_000 });
      await screenshot(
        page,
        testInfo,
        `${viewport.name}-cloud-active-launcher`,
      );
    });
  }

  test.describe("cloud setup walkthrough (recorded)", () => {
    // `test.use({ video })` is not allowed inside a describe group, so the
    // walkthrough records through its own context (recordVideo) instead.
    test("connect flow surfaces the cloud-apps tile", async ({
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
      await expect(cloudTile(page)).toHaveCount(0);
      await screenshot(page, testInfo, "walkthrough-1-launcher-disconnected");

      // Agent-first cloud setup: Settings → Cloud → Overview → Connect Cloud.
      // (The cloud group's overview section registers with defaultLabel
      // "Overview" and defaultTitle "Eliza Cloud" — settings-sections.ts.)
      await openAppPath(page, "/settings");
      await openSettingsSection(page, /^Overview$/);
      const connectButton = page.getByRole("button", {
        name: /Connect Cloud|Connect Eliza Cloud/i,
      });
      await expect(connectButton.first()).toBeVisible({ timeout: 30_000 });
      await screenshot(page, testInfo, "walkthrough-2-settings-cloud-section");

      // Completing the (stubbed) login flips the backend status; the UI must
      // observe it through its own status poll — the same signal a real
      // device-code/Steward completion produces.
      state.connected = true;
      await connectButton.first().click();
      await expect(
        page.getByRole("button", { name: /Cloud connected/i }).first(),
      ).toBeVisible({ timeout: 60_000 });
      await screenshot(
        page,
        testInfo,
        "walkthrough-3-settings-cloud-connected",
      );

      await openAppPath(page, "/views");
      await expect(page.getByTestId("launcher")).toBeVisible({
        timeout: 60_000,
      });
      await expect(cloudTile(page)).toBeVisible({ timeout: 30_000 });
      await screenshot(page, testInfo, "walkthrough-4-launcher-connected");

      // Persist the recording next to the screenshots.
      const video = page.video();
      await context.close();
      if (video) {
        const artifact = await saveBrowserVideoArtifact({
          video,
          testInfo,
          basename: "cloud-setup-walkthrough",
        });
        await testInfo.attach("cloud setup walkthrough", {
          path: artifact.path,
          contentType: artifact.contentType,
        });
        const notePath = testInfo.outputPath("cloud-setup-walkthrough.txt");
        await writeFile(
          notePath,
          [
            "Recorded by launcher-cloud-gating.spec.ts (cloud setup walkthrough).",
            "Flow: launcher without cloud-apps tile → Settings → Eliza Cloud →",
            "Connect Cloud → status flips connected → launcher shows the tile.",
            "",
            "Repro: bun run --cwd packages/app test:e2e -- --project=chromium test/ui-smoke/launcher-cloud-gating.spec.ts",
          ].join("\n"),
        );
        await testInfo.attach("cloud setup walkthrough notes", {
          path: notePath,
          contentType: "text/plain",
        });
      }
    });
  });
});
