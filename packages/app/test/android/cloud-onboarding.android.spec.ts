/**
 * Production Google Play Cloud sign-in checks on the real Android WebView.
 *
 * The Play shell deliberately has no embedded wallet, private-key autologin,
 * local-agent setup, or in-WebView account authentication. Authentication is
 * delegated to the system browser through a short-lived Cloud CLI session.
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
  buildAndroidCloudLoginCompletionRequest,
  buildAndroidCloudOnboardingJpegArtifact,
  extractAndroidCloudLoginHandoff,
  isTrustedAndroidCloudResponseUrl,
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

// This live lane passes a credential to the Cloud completion endpoint. Disable
// Playwright tracing so evaluation/network metadata cannot serialize it; the
// required review artifacts are the explicit JPG and Android MP4 captures.
test.use({ trace: "off" });

async function clearBrowserState(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    localStorage.clear();
    const plugins = (
      window as Window & {
        Capacitor?: {
          Plugins?: {
            Preferences?: { clear(): Promise<void> };
          };
        };
      }
    ).Capacitor?.Plugins;
    if (!plugins?.Preferences) {
      throw new Error("Android Cloud Preferences plugin is unavailable");
    }
    await plugins.Preferences.clear();
  });
}

async function seedStaleBrowserState(page: import("@playwright/test").Page) {
  // Reserved shell keys are realm-guarded after the renderer boots. Seed the
  // adversarial legacy state at document start so this exercises hydration
  // instead of being rejected by the view-storage facade before navigation.
  await page.addInitScript(() => {
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "local:android",
        kind: "remote",
        apiBase: "eliza-local-agent://ipc",
      }),
    );
    localStorage.setItem("eliza:e2e-wallet:autologin", "1");
    localStorage.setItem("eliza:e2e-wallet:pk", "legacy-test-wallet-key");
  });
}

async function loadSignedOutShell(page: import("@playwright/test").Page) {
  await page.goto(`${ORIGIN}/?androidPlayCloudSignIn=1`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await expect(page.getByRole("heading", { name: "Eliza" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: /^Sign in$/ })).toBeVisible();
}

interface CloudResponseEvidence {
  method: string;
  pathname: string;
  status: number;
}

function observeCloudResponses(page: import("@playwright/test").Page) {
  const responses: CloudResponseEvidence[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!isTrustedAndroidCloudResponseUrl(url)) return;
    responses.push({
      method: response.request().method(),
      pathname: url.pathname,
      status: response.status(),
    });
  });
  return responses;
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

    test("stale local and embedded-wallet state cannot bypass Cloud sign-in", async ({
      page,
      device,
    }, testInfo) => {
      await clearBrowserState(page);
      await seedStaleBrowserState(page);

      await loadSignedOutShell(page);
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

      const screenshotPath = path.join(ARTIFACT_DIR, "play-signed-out.png");
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await testInfo.attach("Play signed-out shell", {
        path: screenshotPath,
        contentType: "image/png",
      });
    });

    test("browser-handoff smoke creates a short-lived Cloud session and opens the system browser", async ({
      page,
      device,
    }) => {
      await clearBrowserState(page);
      await loadSignedOutShell(page);
      await device.shell("logcat -c");

      await page.getByRole("button", { name: /^Sign in$/ }).click();
      await expect(
        page.getByRole("button", { name: "Cancel sign-in" }),
      ).toBeVisible({ timeout: 30_000 });

      await expect
        .poll(
          async () => (await device.shell("logcat -d -v brief")).toString(),
          { timeout: 30_000 },
        )
        .toMatch(
          /pluginId: Browser[\s\S]*https:\\?\/\\?\/cloud\.eliza\.app\\?\/auth\\?\/cli-login\?session=[0-9a-f-]{36}/i,
        );

      await expect
        .poll(
          async () =>
            resumedAndroidActivityComponent(
              (await device.shell("dumpsys activity activities")).toString(),
            ),
          { timeout: 15_000 },
        )
        .toMatch(ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY);

      await device.shell("input keyevent BACK");
      await page.getByRole("button", { name: "Cancel sign-in" }).click();
      await expect(
        page.getByRole("button", { name: /^Sign in$/ }),
      ).toBeVisible();
    });

    test("authenticated browser return provisions Cloud and reaches live chat", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(420_000);
      const authToken = process.env.ELIZA_CLOUD_AUTH_TOKEN;
      // Resolve before recording or navigation so a misconfigured operator run
      // fails visibly without producing evidence that looks like a live pass.
      buildAndroidCloudLoginCompletionRequest(
        {
          browserUrl:
            "https://cloud.eliza.app/auth/cli-login?session=123e4567-e89b-42d3-a456-426614174000",
          sessionId: "123e4567-e89b-42d3-a456-426614174000",
          apiBase: "https://api.eliza.app",
        },
        authToken,
      );

      const evidenceResponses = observeCloudResponses(page);
      const recording = await startChunkedAndroidScreenRecord({
        serial: device.serial(),
        artifactDir: path.join(ARTIFACT_DIR, "authenticated-browser-return"),
        filename: "cloud-onboarding-authenticated-browser-return.mp4",
        requireComplete: true,
      });
      let videoPath: string | null = null;

      try {
        await clearBrowserState(page);
        await loadSignedOutShell(page);
        await attachJpeg(page, testInfo, "sign-in-greeting");
        await device.shell("logcat -c");

        await page.getByRole("button", { name: /^Sign in$/ }).click();
        await expect(
          page.getByRole("button", { name: "Cancel sign-in" }),
        ).toBeVisible({ timeout: 30_000 });

        let handoff: ReturnType<typeof extractAndroidCloudLoginHandoff> = null;
        await expect
          .poll(
            async () => {
              handoff = extractAndroidCloudLoginHandoff(
                (await device.shell("logcat -d -v brief")).toString(),
              );
              return handoff;
            },
            { timeout: 30_000 },
          )
          .not.toBeNull();
        if (!handoff) throw new Error("Cloud browser handoff was not captured");

        await expect
          .poll(
            async () =>
              resumedAndroidActivityComponent(
                (await device.shell("dumpsys activity activities")).toString(),
              ),
            { timeout: 15_000 },
          )
          .toMatch(ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY);

        const completion = buildAndroidCloudLoginCompletionRequest(
          handoff,
          authToken,
        );
        const completionResponse = await fetch(completion.url, completion.init);
        if (!completionResponse.ok) {
          throw new Error(
            `Cloud login completion failed (${completionResponse.status})`,
          );
        }

        // Return from the authenticated system-browser handoff. Foregrounding
        // the app is required on devices that suspend WebView timers while the
        // Custom Tab owns the resumed activity; the resumed poll must then
        // consume this exact completed session and close the browser adapter.
        await device.shell("input keyevent BACK");
        await expect
          .poll(
            async () =>
              resumedAndroidActivityComponent(
                (await device.shell("dumpsys activity activities")).toString(),
              ),
            { timeout: 30_000 },
          )
          .toBe(`${APP_ID}/.MainActivity`);

        await expect(
          page.getByRole("button", { name: "Sign out" }),
        ).toBeVisible({
          timeout: 180_000,
        });
        await expect(page.getByPlaceholder("Message Eliza")).toBeVisible();
        await expect
          .poll(
            () =>
              evidenceResponses.filter(
                (response) =>
                  response.method === "GET" &&
                  response.pathname === "/api/v1/eliza/personal" &&
                  response.status === 200,
              ).length,
            { timeout: 30_000 },
          )
          .toBeGreaterThanOrEqual(1);

        await attachJpeg(page, testInfo, "home-landing");

        // A reload can only recover through the Keystore-backed credential
        // written by pollLogin; this guards token persistence independently of
        // the first in-memory ready state.
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await expect(
          page.getByRole("button", { name: "Sign out" }),
        ).toBeVisible({
          timeout: 90_000,
        });
        await expect
          .poll(
            () =>
              evidenceResponses.filter(
                (response) =>
                  response.method === "GET" &&
                  response.pathname === "/api/v1/eliza/personal" &&
                  response.status === 200,
              ).length,
            { timeout: 30_000 },
          )
          .toBeGreaterThanOrEqual(2);

        const challenge = buildLivenessChallenge(
          randomBytes(4).toString("hex"),
        );
        const challengeToken = extractLivenessChallengeToken(challenge);
        const composer = page.getByPlaceholder("Message Eliza");
        await composer.fill(challenge);
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
              const candidate = await assistantText
                .textContent()
                .catch(() => null);
              try {
                reply = assertLiveChallengeReply(candidate, {
                  challengeToken,
                  label: "android-cloud-onboarding",
                });
              } catch {
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
            () =>
              evidenceResponses.some(
                (response) =>
                  response.method === "POST" &&
                  /\/api\/conversations\/[^/]+\/messages$/.test(
                    response.pathname,
                  ) &&
                  response.status >= 200 &&
                  response.status < 300,
              ),
            { timeout: 30_000 },
          )
          .toBe(true);
        await testInfo.attach("liveness reply", {
          body: reply,
          contentType: "text/plain",
        });
        await testInfo.attach("Cloud response evidence", {
          body: JSON.stringify(evidenceResponses, null, 2),
          contentType: "application/json",
        });
        await attachJpeg(page, testInfo, "reply-liveness");
      } finally {
        videoPath = await recording.stop();
        if (videoPath) {
          await testInfo.attach("authenticated browser return walkthrough", {
            path: videoPath,
            contentType: "video/mp4",
          });
        }
      }

      if (!videoPath) {
        throw new Error(
          "Android Cloud onboarding passed without the required MP4 walkthrough",
        );
      }
    });
  });
