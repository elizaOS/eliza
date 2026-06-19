import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Device } from "@capacitor/device";

const MANIFEST_URLS: Record<string, string> = {
  stable:
    "https://github.com/elizaOS/eliza/releases/latest/download/android-update-manifest-stable.json",
  beta: "https://github.com/elizaOS/eliza/releases/latest/download/android-update-manifest-beta.json",
};

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
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
      const info = await Device.getInfo();
      if (info.platform !== "android") return false;
      return import.meta.env.VITE_ANDROID_BUILD_VARIANT === "sideload";
    } catch {
      return false;
    }
  },

  async check(
    channel: "stable" | "beta" = "stable",
  ): Promise<UpdateCheckResult | null> {
    try {
      const isSideload = await AndroidUpdateChecker.isAndroidSideload();
      if (!isSideload) return null;

      const lastCheck = localStorage.getItem(LAST_CHECK_KEY);
      if (lastCheck !== null) {
        const elapsed = Date.now() - parseInt(lastCheck, 10);
        if (elapsed < CHECK_INTERVAL_MS) return null;
      }

      const manifestUrl = MANIFEST_URLS[channel];
      if (!manifestUrl) {
        console.warn(
          `[AndroidUpdateChecker] No manifest URL for channel: ${channel}`,
        );
        return null;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);

      let manifest: UpdateManifest;
      try {
        const response = await fetch(manifestUrl, {
          signal: controller.signal,
        });
        if (!response.ok) {
          console.warn(
            `[AndroidUpdateChecker] Manifest fetch failed: ${response.status} ${response.statusText}`,
          );
          return null;
        }
        manifest = (await response.json()) as UpdateManifest;
      } finally {
        clearTimeout(timeoutId);
      }

      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));

      const appInfo = await App.getInfo();
      const currentVersion = appInfo.version;
      const currentVersionCode = parseInt(appInfo.build, 10);

      const updateAvailable = manifest.versionCode > currentVersionCode;

      return { updateAvailable, manifest, currentVersion, currentVersionCode };
    } catch (err) {
      console.warn("[AndroidUpdateChecker] check() error:", err);
      return null;
    }
  },

  async promptIfUpdateAvailable(
    channel: "stable" | "beta" = "stable",
  ): Promise<boolean> {
    const result = await AndroidUpdateChecker.check(channel);
    if (!result?.updateAvailable) return false;

    const { manifest } = result;
    const message = `elizaOS v${manifest.latestVersion} is available. Update now?`;
    const confirmed = window.confirm(message);
    if (!confirmed) return false;

    await AndroidUpdateChecker.openDownloadPage(manifest);
    return true;
  },

  async openDownloadPage(manifest: UpdateManifest): Promise<void> {
    await Browser.open({ url: manifest.downloadUrl });
  },
};
