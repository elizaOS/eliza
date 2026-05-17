#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");

const args = new Set(process.argv.slice(2));
const platformArg = process.argv.find((arg) => arg.startsWith("--platform="));
const platform = platformArg?.split("=")[1] ?? "ios";
const storeMode = args.has("--store");
const sideloadMode = args.has("--sideload") || !storeMode;

const checks = [];

function addCheck(name, ok, detail, fix = "") {
  checks.push({ name, ok: Boolean(ok), detail, fix });
}

function commandExists(command) {
  const result = spawnSync("command", ["-v", command], {
    shell: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function run(command, args) {
  return spawnSync(command, args, {
    cwd: appRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

function envPresent(names) {
  return names.filter((name) => !process.env[name]?.trim());
}

function checkIos() {
  const iosRoot = path.join(appRoot, "ios", "App");
  addCheck(
    "Xcode command line tools",
    commandExists("xcodebuild"),
    "xcodebuild is available",
    "Install Xcode, open it once, then run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.",
  );

  if (commandExists("xcodebuild")) {
    const version = run("xcodebuild", ["-version"]);
    addCheck(
      "Xcode version",
      version.status === 0,
      version.stdout.trim() || version.stderr.trim(),
      "Run `xcodebuild -version` locally and install a supported Xcode release.",
    );

    const sdks = run("xcodebuild", ["-showsdks"]);
    addCheck(
      "iPhoneOS SDK",
      sdks.status === 0 && /iphoneos/i.test(sdks.stdout),
      "iPhoneOS SDK is installed",
      "Install the iOS SDK from Xcode Settings > Platforms.",
    );
  }

  addCheck(
    "Capacitor iOS workspace",
    fs.existsSync(path.join(iosRoot, "App.xcworkspace")),
    "packages/app/ios/App/App.xcworkspace exists",
    "Run `bun run --cwd packages/app cap:sync:ios`.",
  );
  const workspaceList =
    commandExists("xcodebuild") &&
    fs.existsSync(path.join(iosRoot, "App.xcworkspace"))
      ? run("xcodebuild", [
          "-workspace",
          path.join(iosRoot, "App.xcworkspace"),
          "-list",
        ])
      : null;
  addCheck(
    "App scheme",
    Boolean(
      workspaceList &&
        workspaceList.status === 0 &&
        /\bApp\b/.test(workspaceList.stdout),
    ),
    "App scheme is visible to xcodebuild",
    "Open the workspace in Xcode and mark the App scheme as shared.",
  );
  addCheck(
    "Privacy manifest",
    fs.existsSync(path.join(iosRoot, "App", "PrivacyInfo.xcprivacy")),
    "PrivacyInfo.xcprivacy exists",
    "Add the iOS privacy manifest before TestFlight/App Store upload.",
  );

  if (sideloadMode) {
    const devices = commandExists("xcrun")
      ? run("xcrun", ["xctrace", "list", "devices"])
      : null;
    addCheck(
      "Device discovery",
      Boolean(devices && devices.status === 0),
      devices?.stdout
        ? "xcrun can list simulators and devices"
        : "xcrun unavailable",
      "Install Xcode command line tools and connect or boot a target device.",
    );
  }

  if (storeMode) {
    const missing = envPresent([
      "APPLE_ID",
      "APPLE_TEAM_ID",
      "ITC_TEAM_ID",
      "APP_STORE_APP_ID",
      "APP_IDENTIFIER",
      "MATCH_GIT_URL",
      "MATCH_PASSWORD",
    ]);
    addCheck(
      "App Store credentials",
      missing.length === 0,
      missing.length === 0
        ? "required App Store release environment is present"
        : `missing: ${missing.join(", ")}`,
      "Configure the missing repository secrets before TestFlight/App Store upload.",
    );
  }
}

function checkAndroid() {
  const androidRoot = path.join(appRoot, "android");
  addCheck(
    "Android project",
    fs.existsSync(path.join(androidRoot, "gradlew")),
    "packages/app/android/gradlew exists",
    "Run `bun run --cwd packages/app cap:sync:android`.",
  );
  addCheck(
    "Java",
    commandExists("java"),
    "java is available",
    "Install the JDK version expected by the Android Gradle project.",
  );
  addCheck(
    "Android SDK",
    Boolean(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT),
    "ANDROID_HOME or ANDROID_SDK_ROOT is set",
    "Install Android Studio or the SDK command line tools and export ANDROID_HOME.",
  );

  if (storeMode) {
    const missing = envPresent([
      "ELIZAOS_KEYSTORE_PATH",
      "ELIZAOS_KEYSTORE_PASSWORD",
      "ELIZAOS_KEY_ALIAS",
      "ELIZAOS_KEY_PASSWORD",
      "PLAY_STORE_SERVICE_ACCOUNT_JSON",
    ]);
    addCheck(
      "Play release credentials",
      missing.length === 0,
      missing.length === 0
        ? "required Play release environment is present"
        : `missing: ${missing.join(", ")}`,
      "Configure signing and Play Store service-account secrets before upload.",
    );
  }
}

if (!["ios", "android"].includes(platform)) {
  console.error(
    "Usage: mobile-release-preflight.mjs --platform=ios|android [--sideload|--store]",
  );
  process.exit(1);
}

if (platform === "ios") {
  checkIos();
} else {
  checkAndroid();
}

console.log(
  `Eliza mobile ${platform} ${storeMode ? "store" : "developer install"} preflight`,
);
for (const check of checks) {
  const mark = check.ok ? "ok" : "fail";
  console.log(`- [${mark}] ${check.name}: ${check.detail}`);
  if (!check.ok && check.fix) {
    console.log(`  fix: ${check.fix}`);
  }
}

const failed = checks.filter((check) => !check.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} preflight check(s) failed.`);
  process.exit(1);
}

console.log("\nAll preflight checks passed.");
