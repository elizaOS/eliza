/**
 * Exercises fresh Android remote-connect onboarding through the real
 * Capacitor WebView and OS `appUrlOpen` ingress. The device reaches the host
 * agent through `adb reverse`, proves the post-onboarding home and composer,
 * then force-stops the app to verify the remote target survives a cold restore
 * before sending another chat turn. The default host is the deterministic
 * UI-smoke fixture; `ELIZA_ONBOARDING_LIVENESS=1` promotes the reply contract
 * to a live, non-stub model response.
 */
import path from "node:path";
import type { AndroidDevice, Page } from "@playwright/test";
import { startChunkedAndroidScreenRecord } from "../../scripts/lib/android-capture.mjs";
import {
  APP_ID,
  adbDevice,
  adbReverse,
  MAIN_ACTIVITY,
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

async function waitForRelaunchedPage(
  device: AndroidDevice,
  previousPage: Page,
): Promise<Page> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const webView = device
      .webViews()
      .find((candidate) => candidate.pkg() === APP_ID);
    if (webView) {
      try {
        const candidate = await webView.page();
        if (candidate !== previousPage && !candidate.isClosed()) {
          return candidate;
        }
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Relaunched ${APP_ID} WebView did not become attachable: ${lastError instanceof Error ? lastError.message : String(lastError ?? "no WebView target")}`,
  );
}

async function ensureHostFirstRunComplete(): Promise<void> {
  const headers = { "X-ElizaOS-Client-Id": "android-onboarding" };

  const readCompletion = async (): Promise<boolean> => {
    const [statusResponse, configResponse] = await Promise.all([
      fetch(`${HOST_AGENT_BASE}/api/first-run/status`, { headers }),
      fetch(`${HOST_AGENT_BASE}/api/config`, { headers }),
    ]);
    if (!statusResponse.ok) {
      throw new Error(
        `Host first-run status failed: ${statusResponse.status} ${statusResponse.statusText}`,
      );
    }
    if (!configResponse.ok) {
      throw new Error(
        `Host live config failed: ${configResponse.status} ${configResponse.statusText}`,
      );
    }
    const status: unknown = await statusResponse.json();
    if (
      typeof status !== "object" ||
      status === null ||
      !("complete" in status) ||
      typeof status.complete !== "boolean"
    ) {
      throw new Error("Host first-run status returned an invalid payload");
    }
    const config: unknown = await configResponse.json();
    if (typeof config !== "object" || config === null) {
      throw new Error("Host live config returned an invalid payload");
    }
    const meta = "meta" in config ? config.meta : null;
    const liveComplete =
      typeof meta === "object" &&
      meta !== null &&
      "firstRunComplete" in meta &&
      meta.firstRunComplete === true;
    return status.complete && liveComplete;
  };

  if (await readCompletion()) return;

  const completeResponse = await fetch(`${HOST_AGENT_BASE}/api/first-run`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Android Onboarding Host" }),
  });
  if (!completeResponse.ok) {
    throw new Error(
      `Host first-run completion failed: ${completeResponse.status} ${completeResponse.statusText}`,
    );
  }

  // The route's 200 only acknowledges request handling. Require the durable
  // status and live config mirror to agree; a rejected internal config write
  // must never masquerade as a completed host.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await readCompletion()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "Host first-run completion was not observable after the completion write",
  );
}

test.describe
  .serial("android remote-connect onboarding via deep link (real WebView)", () => {
    test("fresh first-run deep link connects to a host agent and lands on home", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(300_000);

      const adbBin = resolveAdb();
      const serial = device.serial();
      // The device's 127.0.0.1:31337 must reach the host's deterministic agent.
      adbReverse(adbBin, serial, 31337);
      await ensureHostFirstRunComplete();

      const recording = await startChunkedAndroidScreenRecord({
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "onboarding-to-home.mp4",
      });
      let primaryFailure: unknown = null;
      let recordingFailure: unknown = null;
      let diagnosticPage = page;

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

        // Kill the app process and attach to the newly-created WebView so the
        // persisted remote target crosses the same cold restore boundary a
        // real subsequent launch uses. URL shape alone cannot identify the
        // bundled agent because adb reverse deliberately makes a host remote
        // available at loopback:31337 too.
        adbDevice(adbBin, serial, ["shell", "am", "force-stop", APP_ID]);
        adbDevice(adbBin, serial, [
          "shell",
          "am",
          "start",
          "-W",
          "-n",
          MAIN_ACTIVITY,
        ]);
        const relaunchedPage = await waitForRelaunchedPage(device, page);
        diagnosticPage = relaunchedPage;
        await relaunchedPage.waitForLoadState("domcontentloaded");
        await expect(
          relaunchedPage.getByTestId("home-launcher-surface"),
        ).toBeVisible({ timeout: 90_000 });
        await expect(
          relaunchedPage.getByTestId("chat-composer-textarea"),
        ).toBeVisible({ timeout: 60_000 });

        const readRestoredState = () =>
          relaunchedPage.evaluate(() => {
            const globalObject = globalThis as typeof globalThis & {
              __ELIZAOS_UI_APP_STORE__?: {
                value?: {
                  firstRunComplete?: unknown;
                  startupCoordinator?: { phase?: unknown };
                } | null;
              };
            };
            return {
              activeServer: localStorage.getItem("elizaos:active-server"),
              firstRunComplete:
                globalObject.__ELIZAOS_UI_APP_STORE__?.value
                  ?.firstRunComplete ?? null,
              mode: localStorage.getItem("eliza:mobile-runtime-mode"),
              phase:
                globalObject.__ELIZAOS_UI_APP_STORE__?.value?.startupCoordinator
                  ?.phase ?? null,
            };
          });
        await expect
          .poll(
            async () => {
              const state = await readRestoredState();
              return (
                state.firstRunComplete === true &&
                state.mode === "remote-mac" &&
                state.phase === "ready"
              );
            },
            {
              timeout: 90_000,
              message: "cold relaunch restores the remote first-run session",
            },
          )
          .toBe(true);
        const restoredState = await readRestoredState();
        expect(restoredState.activeServer).toContain('"kind":"remote"');
        expect(restoredState.activeServer).toContain("127.0.0.1:31337");

        const relaunchScreenshotPath = path.join(
          ARTIFACT_DIR,
          "home-after-cold-relaunch.png",
        );
        await relaunchedPage.screenshot({
          path: relaunchScreenshotPath,
          fullPage: true,
        });
        await testInfo.attach("home after cold relaunch screenshot", {
          path: relaunchScreenshotPath,
          contentType: "image/png",
        });

        if (LIVENESS_ENABLED) {
          const reply = await assertOnboardingLiveness(relaunchedPage, {
            label: "android-onboarding-cold-relaunch",
          });
          await testInfo.attach("cold relaunch liveness reply (real model)", {
            body: reply,
            contentType: "text/plain",
          });
        } else {
          const reply = await sendChatAndReadReply(relaunchedPage, {
            label: "android-onboarding-cold-relaunch",
          });
          expect(reply).toContain(STUB_FIXTURE_MARKER);
          await testInfo.attach("cold relaunch liveness reply (stub-backed)", {
            body: reply,
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
          diagnosticPage.evaluate(() => {
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
          diagnosticPage.screenshot({
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
