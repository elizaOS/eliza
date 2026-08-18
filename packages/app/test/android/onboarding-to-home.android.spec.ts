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
// The deterministic host agent binds a kernel-assigned host port and is
// exposed on a non-reserved device loopback port through `adb reverse`;
// loopback needs no confirm prompt.
//
// Liveness contract (#14359): this lane is STUB-BACKED by default — the host
// agent is the deterministic ui-smoke stub, so a "real model" reply cannot be
// asserted and the lane ends by proving the stub reply renders. Point the host
// at a live-provider backend and set `ELIZA_ONBOARDING_LIVENESS=1` to promote
// the final turn to the shared liveness assertion (non-empty, non-stub reply).
import path from "node:path";
import { startAndroidScreenRecord } from "../../scripts/lib/android-capture.mjs";
import {
  APP_ID,
  adbDevice,
  adbReverse,
  resolveAdb,
} from "../../scripts/lib/android-device.mjs";
import { parsePort } from "../../scripts/lib/host-agent.mjs";
import {
  assertOnboardingLiveness,
  sendChatAndReadReply,
} from "../liveness-contract";
import { expect, ORIGIN, test } from "./android-harness";

// When the host is a live-provider backend, the final onboarding turn must
// prove a real model answered. Off by default because the shared host agent is
// the deterministic stub.
const LIVENESS_ENABLED = process.env.ELIZA_ONBOARDING_LIVENESS === "1";

const HOST_AGENT_PORT = parsePort(
  process.env.ELIZA_ANDROID_HOST_AGENT_PORT ?? "31337",
  "ELIZA_ANDROID_HOST_AGENT_PORT",
);
// Android reserves loopback:31337 for the bundled local agent. Expose the host
// on a distinct device port so remote adoption exercises HTTP through adb
// reverse instead of being classified as local IPC.
const DEVICE_REMOTE_PORT = 31338;
const HOST_AGENT_BASE = `http://127.0.0.1:${DEVICE_REMOTE_PORT}`;
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
      // The device-side remote port must reach the host's deterministic agent.
      adbReverse(adbBin, serial, DEVICE_REMOTE_PORT, HOST_AGENT_PORT);

      const recording = await startAndroidScreenRecord({
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "onboarding-to-home.mp4",
        remotePath: "/sdcard/eliza-onboarding-to-home.mp4",
      });

      try {
        // The command clears Android app data before launch, so both WebView
        // storage and Capacitor Preferences start from a real first-run state.
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
          .toContain(HOST_AGENT_BASE);
        const activeServer = await readActiveServer();
        expect(activeServer).toBeTruthy();
        expect(activeServer).toContain('"kind":"remote"');

        const screenshotPath = path.join(ARTIFACT_DIR, "home-landing.png");
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await testInfo.attach("home landing screenshot", {
          path: screenshotPath,
          contentType: "image/png",
        });

        // Every onboarding lane ends with the liveness contract (#14359): send a
        // real chat turn. Against a live-provider host it must be a real
        // (non-stub) reply; against the default deterministic host it must be the
        // stub fixture (proving the connected agent actually answers, without
        // claiming a real model).
        if (LIVENESS_ENABLED) {
          const reply = await assertOnboardingLiveness(page, {
            label: "android-onboarding",
          });
          await testInfo.attach("liveness reply (real model)", {
            body: reply,
            contentType: "text/plain",
          });
        } else {
          const stubReply = await sendChatAndReadReply(page, {
            label: "android-onboarding",
          });
          expect(
            stubReply,
            "stub-backed host must render its deterministic device-e2e reply",
          ).toContain("STREAM_E2E_OK");
          await testInfo.attach("liveness reply (stub-backed)", {
            body: stubReply,
            contentType: "text/plain",
          });
        }
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
