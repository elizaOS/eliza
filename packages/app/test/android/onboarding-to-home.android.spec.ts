// Fresh first-run onboarding on the real Android Capacitor WebView.
//
// The broad Android route suite seeds first-run as complete so it can sweep
// routes. This spec deliberately resets the installed app into first-run,
// chooses the Remote runtime with touch input, connects to the deterministic
// host agent exposed through adb reverse, and asserts the post-onboarding home
// surface. No desktop Chromium or page.route fixtures are involved.
//
// ⚠️ NEEDS HUMAN REDESIGN (#9952). Onboarding moved INTO the floating chat
// (ContinuousChatOverlay) and the separate full-screen onboarding surface was
// deleted. The in-chat conductor only offers runtime choices
// `choice-__first_run__:runtime:{cloud,local,other}` — the "Remote" runtime card,
// the `first-run-remote-address` input, and the `choice-connect` button no longer
// exist. `runtime:other` ("Bring your own keys") now runs the LOCAL backend with
// a provider sub-choice; there is NO in-chat "connect to a remote host agent at a
// URL" step anymore (finishRemote still exists in first-run-finish.ts but is
// unreachable from the in-chat conductor). This device lane is UNEXECUTABLE here
// (needs a real Android device) and its remote-connect path below cannot be
// repointed by construction — a human must decide how device remote-connect
// onboarding is driven post-#9952 (e.g. via deep-link / Settings) and rewrite the
// body. Only the first-surface assertion (`continuous-chat-overlay`) is updated.
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

        // #9952: onboarding IS the chat — the conductor greets inside the REAL
        // floating ContinuousChatOverlay (no separate full-screen surface).
        const onboarding = page.getByTestId("continuous-chat-overlay");
        await expect(onboarding).toBeVisible({ timeout: 60_000 });

        // ⚠️ The remote-connect onboarding UI below was removed by #9952 (see the
        // file header). These selectors no longer exist; a human must redesign
        // how device remote-connect onboarding is driven. UNEXECUTABLE here.
        const remoteOption = page.getByTestId("choice-remote");
        await expect(remoteOption).toBeVisible({ timeout: 30_000 });
        await activate(remoteOption);

        const remoteAddress = page.getByTestId("first-run-remote-address");
        await expect(remoteAddress).toBeVisible({ timeout: 30_000 });
        await remoteAddress.fill(HOST_AGENT_BASE);
        await activate(page.getByTestId("choice-connect"));

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
