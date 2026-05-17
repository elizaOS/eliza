// Checks for APK updates on Android sideload builds only.
// Not used in Play Store builds (Play Store handles updates natively).
// Detected via VITE_ANDROID_BUILD_VARIANT=sideload env var.

import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Device } from "@capacitor/device";

const MANIFEST_URLS = {
  stable:
    "https://github.com/elizaOS/eliza/releases/latest/download/android-update-manifest-stable.json",
  beta: "https://github.com/elizaOS/eliza/releases/latest/download/android-update-manifest-beta.json",
} as const;

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "elizaos_android_update_last_check";

interface UpdateManifest {
  schemaVersion: number;
  channel: "stable" | "beta" | "canary";
  latestVersion: string;
  versionCode: number;
  releaseDate: string;
  downloadUrl: string;
  sha256: string;
  sizeBytes?: number;
  changelog?: string;
  forceUpdate?: boolean;
}

interface UpdateCheckResult {
  updateAvailable: boolean;
  manifest: UpdateManifest;
  currentVersion: string;
  currentVersionCode: number;
}

export const AndroidUpdateChecker = {
  async isAndroidSideload(): Promise<boolean> {
    try {
      if (import.meta.env.VITE_ANDROID_BUILD_VARIANT !== "sideload") {
        return false;
      }
      try {
        const info = await Device.getInfo();
        if (info.platform === "android") {
          return true;
        }
      } catch {
        // Device plugin unavailable — fall back to userAgent
      }
      return navigator.userAgent.includes("Android");
    } catch {
      return false;
    }
  },

  async check(
    channel: "stable" | "beta" = "stable",
  ): Promise<UpdateCheckResult | null> {
    try {
      const isSideload = await AndroidUpdateChecker.isAndroidSideload();
      if (!isSideload) {
        return null;
      }

      const lastCheck = localStorage.getItem(LAST_CHECK_KEY);
      if (lastCheck) {
        const elapsed = Date.now() - parseInt(lastCheck, 10);
        if (elapsed < CHECK_INTERVAL_MS) {
          return null;
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      let manifest: UpdateManifest;
      try {
        const response = await fetch(MANIFEST_URLS[channel], {
          signal: controller.signal,
        });
        if (!response.ok) {
          console.warn(
            `[AndroidUpdateChecker] Manifest fetch failed: ${response.status}`,
          );
          return null;
        }
        manifest = (await response.json()) as UpdateManifest;
      } finally {
        clearTimeout(timeout);
      }

      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));

      let currentVersionCode: number;
      let currentVersion: string;
      try {
        const appInfo = await App.getInfo();
        currentVersionCode = parseInt(appInfo.build, 10);
        currentVersion = appInfo.version;
      } catch {
        console.warn(
          "[AndroidUpdateChecker] Could not read app info via @capacitor/app",
        );
        return null;
      }

      return {
        updateAvailable: manifest.versionCode > currentVersionCode,
        manifest,
        currentVersion,
        currentVersionCode,
      };
    } catch (err) {
      console.warn("[AndroidUpdateChecker] check() error:", err);
      return null;
    }
  },

  async promptIfUpdateAvailable(
    channel: "stable" | "beta" = "stable",
  ): Promise<boolean> {
    const result = await AndroidUpdateChecker.check(channel);
    if (!result?.updateAvailable) {
      return false;
    }
    const confirmed = window.confirm(
      `elizaOS v${result.manifest.latestVersion} is available. Download and install now?`,
    );
    if (confirmed) {
      await AndroidUpdateChecker.openDownloadPage(result.manifest);
      return true;
    }
    return false;
  },

  async openDownloadPage(manifest: UpdateManifest): Promise<void> {
    await Browser.open({ url: manifest.downloadUrl });
  },
};
