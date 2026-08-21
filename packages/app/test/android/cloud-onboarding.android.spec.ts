/**
 * Production Google Play Cloud sign-in checks on the real Android WebView.
 *
 * The Play shell deliberately has no embedded wallet, private-key autologin,
 * local-agent setup, or in-WebView account authentication. Authentication is
 * delegated to the system browser through a short-lived Cloud CLI session.
 */

import path from "node:path";
import { expect, ORIGIN, test } from "./android-harness";

const ARTIFACT_DIR = path.join(
  process.cwd(),
  "test-results",
  "android-cloud-onboarding",
);

async function clearBrowserState(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    localStorage.clear();
    const preferences = (
      window as Window & {
        Capacitor?: {
          Plugins?: { Preferences?: { clear(): Promise<void> } };
        };
      }
    ).Capacitor?.Plugins?.Preferences;
    await preferences?.clear();
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
      await page.evaluate(() => {
        localStorage.setItem(
          "elizaos:active-server",
          JSON.stringify({
            id: "local:android",
            kind: "remote",
            apiBase: "eliza-local-agent://ipc",
          }),
        );
        localStorage.setItem("steward_session_token", "stale-browser-token");
        localStorage.setItem("eliza:e2e-wallet:autologin", "1");
        localStorage.setItem("eliza:e2e-wallet:pk", "legacy-test-wallet-key");
      });

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

    test("sign-in creates a live short-lived Cloud session and opens the system browser", async ({
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
            (await device.shell("dumpsys activity activities")).toString(),
          { timeout: 15_000 },
        )
        .toMatch(/com\.android\.chrome|BrowserControllerActivity/);

      await device.shell("input keyevent BACK");
      await page.getByRole("button", { name: "Cancel sign-in" }).click();
      await expect(
        page.getByRole("button", { name: /^Sign in$/ }),
      ).toBeVisible();
    });
  });
