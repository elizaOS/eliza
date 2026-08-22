/**
 * Proves the shipped Android Capacitor shell has no native WebAuthn bridge.
 * The real-device harness requires Cloud sign-in to use the external device
 * flow and rejects any invocation of browser credential APIs.
 */
import path from "node:path";
import { startAndroidScreenRecord } from "../../scripts/lib/android-capture.mjs";
import { expect, ORIGIN, test } from "./android-harness";
import {
  ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY,
  resumedAndroidActivityComponent,
} from "./resumed-android-activity";

const ARTIFACT_DIR = path.join(
  process.cwd(),
  "test-results",
  "android-passkey-degrade",
);

const RESET_KEYS = [
  "eliza:first-run-complete",
  "eliza:onboarding-complete",
  "eliza:setup:step",
  "eliza:mobile-runtime-mode",
  "elizaos:active-server",
  "steward_session_token",
  "eliza:first-run:cloud-resume",
  "elizaos:first-run:force-fresh",
  // A seeded e2e SIWE wallet would hijack the sign-in tap into wallet login;
  // this lane must observe the plain device-code path.
  "eliza:e2e-wallet:pk",
  "eliza:e2e-wallet:autologin",
];

interface PasskeyDegradeProbe {
  webauthnCalls: number;
}

test("native sign-in routes to the external device-code flow with zero WebAuthn invocations", async ({
  page,
  device,
}, testInfo) => {
  test.setTimeout(240_000);

  // Clear the persisted auth/first-run state (Capacitor Preferences survives
  // WebView navigations and would otherwise restore a signed-in session).
  await page.evaluate(async () => {
    const preferences = (
      window as Window & {
        Capacitor?: {
          Plugins?: {
            Preferences?: {
              clear(): Promise<void>;
            };
          };
        };
      }
    ).Capacitor?.Plugins?.Preferences;
    if (!preferences) {
      throw new Error("Capacitor Preferences plugin is unavailable");
    }
    await preferences.clear();
  });

  // Reserved shell keys are realm-guarded once the app boots, so the
  // localStorage reset must run at document start on the next navigation.
  await page.addInitScript((resetKeys) => {
    for (const key of resetKeys) {
      localStorage.removeItem(key);
    }
  }, RESET_KEYS);

  // Keep the observations in the Playwright process. Opening the real Custom
  // Tab can destroy the WebView execution context before an in-page probe can
  // be read back.
  const probe: PasskeyDegradeProbe = { webauthnCalls: 0 };
  await page.exposeBinding("__ELIZA_RECORD_WEBAUTHN__", () => {
    probe.webauthnCalls += 1;
  });

  const recording = await startAndroidScreenRecord({
    serial: device.serial(),
    artifactDir: ARTIFACT_DIR,
    filename: "passkey-native-degrade.mp4",
    remotePath: "/sdcard/eliza-passkey-native-degrade.mp4",
  });

  try {
    await page.goto(`${ORIGIN}/?reset`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expect(page.getByRole("heading", { name: "Eliza" })).toBeVisible({
      timeout: 90_000,
    });
    const signInButton = page.getByRole("button", { name: /^Sign in$/ });
    await expect(signInButton).toBeVisible();

    // Instrument AFTER boot so the app's own plugin wiring is in place and
    // count every browser credential ceremony without altering auth routing.
    await page.evaluate(() => {
      const recorder = window as Window & {
        __ELIZA_RECORD_WEBAUTHN__(): Promise<void>;
      };

      const credentials = navigator.credentials;
      if (credentials) {
        const originalGet = credentials.get?.bind(credentials);
        const originalCreate = credentials.create?.bind(credentials);
        if (originalGet) {
          credentials.get = ((options?: CredentialRequestOptions) => {
            void recorder.__ELIZA_RECORD_WEBAUTHN__();
            return originalGet(options);
          }) as typeof credentials.get;
        }
        if (originalCreate) {
          credentials.create = ((options?: CredentialCreationOptions) => {
            void recorder.__ELIZA_RECORD_WEBAUTHN__();
            return originalCreate(options);
          }) as typeof credentials.create;
        }
      }
    });

    const beforePath = path.join(ARTIFACT_DIR, "before-signin-tap.png");
    await page.screenshot({ path: beforePath, fullPage: true });
    await testInfo.attach("before sign-in tap", {
      path: beforePath,
      contentType: "image/png",
    });

    await device.shell("logcat -c");
    await signInButton.click();

    // The imported Capacitor Browser object is not guaranteed to be the same
    // object exposed at window.Capacitor.Plugins, so observe the native plugin
    // dispatch and foreground Custom Tab instead of monkeypatching app code.
    await expect
      .poll(async () => (await device.shell("logcat -d -v brief")).toString(), {
        timeout: 90_000,
      })
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

    // Leave the custom tab on-screen briefly so the recording captures it.
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    expect(probe.webauthnCalls).toBe(0);

    // The external custom tab now owns the foreground and may have detached
    // the WebView's CDP target, so capture the device framebuffer instead —
    // it shows the real cli-login browser surface the user sees.
    const afterPath = path.join(ARTIFACT_DIR, "after-signin-tap.png");
    const framebuffer = await device.screenshot();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(afterPath, framebuffer);
    await testInfo.attach("after sign-in tap (device-code flow started)", {
      path: afterPath,
      contentType: "image/png",
    });
  } finally {
    const videoPath = await recording.stop();
    if (videoPath) {
      await testInfo.attach("device walkthrough", {
        path: videoPath,
        contentType: "video/mp4",
      });
    }
  }
});
