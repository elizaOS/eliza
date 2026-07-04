/**
 * Android-browser Playwright spec for the Onboarding To Home Android Browser
 * mobile app onboarding flow.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { _android } from "playwright";
import { startAndroidScreenRecord } from "../../scripts/lib/android-capture.mjs";
import { adbReverse, resolveAdb } from "../../scripts/lib/android-device.mjs";
import {
  expectNoPageDiagnostics,
  installPageDiagnosticsGuard,
  seedAppStorage,
} from "../ui-smoke/helpers";
import {
  completeOnboardingToHome,
  expectChatFirstOnboarding,
  injectFullCapabilityHost,
  installHomeRoutes,
  settleHomeEntrance,
} from "../ui-smoke/onboarding-to-home.shared";

const uiSmokePort = Number(process.env.ELIZA_UI_SMOKE_PORT || "2138");
const ANDROID_BROWSER_BASE_URL =
  process.env.ELIZA_ANDROID_BROWSER_BASE_URL?.trim() ||
  `http://127.0.0.1:${uiSmokePort}`;
const ARTIFACT_DIR = path.join(
  process.cwd(),
  "test-results",
  "android-browser-onboarding-to-home",
);

const androidChromeClick = (locator: Locator) => locator.click();

test("Android Chrome first-run onboarding completes in the real chat overlay", async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(180_000);

  const devices = await _android.devices();
  const serial = process.env.ANDROID_SERIAL?.trim();
  const device = serial
    ? devices.find((candidate) => candidate.serial() === serial)
    : devices[0];
  if (!device) {
    throw new Error(
      serial
        ? `Android device ${serial} not found`
        : "No Android device available for Chrome browser smoke.",
    );
  }
  adbReverse(resolveAdb(), device.serial(), uiSmokePort);

  const recording = await startAndroidScreenRecord({
    serial: device.serial(),
    artifactDir: ARTIFACT_DIR,
    filename: "android-browser-onboarding-to-home.mp4",
    remotePath: "/sdcard/eliza-android-browser-onboarding-to-home.mp4",
  });
  const context = await device.launchBrowser();
  const page = await context.newPage();

  try {
    installPageDiagnosticsGuard(page);
    await injectFullCapabilityHost(page);
    const state = await installHomeRoutes(page);
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto(ANDROID_BROWSER_BASE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expectChatFirstOnboarding(page);
    await capture(page, "android-browser-onboarding-chat-first.png", testInfo);

    const { surface } = await completeOnboardingToHome(
      page,
      androidChromeClick,
      {
        state,
        tutorial: "skip",
      },
    );
    await settleHomeEntrance(page);
    await expect(surface).toHaveAttribute("data-page", "home");
    await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0);
    await capture(page, "android-browser-home.png", testInfo);

    await expectNoPageDiagnostics(page, testInfo.title);
  } finally {
    await context.close().catch(() => {});
    for (const candidate of devices) {
      await candidate.close().catch(() => {});
    }
    const videoPath = await recording.stop();
    if (videoPath) {
      await testInfo.attach("android browser onboarding video", {
        path: videoPath,
        contentType: "video/mp4",
      });
    }
  }
});

async function capture(
  page: Page,
  filename: string,
  testInfo: TestInfo,
): Promise<void> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const screenshotPath = path.join(ARTIFACT_DIR, filename);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(filename, {
    path: screenshotPath,
    contentType: "image/png",
  });
}
