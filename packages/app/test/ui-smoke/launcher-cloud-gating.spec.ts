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
 * Rendered launcher evidence that Projects is the one creator-work tile.
 *
 * Historical `my-apps` and `cloud-apps` registrations are hidden while the
 * stable `tasks` tile presents as Projects. This spec renders the real launcher
 * in both cloud states and proves Cloud connection cannot create a second
 * creator-management destination.
 *
 * The harness injects a stale `cloud-apps` catalog entry through GET /api/views
 * to prove curation remains safe even when a remote agent still advertises the
 * retired surface.
 *
 * Capture artifacts are written into Playwright's per-test output directory.
 * The walkthrough test also records a video of the agent-first cloud setup
 * flow: Projects-only launcher → Settings → Cloud → Connect → connected →
 * Projects remains the only creator-work entry.
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
 * Append a stale `cloud-apps` view to the stub backend's GET /api/views
 * response. Field shape mirrors `appShellPageToViewEntry`.
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
const chatTile = (page: Page) => page.getByTestId("launcher-tile-chat");
const myAppsTile = (page: Page) => page.getByTestId("launcher-tile-my-apps");
const projectsTile = (page: Page) => page.getByTestId("launcher-tile-tasks");

test.describe("launcher: Projects is the one creator-work tile", () => {
  for (const viewport of VIEWPORTS) {
    test(`cloud INACTIVE hides the cloud-apps tile on ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      await bootLauncher(page, viewport, { connected: false });
      // The stale catalog entry is present, but only Projects may tile.
      await expect(chatTile(page)).toBeVisible();
      await expect(projectsTile(page)).toBeVisible();
      await expect(myAppsTile(page)).toHaveCount(0);
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
      // Signing in does not reintroduce either retired creator surface.
      await expect(chatTile(page)).toBeVisible();
      await expect(projectsTile(page)).toBeVisible();
      await expect(myAppsTile(page)).toHaveCount(0);
      await expect(cloudTile(page)).toHaveCount(0);
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
    test("connect flow keeps Projects as the one creator-work tile", async ({
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
      // Connecting Cloud must not grow a second creator-management tile.
      await expect(projectsTile(page)).toBeVisible({ timeout: 30_000 });
      await expect(myAppsTile(page)).toHaveCount(0);
      await expect(cloudTile(page)).toHaveCount(0);
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
            "Connect Cloud → status flips connected → launcher still shows only",
            "the Projects creator-work tile.",
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
