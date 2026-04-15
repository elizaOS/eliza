#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const appDir = path.join(repoRoot, "apps", "app");
const iosDir = path.join(appDir, "ios", "App");
const androidDir = path.join(appDir, "android");
const androidBuildGradleTemplate =
  firstExisting([
    path.join(
      repoRoot,
      "eliza",
      "packages",
      "app-core",
      "platforms",
      "android",
      "build.gradle",
    ),
    path.join(repoRoot, "packages", "app-core", "platforms", "android", "build.gradle"),
  ]) ??
  path.join(
    repoRoot,
    "eliza",
    "packages",
    "app-core",
    "platforms",
    "android",
    "build.gradle",
  );
const prepareIosCocoapodsScript =
  firstExisting([
    path.join(
      repoRoot,
      "eliza",
      "packages",
      "app-core",
      "scripts",
      "prepare-ios-cocoapods.sh",
    ),
    path.join(repoRoot, "scripts", "prepare-ios-cocoapods.sh"),
  ]) ??
  path.join(
    repoRoot,
    "eliza",
    "packages",
    "app-core",
    "scripts",
    "prepare-ios-cocoapods.sh",
  );

const target = process.argv[2];

if (target !== "android" && target !== "ios") {
  console.error("Usage: node scripts/run-mobile-build.mjs <android|ios>");
  process.exit(1);
}

function run(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited due to signal ${signal}`));
        return;
      }

      if ((code ?? 1) !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
        return;
      }

      resolve();
    });
  });
}

function firstExisting(paths) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveAndroidSdkRoot() {
  return firstExisting([
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
  ]);
}

function resolveJavaHome() {
  return firstExisting([
    process.env.JAVA_HOME,
    "/opt/homebrew/opt/openjdk@21",
    "/usr/local/opt/openjdk@21",
    "/usr/lib/jvm/temurin-21-jdk-amd64",
    "/usr/lib/jvm/java-21-openjdk-amd64",
    "/usr/lib/jvm/java-21-openjdk",
  ]);
}

function withPrependedPath(env, entries) {
  const separator = process.platform === "win32" ? ";" : ":";
  const filtered = entries.filter(Boolean);
  if (filtered.length === 0) {
    return env.PATH ?? "";
  }
  return `${filtered.join(separator)}${separator}${env.PATH ?? ""}`;
}

async function buildSharedApp() {
  await run("bun", ["scripts/build.mjs"], { cwd: appDir });
}

async function ensureCapacitorPlatform(platform) {
  const platformDir = platform === "android" ? androidDir : iosDir;
  if (fs.existsSync(platformDir)) {
    return;
  }

  console.log(`[mobile-build] Adding missing Capacitor ${platform} platform...`);
  await run("bun", ["x", "capacitor", "add", platform], { cwd: appDir });
}

// ── Source platform directories ─────────────────────────────────────────
const androidPlatformSrc =
  firstExisting([
    path.join(repoRoot, "eliza", "packages", "app-core", "platforms", "android"),
    path.join(repoRoot, "packages", "app-core", "platforms", "android"),
  ]) ??
  path.join(repoRoot, "eliza", "packages", "app-core", "platforms", "android");

const iosPlatformSrc =
  firstExisting([
    path.join(repoRoot, "eliza", "packages", "app-core", "platforms", "ios"),
    path.join(repoRoot, "packages", "app-core", "platforms", "ios"),
  ]) ??
  path.join(repoRoot, "eliza", "packages", "app-core", "platforms", "ios");

// ── Android post-sync overlay ───────────────────────────────────────────

/**
 * Permissions and service declarations that must be present in the manifest.
 * Capacitor sync only generates INTERNET; everything else comes from the
 * source template.
 */
const ANDROID_REQUIRED_PERMISSIONS = [
  '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
  '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
  '<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  `<uses-permission\n        android:name="android.permission.WRITE_EXTERNAL_STORAGE"\n        android:maxSdkVersion="28" />`,
  `<uses-permission\n        android:name="android.permission.READ_EXTERNAL_STORAGE"\n        android:maxSdkVersion="32" />`,
  '<uses-permission android:name="android.permission.WAKE_LOCK" />',
];

const ANDROID_SERVICE_BLOCK = `
        <service
            android:name="ai.elizaos.app.GatewayConnectionService"
            android:exported="false"
            android:foregroundServiceType="dataSync" />`;

const ANDROID_QUERIES_BLOCK = `
    <queries>
        <package android:name="com.google.android.apps.healthdata" />
    </queries>
`;

/**
 * Copy Java source files from the platform template into the synced project
 * and merge manifest entries that Capacitor sync does not generate.
 */
function overlayAndroidNativeFiles() {
  const srcJavaDir = path.join(
    androidPlatformSrc, "app", "src", "main", "java", "ai", "elizaos", "app",
  );
  const targetJavaDir = path.join(
    androidDir, "app", "src", "main", "java", "ai", "elizaos", "app",
  );

  // Detect the host app's namespace so we can add an R import.
  // The source files live under ai.elizaos.app but R is generated under
  // the app's own namespace (e.g. com.miladyai.milady).
  const appBuildGradlePath = path.join(androidDir, "app", "build.gradle");
  let appNamespace = null;
  if (fs.existsSync(appBuildGradlePath)) {
    const gradleContent = fs.readFileSync(appBuildGradlePath, "utf8");
    const nsMatch = gradleContent.match(/namespace\s*[=:]\s*["']([^"']+)["']/);
    if (nsMatch) {
      appNamespace = nsMatch[1];
    }
  }

  // -- Copy Java files (GatewayConnectionService + source MainActivity) --
  if (fs.existsSync(srcJavaDir)) {
    fs.mkdirSync(targetJavaDir, { recursive: true });
    for (const file of ["GatewayConnectionService.java", "MainActivity.java"]) {
      const src = path.join(srcJavaDir, file);
      if (!fs.existsSync(src)) continue;

      let content = fs.readFileSync(src, "utf8");

      // If the host app namespace differs from ai.elizaos.app, the R class
      // lives in the host namespace. Add an explicit import so unqualified
      // R references compile.
      if (appNamespace && appNamespace !== "ai.elizaos.app") {
        const rImport = `import ${appNamespace}.R;`;
        if (!content.includes(rImport)) {
          // Insert right after the package declaration line
          content = content.replace(
            /^(package\s+[^;]+;)/m,
            `$1\n\n${rImport}`,
          );
        }
      }

      fs.writeFileSync(path.join(targetJavaDir, file), content, "utf8");
    }
    console.log("[mobile-build] Copied Android Java source files (GatewayConnectionService, MainActivity).");
  }

  // -- Merge AndroidManifest.xml --
  const manifestPath = path.join(androidDir, "app", "src", "main", "AndroidManifest.xml");
  if (fs.existsSync(manifestPath)) {
    let manifest = fs.readFileSync(manifestPath, "utf8");
    let changed = false;

    // Add usesCleartextTraffic to <application> if missing
    if (!manifest.includes("usesCleartextTraffic")) {
      manifest = manifest.replace(
        "<application",
        '<application\n        android:usesCleartextTraffic="true"',
      );
      changed = true;
    }

    // Add <queries> block before <application> if missing
    if (!manifest.includes("<queries>")) {
      manifest = manifest.replace(
        /(\s*)<application/,
        `${ANDROID_QUERIES_BLOCK}\n    <application`,
      );
      changed = true;
    }

    // Add service declaration inside <application> if missing
    if (!manifest.includes("GatewayConnectionService")) {
      manifest = manifest.replace(
        "</application>",
        `${ANDROID_SERVICE_BLOCK}\n    </application>`,
      );
      changed = true;
    }

    // Add missing permissions before </manifest>
    for (const perm of ANDROID_REQUIRED_PERMISSIONS) {
      // Extract the permission name for checking
      const nameMatch = perm.match(/android:name="([^"]+)"/);
      if (nameMatch && !manifest.includes(nameMatch[1])) {
        manifest = manifest.replace(
          "</manifest>",
          `    ${perm}\n</manifest>`,
        );
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(manifestPath, manifest, "utf8");
      console.log("[mobile-build] Merged permissions and service into AndroidManifest.xml.");
    }
  }

  // -- Copy ProGuard rules --
  const srcProguard = path.join(androidPlatformSrc, "app", "proguard-rules.pro");
  const targetProguard = path.join(androidDir, "app", "proguard-rules.pro");
  if (fs.existsSync(srcProguard)) {
    fs.copyFileSync(srcProguard, targetProguard);
    console.log("[mobile-build] Copied ProGuard rules.");
  }

  // -- Patch app/build.gradle for release optimizations --
  const appBuildGradle = path.join(androidDir, "app", "build.gradle");
  if (fs.existsSync(appBuildGradle)) {
    let gradle = fs.readFileSync(appBuildGradle, "utf8");
    let gradleChanged = false;

    // Enable minification in release builds
    if (gradle.includes("minifyEnabled false")) {
      gradle = gradle.replace("minifyEnabled false", "minifyEnabled true");
      gradleChanged = true;
    }

    // Add shrinkResources if missing
    if (!gradle.includes("shrinkResources") && gradle.includes("minifyEnabled true")) {
      gradle = gradle.replace(
        "minifyEnabled true",
        "minifyEnabled true\n            shrinkResources true",
      );
      gradleChanged = true;
    }

    if (gradleChanged) {
      fs.writeFileSync(appBuildGradle, gradle, "utf8");
      console.log("[mobile-build] Enabled release minification in app/build.gradle.");
    }
  }
}

// ── iOS post-sync overlay ───────────────────────────────────────────────

/**
 * Plist key-value pairs to merge into the Capacitor-generated Info.plist.
 * Order: key line, then value line(s).
 */
const IOS_PLIST_ENTRIES = [
  { key: "NSCameraUsageDescription", value: "<string>This app uses your camera to capture photos and video when you ask it to.</string>" },
  { key: "NSMicrophoneUsageDescription", value: "<string>This app needs microphone access for voice wake, talk mode, and video capture.</string>" },
  { key: "NSLocationWhenInUseUsageDescription", value: "<string>This app uses your location to provide location-aware responses when you allow it.</string>" },
  { key: "NSLocationAlwaysAndWhenInUseUsageDescription", value: "<string>This app can share your location in the background so it stays up to date even when the app is not in use.</string>" },
  { key: "NSPhotoLibraryUsageDescription", value: "<string>This app accesses your photo library to attach and share photos or videos.</string>" },
  { key: "NSPhotoLibraryAddUsageDescription", value: "<string>This app saves captured photos and videos to your photo library.</string>" },
  { key: "NSHealthShareUsageDescription", value: "<string>This app reads your HealthKit sleep and biometric data to infer when you are asleep, awake, and ready for reminders.</string>" },
  { key: "NSHealthUpdateUsageDescription", value: "<string>This app does not write to HealthKit, but iOS requires this key when HealthKit capability is enabled.</string>" },
  { key: "NSSpeechRecognitionUsageDescription", value: "<string>This app uses on-device speech recognition to listen for voice commands and wake words.</string>" },
  { key: "NSLocalNetworkUsageDescription", value: "<string>This app discovers and connects to your elizaOS gateway on the local network.</string>" },
];

const IOS_BONJOUR_BLOCK = `\t<key>NSBonjourServices</key>
\t<array>
\t\t<string>_elizaos-gw._tcp</string>
\t</array>`;

/**
 * Merge permission keys into Info.plist, copy entitlements, and overlay
 * any other iOS source files that Capacitor sync does not generate.
 */
function overlayIosNativeFiles() {
  const targetAppDir = path.join(appDir, "ios", "App", "App");

  // -- Merge Info.plist permission strings --
  const plistPath = path.join(targetAppDir, "Info.plist");
  if (fs.existsSync(plistPath)) {
    let plist = fs.readFileSync(plistPath, "utf8");
    let changed = false;

    for (const entry of IOS_PLIST_ENTRIES) {
      if (!plist.includes(entry.key)) {
        plist = plist.replace(
          "</dict>",
          `\t<key>${entry.key}</key>\n\t${entry.value}\n</dict>`,
        );
        changed = true;
      }
    }

    // Add Bonjour services if missing
    if (!plist.includes("NSBonjourServices")) {
      plist = plist.replace(
        "</dict>",
        `${IOS_BONJOUR_BLOCK}\n</dict>`,
      );
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(plistPath, plist, "utf8");
      console.log("[mobile-build] Merged permission strings into iOS Info.plist.");
    }
  }

  // -- Copy entitlements file --
  const srcEntitlements = path.join(iosPlatformSrc, "App", "App", "App.entitlements");
  const targetEntitlements = path.join(targetAppDir, "App.entitlements");
  if (fs.existsSync(srcEntitlements)) {
    let entitlements = fs.readFileSync(srcEntitlements, "utf8");
    // Replace the generic app group with the Milady-specific one
    entitlements = entitlements.replace(
      "group.ai.elizaos.app",
      "group.com.miladyai.milady",
    );
    fs.writeFileSync(targetEntitlements, entitlements, "utf8");
    console.log("[mobile-build] Copied iOS entitlements (with Milady app group).");
  }
}

/**
 * Capacitor 8.3.0 ships a binary xcframework whose Swift API differs from
 * what older official plugins (status-bar ≤8.0.2, preferences ≤8.0.1)
 * expect. Until the lockfile pins @capacitor/ios to a compatible range,
 * strip those plugins from the SPM Package.swift so they fall back to
 * their web implementations. The native code is not lost — it reactivates
 * automatically once the Capacitor versions are aligned.
 */
function patchIosPluginSwiftCompat() {
  const packageSwiftPath = path.join(appDir, "ios", "App", "CapApp-SPM", "Package.swift");
  if (!fs.existsSync(packageSwiftPath)) return;

  let content = fs.readFileSync(packageSwiftPath, "utf8");
  const spmMatch = content.match(/capacitor-swift-pm\.git",\s*exact:\s*"([^"]+)"/);
  if (!spmMatch) return;

  const [spmMajor, spmMinor] = spmMatch[1].split(".").map(Number);
  // Only strip when the SPM core is 8.1+ (where the API breaks began)
  if (spmMajor < 8 || (spmMajor === 8 && spmMinor < 1)) return;

  // Plugins whose Swift source is incompatible with the resolved SPM core.
  // These all have working web fallbacks so functionality is preserved.
  const incompatible = ["CapacitorStatusBar", "CapacitorPreferences", "CapacitorApp"];
  let changed = false;

  for (const name of incompatible) {
    // Remove .package(name: "...", path: "...") from dependencies
    const depRe = new RegExp(
      `\\s*\\.package\\(name:\\s*"${name}"[^)]*\\),?\\n?`,
    );
    if (depRe.test(content)) {
      content = content.replace(depRe, "\n");
      changed = true;
    }

    // Remove .product(name: "...", package: "...") from target dependencies
    const prodRe = new RegExp(
      `\\s*\\.product\\(name:\\s*"${name}"[^)]*\\),?\\n?`,
    );
    if (prodRe.test(content)) {
      content = content.replace(prodRe, "\n");
      changed = true;
    }
  }

  if (changed) {
    // Clean up trailing commas before closing brackets
    content = content.replace(/,(\s*\])/g, "$1");
    fs.writeFileSync(packageSwiftPath, content, "utf8");
    console.log(
      `[mobile-build] Stripped incompatible SPM plugins (${incompatible.join(", ")}) — using web fallbacks until Capacitor versions are aligned.`,
    );
  }
}

function ensureAndroidBuildGradlePatched() {
  const targetPath = path.join(androidDir, "build.gradle");
  if (!fs.existsSync(targetPath) || !fs.existsSync(androidBuildGradleTemplate)) {
    return;
  }

  const current = fs.readFileSync(targetPath, "utf8");
  const template = fs.readFileSync(androidBuildGradleTemplate, "utf8");
  if (current === template) {
    return;
  }

  fs.writeFileSync(targetPath, template, "utf8");
  console.log("[mobile-build] Patched android/build.gradle for native plugins.");
}

function ensureAndroidVariablesPatched() {
  const targetPath = path.join(androidDir, "variables.gradle");
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const current = fs.readFileSync(targetPath, "utf8");
  const next = current.replace(
    /minSdkVersion\s*=\s*\d+/,
    "minSdkVersion = 26",
  );
  if (next === current) {
    return;
  }

  fs.writeFileSync(targetPath, next, "utf8");
  console.log("[mobile-build] Raised android minSdkVersion to 26.");
}

async function buildAndroid() {
  const androidSdkRoot = resolveAndroidSdkRoot();
  const javaHome = resolveJavaHome();

  if (!androidSdkRoot) {
    throw new Error(
      "Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME before running the Android mobile build.",
    );
  }

  if (!javaHome) {
    throw new Error(
      "JDK 21 not found. Set JAVA_HOME before running the Android mobile build.",
    );
  }

  await buildSharedApp();
  await ensureCapacitorPlatform("android");
  await run("bun", ["run", "cap:sync:android"], { cwd: appDir });
  overlayAndroidNativeFiles();
  ensureAndroidBuildGradlePatched();
  ensureAndroidVariablesPatched();

  const env = {
    ...process.env,
    ANDROID_HOME: androidSdkRoot,
    ANDROID_SDK_ROOT: androidSdkRoot,
    JAVA_HOME: javaHome,
  };

  env.PATH = withPrependedPath(env, [
    path.join(javaHome, "bin"),
    path.join(androidSdkRoot, "platform-tools"),
  ]);

  await run(
    "./gradlew",
    [
      ":elizaos-capacitor-websiteblocker:testDebugUnitTest",
      ":app:assembleDebug",
    ],
    {
      cwd: androidDir,
      env,
    },
  );
}

async function buildIos() {
  if (process.platform !== "darwin") {
    throw new Error("iOS builds require macOS and Xcode.");
  }

  await buildSharedApp();
  await ensureCapacitorPlatform("ios");
  await run("bash", [prepareIosCocoapodsScript], { cwd: repoRoot });
  await run("bun", ["run", "cap:sync:ios"], { cwd: appDir });
  overlayIosNativeFiles();
  patchIosPluginSwiftCompat();

  const iosWorkspacePath = path.join(iosDir, "App.xcworkspace");
  const iosProjectArgs = fs.existsSync(iosWorkspacePath)
    ? ["-workspace", "App.xcworkspace"]
    : ["-project", "App.xcodeproj"];

  await run(
    "xcodebuild",
    [
      ...iosProjectArgs,
      "-scheme",
      "App",
      "-configuration",
      "Debug",
      "-destination",
      "generic/platform=iOS Simulator",
      "-sdk",
      "iphonesimulator",
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ],
    { cwd: iosDir },
  );
}

if (target === "android") {
  await buildAndroid();
} else {
  await buildIos();
}
