/**
 * Exercises fresh Android remote-connect onboarding through the real
 * Capacitor WebView and OS `appUrlOpen` ingress. The device reaches the host
 * agent through `adb reverse`, proves the post-onboarding home and composer,
 * then sends a chat turn. The default host is the deterministic UI-smoke
 * fixture; `ELIZA_ONBOARDING_LIVENESS=1` promotes the reply contract to a live,
 * non-stub model response.
 */
import path from "node:path";
import { startAndroidScreenRecord } from "../../scripts/lib/android-capture.mjs";
import {
  APP_ID,
  adbDevice,
  adbReverse,
  resolveAdb,
} from "../../scripts/lib/android-device.mjs";
import {
  assertOnboardingLiveness,
  STUB_FIXTURE_MARKER,
  sendChatAndReadReply,
} from "../liveness-contract";
import { expect, ORIGIN, test } from "./android-harness";

// When the host is a live-provider backend, the final onboarding turn must
// prove a real model answered. Off by default because the shared host agent is
// the deterministic stub.
const LIVENESS_ENABLED = process.env.ELIZA_ONBOARDING_LIVENESS === "1";

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
      let primaryFailure: unknown = null;
      let recordingFailure: unknown = null;

      try {
        // The product reset path owns shell-reserved storage and arms a
        // force-fresh restore before the deep link arrives.
        await page.goto(`${ORIGIN}/?reset`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });

        // Module-evaluation wiring queues links before React mounts, but the OS
        // intent must not outrun the native appUrlOpen registration itself. The
        // product publishes this state only after Capacitor acknowledges the
        // listener, making the device handoff a handshake rather than a delay.
        await expect
          .poll(
            () =>
              page.evaluate(
                () =>
                  document.documentElement.dataset.elizaMobileDeepLinkReady ??
                  "pending",
              ),
            {
              timeout: 30_000,
              message: "native deep-link ingress registration",
            },
          )
          .not.toBe("pending");
        expect(
          await page.evaluate(
            () =>
              document.documentElement.dataset.elizaMobileDeepLinkReady ??
              "pending",
          ),
        ).toBe("ready");
        const ingressCountBefore = await page.evaluate(() =>
          Number(
            document.documentElement.dataset.elizaMobileDeepLinkCount ?? "0",
          ),
        );
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

        await expect
          .poll(
            () =>
              page.evaluate(() =>
                Number(
                  document.documentElement.dataset.elizaMobileDeepLinkCount ??
                    "0",
                ),
              ),
            {
              timeout: 15_000,
              message: "native appUrlOpen delivery receipt",
            },
          )
          .toBeGreaterThan(ingressCountBefore);

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
            "stub-backed host must render its deterministic reply",
          ).toContain(STUB_FIXTURE_MARKER);
          await testInfo.attach("liveness reply (stub-backed)", {
            body: stubReply,
            contentType: "text/plain",
          });
        }
      } catch (error) {
        primaryFailure = error;
        const diagnosticScreenshot = path.join(
          ARTIFACT_DIR,
          "onboarding-failure.png",
        );
        const [stateResult, screenshotResult] = await Promise.allSettled([
          page.evaluate(() => {
            const globalObject = globalThis as typeof globalThis & {
              __ELIZAOS_UI_APP_STORE__?: {
                value?: {
                  actionNotice?: unknown;
                  firstRunComplete?: unknown;
                  firstRunRemoteConnected?: unknown;
                  firstRunRemoteError?: unknown;
                  firstRunRuntimeTarget?: unknown;
                  startupCoordinator?: {
                    phase?: unknown;
                    state?: unknown;
                  };
                  startupError?: unknown;
                } | null;
              };
            };
            const state = globalObject.__ELIZAOS_UI_APP_STORE__?.value;
            return {
              actionNotice: state?.actionNotice ?? null,
              firstRunComplete: state?.firstRunComplete ?? null,
              firstRunRemoteConnected: state?.firstRunRemoteConnected ?? null,
              firstRunRemoteError: state?.firstRunRemoteError ?? null,
              firstRunRuntimeTarget: state?.firstRunRuntimeTarget ?? null,
              startupCoordinator: state?.startupCoordinator
                ? {
                    phase: state.startupCoordinator.phase ?? null,
                    state: state.startupCoordinator.state ?? null,
                  }
                : null,
              startupError: state?.startupError ?? null,
              ingress: {
                count:
                  document.documentElement.dataset.elizaMobileDeepLinkCount ??
                  null,
                ready:
                  document.documentElement.dataset.elizaMobileDeepLinkReady ??
                  null,
              },
              surfaces: {
                composer: Boolean(
                  document.querySelector(
                    '[data-testid="chat-composer-textarea"]',
                  ),
                ),
                firstRun: Boolean(
                  document.querySelector(
                    '[data-testid="first-run-chat"], [data-testid="startup-first-run-background"]',
                  ),
                ),
                home: Boolean(
                  document.querySelector(
                    '[data-testid="home-launcher-surface"]',
                  ),
                ),
              },
            };
          }),
          page.screenshot({
            path: diagnosticScreenshot,
            fullPage: true,
          }),
        ]);
        const diagnostic = {
          capturedAt: new Date().toISOString(),
          failure: error instanceof Error ? error.message : String(error),
          state:
            stateResult.status === "fulfilled"
              ? stateResult.value
              : { captureError: String(stateResult.reason) },
          screenshot:
            screenshotResult.status === "fulfilled"
              ? "captured"
              : { captureError: String(screenshotResult.reason) },
        };
        const attachments: Promise<unknown>[] = [
          testInfo.attach("onboarding failure diagnostics", {
            body: JSON.stringify(diagnostic, null, 2),
            contentType: "application/json",
          }),
        ];
        if (screenshotResult.status === "fulfilled") {
          attachments.push(
            testInfo.attach("onboarding failure screenshot", {
              path: diagnosticScreenshot,
              contentType: "image/png",
            }),
          );
        }
        await Promise.allSettled(attachments);
      } finally {
        const [stopResult] = await Promise.allSettled([recording.stop()]);
        if (stopResult.status === "fulfilled") {
          await Promise.allSettled([
            testInfo.attach("onboarding walkthrough video", {
              path: stopResult.value,
              contentType: "video/mp4",
            }),
          ]);
        } else {
          await Promise.allSettled([
            testInfo.attach("onboarding recording failure", {
              body:
                stopResult.reason instanceof Error
                  ? stopResult.reason.message
                  : String(stopResult.reason),
              contentType: "text/plain",
            }),
          ]);
          recordingFailure = stopResult.reason;
        }
      }
      if (primaryFailure !== null) throw primaryFailure;
      if (recordingFailure !== null) throw recordingFailure;
    });
  });
