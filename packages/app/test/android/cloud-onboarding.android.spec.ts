/**
 * Proves authenticated Google Play Cloud chat in the real Android WebView.
 *
 * The opt-in lane accepts only the documented device Cloud bearer, writes it
 * through the app's Keystore-backed credential bridge, and requires a live
 * run-bound reply plus reload persistence. Playwright tracing stays disabled
 * because evaluation arguments can contain the bearer.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import { startChunkedAndroidScreenRecord } from "../../scripts/lib/android-capture.mjs";
import { expect, ORIGIN, test } from "./android-harness";
import { buildAndroidCloudOnboardingJpegArtifact } from "./cloud-onboarding-evidence";

const ARTIFACT_DIR = path.join(
  process.cwd(),
  "test-results",
  "android-cloud-onboarding",
);

test.use({ trace: "off" });

async function writeSecureCredential(
  page: import("@playwright/test").Page,
  token: string,
) {
  await page.evaluate(async (value) => {
    const plugins = (
      window as Window & {
        Capacitor?: {
          Plugins?: {
            ElizaSecureCredentials?: {
              set(options: { value: string }): Promise<void>;
            };
          };
        };
      }
    ).Capacitor?.Plugins;
    if (!plugins?.ElizaSecureCredentials) {
      throw new Error("Android Keystore credential bridge is unavailable");
    }
    await plugins.ElizaSecureCredentials.set({ value });
  }, token);
}

async function removeSecureCredential(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const plugin = (
      window as Window & {
        Capacitor?: {
          Plugins?: {
            ElizaSecureCredentials?: { remove(): Promise<void> };
          };
        };
      }
    ).Capacitor?.Plugins?.ElizaSecureCredentials;
    await plugin?.remove();
  });
}

async function readCredentialPlacement(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const plugins = (
      window as Window & {
        Capacitor?: {
          Plugins?: {
            Preferences?: {
              get(options: { key: string }): Promise<{ value: string | null }>;
            };
            ElizaSecureCredentials?: {
              get(): Promise<{ value: string | null }>;
            };
          };
        };
      }
    ).Capacitor?.Plugins;
    if (!plugins?.Preferences || !plugins.ElizaSecureCredentials) {
      throw new Error("Android Cloud credential plugins are unavailable");
    }
    const [preference, secure] = await Promise.all([
      plugins.Preferences.get({ key: "steward_session_token" }),
      plugins.ElizaSecureCredentials.get(),
    ]);
    return {
      localStoragePresent: Boolean(
        localStorage.getItem("steward_session_token"),
      ),
      preferencePresent: Boolean(preference.value),
      securePresent: Boolean(secure.value?.trim()),
    };
  });
}

test.describe
  .serial("Android Google Play authenticated Cloud onboarding", () => {
    test.skip(
      process.env.ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE !== "1",
      "Set ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE=1 to run the real Cloud device lane.",
    );

    test("restores a Keystore session, chats, and restores the reply after reload", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(420_000);
      const cloudToken = process.env.ELIZA_CLOUD_AUTH_TOKEN?.trim();
      expect(
        cloudToken,
        "ELIZA_CLOUD_AUTH_TOKEN is required by the documented real Cloud device lane",
      ).toBeTruthy();

      const recording = await startChunkedAndroidScreenRecord({
        serial: device.serial(),
        artifactDir: ARTIFACT_DIR,
        filename: "cloud-onboarding-authenticated.mp4",
        requireComplete: true,
      });
      let videoPath: string | null = null;

      try {
        await writeSecureCredential(page, cloudToken as string);
        await page.goto(`${ORIGIN}/?androidCloudAuthenticatedE2E=1`, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });

        await expect(page.getByPlaceholder("Message Eliza")).toBeVisible({
          timeout: 150_000,
        });
        await expect(
          page.getByRole("button", { name: "Sign out" }),
        ).toBeVisible();
        await expect(readCredentialPlacement(page)).resolves.toEqual({
          localStoragePresent: false,
          preferencePresent: false,
          securePresent: true,
        });

        const homeArtifact = buildAndroidCloudOnboardingJpegArtifact(
          ARTIFACT_DIR,
          "home-landing",
        );
        await page.screenshot(homeArtifact.screenshot);
        await testInfo.attach("authenticated home", homeArtifact.attachment);

        const challenge = `ANDROID_CLOUD_E2E_${randomBytes(5)
          .toString("hex")
          .toUpperCase()}`;
        await page
          .getByPlaceholder("Message Eliza")
          .fill(`Reply with exactly ${challenge} and no other text.`);
        await page.getByRole("button", { name: "Send" }).click();

        const assistantReply = page
          .getByRole("button", { name: "Play" })
          .last()
          .locator("..");
        await expect(assistantReply).toContainText(challenge, {
          timeout: 300_000,
        });

        const replyArtifact = buildAndroidCloudOnboardingJpegArtifact(
          ARTIFACT_DIR,
          "reply-liveness",
        );
        await page.screenshot(replyArtifact.screenshot);
        await testInfo.attach(
          "run-bound Cloud reply",
          replyArtifact.attachment,
        );

        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await expect(page.getByPlaceholder("Message Eliza")).toBeVisible({
          timeout: 150_000,
        });
        await expect(
          page.getByRole("button", { name: "Play" }).last().locator(".."),
        ).toContainText(challenge, { timeout: 150_000 });
      } finally {
        videoPath = await recording.stop();
        try {
          await removeSecureCredential(page);
        } catch (error) {
          // error-policy:J6 cleanup failure is reported without hiding the
          // authoritative test result or exposing credential contents.
          console.warn("Android Cloud credential cleanup failed", error);
        }
        if (videoPath) {
          await testInfo.attach("authenticated Cloud walkthrough", {
            path: videoPath,
            contentType: "video/mp4",
          });
        }
      }

      if (!videoPath) {
        throw new Error(
          "Android Cloud onboarding passed without a complete MP4 walkthrough",
        );
      }
    });
  });
