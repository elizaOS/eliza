/**
 * Operator-driven Google sign-in checks on the real Android Play shell.
 * Authentication stays in the system browser while the app retains its PKCE
 * verifier in Keystore; only a genuine OS callback may return automatically,
 * activate the mobile credential, restore the same agent, and reach chat.
 * Browser authentication is deliberately excluded from recorded artifacts so
 * account details and credentials cannot enter CI evidence.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import { startChunkedAndroidScreenRecord } from "../../scripts/lib/android-capture.mjs";
import { APP_ID } from "../../scripts/lib/android-device.mjs";
import {
  assertLiveChallengeReply,
  buildLivenessChallenge,
  extractLivenessChallengeToken,
} from "../liveness-contract";
import { expect, ORIGIN, test } from "./android-harness";
import {
  type AndroidCloudResponseEvidence,
  applyAndroidCloudOnboardingDocumentBootstrap,
  buildAndroidCloudOnboardingBootstrapPlan,
  buildAndroidCloudOnboardingJpegArtifact,
  buildAndroidCloudResponseEvidence,
  extractAndroidCloudPkceHandoffEvidence,
  findAndroidGoogleProviderTapPoint,
  requirePhysicalAndroidDevice,
} from "./cloud-onboarding-evidence";
import {
  ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY,
  resumedAndroidActivityComponent,
} from "./resumed-android-activity";

const ARTIFACT_DIR = path.join(
  process.cwd(),
  "test-results",
  "android-cloud-onboarding",
);
const STALE_ACTIVE_SERVER = JSON.stringify({
  id: "local:android",
  kind: "remote",
  apiBase: "eliza-local-agent://ipc",
});

// The genuine callback exchange carries one-time codes and mobile credentials.
// Disable tracing so request bodies and URLs cannot serialize them; explicit
// artifacts begin only after the private system-browser step has completed.
test.use({ trace: "off" });

interface NativeCloudStateOptions {
  seedStaleLocalState?: boolean;
}

async function resetNativeCloudState(
  page: import("@playwright/test").Page,
  options: NativeCloudStateOptions = {},
) {
  await page.evaluate(
    async ({ seedStaleLocalState, staleActiveServer }) => {
      const plugins = (
        window as Window & {
          Capacitor?: {
            Plugins?: {
              ElizaSecureCredentials?: {
                remove(options: { slot: "pending_login" }): Promise<void>;
              };
              ElizaSecureStore?: {
                remove(options: {
                  key: "runtime.active_server" | "session.steward_token";
                }): Promise<{ error?: string; ok: boolean }>;
                set(options: {
                  key: "runtime.active_server";
                  value: string;
                }): Promise<{ error?: string; ok: boolean }>;
              };
              Preferences?: {
                clear(): Promise<void>;
                set(options: { key: string; value: string }): Promise<void>;
              };
            };
          };
        }
      ).Capacitor?.Plugins;
      const preferences = plugins?.Preferences;
      const pendingCredentials = plugins?.ElizaSecureCredentials;
      const secureStore = plugins?.ElizaSecureStore;
      if (!preferences || !pendingCredentials || !secureStore) {
        throw new Error("Android Cloud native reset plugins are unavailable");
      }

      await preferences.clear();
      await pendingCredentials.remove({ slot: "pending_login" });
      for (const key of [
        "runtime.active_server",
        "session.steward_token",
      ] as const) {
        const result = await secureStore.remove({ key });
        if (!result.ok && result.error !== "not_found") {
          throw new Error(`Android secure state reset failed for ${key}`);
        }
      }

      if (seedStaleLocalState) {
        const activeServerResult = await secureStore.set({
          key: "runtime.active_server",
          value: staleActiveServer,
        });
        if (!activeServerResult.ok) {
          throw new Error("Android stale active-server seed was rejected");
        }
        await preferences.set({
          key: "eliza:e2e-wallet:autologin",
          value: "1",
        });
        await preferences.set({
          key: "eliza:e2e-wallet:pk",
          value: "legacy-test-wallet-key",
        });
      }
    },
    {
      seedStaleLocalState: options.seedStaleLocalState === true,
      staleActiveServer: STALE_ACTIVE_SERVER,
    },
  );
}

async function loadFreshCloudAuthFirstScreen(
  page: import("@playwright/test").Page,
  options: NativeCloudStateOptions & { switchAccount?: boolean } = {},
) {
  await resetNativeCloudState(page, options);
  const bootstrap = buildAndroidCloudOnboardingBootstrapPlan(
    randomBytes(16).toString("hex"),
    { switchAccount: options.switchAccount },
  );
  // The exact helper is installed once per reset. Its unique URL token is
  // consumed and removed at document start, so older scripts retained by this
  // serial page and the successful credential reload are both inert.
  await page.addInitScript(
    applyAndroidCloudOnboardingDocumentBootstrap,
    bootstrap,
  );
  await page.goto(`${ORIGIN}${bootstrap.navigationPath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await expect(page.getByTestId("startup-shell-loading")).toContainText(
    "Opening secure sign in…",
    {
      timeout: 30_000,
    },
  );
}

async function closeBrowserAndExpectSignedOutRecovery(
  page: import("@playwright/test").Page,
  device: import("@playwright/test").AndroidDevice,
) {
  await page.evaluate(async () => {
    const browser = (
      window as Window & {
        Capacitor?: {
          Plugins?: { Browser?: { close?: () => Promise<void> } };
        };
      }
    ).Capacitor?.Plugins?.Browser;
    if (!browser?.close) {
      throw new Error("Android Browser.close is unavailable");
    }
    await browser.close();
  });
  await expect
    .poll(
      async () =>
        resumedAndroidActivityComponent(
          (await device.shell("dumpsys activity activities")).toString(),
        ),
      { timeout: 30_000 },
    )
    .toBe(`${APP_ID}/.MainActivity`);

  await expect(page.getByTestId("cloud-sign-in-recovery")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("heading", { name: "Sign in to Eliza Cloud" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in again" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await expect(page.getByTestId("home-launcher-surface")).toHaveCount(0);
}

function observeCloudResponses(page: import("@playwright/test").Page) {
  const responses: AndroidCloudResponseEvidence[] = [];
  page.on("response", (response) => {
    const evidence = buildAndroidCloudResponseEvidence(
      response.url(),
      response.request().method(),
      response.status(),
    );
    if (evidence) responses.push(evidence);
  });
  return responses;
}

function successfulPhaseCount(
  responses: readonly AndroidCloudResponseEvidence[],
  phase: AndroidCloudResponseEvidence["phase"],
): number {
  return responses.filter(
    (response) =>
      response.phase === phase &&
      response.status >= 200 &&
      response.status < 300,
  ).length;
}

async function attachJpeg(
  page: import("@playwright/test").Page,
  testInfo: import("@playwright/test").TestInfo,
  name: Parameters<typeof buildAndroidCloudOnboardingJpegArtifact>[1],
) {
  const artifact = buildAndroidCloudOnboardingJpegArtifact(
    path.join(ARTIFACT_DIR, "authenticated-browser-return"),
    name,
  );
  await page.screenshot(artifact.screenshot);
  await testInfo.attach(name, artifact.attachment);
}

test.describe
  .serial("Android Google Play Cloud sign-in", () => {
    test.skip(
      process.env.ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE !== "1",
      "Set ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE=1 to exercise the live Cloud sign-in handoff.",
    );

    test.beforeEach(async ({ device }, testInfo) => {
      const kernelQemuProperty = (
        await device.shell("getprop ro.kernel.qemu")
      ).toString();
      const receipt = requirePhysicalAndroidDevice(
        device.serial(),
        kernelQemuProperty,
      );
      await testInfo.attach("physical Android device receipt", {
        body: JSON.stringify(receipt, null, 2),
        contentType: "application/json",
      });
    });

    test("stale local and embedded-wallet state cannot bypass Cloud sign-in", async ({
      page,
      device,
    }, testInfo) => {
      await device.shell("logcat -c");

      await loadFreshCloudAuthFirstScreen(page, {
        seedStaleLocalState: true,
      });
      await expect(page.getByTestId("home-launcher-surface")).toHaveCount(0);
      await expect(page.getByText(/where should your agent run/i)).toHaveCount(
        0,
      );

      const packageState = (
        await device.shell("dumpsys package ai.elizaos.app")
      ).toString();
      expect(packageState).toContain(
        "android.permission.RECORD_AUDIO: granted=false",
      );

      await expect
        .poll(
          async () =>
            resumedAndroidActivityComponent(
              (await device.shell("dumpsys activity activities")).toString(),
            ),
          { timeout: 30_000 },
        )
        .toMatch(ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY);
      await closeBrowserAndExpectSignedOutRecovery(page, device);

      const screenshotPath = path.join(ARTIFACT_DIR, "play-signed-out.png");
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach("Play signed-out shell", {
        path: screenshotPath,
        contentType: "image/png",
      });
    });

    test("mobile-PKCE handoff closes into signed-out recovery", async ({
      page,
      device,
    }) => {
      await device.shell("logcat -c");
      await loadFreshCloudAuthFirstScreen(page);

      await expect
        .poll(
          async () =>
            extractAndroidCloudPkceHandoffEvidence(
              (await device.shell("logcat -d -v brief")).toString(),
            ),
          { timeout: 30_000 },
        )
        .toMatchObject({
          browserHost: "cloud.eliza.app",
          codeChallengeShapeValid: true,
          codeChallengeMethod: "S256",
          environment: "production",
          stateShapeValid: true,
        });

      await expect
        .poll(
          async () =>
            resumedAndroidActivityComponent(
              (await device.shell("dumpsys activity activities")).toString(),
            ),
          { timeout: 15_000 },
        )
        .toMatch(ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY);
      await closeBrowserAndExpectSignedOutRecovery(page, device);
    });

    test("Google returns by PKCE callback and reaches streamed chat", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(660_000);
      testInfo.annotations.push({
        type: "operator-action",
        description:
          "After the lane taps Google, complete the private test-account chooser without pressing Android Back.",
      });
      const evidenceResponses = observeCloudResponses(page);
      await device.shell("logcat -c");
      await loadFreshCloudAuthFirstScreen(page, { switchAccount: true });
      await attachJpeg(page, testInfo, "sign-in-greeting");

      await expect
        .poll(
          async () =>
            extractAndroidCloudPkceHandoffEvidence(
              (await device.shell("logcat -d -v brief")).toString(),
            ),
          { timeout: 30_000 },
        )
        .not.toBeNull();
      const handoff = extractAndroidCloudPkceHandoffEvidence(
        (await device.shell("logcat -d -v brief")).toString(),
      );
      if (!handoff) throw new Error("Mobile-PKCE browser handoff was not seen");
      expect(handoff.switchAccount).toBe(true);
      await testInfo.attach("mobile PKCE handoff receipt", {
        body: JSON.stringify(handoff, null, 2),
        contentType: "application/json",
      });

      await expect
        .poll(() => successfulPhaseCount(evidenceResponses, "mobile-config"), {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(1);
      await expect
        .poll(
          async () =>
            resumedAndroidActivityComponent(
              (await device.shell("dumpsys activity activities")).toString(),
            ),
          { timeout: 15_000 },
        )
        .toMatch(ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY);

      await expect
        .poll(
          async () => {
            const point = findAndroidGoogleProviderTapPoint(
              (await device.shell("uiautomator dump /dev/tty")).toString(),
            );
            return point ? { googleProviderAvailable: true } : null;
          },
          { timeout: 90_000 },
        )
        .not.toBeNull();
      const googleTapPoint = findAndroidGoogleProviderTapPoint(
        (await device.shell("uiautomator dump /dev/tty")).toString(),
      );
      if (!googleTapPoint) {
        throw new Error("Google was not available in the Android login picker");
      }
      await device.shell(`input tap ${googleTapPoint.x} ${googleTapPoint.y}`);
      await testInfo.attach("Google provider selection receipt", {
        body: JSON.stringify({ accessibilityTargetTapped: true }),
        contentType: "application/json",
      });

      // The operator completes the private Google account chooser. The test
      // never sends Back or foregrounds the package: only the genuine custom
      // scheme callback may make MainActivity resume and complete token/ACK.
      await expect
        .poll(
          async () =>
            resumedAndroidActivityComponent(
              (await device.shell("dumpsys activity activities")).toString(),
            ),
          { timeout: 360_000 },
        )
        .toBe(`${APP_ID}/.MainActivity`);

      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible({
        timeout: 180_000,
      });
      await expect(page.getByPlaceholder("Message Eliza")).toBeVisible();
      for (const phase of ["mobile-token", "mobile-ack"] as const) {
        await expect
          .poll(() => successfulPhaseCount(evidenceResponses, phase), {
            timeout: 30_000,
          })
          .toBeGreaterThanOrEqual(1);
      }
      await expect
        .poll(() => successfulPhaseCount(evidenceResponses, "personal-agent"), {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(1);

      // Recording starts only after authentication so account chooser, email,
      // credentials, callback parameters, and authorization codes stay private.
      const recording = await startChunkedAndroidScreenRecord({
        serial: device.serial(),
        artifactDir: path.join(ARTIFACT_DIR, "authenticated-browser-return"),
        filename: "cloud-onboarding-post-callback-chat.mp4",
        requireComplete: true,
      });
      let videoPath: string | null = null;
      try {
        await attachJpeg(page, testInfo, "home-landing");

        // A reload can only recover through the Keystore-backed credential
        // committed by mobile token/ACK; this guards persistence independently
        // of the first in-memory ready state and must restore Personal again.
        const personalAgentCountBeforeReload = successfulPhaseCount(
          evidenceResponses,
          "personal-agent",
        );
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await expect(
          page.getByRole("button", { name: "Sign out" }),
        ).toBeVisible({
          timeout: 90_000,
        });
        await expect
          .poll(
            () => successfulPhaseCount(evidenceResponses, "personal-agent"),
            { timeout: 30_000 },
          )
          .toBeGreaterThan(personalAgentCountBeforeReload);

        const challenge = buildLivenessChallenge(
          randomBytes(4).toString("hex"),
        );
        const challengeToken = extractLivenessChallengeToken(challenge);
        const composer = page.getByPlaceholder("Message Eliza");
        await composer.fill(challenge);
        const streamCountBeforeSend = successfulPhaseCount(
          evidenceResponses,
          "message-stream",
        );
        await page.getByRole("button", { name: /^Send$/ }).click();
        const userRow = page
          .locator("ol > li")
          .filter({ hasText: challenge })
          .last();
        await expect(userRow).toBeVisible();
        const assistantText = userRow
          .locator("xpath=following-sibling::li[1]")
          .locator("p");
        let reply: string | null = null;
        await expect
          .poll(
            async () => {
              let candidate: string | null = null;
              try {
                candidate = await assistantText.textContent();
              } catch {
                // error-policy:J4 A transiently detached streaming row remains
                // visibly pending until this bounded assertion poll expires.
              }
              try {
                reply = assertLiveChallengeReply(candidate, {
                  challengeToken,
                  label: "android-cloud-onboarding",
                });
              } catch {
                // error-policy:J3 Partial streamed text is explicitly not yet
                // a valid liveness reply; the bounded poll retries it.
                reply = null;
              }
              return reply;
            },
            { timeout: 300_000 },
          )
          .not.toBeNull();
        if (!reply) throw new Error("Cloud liveness reply was not captured");
        assertLiveChallengeReply(reply, {
          challengeToken,
          label: "android-cloud-onboarding",
        });

        await expect
          .poll(
            () => successfulPhaseCount(evidenceResponses, "message-stream"),
            { timeout: 30_000 },
          )
          .toBeGreaterThan(streamCountBeforeSend);
        await testInfo.attach("liveness receipt", {
          body: JSON.stringify({ matchedFreshChallenge: true }),
          contentType: "application/json",
        });
        await testInfo.attach("Cloud response evidence", {
          body: JSON.stringify(evidenceResponses, null, 2),
          contentType: "application/json",
        });
        await attachJpeg(page, testInfo, "reply-liveness");
      } finally {
        videoPath = await recording.stop();
        if (videoPath) {
          await testInfo.attach("post-callback chat walkthrough", {
            path: videoPath,
            contentType: "video/mp4",
          });
        }
      }

      if (!videoPath) {
        throw new Error(
          "Android Cloud onboarding passed without the required post-callback MP4",
        );
      }
    });
  });
