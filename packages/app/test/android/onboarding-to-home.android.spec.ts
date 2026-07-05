// Fresh first-run REMOTE-CONNECT onboarding on the real Android Capacitor
// WebView, driven by the OS deep link.
//
// The host (a desktop/cloud agent) emits a
// `<scheme>://first-run/runtime/remote?api=<url>` link/QR. Opening it on a fresh
// device connects to that remote and lands on home. This spec resets the
// installed app into first-run, fires the real deep link via `adb am start`
// (delivered to Capacitor's `appUrlOpen`), and asserts the post-onboarding home
// surface — no onboarding DOM is touched, so the lane survives the in-chat
// onboarding redesign (#9952/#10302) instead of binding to deleted testids
// (the original `choice-remote` / `first-run-remote-address` / `choice-connect`
// flow). Replaces the lane quarantined in #10322.
//
// The deterministic host agent is reachable at 127.0.0.1:31337 through
// `adb reverse`; 127.0.0.1 is loopback, so the connect needs no confirm prompt.
import path from "node:path";
import { startAndroidScreenRecord } from "../../scripts/lib/android-capture.mjs";
import {
  APP_ID,
  adbDevice,
  adbReverse,
  resolveAdb,
} from "../../scripts/lib/android-device.mjs";
import { expect, ORIGIN, test } from "./android-harness";

const HOST_AGENT_BASE = "http://127.0.0.1:31337";
// app.config.ts `desktop.urlScheme`; the Android manifest registers it as the
// BROWSABLE `@string/custom_url_scheme` intent-filter.
const URL_SCHEME = "elizaos";
const FIRST_RUN_REMOTE_DEEPLINK = `${URL_SCHEME}://first-run/runtime/remote?api=${encodeURIComponent(
  HOST_AGENT_BASE,
)}`;
const ARTIFACT_DIR = path.join(
  process.env.ELIZA_ANDROID_ARTIFACT_DIR ??
    path.join(process.cwd(), "test-results", "android"),
  "onboarding-to-home",
);

test.describe
  .serial("android remote-connect onboarding via deep link (real WebView)", () => {
    test("fresh first-run deep link connects to a host agent and lands on home", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(180_000);

      const adbBin = resolveAdb();
      const serial = device.serial();
      // The device's 127.0.0.1:31337 must reach the host's deterministic agent.
      adbReverse(adbBin, serial, 31337);

      const recording = await startAndroidScreenRecord({
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "onboarding-to-home.mp4",
        remotePath: "/sdcard/eliza-onboarding-to-home.mp4",
      });

      try {
        // Force a fresh first-run: drop any seeded active-server / completion so
        // the app boots into onboarding before the deep link arrives.
        await page.evaluate(() => {
          localStorage.removeItem("elizaos:active-server");
          localStorage.removeItem("eliza:onboarding-complete");
          localStorage.removeItem("eliza:first-run-complete");
          localStorage.removeItem("eliza:setup:step");
          localStorage.removeItem("eliza:mobile-runtime-mode");
        });
        await page.goto(`${ORIGIN}/?reset`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });

        // Fire the real OS deep link. `am start` delivers it to the running
        // WebView via Capacitor `appUrlOpen` (singleTask onNewIntent), so the
        // CDP page survives and observes the connect → home transition.
        adbDevice(adbBin, serial, [
          "shell",
          "am",
          "start",
          "-a",
          "android.intent.action.VIEW",
          "-c",
          "android.intent.category.BROWSABLE",
          "-d",
          FIRST_RUN_REMOTE_DEEPLINK,
          APP_ID,
        ]);

        const surface = page.getByTestId("home-launcher-surface");
        await expect(surface).toBeVisible({ timeout: 90_000 });
        await expect(surface).toHaveAttribute("data-page", "home");
        await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
          timeout: 60_000,
        });

        // The connect must have persisted the remote as the active server.
        const readActiveServer = () =>
          page.evaluate(async () => {
            const localValue = localStorage.getItem("elizaos:active-server");
            if (localValue) return localValue;
            const preferences = (
              window as Window & {
                Capacitor?: {
                  Plugins?: {
                    Preferences?: {
                      get?: (args: {
                        key: string;
                      }) => Promise<{ value?: string | null }>;
                    };
                  };
                };
              }
            ).Capacitor?.Plugins?.Preferences;
            return (
              (
                await preferences?.get?.({
                  key: "elizaos:active-server",
                })
              )?.value ?? null
            );
          });
        await expect
          .poll(readActiveServer, {
            timeout: 30_000,
            message: "active-server persisted",
          })
          .toContain("127.0.0.1:31337");
        const activeServer = await readActiveServer();
        expect(activeServer).toBeTruthy();
        expect(activeServer).toContain('"kind":"remote"');

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
