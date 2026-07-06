/**
 * Android device smoke spec for the Native Plugin View Smoke Android native
 * plugin app surface.
 */
import fs from "node:fs";
import path from "node:path";
import {
  captureAndroidLogcat,
  captureAndroidScreenshot,
  startAndroidScreenRecord,
} from "../../scripts/lib/android-capture.mjs";
import {
  APP_ID,
  adbDevice,
  resolveAdb,
} from "../../scripts/lib/android-device.mjs";
import { expect, test, waitForShellReady } from "./android-harness";

const ARTIFACT_DIR = path.join(
  process.env.ELIZA_ANDROID_ARTIFACT_DIR ??
    path.join(process.cwd(), "test-results", "android"),
  "native-plugin-view-smoke",
);

type NativePluginSmokeResult = {
  platform: unknown;
  isNativePlatform: unknown;
  pluginAvailable: unknown;
  pluginNames: string[];
  status: {
    packageName?: unknown;
    roles?: Array<{
      role?: unknown;
      androidRole?: unknown;
      held?: unknown;
      holders?: unknown;
      available?: unknown;
    }>;
  };
  settings: {
    brightness?: unknown;
    brightnessMode?: unknown;
    canWriteSettings?: unknown;
    volumes?: Array<{
      stream?: unknown;
      current?: unknown;
      max?: unknown;
    }>;
  };
};

test.describe
  .serial("android native plugin x view smoke (real WebView)", () => {
    test("calls ElizaSystem Kotlin through the Capacitor bridge", async ({
      page,
      device,
    }, testInfo) => {
      test.setTimeout(180_000);

      fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
      const adb = resolveAdb();
      const serial = device.serial();
      const consoleLines: string[] = [];
      const pageErrors: string[] = [];

      adbDevice(adb, serial, ["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
      adbDevice(adb, serial, ["shell", "wm", "dismiss-keyguard"]);

      page.on("console", (message) => {
        consoleLines.push(
          JSON.stringify({
            type: message.type(),
            text: message.text(),
          }),
        );
      });
      page.on("pageerror", (error) => {
        pageErrors.push(error.stack || error.message);
      });

      const recording = await startAndroidScreenRecord({
        serial,
        artifactDir: ARTIFACT_DIR,
        filename: "native-plugin-view-smoke.mp4",
        remotePath: "/sdcard/eliza-native-plugin-view-smoke.mp4",
      });

      try {
        await waitForShellReady(page);

        const result = await page.evaluate(async () => {
          const capacitor = window.Capacitor;
          const plugin = capacitor?.Plugins?.ElizaSystem;
          if (!capacitor || !plugin) {
            throw new Error(
              "ElizaSystem plugin is not registered on window.Capacitor",
            );
          }

          const [status, settings] = await Promise.all([
            plugin.getStatus(),
            plugin.getDeviceSettings(),
          ]);

          return {
            platform: capacitor.getPlatform?.(),
            isNativePlatform: capacitor.isNativePlatform?.(),
            pluginAvailable: capacitor.isPluginAvailable?.("ElizaSystem"),
            pluginNames: Object.keys(capacitor.Plugins ?? {}).sort(),
            status,
            settings,
          };
        });

        const evidence = result as NativePluginSmokeResult;
        expect(evidence.platform, "Capacitor platform").toBe("android");
        expect(evidence.isNativePlatform, "native platform flag").toBe(true);
        expect(evidence.pluginAvailable, "ElizaSystem available").toBe(true);
        expect(evidence.pluginNames).toContain("ElizaSystem");

        // These are native-only facts. The web shim returns packageName="web",
        // no roles, and no voiceCall stream.
        expect(evidence.status.packageName, "native package name").toBe(APP_ID);
        expect(
          Array.isArray(evidence.status.roles) && evidence.status.roles.length,
          "Android role rows returned by Kotlin RoleManager",
        ).toBeGreaterThan(0);
        for (const role of evidence.status.roles ?? []) {
          expect(typeof role.role, "role name").toBe("string");
          expect(typeof role.androidRole, "android role name").toBe("string");
          expect(typeof role.held, "role held flag").toBe("boolean");
          expect(Array.isArray(role.holders), "role holders").toBe(true);
          expect(typeof role.available, "role available flag").toBe("boolean");
        }

        expect(typeof evidence.settings.brightness, "brightness").toBe(
          "number",
        );
        expect(evidence.settings.brightness as number).toBeGreaterThanOrEqual(
          0,
        );
        expect(evidence.settings.brightness as number).toBeLessThanOrEqual(1);
        expect(["manual", "automatic", "unknown"]).toContain(
          evidence.settings.brightnessMode,
        );
        expect(typeof evidence.settings.canWriteSettings).toBe("boolean");

        const volumes = evidence.settings.volumes ?? [];
        expect(volumes.length, "native volume streams").toBeGreaterThanOrEqual(
          5,
        );
        expect(volumes.map((volume) => volume.stream)).toContain("voiceCall");
        for (const volume of volumes) {
          expect(typeof volume.stream, "volume stream").toBe("string");
          expect(typeof volume.current, `${volume.stream} current volume`).toBe(
            "number",
          );
          expect(typeof volume.max, `${volume.stream} max volume`).toBe(
            "number",
          );
          expect(volume.current as number).toBeGreaterThanOrEqual(0);
          expect(volume.max as number).toBeGreaterThan(0);
          expect(volume.current as number).toBeLessThanOrEqual(
            volume.max as number,
          );
        }

        const resultPath = path.join(ARTIFACT_DIR, "native-plugin-result.json");
        fs.writeFileSync(resultPath, `${JSON.stringify(evidence, null, 2)}\n`);
        await testInfo.attach("native plugin result", {
          path: resultPath,
          contentType: "application/json",
        });

        const screenshotPath = captureAndroidScreenshot({
          adb,
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: "native-plugin-device.png",
        });
        await testInfo.attach("native plugin screen", {
          path: screenshotPath,
          contentType: "image/png",
        });
      } finally {
        const consolePath = path.join(ARTIFACT_DIR, "webview-console.log");
        fs.writeFileSync(
          consolePath,
          `${consoleLines.join("\n")}\n${pageErrors
            .map((error) => `[pageerror] ${error}`)
            .join("\n")}\n`,
        );
        await testInfo.attach("WebView console", {
          path: consolePath,
          contentType: "text/plain",
        });

        const logcatPath = captureAndroidLogcat({
          adb,
          serial,
          artifactDir: ARTIFACT_DIR,
          filename: "logcat.txt",
          lines: 800,
        });
        await testInfo.attach("Android logcat", {
          path: logcatPath,
          contentType: "text/plain",
        });

        const videoPath = await recording.stop();
        if (videoPath) {
          await testInfo.attach("native plugin walkthrough video", {
            path: videoPath,
            contentType: "video/mp4",
          });
        }
      }
    });
  });
