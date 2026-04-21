#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertIosScreenTimeBuildWiring } from "../../native-plugins/mobile-signals/scripts/validate-ios-screen-time.mjs";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const appDir = path.join(repoRoot, "apps", "app");
const iosPlatformDir = path.join(appDir, "ios");
const iosDir = path.join(appDir, "ios", "App");
const androidDir = path.join(appDir, "android");
const iosWorkspacePath = path.join(iosDir, "App.xcworkspace");
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

export const PLATFORM_TEMPLATE_FILES = {
  android: [
    "gradlew",
    "gradlew.bat",
    "gradle.properties",
    "build.gradle",
    "settings.gradle",
    "variables.gradle",
    "capacitor.settings.gradle",
    path.join("gradle", "wrapper", "gradle-wrapper.jar"),
    path.join("gradle", "wrapper", "gradle-wrapper.properties"),
    path.join("app", "build.gradle"),
    path.join("app", "capacitor.build.gradle"),
    path.join("app", "proguard-rules.pro"),
    path.join("app", "src", "main"),
  ],
  ios: [
    path.join("App", "Podfile"),
    path.join("App", "App.xcodeproj", "project.pbxproj"),
    path.join("App", "App", "App.entitlements"),
    path.join("App", "App", "AppDelegate.swift"),
    path.join("App", "App", "Base.lproj", "LaunchScreen.storyboard"),
    path.join("App", "App", "Base.lproj", "Main.storyboard"),
    path.join("App", "App", "Info.plist"),
    path.join("App", "App", "Assets.xcassets", "Contents.json"),
    path.join(
      "App",
      "App",
      "Assets.xcassets",
      "AppIcon.appiconset",
      "AppIcon-512@2x.png",
    ),
    path.join(
      "App",
      "App",
      "Assets.xcassets",
      "AppIcon.appiconset",
      "Contents.json",
    ),
    path.join(
      "App",
      "App",
      "Assets.xcassets",
      "Splash.imageset",
      "Contents.json",
    ),
    path.join(
      "App",
      "App",
      "Assets.xcassets",
      "Splash.imageset",
      "splash-2732x2732.png",
    ),
    path.join(
      "App",
      "App",
      "Assets.xcassets",
      "Splash.imageset",
      "splash-2732x2732-1.png",
    ),
    path.join(
      "App",
      "App",
      "Assets.xcassets",
      "Splash.imageset",
      "splash-2732x2732-2.png",
    ),
    path.join("App", "App", "MiladyIntentPlugin.swift"),
    path.join(
      "App",
      "App",
      "WebsiteBlockerContentExtension",
      "ActionRequestHandler.swift",
    ),
    path.join("App", "App", "WebsiteBlockerContentExtension", "Info.plist"),
    path.join(
      "App",
      "App",
      "WebsiteBlockerContentExtension",
      "WebsiteBlockerContentExtension.entitlements",
    ),
  ],
};

export function resolvePlatformTemplateRoot(
  platform,
  { repoRootValue = repoRoot } = {},
) {
  return firstExisting([
    path.join(
      repoRootValue,
      "eliza",
      "packages",
      "app-core",
      "platforms",
      platform,
    ),
    path.join(repoRootValue, "packages", "app-core", "platforms", platform),
  ]);
}

const androidPlatformSrc =
  resolvePlatformTemplateRoot("android") ??
  path.join(repoRoot, "eliza", "packages", "app-core", "platforms", "android");
const iosPlatformSrc =
  resolvePlatformTemplateRoot("ios") ??
  path.join(repoRoot, "eliza", "packages", "app-core", "platforms", "ios");
const androidBuildGradleTemplate = path.join(
  androidPlatformSrc,
  "build.gradle",
);

// ── App identity ────────────────────────────────────────────────────────
// Read appId and appName from app.config.ts (primary) or capacitor.config.ts
// (fallback). The build script uses these to parameterize entitlements,
// manifest service names, notification strings, etc.

function readAppIdentity() {
  const defaults = { appId: "ai.elizaos.app", appName: "Eliza" };
  for (const file of ["app.config.ts", "capacitor.config.ts"]) {
    const fp = path.join(appDir, file);
    if (!fs.existsSync(fp)) continue;
    const src = fs.readFileSync(fp, "utf8");
    const id = src.match(/appId\s*[:=]\s*["']([^"']+)["']/)?.[1];
    const name = src.match(/appName\s*[:=]\s*["']([^"']+)["']/)?.[1];
    if (id) defaults.appId = id;
    if (name) defaults.appName = name;
  }
  return { ...defaults, appGroup: `group.${defaults.appId}` };
}

const APP = readAppIdentity();
console.log(`[mobile-build] App: ${APP.appName} (${APP.appId})`);

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

async function buildSharedApp(platform) {
  if (process.env.ELIZA_SKIP_WEB_BUILD === "1") {
    console.log("[mobile-build] Skipping web build (ELIZA_SKIP_WEB_BUILD=1).");
    return;
  }
  await run("bun", ["scripts/build.mjs"], {
    cwd: appDir,
    env: {
      ...process.env,
      ELIZA_CAPACITOR_BUILD_TARGET: platform,
      MILADY_CAPACITOR_BUILD_TARGET: platform,
    },
  });
}

export function syncPlatformTemplateFiles(
  platform,
  { repoRootValue = repoRoot, appDirValue = appDir, log = console.log } = {},
) {
  const templateRoot = resolvePlatformTemplateRoot(platform, { repoRootValue });
  const templateFiles = PLATFORM_TEMPLATE_FILES[platform];

  if (
    !templateRoot ||
    !Array.isArray(templateFiles) ||
    templateFiles.length === 0
  ) {
    return [];
  }

  const targetRoot = path.join(appDirValue, platform);
  const copiedFiles = [];
  const copiedFileSet = new Set();

  for (const relativeEntry of templateFiles) {
    const relativeFiles = collectTemplateFiles(templateRoot, relativeEntry);
    for (const relativeFile of relativeFiles) {
      if (copiedFileSet.has(relativeFile)) {
        continue;
      }
      copiedFileSet.add(relativeFile);

      const sourcePath = path.join(templateRoot, relativeFile);
      const destinationPath = path.join(targetRoot, relativeFile);
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
      copiedFiles.push(relativeFile);
    }
  }

  if (copiedFiles.length > 0) {
    log(
      `[mobile-build] Synced ${platform} platform template files: ${copiedFiles.join(", ")}`,
    );
  }

  return copiedFiles;
}

function collectTemplateFiles(templateRoot, relativeEntry) {
  const sourcePath = path.join(templateRoot, relativeEntry);
  if (!fs.existsSync(sourcePath)) {
    return [];
  }

  const stat = fs.statSync(sourcePath);
  if (stat.isFile()) {
    return [relativeEntry];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const entries = fs.readdirSync(sourcePath, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const childRelativePath = path.join(relativeEntry, entry.name);
    if (entry.isDirectory()) {
      return collectTemplateFiles(templateRoot, childRelativePath);
    }
    if (entry.isFile()) {
      return [childRelativePath];
    }
    return [];
  });
}

function getCapacitorPlatformRoot(platform) {
  return platform === "android" ? androidDir : iosPlatformDir;
}

function resolveNativePluginRoot(pluginName) {
  return firstExisting([
    path.join(repoRoot, "eliza", "packages", "native-plugins", pluginName),
    path.join(repoRoot, "packages", "native-plugins", pluginName),
  ]);
}

export function isCapacitorPlatformReady(
  platform,
  { appDirValue = appDir } = {},
) {
  const androidDirValue = path.join(appDirValue, "android");
  const iosDirValue = path.join(appDirValue, "ios", "App");

  if (platform === "android") {
    return (
      fs.existsSync(path.join(androidDirValue, "gradlew")) &&
      fs.existsSync(path.join(androidDirValue, "app", "build.gradle"))
    );
  }

  return (
    fs.existsSync(path.join(iosDirValue, "Podfile")) &&
    fs.existsSync(path.join(iosDirValue, "App.xcodeproj", "project.pbxproj"))
  );
}

async function ensureCapacitorPlatform(platform) {
  if (isCapacitorPlatformReady(platform)) {
    return;
  }

  const syncedFiles = syncPlatformTemplateFiles(platform);
  if (syncedFiles.length > 0 && isCapacitorPlatformReady(platform)) {
    console.log(
      `[mobile-build] Repaired incomplete Capacitor ${platform} platform from shipped templates.`,
    );
    return;
  }

  const platformRootDir = getCapacitorPlatformRoot(platform);
  if (fs.existsSync(platformRootDir)) {
    if (process.env.CI !== "true") {
      throw new Error(
        `Capacitor ${platform} platform at ${platformRootDir} is incomplete and could not be repaired from shipped templates. Remove it or run 'bun x capacitor add ${platform}' before retrying.`,
      );
    }

    console.log(
      `[mobile-build] Recreating incomplete Capacitor ${platform} platform at ${platformRootDir}...`,
    );
    fs.rmSync(platformRootDir, { force: true, recursive: true });
  }

  console.log(
    `[mobile-build] Adding missing Capacitor ${platform} platform...`,
  );
  await run("bun", ["x", "capacitor", "add", platform], { cwd: appDir });
}

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
    androidPlatformSrc,
    "app",
    "src",
    "main",
    "java",
    "ai",
    "elizaos",
    "app",
  );
  const targetJavaDir = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    "ai",
    "elizaos",
    "app",
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
          content = content.replace(/^(package\s+[^;]+;)/m, `$1\n\n${rImport}`);
        }
      }

      fs.writeFileSync(path.join(targetJavaDir, file), content, "utf8");
    }
    console.log(
      "[mobile-build] Copied Android Java source files (GatewayConnectionService, MainActivity).",
    );
  }

  // -- Merge AndroidManifest.xml --
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
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
        manifest = manifest.replace("</manifest>", `    ${perm}\n</manifest>`);
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(manifestPath, manifest, "utf8");
      console.log(
        "[mobile-build] Merged permissions and service into AndroidManifest.xml.",
      );
    }
  }

  // -- Copy ProGuard rules --
  const srcProguard = path.join(
    androidPlatformSrc,
    "app",
    "proguard-rules.pro",
  );
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
    if (
      !gradle.includes("shrinkResources") &&
      gradle.includes("minifyEnabled true")
    ) {
      gradle = gradle.replace(
        "minifyEnabled true",
        "minifyEnabled true\n            shrinkResources true",
      );
      gradleChanged = true;
    }

    if (gradleChanged) {
      fs.writeFileSync(appBuildGradle, gradle, "utf8");
      console.log(
        "[mobile-build] Enabled release minification in app/build.gradle.",
      );
    }
  }
}

// ── iOS post-sync overlay ───────────────────────────────────────────────

/**
 * Plist key-value pairs to merge into the Capacitor-generated Info.plist.
 * Order: key line, then value line(s).
 */
const IOS_PLIST_ENTRIES = [
  {
    key: "NSCameraUsageDescription",
    value:
      "<string>This app uses your camera to capture photos and video when you ask it to.</string>",
  },
  {
    key: "NSMicrophoneUsageDescription",
    value:
      "<string>This app needs microphone access for voice wake, talk mode, and video capture.</string>",
  },
  {
    key: "NSLocationWhenInUseUsageDescription",
    value:
      "<string>This app uses your location to provide location-aware responses when you allow it.</string>",
  },
  {
    key: "NSLocationAlwaysAndWhenInUseUsageDescription",
    value:
      "<string>This app can share your location in the background so it stays up to date even when the app is not in use.</string>",
  },
  {
    key: "NSPhotoLibraryUsageDescription",
    value:
      "<string>This app accesses your photo library to attach and share photos or videos.</string>",
  },
  {
    key: "NSPhotoLibraryAddUsageDescription",
    value:
      "<string>This app saves captured photos and videos to your photo library.</string>",
  },
  {
    key: "NSHealthShareUsageDescription",
    value:
      "<string>This app reads your HealthKit sleep and biometric data to infer when you are asleep, awake, and ready for reminders.</string>",
  },
  {
    key: "NSHealthUpdateUsageDescription",
    value:
      "<string>This app does not write to HealthKit, but iOS requires this key when HealthKit capability is enabled.</string>",
  },
  {
    key: "NSSpeechRecognitionUsageDescription",
    value:
      "<string>This app uses on-device speech recognition to listen for voice commands and wake words.</string>",
  },
  {
    key: "NSLocalNetworkUsageDescription",
    value:
      "<string>This app discovers and connects to your elizaOS gateway on the local network.</string>",
  },
];

const IOS_BONJOUR_BLOCK = `\t<key>NSBonjourServices</key>
\t<array>
\t\t<string>_elizaos-gw._tcp</string>
\t</array>`;

// Enables BGAppRefreshTask (and BGProcessingTask) from BackgroundTasks so the
// MobileSignalsPlugin can poll HealthKit sleep/wake data while the app is
// backgrounded. Without these keys the task never fires and wake detection
// regresses to "next time the user foregrounds the app".
const IOS_BACKGROUND_MODES_BLOCK = `\t<key>UIBackgroundModes</key>
\t<array>
\t\t<string>fetch</string>
\t\t<string>processing</string>
\t</array>`;

const IOS_BGTASK_IDENTIFIERS_BLOCK = `\t<key>BGTaskSchedulerPermittedIdentifiers</key>
\t<array>
\t\t<string>ai.eliza.mobile-signals.sleep-refresh</string>
\t</array>`;

function replaceFileContent(filePath, replacements) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const current = fs.readFileSync(filePath, "utf8");
  let next = current;
  for (const [pattern, replacement] of replacements) {
    next = next.replace(pattern, replacement);
  }
  if (next === current) {
    return false;
  }

  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

export function applyIosAppIdentity({
  appDirValue = appDir,
  appId = APP.appId,
  appGroup = `group.${appId}`,
  developmentTeam = process.env.MILADY_IOS_DEVELOPMENT_TEAM ??
    process.env.ELIZA_IOS_DEVELOPMENT_TEAM ??
    null,
  log = console.log,
} = {}) {
  const iosAppRoot = path.join(appDirValue, "ios", "App");
  const appExtensionId = `${appId}.WebsiteBlockerContentExtension`;
  const changedFiles = [];
  const projectPath = path.join(iosAppRoot, "App.xcodeproj", "project.pbxproj");
  const projectReplacements = [
    [
      /PRODUCT_BUNDLE_IDENTIFIER = ai\.elizaos\.app\.WebsiteBlockerContentExtension;/g,
      `PRODUCT_BUNDLE_IDENTIFIER = ${appExtensionId};`,
    ],
    [
      /PRODUCT_BUNDLE_IDENTIFIER = ai\.elizaos\.app;/g,
      `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`,
    ],
  ];

  if (developmentTeam) {
    projectReplacements.push([
      /DEVELOPMENT_TEAM = [A-Z0-9]+;/g,
      `DEVELOPMENT_TEAM = ${developmentTeam};`,
    ]);
  }

  if (replaceFileContent(projectPath, projectReplacements)) {
    changedFiles.push(path.relative(iosAppRoot, projectPath));
  }

  const identityFiles = [
    path.join(iosAppRoot, "App", "App.entitlements"),
    path.join(iosAppRoot, "App", "ScreenTimeSupport.swift"),
    path.join(
      iosAppRoot,
      "App",
      "WebsiteBlockerContentExtension",
      "WebsiteBlockerContentExtension.entitlements",
    ),
    path.join(
      iosAppRoot,
      "App",
      "WebsiteBlockerContentExtension",
      "ActionRequestHandler.swift",
    ),
  ];

  for (const filePath of identityFiles) {
    if (
      replaceFileContent(filePath, [
        [/group\.ai\.elizaos\.app/g, appGroup],
        [/group\.com\.miladyai\.milady/g, appGroup],
      ])
    ) {
      changedFiles.push(path.relative(iosAppRoot, filePath));
    }
  }

  if (changedFiles.length > 0) {
    log(
      `[mobile-build] Applied iOS app identity (${appId}, ${appGroup}) to ${changedFiles.join(", ")}.`,
    );
  }

  return changedFiles;
}

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
      plist = plist.replace("</dict>", `${IOS_BONJOUR_BLOCK}\n</dict>`);
      changed = true;
    }

    // Add UIBackgroundModes if missing
    if (!plist.includes("UIBackgroundModes")) {
      plist = plist.replace(
        "</dict>",
        `${IOS_BACKGROUND_MODES_BLOCK}\n</dict>`,
      );
      changed = true;
    }

    // Add BGTaskSchedulerPermittedIdentifiers if missing
    if (!plist.includes("BGTaskSchedulerPermittedIdentifiers")) {
      plist = plist.replace(
        "</dict>",
        `${IOS_BGTASK_IDENTIFIERS_BLOCK}\n</dict>`,
      );
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(plistPath, plist, "utf8");
      console.log(
        "[mobile-build] Merged permission strings into iOS Info.plist.",
      );
    }
  }

  // -- Copy entitlements file --
  const srcEntitlements = path.join(
    iosPlatformSrc,
    "App",
    "App",
    "App.entitlements",
  );
  const targetEntitlements = path.join(targetAppDir, "App.entitlements");
  if (fs.existsSync(srcEntitlements)) {
    let entitlements = fs.readFileSync(srcEntitlements, "utf8");
    // Replace the generic app group with the Milady-specific one
    entitlements = entitlements.replace("group.ai.elizaos.app", APP.appGroup);
    fs.writeFileSync(targetEntitlements, entitlements, "utf8");
    console.log(
      `[mobile-build] Copied iOS entitlements (app group: ${APP.appGroup}).`,
    );
  }

  applyIosAppIdentity();

  // -- Copy AppDelegate.swift (Capacitor CLI template has broken API call) --
  const srcAppDelegate = path.join(
    iosPlatformSrc,
    "App",
    "App",
    "AppDelegate.swift",
  );
  if (fs.existsSync(srcAppDelegate)) {
    fs.copyFileSync(
      srcAppDelegate,
      path.join(targetAppDir, "AppDelegate.swift"),
    );
    console.log("[mobile-build] Copied iOS AppDelegate.swift.");
  }

  // -- Copy Fastlane config into the synced iOS project --
  // CI runs `bundle exec fastlane ...` from apps/app/ios and expects the
  // Gemfile + fastlane/ directory there. The canonical copies live in
  // packages/app-core/platforms/ios/; sync them so both local dev and CI
  // see the same signed-release tooling.
  const srcFastlaneDir = path.join(iosPlatformSrc, "fastlane");
  const targetFastlaneDir = path.join(appDir, "ios", "fastlane");
  if (fs.existsSync(srcFastlaneDir)) {
    fs.rmSync(targetFastlaneDir, { recursive: true, force: true });
    fs.cpSync(srcFastlaneDir, targetFastlaneDir, { recursive: true });
    console.log("[mobile-build] Copied iOS Fastlane config.");
  }
  const srcGemfile = path.join(iosPlatformSrc, "Gemfile");
  const targetGemfile = path.join(appDir, "ios", "Gemfile");
  if (fs.existsSync(srcGemfile)) {
    fs.copyFileSync(srcGemfile, targetGemfile);
    console.log("[mobile-build] Copied iOS Gemfile.");
  }

  // -- Patch xcconfigs to include CocoaPods settings --
  // Capacitor generates debug/release xcconfigs that the Xcode project uses
  // as base configurations. CocoaPods needs its own xcconfig included too.
  for (const config of ["debug", "release"]) {
    const xcPath = path.join(appDir, "ios", `${config}.xcconfig`);
    if (fs.existsSync(xcPath)) {
      let xc = fs.readFileSync(xcPath, "utf8");
      const include = `#include "App/Pods/Target Support Files/Pods-App/Pods-App.${config}.xcconfig"`;
      if (!xc.includes(include)) {
        xc = `${include}\n${xc}`;
        fs.writeFileSync(xcPath, xc, "utf8");
      }
    }
  }

  // -- Generate Podfile for CocoaPods integration --
  // SPM binary xcframeworks have known API mismatches with plugin source.
  // CocoaPods compiles Capacitor from source alongside plugins, avoiding this.
  generateIosPodfile();
}

function validateIosScreenTimeNativeFiles() {
  const mobileSignalsRoot = resolveNativePluginRoot("mobile-signals");
  const provisioningProfilePath =
    process.env.MOBILE_SIGNALS_IOS_PROVISIONING_PROFILE ||
    firstExisting([
      path.join(appDir, "ios", "App", "App", "embedded.mobileprovision"),
    ]);

  const result = assertIosScreenTimeBuildWiring({
    entitlementsPath: path.join(
      appDir,
      "ios",
      "App",
      "App",
      "App.entitlements",
    ),
    projectPath: path.join(
      appDir,
      "ios",
      "App",
      "App.xcodeproj",
      "project.pbxproj",
    ),
    podspecPath: path.join(
      mobileSignalsRoot ??
        path.join(repoRoot, "packages", "native-plugins", "mobile-signals"),
      "ElizaosCapacitorMobileSignals.podspec",
    ),
    provisioningProfilePath,
    requireProvisioningProfile:
      process.env.MOBILE_SIGNALS_REQUIRE_IOS_PROVISIONING_PROFILE === "1",
  });

  const skippedProvisioning = result.checks.some(
    (check) => check.id === "provisioning-entitlements" && check.skipped,
  );
  console.log(
    `[mobile-build] Validated iOS Screen Time entitlements and build wiring${
      skippedProvisioning ? " (provisioning profile not supplied)" : ""
    }.`,
  );
}

/**
 * Resolve the real path to a node_modules package, following symlinks
 * through bun's store. Returns a path relative to the Podfile directory
 * (apps/app/ios/App/).
 */
function resolveCapacitorPodPath(pkgName) {
  const linked = path.join(appDir, "node_modules", ...pkgName.split("/"));
  if (!fs.existsSync(linked)) return null;
  const real = fs.realpathSync(linked);
  return path.relative(path.join(appDir, "ios", "App"), real);
}

function generateIosPodfile() {
  const podfileDir = path.join(appDir, "ios", "App");
  const iosPath = resolveCapacitorPodPath("@capacitor/ios");
  if (!iosPath) {
    console.warn(
      "[mobile-build] Could not resolve @capacitor/ios — skipping Podfile generation.",
    );
    return;
  }

  // All official plugins compile fine from source via CocoaPods. The errors
  // only occur with the precompiled SPM binary (capacitor-swift-pm) which
  // gates APIs behind $NonescapableTypes (a Swift 6.2/Xcode 26 feature).
  // These same plugins are stripped from SPM by patchIosPluginSwiftCompat().
  const pluginPods = [
    ["CapacitorApp", "@capacitor/app"],
    ["CapacitorKeyboard", "@capacitor/keyboard"],
    ["CapacitorPreferences", "@capacitor/preferences"],
    ["CapacitorStatusBar", "@capacitor/status-bar"],
    ["LlamaCppCapacitor", "llama-cpp-capacitor"],
  ];

  const nativePluginPods = [
    ["ElizaosCapacitorAgent", "agent"],
    ["ElizaosCapacitorCamera", "camera"],
    ["ElizaosCapacitorCanvas", "canvas"],
    ["ElizaosCapacitorGateway", "gateway"],
    ["ElizaosCapacitorLocation", "location"],
    ["ElizaosCapacitorMobileSignals", "mobile-signals"],
    ["ElizaosCapacitorScreencapture", "screencapture"],
    ["ElizaosCapacitorSwabble", "swabble"],
    ["ElizaosCapacitorTalkmode", "talkmode"],
    ["ElizaosCapacitorWebsiteblocker", "websiteblocker"],
  ];

  const podLines = [];
  podLines.push(`  pod 'Capacitor', :path => '${iosPath}'`);
  podLines.push(`  pod 'CapacitorCordova', :path => '${iosPath}'`);

  for (const [podName, npmPkg] of pluginPods) {
    const p = resolveCapacitorPodPath(npmPkg);
    if (p) podLines.push(`  pod '${podName}', :path => '${p}'`);
  }

  const nativePluginsBase = path.relative(
    podfileDir,
    path.join(repoRoot, "eliza", "packages", "native-plugins"),
  );
  for (const [podName, dirName] of nativePluginPods) {
    const pluginDir = path.join(
      repoRoot,
      "eliza",
      "packages",
      "native-plugins",
      dirName,
    );
    if (fs.existsSync(pluginDir)) {
      podLines.push(
        `  pod '${podName}', :path => '${nativePluginsBase}/${dirName}'`,
      );
    }
  }

  const podfile = `require_relative '${iosPath}/scripts/pods_helpers'

platform :ios, '15.0'
use_frameworks!

install! 'cocoapods', :disable_input_output_paths => true

def capacitor_pods
${podLines.join("\n")}
end

target 'App' do
  capacitor_pods
end

post_install do |installer|
  assertDeploymentTarget(installer)
end
`;

  fs.writeFileSync(path.join(podfileDir, "Podfile"), podfile, "utf8");
  console.log("[mobile-build] Generated Podfile for CocoaPods integration.");
}

/**
 * Strip official Capacitor plugins from SPM Package.swift.
 *
 * The capacitor-swift-pm xcframework was built with Xcode 26 / Swift 6.2.
 * Its .swiftinterface files gate APIs behind $NonescapableTypes, making
 * them invisible to Xcode 16. These plugins compile fine from source via
 * CocoaPods (included in the Podfile), so we only strip them from SPM to
 * prevent Xcode from trying to build them through the broken binary path.
 *
 * This becomes a no-op once the project uses Xcode 26+.
 */
function patchIosPluginSwiftCompat() {
  const packageSwiftPath = path.join(
    appDir,
    "ios",
    "App",
    "CapApp-SPM",
    "Package.swift",
  );
  if (!fs.existsSync(packageSwiftPath)) return;

  let content = fs.readFileSync(packageSwiftPath, "utf8");
  const incompatible = [
    "CapacitorStatusBar",
    "CapacitorPreferences",
    "CapacitorApp",
  ];
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
  if (
    !fs.existsSync(targetPath) ||
    !fs.existsSync(androidBuildGradleTemplate)
  ) {
    return;
  }

  const current = fs.readFileSync(targetPath, "utf8");
  const template = fs.readFileSync(androidBuildGradleTemplate, "utf8");
  if (current === template) {
    return;
  }

  fs.writeFileSync(targetPath, template, "utf8");
  console.log(
    "[mobile-build] Patched android/build.gradle for native plugins.",
  );
}

function ensureAndroidVariablesPatched() {
  const targetPath = path.join(androidDir, "variables.gradle");
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const current = fs.readFileSync(targetPath, "utf8");
  const next = current.replace(/minSdkVersion\s*=\s*\d+/, "minSdkVersion = 26");
  if (next === current) {
    return;
  }

  fs.writeFileSync(targetPath, next, "utf8");
  console.log("[mobile-build] Raised android minSdkVersion to 26.");
}

async function ensureIosWorkspace() {
  if (fs.existsSync(iosWorkspacePath)) {
    return;
  }

  console.log("[mobile-build] Running CocoaPods install for iOS workspace...");
  await run("pod", ["install"], { cwd: iosDir });

  if (!fs.existsSync(iosWorkspacePath)) {
    throw new Error(
      `Expected iOS workspace at ${iosWorkspacePath} after pod install.`,
    );
  }
}

export function shouldRunIosPodInstall(syncedFiles = []) {
  return syncedFiles.includes(path.join("App", "Podfile"));
}

export function resolveIosBuildTarget({
  env = process.env,
  appDirValue = appDir,
} = {}) {
  const explicitDestination =
    env.MILADY_IOS_BUILD_DESTINATION ?? env.ELIZA_IOS_BUILD_DESTINATION;
  const explicitSdk = env.MILADY_IOS_BUILD_SDK ?? env.ELIZA_IOS_BUILD_SDK;

  if (explicitDestination || explicitSdk) {
    return {
      destination: explicitDestination ?? "generic/platform=iOS Simulator",
      sdk: explicitSdk ?? "iphonesimulator",
      reason: "explicit environment override",
    };
  }

  const llamaCppFramework = path.join(
    appDirValue,
    "node_modules",
    "llama-cpp-capacitor",
    "ios",
    "Frameworks",
    "llama-cpp.framework",
    "llama-cpp",
  );

  if (fs.existsSync(llamaCppFramework)) {
    return {
      destination: "generic/platform=iOS",
      sdk: "iphoneos",
      reason: "llama-cpp-capacitor ships a device iOS framework",
    };
  }

  return {
    destination: "generic/platform=iOS Simulator",
    sdk: "iphonesimulator",
    reason: "default simulator build",
  };
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

  await buildSharedApp("android");
  await ensureCapacitorPlatform("android");
  await run("bun", ["run", "cap:sync:android"], { cwd: appDir });
  syncPlatformTemplateFiles("android");
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

  await buildSharedApp("ios");
  await ensureCapacitorPlatform("ios");
  await run("bash", [prepareIosCocoapodsScript], { cwd: repoRoot });
  await run("bun", ["run", "cap:sync:ios"], { cwd: appDir });
  const syncedFiles = syncPlatformTemplateFiles("ios");
  overlayIosNativeFiles();
  validateIosScreenTimeNativeFiles();

  // Always strip incompatible official plugins from SPM Package.swift.
  // Xcode compiles SPM targets regardless of whether CocoaPods is used.
  patchIosPluginSwiftCompat();

  if (shouldRunIosPodInstall(syncedFiles)) {
    console.log(
      "[mobile-build] Re-running CocoaPods install after syncing the iOS Podfile...",
    );
    await run("pod", ["install"], { cwd: iosDir });
  }
  await ensureIosWorkspace();
  const iosBuildTarget = resolveIosBuildTarget();
  console.log(
    `[mobile-build] Building iOS with ${iosBuildTarget.sdk} (${iosBuildTarget.reason}).`,
  );
  await run(
    "xcodebuild",
    [
      "-workspace",
      "App.xcworkspace",
      "-scheme",
      "App",
      "-configuration",
      "Debug",
      "-destination",
      iosBuildTarget.destination,
      "-sdk",
      iosBuildTarget.sdk,
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ],
    { cwd: iosDir },
  );
}

export async function syncIosOverlay() {
  overlayIosNativeFiles();
}

export async function main(target = process.argv[2]) {
  if (
    target !== "android" &&
    target !== "ios" &&
    target !== "ios-overlay"
  ) {
    console.error(
      "Usage: node scripts/run-mobile-build.mjs <android|ios|ios-overlay>",
    );
    process.exit(1);
  }

  if (target === "android") {
    await buildAndroid();
    return;
  }

  if (target === "ios-overlay") {
    await syncIosOverlay();
    return;
  }

  await buildIos();
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
