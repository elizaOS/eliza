// On-device proof for #15828 on the real Android Capacitor WebView: the shipped
// shell exposes no native WebAuthn bridge, so tapping "Sign in to Eliza Cloud"
// must route through the external device-code flow (Capacitor Browser plugin →
// /auth/cli-login) and must never invoke the browser's `navigator.credentials`
// WebAuthn calls. Screen-recorded; run with ELIZA_ANDROID_ALLOW_FIRST_RUN=1.
import path from "node:path";
import { startAndroidScreenRecord } from "../../scripts/lib/android-capture.mjs";
import { expect, ORIGIN, test } from "./android-harness";

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
  openedUrls: string[];
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

    await expect(page.getByText(/Sign in to Eliza Cloud/i)).toBeVisible({
      timeout: 90_000,
    });

    // Instrument AFTER boot so the app's own plugin wiring is in place: count
    // every WebAuthn ceremony and record every external-browser URL, calling
    // through so the real Chrome custom tab still opens on the recording.
    await page.evaluate(() => {
      const state: { webauthnCalls: number; openedUrls: string[] } = {
        webauthnCalls: 0,
        openedUrls: [],
      };
      Object.defineProperty(window, "__PASSKEY_DEGRADE_PROBE__", {
        configurable: true,
        value: state,
      });

      const credentials = navigator.credentials;
      if (credentials) {
        const originalGet = credentials.get?.bind(credentials);
        const originalCreate = credentials.create?.bind(credentials);
        if (originalGet) {
          credentials.get = ((options?: CredentialRequestOptions) => {
            state.webauthnCalls += 1;
            return originalGet(options);
          }) as typeof credentials.get;
        }
        if (originalCreate) {
          credentials.create = ((options?: CredentialCreationOptions) => {
            state.webauthnCalls += 1;
            return originalCreate(options);
          }) as typeof credentials.create;
        }
      }

      const capacitorBrowser = (
        window as Window & {
          Capacitor?: {
            Plugins?: {
              Browser?: {
                open(options: { url: string }): Promise<void>;
              };
            };
          };
        }
      ).Capacitor?.Plugins?.Browser;
      if (capacitorBrowser?.open) {
        const originalOpen = capacitorBrowser.open.bind(capacitorBrowser);
        capacitorBrowser.open = (options: { url: string }) => {
          state.openedUrls.push(options?.url ?? "");
          return originalOpen(options);
        };
      }

      const originalWindowOpen = window.open.bind(window);
      window.open = ((
        url?: string | URL,
        target?: string,
        features?: string,
      ) => {
        state.openedUrls.push(String(url ?? ""));
        return originalWindowOpen(url, target, features);
      }) as typeof window.open;
    });

    const beforePath = path.join(ARTIFACT_DIR, "before-signin-tap.png");
    await page.screenshot({ path: beforePath, fullPage: true });
    await testInfo.attach("before sign-in tap", {
      path: beforePath,
      contentType: "image/png",
    });

    await page.getByText(/Sign in to Eliza Cloud/i).click();

    // The device-code flow surfaces as an external cli-login URL handed to the
    // Capacitor Browser plugin (or window.open on engines without it).
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  __PASSKEY_DEGRADE_PROBE__?: PasskeyDegradeProbe;
                }
              ).__PASSKEY_DEGRADE_PROBE__?.openedUrls ?? [],
          ),
        { timeout: 90_000 },
      )
      .toEqual(
        expect.arrayContaining([expect.stringContaining("/auth/cli-login")]),
      );

    // Leave the custom tab on-screen briefly so the recording captures it.
    await new Promise((resolve) => setTimeout(resolve, 4_000));

    const probe = (await page.evaluate(
      () =>
        (
          window as Window & {
            __PASSKEY_DEGRADE_PROBE__?: PasskeyDegradeProbe;
          }
        ).__PASSKEY_DEGRADE_PROBE__,
    )) as PasskeyDegradeProbe;

    expect(probe.webauthnCalls).toBe(0);
    expect(
      probe.openedUrls.some((url) => url.includes("/auth/cli-login")),
    ).toBe(true);

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
