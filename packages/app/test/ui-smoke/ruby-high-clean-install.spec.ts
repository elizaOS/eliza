/**
 * Clean-install proof for the registry's first third-party app entry.
 *
 * This lane intentionally uses the real local runtime, the exact generated
 * registry from the checkout, npm installation, runtime plugin registration,
 * and the production renderer. It records desktop/mobile catalog and viewer
 * renders plus browser/network/backend logs for review.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const REAL_LOCAL_STACK = process.env.ELIZA_UI_SMOKE_REAL_LOCAL_STACK === "1";
const REGISTRY_FIXTURE =
  process.env.ELIZA_UI_SMOKE_GENERATED_REGISTRY_FIXTURE?.trim();
const APP_NAME = "@rati-osf/plugin-ruby-high";
const VIEWER_PATH = "/ruby-high/viewer";
const APP_ICON =
  "https://unpkg.com/@rati-osf/plugin-ruby-high@0.1.5/images/ruby-high-app-icon.png";
const APP_HERO =
  "https://unpkg.com/@rati-osf/plugin-ruby-high@0.1.5/images/ruby-eliza-plugin-launch.jpg";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

type RubyHighCatalogEntry = {
  appMeta?: {
    category?: string;
    heroImage?: string;
    icon?: string;
    launchType?: string;
    viewer?: { url?: string };
  };
  category?: string;
  homepage?: string;
  launchType?: string;
  name?: string;
  npm?: { package?: string; v2Version?: string | null };
  viewer?: { url?: string };
};

type RubyHighLaunch = {
  displayName?: string;
  launchType?: string;
  needsRestart?: boolean;
  pluginInstalled?: boolean;
  run?: {
    appName?: string;
    runId?: string;
    viewer?: { url?: string };
  };
  viewer?: { url?: string };
};

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.jpg`);
  await mkdir(testInfo.outputDir, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: screenshotPath,
    type: "jpeg",
    quality: 92,
    fullPage: true,
    attempts: 4,
  });
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/jpeg",
  });
}

async function expectImagesLoaded(scope: Locator): Promise<void> {
  const images = scope.locator("img");
  await expect
    .poll(
      async () => {
        if ((await images.count()) === 0) return false;
        return images.evaluateAll((nodes) =>
          nodes.every((node) => {
            const image = node as HTMLImageElement;
            return image.complete && image.naturalWidth > 0;
          }),
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

test.describe("Ruby High clean-install catalog and launch", () => {
  test.skip(!REAL_LOCAL_STACK, "requires ELIZA_UI_SMOKE_REAL_LOCAL_STACK=1");
  test.skip(!REGISTRY_FIXTURE, "requires the exact-head registry fixture");
  test.setTimeout(420_000);

  test("installs once and opens the declared viewer on desktop and mobile", async ({
    page,
  }, testInfo) => {
    const consoleLines: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const httpErrors: string[] = [];
    page.on("console", (message) => {
      consoleLines.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) =>
      pageErrors.push(error.stack ?? error.message),
    );
    page.on("requestfailed", (request) => {
      requestFailures.push(
        `${request.method()} ${request.url()} — ${
          request.failure()?.errorText ?? "unknown error"
        }`,
      );
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      httpErrors.push(
        `${response.status()} ${response.request().method()} ${response.url()}`,
      );
    });

    const installedBeforeResponse = await page.request.get(
      "/api/apps/installed",
    );
    expect(installedBeforeResponse.ok()).toBe(true);
    const installedBefore = (await installedBeforeResponse.json()) as Array<{
      name?: string;
    }>;
    expect(installedBefore.some((app) => app.name === APP_NAME)).toBe(false);

    const catalogResponse = await page.request.get("/api/apps");
    expect(catalogResponse.ok()).toBe(true);
    const catalog = (await catalogResponse.json()) as RubyHighCatalogEntry[];
    const rubyHigh = catalog.find((app) => app.name === APP_NAME);
    expect(rubyHigh).toMatchObject({
      name: APP_NAME,
      homepage: "https://ruby-high.ai",
      category: "education",
      launchType: "connect",
      npm: {
        package: APP_NAME,
        v2Version: "0.1.5",
      },
      viewer: { url: VIEWER_PATH },
      appMeta: {
        category: "education",
        heroImage: APP_HERO,
        icon: APP_ICON,
        launchType: "connect",
        viewer: { url: VIEWER_PATH },
      },
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await seedAppStorage(page);
    await openAppPath(page, "/views");
    await expect(page.getByTestId("launcher")).toBeVisible({
      timeout: 60_000,
    });
    const rubyTile = page.getByRole("button", { name: "Ruby High" });
    await expect(rubyTile).toBeVisible({ timeout: 60_000 });
    await rubyTile.scrollIntoViewIfNeeded();
    await expectImagesLoaded(rubyTile);
    await capture(page, testInfo, "desktop-clean-catalog");

    await page.setViewportSize({ width: 390, height: 844 });
    await rubyTile.scrollIntoViewIfNeeded();
    await expect(rubyTile).toBeVisible();
    await capture(page, testInfo, "mobile-clean-catalog");

    await page.setViewportSize({ width: 1440, height: 1000 });
    await rubyTile.scrollIntoViewIfNeeded();
    const launchResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/apps/launch",
      { timeout: 300_000 },
    );
    await rubyTile.click();
    const launchResponse = await launchResponsePromise;
    const launchBody = (await launchResponse.json()) as
      | RubyHighLaunch
      | { error?: string };
    expect(
      launchResponse.ok(),
      `launch failed: ${JSON.stringify(launchBody)}`,
    ).toBe(true);
    const launch = launchBody as RubyHighLaunch;
    expect(launch).toMatchObject({
      displayName: "Ruby High",
      launchType: "connect",
      pluginInstalled: true,
      viewer: { url: VIEWER_PATH },
      run: {
        appName: APP_NAME,
        viewer: { url: VIEWER_PATH },
      },
    });
    expect(typeof launch.needsRestart).toBe("boolean");

    const viewer = page.getByTestId("game-view-iframe");
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => {
        const src = await viewer.getAttribute("src");
        return new URL(src ?? "", page.url()).pathname;
      })
      .toBe(VIEWER_PATH);
    const viewerFrame = page.frameLocator('[data-testid="game-view-iframe"]');
    await expect(
      viewerFrame.getByRole("heading", { name: "Ruby High" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      viewerFrame.getByText("Agents go to school here."),
    ).toBeVisible();
    await expectImagesLoaded(viewerFrame.locator("body"));
    await capture(page, testInfo, "desktop-first-launch-viewer");

    const installedAfterResponse = await page.request.get(
      "/api/apps/installed",
    );
    expect(installedAfterResponse.ok()).toBe(true);
    const installedAfter = (await installedAfterResponse.json()) as Array<{
      name?: string;
    }>;
    expect(installedAfter.some((app) => app.name === APP_NAME)).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(viewer).toBeVisible();
    await expect(
      viewerFrame.getByRole("heading", { name: "Ruby High" }),
    ).toBeVisible();
    await capture(page, testInfo, "mobile-first-launch-viewer");

    const unexpectedRequestFailures = requestFailures.filter((line) => {
      if (!line.endsWith("— net::ERR_ABORTED")) return true;
      const url = line.match(/^GET (\S+) —/)?.[1];
      if (!url) return true;
      const pathname = new URL(url).pathname;
      return !(
        pathname === "/views" ||
        pathname.startsWith("/assets/") ||
        pathname === "/api/local-inference/downloads/stream"
      );
    });
    const frontendEvidence = {
      appName: APP_NAME,
      catalog: rubyHigh,
      installedBefore,
      installedAfter,
      launch,
      finalUrl: page.url(),
      consoleLines,
      pageErrors,
      requestFailures,
      unexpectedRequestFailures,
      httpErrors,
    };
    const frontendLogPath = testInfo.outputPath("frontend-and-network.json");
    await writeFile(
      frontendLogPath,
      `${JSON.stringify(frontendEvidence, null, 2)}\n`,
      "utf8",
    );
    await testInfo.attach("frontend and network log", {
      path: frontendLogPath,
      contentType: "application/json",
    });

    const backendLogSetting =
      process.env.ELIZA_UI_SMOKE_BACKEND_LOG_PATH?.trim();
    expect(backendLogSetting).toBeTruthy();
    const backendLogPath = path.resolve(
      REPO_ROOT,
      backendLogSetting ?? "e2e-recordings/ruby-high/backend.log",
    );
    const backendLog = await readFile(backendLogPath, "utf8");
    expect(backendLog).toContain("serving generated registry fixture");
    expect(backendLog).toContain("[registry-client] Fetching plugin registry");
    expect(backendLog).toContain("Loaded ");
    expect(backendLog).toContain(
      `[app-manager] Installing plugin for app: ${APP_NAME}`,
    );
    expect(backendLog).toContain(
      `[app-manager] Plugin installed: ${APP_NAME} v0.1.5`,
    );
    expect(backendLog).not.toContain("[plugin-installer] npm failed");
    await testInfo.attach("backend log", {
      path: backendLogPath,
      contentType: "text/plain",
    });

    expect(pageErrors, "no uncaught frontend errors").toEqual([]);
    expect(
      unexpectedRequestFailures,
      "no unexpected failed frontend requests",
    ).toEqual([]);
    expect(
      httpErrors.filter((line) => line.includes("ruby-high")),
      "no Ruby High HTTP errors",
    ).toEqual([]);
  });
});
