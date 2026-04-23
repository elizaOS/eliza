#!/usr/bin/env node
/**
 * Mobile build orchestrator for elizaOS apps.
 *
 * Builds an iOS or Android app from any elizaOS host app (Milady, etc.).
 * Reads app identity from the host's app.config.ts so web, desktop, and
 * native builds share one canonical app contract.
 *
 * Usage: node scripts/run-mobile-build.mjs <android|android-system|ios|ios-overlay>
 *
 * Phases:
 *   1. Resolve config  — read app.config.ts for appId / appName
 *   2. Build web        — vite build → dist/
 *   3. Capacitor sync   — generate native platform projects
 *   4. Overlay native   — permissions, services, entitlements, Podfile
 *   5. Platform patches — Gradle template, SPM compat, xcconfig
 *   6. Native build     — gradlew / xcodebuild
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertIosScreenTimeBuildWiring } from "../../native-plugins/mobile-signals/scripts/validate-ios-screen-time.mjs";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

// ── Paths ───────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const appDir = path.join(repoRoot, "apps", "app");
const iosPlatformDir = path.join(appDir, "ios");
const iosDir = path.join(appDir, "ios", "App");
const androidDir = path.join(appDir, "android");
const miladyOsVendorDir = path.join(repoRoot, "os", "android", "vendor", "milady");
const miladyOsApkDir = path.join(miladyOsVendorDir, "apps", "Milady");
const platformsDir = path.join(
  repoRoot,
  "eliza",
  "packages",
  "app-core",
  "platforms",
);
const nativePluginsDir = path.join(
  repoRoot,
  "eliza",
  "packages",
  "native-plugins",
);
const iosWorkspacePath = path.join(iosDir, "App.xcworkspace");

// ── Phase 1: Resolve app identity from app.config.ts ────────────────────

function readAppIdentity() {
  const cfgPath = path.join(appDir, "app.config.ts");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`app.config.ts not found at ${cfgPath}`);
  }
  const src = fs.readFileSync(cfgPath, "utf8");
  const appId = src.match(/appId:\s*["']([^"']+)["']/)?.[1];
  const appName = src.match(/appName:\s*["']([^"']+)["']/)?.[1];
  const urlScheme =
    src.match(/urlScheme:\s*["']([^"']+)["']/)?.[1] ?? appId;
  if (!appId || !appName) {
    throw new Error("Could not parse appId/appName from app.config.ts");
  }
  return { appId, appName, urlScheme };
}

const APP = readAppIdentity();
console.log(`[mobile-build] App: ${APP.appName} (${APP.appId})`);

// ── Helpers ─────────────────────────────────────────────────────────────

function run(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`${command} killed by ${signal}`));
      if ((code ?? 1) !== 0)
        return reject(new Error(`${command} exited with code ${code ?? 1}`));
      resolve();
    });
  });
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
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

function prependPath(env, entries) {
  const sep = process.platform === "win32" ? ";" : ":";
  const valid = entries.filter(Boolean);
  return valid.length
    ? `${valid.join(sep)}${sep}${env.PATH ?? ""}`
    : (env.PATH ?? "");
}

function escapeJavaString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeXmlText(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Resolve the real filesystem path to a node_modules package (follows bun
 * symlinks). Returns a path relative to `relativeTo`.
 */
function resolvePackagePath(pkgName, relativeTo) {
  const linked = path.join(appDir, "node_modules", ...pkgName.split("/"));
  if (!fs.existsSync(linked)) return null;
  return path.relative(relativeTo, fs.realpathSync(linked));
}

function collectTemplateFiles(root, dir = root) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTemplateFiles(root, fullPath));
    } else if (entry.isFile()) {
      files.push(path.relative(root, fullPath));
    }
  }
  return files;
}

function templateFilePriority(platform, relPath) {
  if (platform !== "ios") return relPath;
  const priority = [
    path.join("App", "Podfile"),
    path.join("App", "App.xcodeproj", "project.pbxproj"),
    path.join("App", "App", "Base.lproj", "LaunchScreen.storyboard"),
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
  ];
  const index = priority.indexOf(relPath);
  return `${String(index === -1 ? priority.length : index).padStart(4, "0")}:${relPath}`;
}

export function resolvePlatformTemplateRoot(
  platform,
  { repoRootValue = repoRoot } = {},
) {
  const templateRoot = path.join(
    repoRootValue,
    "eliza",
    "packages",
    "app-core",
    "platforms",
    platform,
  );
  return fs.existsSync(templateRoot) ? templateRoot : null;
}

export function syncPlatformTemplateFiles(
  platform,
  { repoRootValue = repoRoot, appDirValue = appDir, log = console.log } = {},
) {
  const templateRoot = resolvePlatformTemplateRoot(platform, { repoRootValue });
  if (!templateRoot) return [];
  const targetRoot = path.join(appDirValue, platform);
  const files = collectTemplateFiles(templateRoot).sort((a, b) =>
    templateFilePriority(platform, a).localeCompare(
      templateFilePriority(platform, b),
    ),
  );
  const copied = [];
  for (const relPath of files) {
    const source = path.join(templateRoot, relPath);
    const targetPath = path.join(targetRoot, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(source, targetPath);
    copied.push(relPath);
  }
  if (copied.length > 0) {
    log(
      `[mobile-build] Synced ${copied.length} ${platform} platform template file(s).`,
    );
  }
  return copied;
}

export function isCapacitorPlatformReady(
  platform,
  { appDirValue = appDir } = {},
) {
  if (platform === "ios") {
    return (
      fs.existsSync(path.join(appDirValue, "ios", "App", "Podfile")) &&
      fs.existsSync(
        path.join(
          appDirValue,
          "ios",
          "App",
          "App.xcodeproj",
          "project.pbxproj",
        ),
      )
    );
  }
  if (platform === "android") {
    return (
      fs.existsSync(path.join(appDirValue, "android", "gradlew")) &&
      fs.existsSync(path.join(appDirValue, "android", "app", "build.gradle"))
    );
  }
  return false;
}

function replaceInFile(filePath, replacements) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;
  for (const [search, replacement] of replacements) {
    content = content.replaceAll(search, replacement);
  }
  if (content === original) return false;
  fs.writeFileSync(filePath, content, "utf8");
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
  const changed = [];
  const projectPath = path.join(iosAppRoot, "App.xcodeproj", "project.pbxproj");
  if (fs.existsSync(projectPath)) {
    let project = fs.readFileSync(projectPath, "utf8");
    const original = project;
    project = project.replaceAll(
      "PRODUCT_BUNDLE_IDENTIFIER = ai.elizaos.app.WebsiteBlockerContentExtension;",
      `PRODUCT_BUNDLE_IDENTIFIER = ${appId}.WebsiteBlockerContentExtension;`,
    );
    project = project.replaceAll(
      "PRODUCT_BUNDLE_IDENTIFIER = ai.elizaos.app;",
      `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`,
    );
    if (developmentTeam) {
      project = project.replace(
        /DEVELOPMENT_TEAM = [A-Z0-9]+;/g,
        `DEVELOPMENT_TEAM = ${developmentTeam};`,
      );
    }
    if (project !== original) {
      fs.writeFileSync(projectPath, project, "utf8");
      changed.push(path.relative(iosAppRoot, projectPath));
    }
  }

  const replacements = [
    ["group.ai.elizaos.app", appGroup],
    ['"group.ai.elizaos.app"', `"${appGroup}"`],
  ];
  for (const relPath of [
    path.join("App", "App.entitlements"),
    path.join("App", "ScreenTimeSupport.swift"),
    path.join(
      "App",
      "WebsiteBlockerContentExtension",
      "WebsiteBlockerContentExtension.entitlements",
    ),
    path.join(
      "App",
      "WebsiteBlockerContentExtension",
      "ActionRequestHandler.swift",
    ),
  ]) {
    const filePath = path.join(iosAppRoot, relPath);
    if (replaceInFile(filePath, replacements)) {
      changed.push(relPath);
    }
  }

  const extensionId = `${appId}.WebsiteBlockerContentExtension`;
  const fastlaneReplacements = [
    [
      'ENV["APP_IDENTIFIER"] || "ai.elizaos.app"',
      `ENV["APP_IDENTIFIER"] || "${appId}"`,
    ],
    [
      'ENV["APP_IDENTIFIER_EXTRA"] || ""',
      `ENV["APP_IDENTIFIER_EXTRA"] || "${extensionId}"`,
    ],
  ];
  for (const relPath of [
    path.join("fastlane", "Appfile"),
    path.join("fastlane", "Fastfile"),
    path.join("fastlane", "Matchfile"),
  ]) {
    const filePath = path.join(path.dirname(iosAppRoot), relPath);
    if (replaceInFile(filePath, fastlaneReplacements)) {
      changed.push(relPath);
    }
  }
  if (changed.length > 0) {
    log(`[mobile-build] Applied iOS identity ${appId}.`);
  }
  return changed;
}

// ── Phase 2: Build web bundle ───────────────────────────────────────────

async function buildWeb() {
  await run("bun", ["scripts/build.mjs"], { cwd: appDir });
}

// ── Phase 3: Capacitor sync ────────────────────────────────────────────

async function ensurePlatform(platform) {
  const dir = platform === "android" ? androidDir : iosDir;
  if (!fs.existsSync(dir)) {
    console.log(`[mobile-build] Adding Capacitor ${platform} platform...`);
    await run("bun", ["x", "capacitor", "add", platform], { cwd: appDir });
  }
  if (!isCapacitorPlatformReady(platform)) {
    syncPlatformTemplateFiles(platform);
  }
}

// ── Phase 4: Android native overlay ─────────────────────────────────────

/** Permissions that Capacitor sync doesn't generate (it only adds INTERNET). */
const ANDROID_PERMISSIONS = [
  "READ_CONTACTS",
  "WRITE_CONTACTS",
  "CALL_PHONE",
  "READ_PHONE_STATE",
  "ANSWER_PHONE_CALLS",
  "MANAGE_OWN_CALLS",
  "READ_CALL_LOG",
  "WRITE_CALL_LOG",
  "READ_SMS",
  "SEND_SMS",
  "RECEIVE_SMS",
  "RECEIVE_MMS",
  "RECEIVE_WAP_PUSH",
  "RECORD_AUDIO",
  "CAMERA",
  "ACCESS_FINE_LOCATION",
  "ACCESS_COARSE_LOCATION",
  "ACCESS_BACKGROUND_LOCATION",
  "FOREGROUND_SERVICE",
  "FOREGROUND_SERVICE_DATA_SYNC",
  "POST_NOTIFICATIONS",
  "WAKE_LOCK",
];

function replaceOrInsertGradleString(content, key, value) {
  const quoted = `${key} "${value}"`;
  const assignmentRe = new RegExp(`${key}\\s+["'][^"']+["']`);
  if (assignmentRe.test(content)) {
    return content.replace(assignmentRe, quoted);
  }
  return content;
}

function appendMissingGradleDependency(content, notation) {
  if (content.includes(notation)) return content;
  return content.replace(
    /dependencies\s*\{/,
    `dependencies {\n    implementation "${notation}"`,
  );
}

function appendMissingAndroidManifestBlock(xml, marker, block) {
  if (xml.includes(marker)) return xml;
  return xml.replace("</manifest>", `${block}\n</manifest>`);
}

function appendMissingApplicationBlock(xml, marker, block) {
  if (xml.includes(marker)) return xml;
  return xml.replace("</application>", `${block}\n    </application>`);
}

function ensureMiladyOsActivityFilters(xml) {
  if (xml.includes("android.intent.category.HOME")) {
    return xml;
  }
  const mainActivityRe =
    /(<activity\b(?=[\s\S]*?android:name="\.?MainActivity")[\s\S]*?)(\n\s*<\/activity>)/m;
  const homeFilter = `
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.HOME" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
`;
  return xml.replace(mainActivityRe, `$1${homeFilter}$2`);
}

function overlayAndroid() {
  const srcJava = path.join(
    platformsDir,
    "android",
    "app",
    "src",
    "main",
    "java",
    "ai",
    "elizaos",
    "app",
  );
  const gradlePath = path.join(androidDir, "app", "build.gradle");
  const namespace = fs.existsSync(gradlePath)
    ? fs
        .readFileSync(gradlePath, "utf8")
        .match(/namespace\s*(?:[=:]\s*)?["']([^"']+)["']/)?.[1]
    : APP.appId;
  const androidPackage = namespace || APP.appId;
  const dstJava = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    ...androidPackage.split("."),
  );
  const legacyJava = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    "ai",
    "elizaos",
    "app",
  );
  const appIdJava = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    ...APP.appId.split("."),
  );

  if (fs.existsSync(srcJava)) {
    for (const staleJava of [legacyJava, appIdJava]) {
      if (staleJava !== dstJava) {
        fs.rmSync(staleJava, { recursive: true, force: true });
      }
    }
    fs.mkdirSync(dstJava, { recursive: true });
    for (const file of [
      "GatewayConnectionService.java",
      "MainActivity.java",
      "MiladyAssistActivity.java",
      "MiladyBootReceiver.java",
      "MiladyDialActivity.java",
      "MiladyInCallService.java",
      "MiladyMmsReceiver.java",
      "MiladySmsReceiver.java",
    ]) {
      const src = path.join(srcJava, file);
      if (!fs.existsSync(src)) continue;
      let code = fs.readFileSync(src, "utf8");
      code = code.replace(
        /^package\s+ai\.elizaos\.app;/m,
        `package ${androidPackage};`,
      );
      code = code.replaceAll(
        "ai.elizaos.app.action.",
        `${androidPackage}.action.`,
      );
      code = code.replaceAll("ai.elizaos.app://", `${APP.urlScheme}://`);
      code = code.replaceAll(
        "elizaOS Gateway",
        `${escapeJavaString(APP.appName)} Gateway`,
      );
      code = code.replaceAll(
        "Shows elizaOS gateway connection status",
        `Shows ${escapeJavaString(APP.appName)} gateway connection status`,
      );
      fs.writeFileSync(path.join(dstJava, file), code, "utf8");
    }
    console.log("[mobile-build] Overlaid Android Java sources.");
  }

  // Merge AndroidManifest.xml
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (fs.existsSync(manifestPath)) {
    let xml = fs.readFileSync(manifestPath, "utf8");
    let dirty = false;

    if (!xml.includes("usesCleartextTraffic")) {
      xml = xml.replace(
        "<application",
        '<application\n        android:usesCleartextTraffic="true"',
      );
      dirty = true;
    }
    if (!xml.includes("<queries>")) {
      xml = xml.replace(
        /(\s*)<application/,
        '\n    <queries>\n        <package android:name="com.google.android.apps.healthdata" />\n    </queries>\n\n    <application',
      );
      dirty = true;
    }
    xml = appendMissingAndroidManifestBlock(
      xml,
      "android.hardware.telephony",
      '    <uses-feature android:name="android.hardware.telephony" android:required="false" />',
    );
    xml = ensureMiladyOsActivityFilters(xml);
    const gatewayServiceName = `${androidPackage}.GatewayConnectionService`;
    const gatewayServicePattern =
      /\n\s*<service\b[^>]*android:name="[^"]*GatewayConnectionService"[^>]*\/>\s*/g;
    const withoutGatewayServices = xml.replace(gatewayServicePattern, "\n");
    if (withoutGatewayServices !== xml) {
      xml = withoutGatewayServices;
      dirty = true;
    }
    xml = xml.replace(
      "</application>",
      `\n        <service\n            android:name="${gatewayServiceName}"\n            android:exported="false"\n            android:foregroundServiceType="dataSync" />\n    </application>`,
    );
    dirty = true;
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.MiladyDialActivity`,
      `
        <activity
            android:name="${androidPackage}.MiladyDialActivity"
            android:exported="true"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.DIAL" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:scheme="tel" />
            </intent-filter>
        </activity>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.MiladyAssistActivity`,
      `
        <activity
            android:name="${androidPackage}.MiladyAssistActivity"
            android:exported="true"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.ASSIST" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.MiladyInCallService`,
      `
        <service
            android:name="${androidPackage}.MiladyInCallService"
            android:exported="true"
            android:permission="android.permission.BIND_INCALL_SERVICE">
            <meta-data
                android:name="android.telecom.IN_CALL_SERVICE_UI"
                android:value="true" />
            <meta-data
                android:name="android.telecom.IN_CALL_SERVICE_RINGING"
                android:value="true" />
            <intent-filter>
                <action android:name="android.telecom.InCallService" />
            </intent-filter>
        </service>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.MiladySmsReceiver`,
      `
        <receiver
            android:name="${androidPackage}.MiladySmsReceiver"
            android:exported="true"
            android:permission="android.permission.BROADCAST_SMS">
            <intent-filter>
                <action android:name="android.provider.Telephony.SMS_DELIVER" />
            </intent-filter>
        </receiver>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.MiladyMmsReceiver`,
      `
        <receiver
            android:name="${androidPackage}.MiladyMmsReceiver"
            android:exported="true"
            android:permission="android.permission.BROADCAST_WAP_PUSH">
            <intent-filter>
                <action android:name="android.provider.Telephony.WAP_PUSH_DELIVER" />
                <data android:mimeType="application/vnd.wap.mms-message" />
            </intent-filter>
        </receiver>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.MiladyBootReceiver`,
      `
        <receiver
            android:name="${androidPackage}.MiladyBootReceiver"
            android:directBootAware="true"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.LOCKED_BOOT_COMPLETED" />
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>`,
    );
    dirty = true;
    for (const perm of ANDROID_PERMISSIONS) {
      const full = `android.permission.${perm}`;
      if (!xml.includes(full)) {
        xml = xml.replace(
          "</manifest>",
          `    <uses-permission android:name="${full}" />\n</manifest>`,
        );
        dirty = true;
      }
    }
    // Storage permissions with maxSdkVersion
    if (!xml.includes("WRITE_EXTERNAL_STORAGE")) {
      xml = xml.replace(
        "</manifest>",
        '    <uses-permission\n        android:name="android.permission.WRITE_EXTERNAL_STORAGE"\n        android:maxSdkVersion="28" />\n</manifest>',
      );
      dirty = true;
    }
    if (!xml.includes("READ_EXTERNAL_STORAGE")) {
      xml = xml.replace(
        "</manifest>",
        '    <uses-permission\n        android:name="android.permission.READ_EXTERNAL_STORAGE"\n        android:maxSdkVersion="32" />\n</manifest>',
      );
      dirty = true;
    }
    if (dirty) {
      fs.writeFileSync(manifestPath, xml, "utf8");
      console.log(
        "[mobile-build] Merged permissions and service into AndroidManifest.xml.",
      );
    }
  }

  // Copy ProGuard rules
  const srcPro = path.join(
    platformsDir,
    "android",
    "app",
    "proguard-rules.pro",
  );
  if (fs.existsSync(srcPro)) {
    fs.copyFileSync(srcPro, path.join(androidDir, "app", "proguard-rules.pro"));
    console.log("[mobile-build] Copied ProGuard rules.");
  }

  // Enable release minification
  if (fs.existsSync(gradlePath)) {
    let g = fs.readFileSync(gradlePath, "utf8");
    if (g.includes("minifyEnabled false")) {
      g = g.replace(
        "minifyEnabled false",
        "minifyEnabled true\n            shrinkResources true",
      );
      fs.writeFileSync(gradlePath, g, "utf8");
      console.log("[mobile-build] Enabled release minification.");
    }
  }
}

// ── Phase 4: iOS native overlay ─────────────────────────────────────────

const IOS_PERMISSION_KEYS = [
  [
    "NSCameraUsageDescription",
    "This app uses your camera to capture photos and video when you ask it to.",
  ],
  [
    "NSMicrophoneUsageDescription",
    "This app needs microphone access for voice wake, talk mode, and video capture.",
  ],
  [
    "NSLocationWhenInUseUsageDescription",
    "This app uses your location to provide location-aware responses when you allow it.",
  ],
  [
    "NSLocationAlwaysAndWhenInUseUsageDescription",
    "This app can share your location in the background so it stays up to date even when the app is not in use.",
  ],
  [
    "NSPhotoLibraryUsageDescription",
    "This app accesses your photo library to attach and share photos or videos.",
  ],
  [
    "NSPhotoLibraryAddUsageDescription",
    "This app saves captured photos and videos to your photo library.",
  ],
  [
    "NSHealthShareUsageDescription",
    "This app reads your HealthKit sleep and biometric data to infer when you are asleep, awake, and ready for reminders.",
  ],
  [
    "NSHealthUpdateUsageDescription",
    "This app does not write to HealthKit, but iOS requires this key when HealthKit capability is enabled.",
  ],
  [
    "NSSpeechRecognitionUsageDescription",
    "This app uses on-device speech recognition to listen for voice commands and wake words.",
  ],
  [
    "NSLocalNetworkUsageDescription",
    "This app discovers and connects to your elizaOS gateway on the local network.",
  ],
];

const IOS_OFFICIAL_COMPATIBLE_PODS = [
  ["CapacitorKeyboard", "@capacitor/keyboard"],
];

const IOS_INCOMPATIBLE_SPM_PLUGINS = new Set([
  "CapacitorApp",
  "CapacitorPreferences",
  "CapacitorStatusBar",
]);

function overlayIos() {
  const targetAppDir = path.join(appDir, "ios", "App", "App");

  // Merge Info.plist permission strings
  const plistPath = path.join(targetAppDir, "Info.plist");
  if (fs.existsSync(plistPath)) {
    let plist = fs.readFileSync(plistPath, "utf8");
    let dirty = false;
    for (const [key, desc] of IOS_PERMISSION_KEYS) {
      if (!plist.includes(key)) {
        plist = plist.replace(
          "</dict>",
          `\t<key>${key}</key>\n\t<string>${desc}</string>\n</dict>`,
        );
        dirty = true;
      }
    }
    if (!plist.includes("NSBonjourServices")) {
      plist = plist.replace(
        "</dict>",
        `\t<key>NSBonjourServices</key>\n\t<array>\n\t\t<string>_elizaos-gw._tcp</string>\n\t</array>\n</dict>`,
      );
      dirty = true;
    }
    if (dirty) {
      fs.writeFileSync(plistPath, plist, "utf8");
      console.log("[mobile-build] Merged iOS permission strings.");
    }
  }

  // Copy entitlements with app group derived from appId
  const srcEnt = path.join(
    platformsDir,
    "ios",
    "App",
    "App",
    "App.entitlements",
  );
  if (fs.existsSync(srcEnt)) {
    let ent = fs.readFileSync(srcEnt, "utf8");
    ent = ent.replace("group.ai.elizaos.app", `group.${APP.appId}`);
    fs.writeFileSync(path.join(targetAppDir, "App.entitlements"), ent, "utf8");
    console.log(
      `[mobile-build] Copied iOS entitlements (app group: group.${APP.appId}).`,
    );
  }

  // Patch xcconfigs to include CocoaPods settings
  for (const cfg of ["debug", "release"]) {
    const xcPath = path.join(appDir, "ios", `${cfg}.xcconfig`);
    if (fs.existsSync(xcPath)) {
      let xc = fs.readFileSync(xcPath, "utf8");
      const inc = `#include "App/Pods/Target Support Files/Pods-App/Pods-App.${cfg}.xcconfig"`;
      if (!xc.includes(inc)) {
        fs.writeFileSync(xcPath, `${inc}\n${xc}`, "utf8");
      }
    }
  }

  // Generate Podfile
  generatePodfile();
  applyIosAppIdentity();
}

export function prepareIosOverlay() {
  const syncedFiles = syncPlatformTemplateFiles("ios");
  overlayIos();
  stripSpmIncompatiblePlugins();
  return syncedFiles;
}

function generatePodfile() {
  const podfileDir = path.join(appDir, "ios", "App");
  const iosPath = resolvePackagePath("@capacitor/ios", podfileDir);
  if (!iosPath) {
    console.warn(
      "[mobile-build] Could not resolve @capacitor/ios — skipping Podfile.",
    );
    return;
  }

  const customPods = [
    ["ElizaosCapacitorAgent", "agent"],
    ["ElizaosCapacitorAppblocker", "appblocker"],
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

  const lines = [
    `  pod 'Capacitor', :path => '${iosPath}'`,
    `  pod 'CapacitorCordova', :path => '${iosPath}'`,
  ];

  for (const [name, pkg] of IOS_OFFICIAL_COMPATIBLE_PODS) {
    const p = resolvePackagePath(pkg, podfileDir);
    if (p) lines.push(`  pod '${name}', :path => '${p}'`);
  }

  const pluginsRel = path.relative(podfileDir, nativePluginsDir);
  for (const [name, dir] of customPods) {
    if (fs.existsSync(path.join(nativePluginsDir, dir))) {
      lines.push(`  pod '${name}', :path => '${pluginsRel}/${dir}'`);
    }
  }

  fs.writeFileSync(
    path.join(podfileDir, "Podfile"),
    `\
require_relative '${iosPath}/scripts/pods_helpers'

platform :ios, '15.0'
use_frameworks!

install! 'cocoapods', :disable_input_output_paths => true

def capacitor_pods
${lines.join("\n")}
end

target 'App' do
  capacitor_pods
end

post_install do |installer|
  assertDeploymentTarget(installer)
end
`,
    "utf8",
  );
  console.log("[mobile-build] Generated Podfile.");
}

// ── Phase 5: Platform patches ───────────────────────────────────────────

/** Strip incompatible official plugins from SPM Package.swift. */
function stripSpmIncompatiblePlugins() {
  const pkgPath = path.join(
    appDir,
    "ios",
    "App",
    "CapApp-SPM",
    "Package.swift",
  );
  if (!fs.existsSync(pkgPath)) return;

  let content = fs.readFileSync(pkgPath, "utf8");
  const lines = content.split("\n");
  const filtered = lines.filter((line) => {
    for (const name of IOS_INCOMPATIBLE_SPM_PLUGINS) {
      if (line.includes(`"${name}"`)) return false;
    }
    return true;
  });
  let changed = filtered.length !== lines.length;
  content = filtered.join("\n");

  if (changed) {
    content = content.replace(/,(\s*[\]\)])/g, "$1").replace(/\n{3,}/g, "\n\n");
    fs.writeFileSync(pkgPath, content, "utf8");
    console.log(
      `[mobile-build] Stripped incompatible SPM plugins: ${Array.from(
        IOS_INCOMPATIBLE_SPM_PLUGINS,
      ).join(", ")}`,
    );
  }
}

function patchAndroidGradle() {
  // Overwrite root build.gradle with our template (Maven mirrors, Kotlin version)
  const templateGradle = path.join(platformsDir, "android", "build.gradle");
  const targetGradle = path.join(androidDir, "build.gradle");
  if (fs.existsSync(templateGradle) && fs.existsSync(targetGradle)) {
    const current = fs.readFileSync(targetGradle, "utf8");
    const template = fs.readFileSync(templateGradle, "utf8");
    if (current !== template) {
      fs.writeFileSync(targetGradle, template, "utf8");
      console.log("[mobile-build] Patched android/build.gradle.");
    }
  }

  // Keep generated Android projects aligned with current Capacitor/AndroidX requirements.
  const varsPath = path.join(androidDir, "variables.gradle");
  if (fs.existsSync(varsPath)) {
    const vars = fs.readFileSync(varsPath, "utf8");
    const patched = vars
      .replace(/minSdkVersion\s*=\s*\d+/, "minSdkVersion = 26")
      .replace(/compileSdkVersion\s*=\s*\d+/, "compileSdkVersion = 36");
    if (patched !== vars) {
      fs.writeFileSync(varsPath, patched, "utf8");
      console.log("[mobile-build] Patched Android SDK versions.");
    }
  }

  const appGradlePath = path.join(androidDir, "app", "build.gradle");
  if (fs.existsSync(appGradlePath)) {
    const current = fs.readFileSync(appGradlePath, "utf8");
    let patched = replaceOrInsertGradleString(current, "namespace", APP.appId);
    patched = replaceOrInsertGradleString(
      patched,
      "applicationId",
      APP.appId,
    );
    patched = appendMissingGradleDependency(
      patched,
      "com.google.code.gson:gson:2.13.2",
    );
    patched = appendMissingGradleDependency(
      patched,
      "com.google.firebase:firebase-common-ktx:20.3.3",
    );
    if (patched !== current) {
      fs.writeFileSync(appGradlePath, patched, "utf8");
      console.log(`[mobile-build] Applied Android package identity ${APP.appId}.`);
    }
  }

  const stringsPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "res",
    "values",
    "strings.xml",
  );
  if (fs.existsSync(stringsPath)) {
    const current = fs.readFileSync(stringsPath, "utf8");
    const appName = escapeXmlText(APP.appName);
    const appId = escapeXmlText(APP.appId);
    const urlScheme = escapeXmlText(APP.urlScheme);
    const patched = current
      .replace(
        /<string name="app_name">[^<]*<\/string>/,
        `<string name="app_name">${appName}</string>`,
      )
      .replace(
        /<string name="title_activity_main">[^<]*<\/string>/,
        `<string name="title_activity_main">${appName}</string>`,
      )
      .replace(
        /<string name="package_name">[^<]*<\/string>/,
        `<string name="package_name">${appId}</string>`,
      )
      .replace(
        /<string name="custom_url_scheme">[^<]*<\/string>/,
        `<string name="custom_url_scheme">${urlScheme}</string>`,
      );
    if (patched !== current) {
      fs.writeFileSync(stringsPath, patched, "utf8");
      console.log(`[mobile-build] Applied Android app strings for ${APP.appName}.`);
    }
  }
}

// ── Phase 6: Native builds ──────────────────────────────────────────────

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
  const sdk = resolveAndroidSdkRoot();
  const jdk = resolveJavaHome();
  if (!sdk)
    throw new Error(
      "Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME.",
    );
  if (!jdk) throw new Error("JDK 21 not found. Set JAVA_HOME.");

  await buildWeb();
  await ensurePlatform("android");
  await run("bun", ["run", "cap:sync:android"], { cwd: appDir });

  patchAndroidGradle();
  overlayAndroid();

  const env = {
    ...process.env,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    JAVA_HOME: jdk,
    PATH: prependPath(process.env, [
      path.join(jdk, "bin"),
      path.join(sdk, "platform-tools"),
    ]),
  };

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

function findAndroidSystemApk() {
  const candidates = [
    path.join(androidDir, "app", "build", "outputs", "apk", "release", "app-release-unsigned.apk"),
    path.join(androidDir, "app", "build", "outputs", "apk", "release", "app-release.apk"),
    path.join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
  ];
  return firstExisting(candidates);
}

function stageAndroidSystemApk() {
  const apk = findAndroidSystemApk();
  if (!apk) {
    throw new Error("No Android APK found to stage for MiladyOS.");
  }
  fs.mkdirSync(miladyOsApkDir, { recursive: true });
  const target = path.join(miladyOsApkDir, "Milady.apk");
  fs.copyFileSync(apk, target);
  console.log(`[mobile-build] Staged MiladyOS APK at ${target}.`);
}

async function buildAndroidSystem() {
  const sdk = resolveAndroidSdkRoot();
  const jdk = resolveJavaHome();
  if (!sdk)
    throw new Error(
      "Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME.",
    );
  if (!jdk) throw new Error("JDK 21 not found. Set JAVA_HOME.");

  await buildWeb();
  await ensurePlatform("android");
  await run("bun", ["run", "cap:sync:android"], { cwd: appDir });

  patchAndroidGradle();
  overlayAndroid();

  const env = {
    ...process.env,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    JAVA_HOME: jdk,
    PATH: prependPath(process.env, [
      path.join(jdk, "bin"),
      path.join(sdk, "platform-tools"),
    ]),
  };

  await run("./gradlew", [":app:assembleRelease"], {
    cwd: androidDir,
    env,
  });
  stageAndroidSystemApk();
}

async function buildIos() {
  if (process.platform !== "darwin")
    throw new Error("iOS builds require macOS and Xcode.");

  const cocoapodsScript = path.join(
    repoRoot,
    "eliza",
    "packages",
    "app-core",
    "scripts",
    "prepare-ios-cocoapods.sh",
  );

  await buildWeb();
  await ensurePlatform("ios");
  if (fs.existsSync(cocoapodsScript)) {
    await run("bash", [cocoapodsScript], { cwd: repoRoot });
  }
  await run("bun", ["run", "cap:sync:ios"], { cwd: appDir });

  const syncedFiles = prepareIosOverlay();

  // CocoaPods compiles Capacitor from source, avoiding SPM binary API issues
  if (
    fs.existsSync(path.join(iosDir, "Podfile")) ||
    shouldRunIosPodInstall(syncedFiles)
  ) {
    await run("pod", ["install"], { cwd: iosDir });
  }

  const wsPath = path.join(iosDir, "App.xcworkspace");
  const projectArgs = fs.existsSync(wsPath)
    ? ["-workspace", "App.xcworkspace"]
    : ["-project", "App.xcodeproj"];
  const buildTarget = resolveIosBuildTarget();

  await run(
    "xcodebuild",
    [
      ...projectArgs,
      "-scheme",
      "App",
      "-configuration",
      "Debug",
      "-destination",
      buildTarget.destination,
      "-sdk",
      buildTarget.sdk,
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ],
    { cwd: iosDir },
  );
}

// ── Entry point ─────────────────────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const target = argv[0];
  if (
    target !== "android" &&
    target !== "android-system" &&
    target !== "ios" &&
    target !== "ios-overlay"
  ) {
    console.error(
      "Usage: node scripts/run-mobile-build.mjs <android|android-system|ios|ios-overlay>",
    );
    process.exit(1);
  }
  if (target === "android") {
    await buildAndroid();
  } else if (target === "android-system") {
    await buildAndroidSystem();
  } else if (target === "ios") {
    await buildIos();
  } else {
    prepareIosOverlay();
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  await main();
}
