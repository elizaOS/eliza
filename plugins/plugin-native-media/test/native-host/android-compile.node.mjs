import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../android-consumer/", import.meta.url));
const capacitor =
  process.env.CAPACITOR_ANDROID_DIR ||
  fileURLToPath(
    new URL(
      "../../node_modules/@capacitor/android/capacitor/",
      import.meta.url,
    ),
  );

test("real Android consumer and instrumentation APKs compile", {
  timeout: 300000,
}, () => {
  assert.ok(
    process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT,
    "An Android SDK is required",
  );
  assert.ok(
    fs.existsSync(capacitor),
    "Install the pinned Capacitor dependency or set CAPACITOR_ANDROID_DIR",
  );
  execFileSync(
    process.env.GRADLE_BIN || "gradle",
    [
      "--no-daemon",
      "--max-workers=1",
      ":host:assembleDebug",
      ":host:assembleDebugAndroidTest",
    ],
    {
      cwd: fixture,
      env: { ...process.env, CAPACITOR_ANDROID_DIR: capacitor },
      timeout: 290000,
      stdio: "pipe",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.ok(
    fs.existsSync(`${fixture}host/build/outputs/apk/debug/host-debug.apk`),
  );
  assert.ok(
    fs.existsSync(
      `${fixture}host/build/outputs/apk/androidTest/debug/host-debug-androidTest.apk`,
    ),
  );
});
