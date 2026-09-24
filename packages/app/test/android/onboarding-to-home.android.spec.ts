/**
 * Drives installed Android remote pairing and chat through the real host runtime
 * and HTTP API. The default host uses deterministic inference responses; this
 * is product-flow coverage, not evidence of live model quality. Device execution
 * and migration of host responses to strict scenario fixtures remain required.
 */

import path from "node:path";
import { testOutputPath } from "../../../scripts/lib/test-output.mjs";
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

// Optional live-provider runs use the same UI path with their own inference source.
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

async function readHostPairingCode(): Promise<string> {
  const response = await fetch(
    `http://127.0.0.1:${HOST_AGENT_PORT}/api/auth/pair-code`,
  );
  if (!response.ok) {
    throw new Error(
      `Host pairing-code request failed (${response.status}): ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { code?: unknown };
  if (typeof body.code !== "string" || !body.code.trim()) {
    throw new Error("Host pairing-code response did not contain a code.");
  }
  return body.code;
}
const ARTIFACT_DIR = path.join(
  process.env.ELIZA_ANDROID_ARTIFACT_DIR ?? testOutputPath("app", "android"),
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

        // OS deep links deliberately never carry bearer credentials. Complete
        // the production remote-device pairing flow against the real host,
        // obtaining the short-lived code through its loopback-only operator
        // endpoint and entering it through the rendered device UI.
        const pairingInput = page.getByPlaceholder("Enter pairing code");
        await expect(pairingInput).toBeVisible({ timeout: 60_000 });
        await pairingInput.fill(await readHostPairingCode());
        await page.getByRole("button", { name: "Submit" }).click();

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

        // The final chat turn must traverse the connected host and render its reply.
        if (LIVENESS_ENABLED) {
          const reply = await assertOnboardingLiveness(page, {
            label: "android-onboarding",
          });
          await testInfo.attach("liveness reply (real model)", {
            body: reply,
            contentType: "text/plain",
          });
        } else {
          const fixtureReply = await sendChatAndReadReply(page, {
            label: "android-onboarding",
          });
          expect(
            fixtureReply,
            "connected host must render its deterministic device-e2e reply",
          ).toContain("STREAM_E2E_OK");
          await testInfo.attach("chat reply (deterministic inference)", {
            body: fixtureReply,
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
