// Fresh first-run onboarding on the real Android Capacitor WebView.
//
// The broad Android route suite seeds first-run as complete so it can sweep
// routes. This spec deliberately resets the installed app into first-run,
// chooses the Remote runtime with touch input, connects to the deterministic
// host agent exposed through adb reverse, and asserts the post-onboarding home
// surface. No desktop Chromium or page.route fixtures are involved.
import path from "node:path";
import type { Locator } from "@playwright/test";
import { startAndroidScreenRecord } from "../../scripts/lib/android-capture.mjs";
import { expect, ORIGIN, test } from "./android-harness";

const HOST_AGENT_BASE = "http://127.0.0.1:31337";
const ARTIFACT_DIR = path.join(
  process.cwd(),
  "test-results",
  "android-onboarding-to-home",
);

async function activate(locator: Locator) {
  try {
    await locator.tap();
  } catch (error) {
    if (!/does not support tap/i.test(String(error))) throw error;
    await locator.click();
  }
}

test.describe
  .serial("android onboarding to home (real Capacitor WebView)", () => {
    test("fresh first-run connects to a host agent and lands on home", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(180_000);

      const recording = await startAndroidScreenRecord({
        serial: device.serial(),
        artifactDir: ARTIFACT_DIR,
        filename: "onboarding-to-home.mp4",
        remotePath: "/sdcard/eliza-onboarding-to-home.mp4",
      });

      try {
        // Keep Android's local sideload pre-seed from rewriting the fresh session
        // back to eliza-local-agent://ipc after ?reset clears active-server.
        await page.evaluate(() => {
          localStorage.setItem("eliza:mobile-runtime-mode", "remote");
          localStorage.removeItem("elizaos:active-server");
          localStorage.removeItem("eliza:onboarding-complete");
          localStorage.removeItem("eliza:first-run-complete");
          localStorage.removeItem("eliza:setup:step");
        });

        await page.goto(`${ORIGIN}/?reset`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });

        const onboarding = page.getByTestId("onboarding-toast");
        await expect(onboarding).toBeVisible({ timeout: 60_000 });

        const remoteOption = page.getByTestId("onboarding-option-remote");
        await expect(remoteOption).toBeVisible({ timeout: 30_000 });
        await activate(remoteOption);

        const remoteConnect = page.getByTestId("onboarding-remote-connect");
        await expect(remoteConnect).toBeVisible({ timeout: 30_000 });
        await page.locator("#onboarding-remote-address").fill(HOST_AGENT_BASE);
        await activate(remoteConnect);

        await expect(onboarding).toBeHidden({ timeout: 90_000 });

        const surface = page.getByTestId("home-launcher-surface");
        await expect(surface).toBeVisible({ timeout: 60_000 });
        await expect(surface).toHaveAttribute("data-page", "home");
        await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
          timeout: 60_000,
        });

        const screenshotPath = path.join(ARTIFACT_DIR, "home-landing.png");
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await testInfo.attach("home landing screenshot", {
          path: screenshotPath,
          contentType: "image/png",
        });
      } finally {
        const videoPath = await recording.stop();
        if (videoPath) {
          await testInfo.attach("onboarding walkthrough video", {
            path: videoPath,
            contentType: "video/mp4",
          });
        }
      }
    });
  });
