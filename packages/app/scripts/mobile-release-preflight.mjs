#!/usr/bin/env node
/**
 * Command-line helper for the Mobile Release Preflight app packaging, mobile,
 * or Playwright automation lane.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateStagedIosSideloadBundle } from "../../app-core/scripts/lib/mobile-lane-stamp.mjs";
import { evaluateIosStoreEngineGate } from "./ios-store-engine-gate.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");

const args = new Set(process.argv.slice(2));
const platformArg = process.argv.find((arg) => arg.startsWith("--platform="));
const platform = platformArg?.split("=")[1] ?? "ios";
const storeMode = args.has("--store");
const sideloadMode = args.has("--sideload") || !storeMode;
// --staged-only: run ONLY the staged-bundle check (used by ios-sideload-helper
// right after a build step, when toolchain checks already passed once).
// --skip-staged: omit the staged-bundle check (used by ios-sideload-helper
// before a build step — the staged state is about to be replaced and gets
// re-validated post-build).
const stagedOnly = args.has("--staged-only");
const skipStaged = args.has("--skip-staged");

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

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// #11030: a sideloaded bundle whose staged runtime mode is cloud with no
// Agent.apiBase hangs at "Booting up…" on a real device (the native agent has
// no endpoint and no local mode). The store lane (--store) legitimately ships
// cloud mode with no apiBase — cloud onboarding happens in-app — so this
// check is sideload-only by design; see evaluateStagedIosSideloadBundle.
function checkIosStagedSideloadBundle() {
  const iosAppDir = path.join(appRoot, "ios", "App", "App");
  const agentConfig =
    readJson(path.join(iosAppDir, "capacitor.config.json"))?.plugins?.Agent ??
    null;
  const rendererManifest = readJson(
    path.join(iosAppDir, "public", "eliza-renderer-build.json"),
  );
  const verdict = evaluateStagedIosSideloadBundle({
    agentConfig,
    rendererManifest,
  });
  addCheck(
    "Staged bundle agent reachability",
    verdict.ok,
    verdict.reason,
    "Rebuild with `bun run --cwd packages/app build:ios:local`, or set VITE_ELIZA_IOS_API_BASE for an intentional cloud sideload.",
  );
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
    if (!skipStaged) {
      checkIosStagedSideloadBundle();
    }
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

    // An App Store / TestFlight build must declare itself a store build so the
    // web bundle bakes __ELIZA_BUILD_VARIANT__="store" (store CSP + correct
    // isNativeIosStoreBuild() at runtime). Without it the IPA ships as a
    // "direct" build with localhost CSP sources still allowed.
    // Shared gate so this fail-the-build check can never drift from the
    // engine-stager decision in run-mobile-build.mjs (#8861).
    const { storeVariant, localRuntimeDisabled, engineWillEmbed } =
      evaluateIosStoreEngineGate(process.env);
    addCheck(
      "iOS store build variant",
      storeVariant,
      storeVariant
        ? "ELIZA_BUILD_VARIANT=store / ELIZA_RELEASE_AUTHORITY=apple-app-store is set"
        : "store build is not flagged as a store variant",
      "Set ELIZA_BUILD_VARIANT=store and ELIZA_RELEASE_AUTHORITY=apple-app-store on the build job.",
    );

    // The shipped IPA must actually contain a local-agent runtime. This mirrors
    // shouldIncludeIosFullBunEngine() in run-mobile-build.mjs: the on-device
    // no-JIT Bun engine ships when explicitly requested, or for a store build
    // with the local runtime left enabled (the default). An operator can opt
    // into a cloud-only thin client with ELIZA_IOS_APP_STORE_LOCAL_RUNTIME=0 —
    // only then is shipping without the engine intentional.
    if (localRuntimeDisabled) {
      addCheck(
        "On-device local agent runtime",
        true,
        "cloud-only store build (ELIZA_IOS_APP_STORE_LOCAL_RUNTIME=0) — on-device runtime intentionally omitted",
      );
    } else {
      addCheck(
        "On-device local agent runtime",
        engineWillEmbed,
        engineWillEmbed
          ? "the no-JIT Bun engine will be embedded — local agent will start on device"
          : "store build would ship WITHOUT the Bun engine; the in-app local agent would hard-fail",
        "Set ELIZA_BUILD_VARIANT=store (engine ships by default) or ELIZA_IOS_FULL_BUN_ENGINE=1, or set ELIZA_IOS_APP_STORE_LOCAL_RUNTIME=0 for an intentional cloud-only build.",
      );
    }
  }
}

function checkAndroid() {
  const androidRoot = path.join(
    appRoot,
    "..",
    "app-core",
    "platforms",
    "android",
  );
  addCheck(
    "Android project",
    fs.existsSync(path.join(androidRoot, "gradlew")),
    "packages/app-core/platforms/android/gradlew exists",
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

if (
  !["ios", "android"].includes(platform) ||
  (stagedOnly && (platform !== "ios" || storeMode || skipStaged))
) {
  console.error(
    "Usage: mobile-release-preflight.mjs --platform=ios|android [--sideload|--store] [--staged-only|--skip-staged]\n" +
      "  --staged-only applies to the iOS sideload lane only.",
  );
  process.exit(1);
}

if (platform === "ios") {
  if (stagedOnly) {
    checkIosStagedSideloadBundle();
  } else {
    checkIos();
  }
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
