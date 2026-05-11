#!/usr/bin/env node
/**
 * Mobile build orchestrator for elizaOS apps.
 *
 * Builds an iOS or Android app from any elizaOS host app (Eliza, etc.).
 * Reads app identity from the host's app.config.ts so web, desktop, and
 * native builds share one canonical app contract.
 *
 * Usage: node scripts/run-mobile-build.mjs <android|android-cloud|android-cloud-debug|android-system|ios|ios-local|ios-overlay>
 *
 * Android targets:
 *   - android         Sideload-only debug APK with the on-device agent runtime
 *                     and AOSP/system-only permissions. NOT Play-Store-shippable.
 *   - android-cloud   Play-Store-compliant release AAB thin client backed by
 *                     Eliza Cloud. No on-device agent, no default-role
 *                     activities, no system-only permissions.
 *   - android-cloud-debug
 *                     Debug APK for cloud-client iteration. Not for Play.
 *   - android-system  Privileged platform-signed AOSP release APK for
 *                     Milady OS / ElizaOS device builds.
 *
 * Phases:
 *   1. Resolve config       — read app.config.ts for appId / appName
 *   2. Build web            — vite build → dist/
 *   3. Capacitor sync       — generate native platform projects
 *   4. Overlay native       — permissions, services, entitlements, Podfile
 *   5. Platform patches     — Gradle template, SPM compat, xcconfig
 *   5b. Stage Android agent — bun + musl + libstdc++ + libgcc + bundle
 *                             into packages/app/android/app/src/main/assets/agent/
 *                             (Android targets only; see
 *                             scripts/lib/stage-android-agent.mjs and
 *                             docs/agent-on-mobile.md).
 *   6. Native build         — gradlew / xcodebuild
 *
 * iOS targets:
 *   - ios         Cloud/client-oriented iOS build. Local inference is omitted
 *                 unless ELIZA_IOS_INCLUDE_LLAMA / MILADY_IOS_INCLUDE_LLAMA is set.
 *   - ios-local   Dev/sideload iOS build. Bakes runtimeMode=local and includes
 *                 the native llama bridge so the WebView ITTP local kernel can run.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "./aosp/lib/load-variant-config.mjs";
import { resolveMainAppDir } from "./lib/app-dir.mjs";
import {
  isCapacitorPlatformReady as isCapacitorPlatformReadyImpl,
  resolvePlatformTemplateRoot as resolvePlatformTemplateRootImpl,
  syncPlatformTemplateFiles as syncPlatformTemplateFilesImpl,
} from "./lib/capacitor-platform-templates.mjs";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";
import { stageAndroidAgentRuntime } from "./lib/stage-android-agent.mjs";

// ── Paths ───────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url, {
  fallbackToCwd: true,
});
const appCoreRoot = path.resolve(__dirname, "..");
const packagesRoot = path.resolve(appCoreRoot, "..");
const appDir = resolveMainAppDir(repoRoot, "app");
const iosDir = path.join(appDir, "ios", "App");
const androidDir = path.join(appDir, "android");

// AOSP system APK staging path. Brand-aware: forks declare their vendor
// dir + APK name in `app.config.ts > aosp:`. When that block is present
// (Milady, etc.), stage to `<repoRoot>/os/android/vendor/<vendorDir>/
// apps/<appName>/<appName>.apk`. When absent, fall back to the upstream
// elizaOS path under packages/os/.
function resolveSystemApkStagingDir() {
  let variant = null;
  try {
    variant = loadAospVariantConfig({
      appConfigPath: resolveAppConfigPath({ repoRoot, flagValue: null }),
    });
  } catch {
    // app.config.ts missing or malformed — fall through to the elizaOS
    // default. The upstream layout is the right answer for forks that
    // never set up an aosp: block.
  }
  if (variant) {
    const vendorDir = path.join(
      repoRoot,
      "os",
      "android",
      "vendor",
      variant.vendorDir,
    );
    return {
      vendorDir,
      apkDir: path.join(vendorDir, "apps", variant.appName),
      apkName: `${variant.appName}.apk`,
    };
  }
  const elizaOsVendorDir = path.join(
    repoRoot,
    "packages",
    "os",
    "android",
    "vendor",
    "eliza",
  );
  return {
    vendorDir: elizaOsVendorDir,
    apkDir: path.join(elizaOsVendorDir, "apps", "Eliza"),
    apkName: "Eliza.apk",
  };
}
const systemApkStaging = resolveSystemApkStagingDir();
const elizaOsApkDir = systemApkStaging.apkDir;
const elizaOsApkName = systemApkStaging.apkName;
const platformsDir = path.join(appCoreRoot, "platforms");
const nativePluginsDir = path.join(packagesRoot, "native-plugins");
const androidAgentSpikeDir = path.join(
  repoRoot,
  "scripts",
  "spike-android-agent",
);
// ── Phase 1: Resolve app identity from app.config.ts ────────────────────

function readAppIdentity() {
  const cfgPath = path.join(appDir, "app.config.ts");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`app.config.ts not found at ${cfgPath}`);
  }
  const src = fs.readFileSync(cfgPath, "utf8");
  const appId = src.match(/appId:\s*["']([^"']+)["']/)?.[1];
  const appName = src.match(/appName:\s*["']([^"']+)["']/)?.[1];
  const urlScheme = src.match(/urlScheme:\s*["']([^"']+)["']/)?.[1] ?? appId;
  if (!appId || !appName) {
    throw new Error("Could not parse appId/appName from app.config.ts");
  }
  // android.userAgentMarkers is an optional array literal nested under
  // `android: { ... }`. Parse the array body via regex (rather than
  // executing the TS file) so this script stays bun-import-free.
  const userAgentMarkers = parseAndroidUserAgentMarkers(src);
  return { appId, appName, urlScheme, userAgentMarkers };
}

function parseAndroidUserAgentMarkers(configSrc) {
  const block = configSrc.match(
    /android\s*:\s*\{[\s\S]*?userAgentMarkers\s*:\s*\[([\s\S]*?)\]/,
  );
  if (!block) return [];
  const body = block[1];
  const markers = [];
  const entryRe =
    /\{\s*systemProp\s*:\s*["']([^"']+)["']\s*,\s*uaPrefix\s*:\s*["']([^"']+)["']\s*[,}]/g;
  while (true) {
    const m = entryRe.exec(body);
    if (!m) break;
    markers.push({ systemProp: m[1], uaPrefix: m[2] });
  }
  return markers;
}

const APP = readAppIdentity();

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

function runCapacitor(args) {
  return run(
    process.execPath,
    [
      path.join(
        appDir,
        "node_modules",
        "@capacitor",
        "cli",
        "bin",
        "capacitor",
      ),
      ...args,
    ],
    { cwd: appDir },
  );
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function walkFiles(root, visitor) {
  if (!fs.existsSync(root)) return;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(filePath, visitor);
    } else if (entry.isFile()) {
      visitor(filePath);
    }
  }
}

function resolveExecutable(name) {
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

function resolveBunExecutable() {
  if (process.versions.bun) return process.execPath;
  return resolveExecutable("bun");
}

function resolveAndroidSdkRoot() {
  return firstExisting([
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
  ]);
}

function resolveViteCli() {
  const viteCli = firstExisting([
    path.join(appDir, "node_modules", ".bin", "vite"),
    path.join(repoRoot, "node_modules", ".bin", "vite"),
    path.join(appDir, "node_modules", "vite", "bin", "vite.js"),
    path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
  ]);
  if (!viteCli) {
    throw new Error("vite CLI not found; run bun install");
  }
  return viteCli;
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

function escapeXcodeBuildSetting(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function replaceOrInsertPlistString(content, key, value) {
  const escapedValue = escapeXmlText(value);
  const keyRe = escapeRegExp(key);
  const existingRe = new RegExp(
    `(<key>${keyRe}</key>\\s*<string>)[^<]*(</string>)`,
  );
  if (existingRe.test(content)) {
    return content.replace(existingRe, `$1${escapedValue}$2`);
  }
  return content.replace(
    "</dict>",
    `\t<key>${key}</key>\n\t<string>${escapedValue}</string>\n</dict>`,
  );
}

function ensurePlistArrayStrings(content, key, values) {
  const escapedValues = values.map(escapeXmlText);
  const keyRe = escapeRegExp(key);
  const arrayRe = new RegExp(
    `(<key>${keyRe}</key>\\s*<array>)([\\s\\S]*?)(\\s*</array>)`,
  );
  const match = content.match(arrayRe);
  if (!match) {
    const body = escapedValues
      .map((value) => `\t\t<string>${value}</string>`)
      .join("\n");
    return insertBeforeRootPlistDictClose(
      content,
      `\t<key>${key}</key>\n\t<array>\n${body}\n\t</array>\n</dict>`,
    );
  }
  let body = match[2];
  for (const value of escapedValues) {
    if (!body.includes(`<string>${value}</string>`)) {
      body += `\n\t\t<string>${value}</string>`;
    }
  }
  return content.replace(arrayRe, `$1${body}$3`);
}

function insertBeforeRootPlistDictClose(content, insertion) {
  const rootClose = "\n</dict>\n</plist>";
  const index = content.lastIndexOf(rootClose);
  if (index >= 0) {
    return `${content.slice(0, index)}\n${insertion}${content.slice(index + "\n</dict>".length)}`;
  }
  const fallbackIndex = content.lastIndexOf("</dict>");
  if (fallbackIndex < 0) return content;
  return `${content.slice(0, fallbackIndex)}${insertion}${content.slice(fallbackIndex + "</dict>".length)}`;
}

function ensurePlistUrlScheme(content, urlScheme) {
  const escapedScheme = escapeXmlText(urlScheme);
  const urlTypesRe =
    /(<key>CFBundleURLTypes<\/key>\s*<array>)([\s\S]*?)(\s*<\/array>)/;
  const entry = `
		<dict>
			<key>CFBundleURLName</key>
			<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>${escapedScheme}</string>
			</array>
		</dict>`;
  const match = content.match(urlTypesRe);
  if (!match) {
    return insertBeforeRootPlistDictClose(
      content,
      `\t<key>CFBundleURLTypes</key>\n\t<array>${entry}\n\t</array>\n</dict>`,
    );
  }
  if (match[2].includes(`<string>${escapedScheme}</string>`)) {
    return content;
  }
  return content.replace(urlTypesRe, `$1${match[2]}${entry}$3`);
}

/**
 * Resolve the real filesystem path to a node_modules package (follows bun
 * symlinks). Returns a path relative to `relativeTo`.
 */
function resolvePackagePath(pkgName, relativeTo) {
  const linked = resolvePackageAbsolutePath(pkgName);
  if (!linked) return null;
  return path.relative(relativeTo, linked);
}

function resolvePackageAbsolutePath(pkgName) {
  const appPackage = path.join(appDir, "node_modules", ...pkgName.split("/"));
  const rootNodeModulesPackage = path.join(
    repoRoot,
    "node_modules",
    ...pkgName.split("/"),
  );
  const candidates = [appPackage, rootNodeModulesPackage];
  for (const bunStore of [
    path.join(appDir, "node_modules", ".bun"),
    path.join(repoRoot, "node_modules", ".bun"),
  ]) {
    if (!fs.existsSync(bunStore)) continue;
    for (const entry of fs.readdirSync(bunStore, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push(
        path.join(bunStore, entry.name, "node_modules", ...pkgName.split("/")),
      );
    }
  }
  const linked = candidates.find((candidate) => fs.existsSync(candidate));
  if (!linked) return null;
  return fs.realpathSync(linked);
}

function resolveNativePluginPackagePath(pkgName, relativeTo) {
  const match = pkgName.match(/^@elizaos\/capacitor-(.+)$/);
  if (match) {
    const localPluginRoot = path.join(nativePluginsDir, match[1]);
    if (fs.existsSync(path.join(localPluginRoot, "package.json"))) {
      return path.relative(relativeTo, localPluginRoot);
    }
  }
  return resolvePackagePath(pkgName, relativeTo);
}

export function resolvePlatformTemplateRoot(
  platform,
  { repoRootValue = repoRoot } = {},
) {
  return resolvePlatformTemplateRootImpl(platform, { repoRootValue });
}

export function syncPlatformTemplateFiles(
  platform,
  { repoRootValue = repoRoot, appDirValue = appDir, log = console.log } = {},
) {
  return syncPlatformTemplateFilesImpl(platform, {
    repoRootValue,
    appDirValue,
    log,
  });
}

export function isCapacitorPlatformReady(
  platform,
  { appDirValue = appDir } = {},
) {
  return isCapacitorPlatformReadyImpl(platform, { appDirValue });
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

function packageNameToPath(packageName) {
  return path.join(...packageName.split("."));
}

export function applyIosAppIdentity({
  appDirValue = appDir,
  appId = APP.appId,
  appName = APP.appName,
  appGroup = `group.${appId}`,
  developmentTeam = process.env.ELIZA_IOS_DEVELOPMENT_TEAM ??
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
    project = project.replace(
      /PRODUCT_BUNDLE_IDENTIFIER = [A-Za-z0-9_.-]+\.WebsiteBlockerContentExtension;/g,
      `PRODUCT_BUNDLE_IDENTIFIER = ${appId}.WebsiteBlockerContentExtension;`,
    );
    project = project.replace(
      /PRODUCT_BUNDLE_IDENTIFIER = (?![A-Za-z0-9_.-]+\.WebsiteBlockerContentExtension;)[A-Za-z0-9_.-]+;/g,
      `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`,
    );
    const displayNameSetting = `ELIZA_DISPLAY_NAME = ${escapeXcodeBuildSetting(appName)};`;
    if (project.includes("ELIZA_DISPLAY_NAME = ")) {
      project = project.replace(
        /ELIZA_DISPLAY_NAME = .*?;/g,
        displayNameSetting,
      );
    } else {
      project = project.replace(
        new RegExp(
          `(^[ \\t]*MARKETING_VERSION = 1\\.0;\\n)([ \\t]*)PRODUCT_BUNDLE_IDENTIFIER = ${escapeRegExp(appId)};`,
          "m",
        ),
        `$1$2${displayNameSetting}\n$2PRODUCT_BUNDLE_IDENTIFIER = ${appId};`,
      );
    }
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
    ["group.app.eliza", appGroup],
    ["group.com.miladyai.milady", appGroup],
    ['"group.ai.elizaos.app"', `"${appGroup}"`],
    ['"group.app.eliza"', `"${appGroup}"`],
    ['"group.com.miladyai.milady"', `"${appGroup}"`],
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

export function resolveMobileBuildPolicy(platform) {
  const capacitorTarget =
    platform === "android-system" ||
    platform === "android-cloud" ||
    platform === "android-cloud-debug"
      ? "android"
      : platform === "ios-overlay" || platform === "ios-local"
        ? "ios"
        : platform;
  // Android runtime mode mirrors the iOS runtime mode pattern: `cloud`
  // means the renderer should treat Eliza Cloud as the only hosting target
  // (Play-Store-compliant thin client; no on-device agent), while `local`
  // is the default sideload/AOSP behavior. Surfaced to the renderer via
  // VITE_ELIZA_ANDROID_RUNTIME_MODE so it can hide the Local picker option.
  const androidRuntimeMode =
    platform === "android-cloud" || platform === "android-cloud-debug"
      ? "cloud"
      : platform === "android" || platform === "android-system"
        ? "local"
        : null;
  const iosRuntimeMode =
    platform === "ios-local"
      ? "local"
      : platform === "ios" || platform === "ios-overlay"
        ? "cloud"
        : null;
  const buildVariant =
    platform === "android-cloud" || platform === "ios" ? "store" : "direct";
  const releaseAuthority =
    platform === "android-cloud"
      ? "google-play"
      : platform === "android"
        ? "github-release-android-package-installer"
        : platform === "android-system"
          ? "aosp-ota"
          : platform === "ios"
            ? "apple-app-store"
            : platform === "ios-local"
              ? "developer-toolchain"
              : platform === "android-cloud-debug"
                ? "developer-debug"
                : "developer-toolchain";
  return {
    capacitorTarget,
    buildVariant,
    androidRuntimeMode,
    iosRuntimeMode,
    releaseAuthority,
    appControlledOta: false,
  };
}

async function buildWeb(platform) {
  const {
    capacitorTarget,
    buildVariant,
    androidRuntimeMode,
    iosRuntimeMode,
    releaseAuthority,
  } = resolveMobileBuildPolicy(platform);
  const env = {
    ...process.env,
    ELIZA_CAPACITOR_BUILD_TARGET: capacitorTarget,
    MILADY_CAPACITOR_BUILD_TARGET: capacitorTarget,
    MILADY_BUILD_VARIANT: process.env.MILADY_BUILD_VARIANT || buildVariant,
    ELIZA_BUILD_VARIANT: process.env.ELIZA_BUILD_VARIANT || buildVariant,
    ELIZA_RELEASE_AUTHORITY:
      process.env.ELIZA_RELEASE_AUTHORITY || releaseAuthority,
    MILADY_RELEASE_AUTHORITY:
      process.env.MILADY_RELEASE_AUTHORITY || releaseAuthority,
    ...(androidRuntimeMode
      ? {
          VITE_ELIZA_ANDROID_RUNTIME_MODE: androidRuntimeMode,
          VITE_MILADY_ANDROID_RUNTIME_MODE: androidRuntimeMode,
        }
      : {}),
    ...(iosRuntimeMode
      ? {
          ELIZA_IOS_RUNTIME_MODE: iosRuntimeMode,
          MILADY_IOS_RUNTIME_MODE: iosRuntimeMode,
          VITE_ELIZA_IOS_RUNTIME_MODE: iosRuntimeMode,
          VITE_MILADY_IOS_RUNTIME_MODE: iosRuntimeMode,
        }
      : {}),
  };
  const bun = resolveBunExecutable();
  if (bun) {
    await run(bun, ["run", "build:web"], { cwd: appDir, env });
    return;
  }
  await run(process.execPath, [resolveViteCli(), "build"], {
    cwd: appDir,
    env,
  });
}

async function buildMobileAgentBundle() {
  const bun = resolveBunExecutable();
  if (!bun) {
    throw new Error(
      "bun executable not found; run bun install before Android local builds.",
    );
  }
  await run(bun, ["run", "build:mobile"], {
    cwd: path.join(packagesRoot, "agent"),
  });
}

// ── Phase 3: Capacitor sync ────────────────────────────────────────────

async function ensurePlatform(platform) {
  const dir = platform === "android" ? androidDir : iosDir;
  if (!fs.existsSync(dir)) {
    const copied = syncPlatformTemplateFiles(platform);
    if (copied.length === 0) {
      console.log(`[mobile-build] Adding Capacitor ${platform} platform...`);
      await runCapacitor(["add", platform]);
    }
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
  "FOREGROUND_SERVICE_SPECIAL_USE",
  "POST_NOTIFICATIONS",
  "WAKE_LOCK",
  "RECEIVE_BOOT_COMPLETED",
  "SYSTEM_ALERT_WINDOW",
  // PACKAGE_USAGE_STATS is granted via the privapp-permissions whitelist;
  // MANAGE_APP_OPS_MODES is what ElizaBootReceiver actually needs to
  // reflectively flip the GET_USAGE_STATS appop to ALLOWED at boot.
  // Without MANAGE_APP_OPS_MODES the receiver throws SecurityException
  // and PACKAGE_USAGE_STATS stays appop-default-denied, which breaks
  // priv-app usage-stats access. See vendor/eliza/permissions/
  // privapp-permissions-com.elizaai.eliza.xml.
  "PACKAGE_USAGE_STATS",
  "MANAGE_APP_OPS_MODES",
  "MANAGE_VIRTUAL_MACHINE",
];

function replaceOrInsertGradleString(content, key, value) {
  // AGP-modern uses `key = "value"`, AGP-legacy uses `key "value"`. Match
  // either and preserve the existing assignment shape so we don't flip
  // styles unnecessarily. The namespace declaration ships in the modern
  // form on Android Gradle Plugin 8+ generated projects, while
  // applicationId is still emitted in the legacy form by Capacitor's
  // template — both must be patchable.
  const re = new RegExp(`(${key}\\s*=?\\s*)["'][^"']+["']`);
  if (re.test(content)) {
    return content.replace(re, `$1"${value}"`);
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

/**
 * Inject `buildFeatures { buildConfig true }` and the `AOSP_BUILD`
 * buildConfigField into the app-level build.gradle.
 *
 * Why: `ElizaAgentService` reads `BuildConfig.AOSP_BUILD` to decide whether
 * to export `ELIZA_LOCAL_LLAMA=1` to the spawned bun process (see
 * eliza/packages/agent/src/runtime/aosp-llama-adapter.ts). AGP 8+ defaults
 * `buildFeatures.buildConfig` to false, so without the flag flip the
 * BuildConfig.java is never generated and the Java service refuses to
 * compile. The boolean field defaults to false, so the Capacitor APK build
 * keeps DeviceBridge inference; the AOSP build flow flips it to true via
 * the `-PelizaAospBuild=true` gradle property documented in
 * scripts/elizaos/build-aosp.mjs and SETUP_AOSP.md.
 */
function injectBuildConfigAospField(content) {
  let next = content;
  if (!/\bbuildFeatures\s*\{/.test(next)) {
    next = next.replace(
      /android\s*\{/,
      `android {\n    buildFeatures {\n        buildConfig true\n    }\n`,
    );
  } else if (!/buildConfig\s+true/.test(next)) {
    next = next.replace(
      /buildFeatures\s*\{/,
      "buildFeatures {\n        buildConfig true",
    );
  }
  if (!/buildConfigField\s+["']boolean["'],\s*["']AOSP_BUILD["']/.test(next)) {
    next = next.replace(
      /defaultConfig\s*\{/,
      `defaultConfig {\n        buildConfigField "boolean", "AOSP_BUILD", "\${project.findProperty('elizaAospBuild') ?: 'false'}"\n`,
    );
  }
  return next;
}

/**
 * Inject the `androidResources { noCompress += [...] }` block that keeps
 * `.tar.gz`, `.tar`, `.gguf`, and `.so` files byte-identical in the
 * packaged APK.
 *
 * Why: aapt2's default packaging treats `.gz` and `.tar.gz` as
 * "compressed-extension-to-preserve-uncompressed" and rewrites the entry
 * to a plain `.tar`. PGlite's runtime extension loader resolves
 * `vector.tar.gz` and `fuzzystrmatch.tar.gz` via
 * `new URL("../X", import.meta.url)`; when aapt2 strips the `.gz` the
 * loader can't find the file and the runtime falls over at first
 * Postgres extension call.
 *
 * Idempotent: re-runs are no-ops once the block is present. The matcher
 * accepts AGP-modern `androidResources` and legacy `aaptOptions` blocks,
 * but only injects when neither already lists `tar.gz`.
 */
export function injectNoCompressTarGz(content) {
  if (/noCompress[^\n]*['"]tar\.gz['"]/.test(content)) return content;
  const block =
    `\n    // Preserve .tar.gz / .tar / .gguf / .so as-is in the packaged APK.\n` +
    `    // aapt2 otherwise rewrites .tar.gz to .tar and PGlite's runtime\n` +
    `    // extension loader fails to find vector.tar.gz / fuzzystrmatch.tar.gz.\n` +
    `    androidResources {\n` +
    `        noCompress += ['gguf', 'tar.gz', 'so', 'tar']\n` +
    `    }\n`;
  // Inject just before the closing brace of the top-level `android { ... }`
  // block. Match the LAST `}` in the file as a heuristic that's robust
  // against arbitrary middle content.
  const androidOpen = content.search(/\n\s*android\s*\{/);
  if (androidOpen < 0) return content;
  // Find the matching closing brace by counting from the open.
  let depth = 0;
  let i = content.indexOf("{", androidOpen);
  while (i < content.length) {
    const ch = content[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(0, i) + block + content.slice(i);
      }
    }
    i += 1;
  }
  return content;
}

/**
 * Keep packaged Android native libraries extracted on install.
 *
 * Normal Capacitor installs run as `untrusted_app`, which cannot execute
 * bun/musl files copied into app data. ElizaAgentService therefore prefers
 * the same payload shipped as libeliza_* native libraries; those files must
 * exist on disk under nativeLibraryDir for ProcessBuilder to execute them.
 */
export function injectNativeLibLegacyPackaging(content) {
  if (/useLegacyPackaging\s*=\s*true/.test(content)) return content;
  if (/jniLibs\s*\{/.test(content)) {
    return content.replace(
      /jniLibs\s*\{/,
      "jniLibs {\n            useLegacyPackaging = true",
    );
  }
  if (/packaging\s*\{/.test(content)) {
    return content.replace(
      /packaging\s*\{/,
      "packaging {\n        jniLibs {\n            useLegacyPackaging = true\n        }",
    );
  }

  const block =
    `\n    packaging {\n` +
    `        jniLibs {\n` +
    `            useLegacyPackaging = true\n` +
    `        }\n` +
    `    }\n`;
  const androidOpen = content.search(/\n\s*android\s*\{/);
  if (androidOpen < 0) return content;
  let depth = 0;
  let i = content.indexOf("{", androidOpen);
  while (i < content.length) {
    const ch = content[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(0, i) + block + content.slice(i);
      }
    }
    i += 1;
  }
  return content;
}

/**
 * Inject an optional app-thinning hook for `assets/agent/`.
 *
 * Local mode on stock Capacitor APKs now depends on the staged bun runtime,
 * agent-bundle, and PGlite payload, so the default mobile build must keep
 * assets/agent/*. CI/release jobs that deliberately want a cloud-only slim APK
 * can opt into stripping with `-PelizaStripAgentAssets=true`.
 *
 * Idempotent: re-runs are no-ops once the block is present.
 */
/**
 * Inject the `copyForkLlamaLib` Gradle task that bundles the buun-llama-cpp
 * fork's android-arm64 .so into the APK's jniLibs/. The fork's specialized
 * KV cache types (turbo3, turbo4, turbo3_tcq) and DFlash spec-decoding kernels
 * live in this .so; without it, mobile only gets stock llama.cpp.
 *
 * Resolution order for the libdir:
 *   1. -Peliza.dflash.android.libdir=<path>   (gradle property)
 *   2. ELIZA_DFLASH_ANDROID_LIBDIR env var
 *   3. ~/.eliza/local-inference/bin/dflash/android-arm64-{cpu,vulkan}/
 *
 * Skips with a clear log when no path is configured or the dir doesn't exist,
 * so a desktop dev still gets a working APK without local fork builds.
 *
 * Idempotent: re-runs are no-ops once the block is present.
 */
function ensureCopyForkLlamaLibCloudGuard(content) {
  if (!/\[copyForkLlamaLib\]/.test(content)) return content;
  if (/skipped for cloud build/.test(content)) return content;
  return content.replace(
    /(task copyForkLlamaLib\s*\{\s*\n\s*doLast\s*\{\s*\n)/,
    `$1` +
      `        if (project.findProperty('elizaCloudBuild') == 'true') {\n` +
      `            println "[copyForkLlamaLib] skipped for cloud build"\n` +
      `            return\n` +
      `        }\n`,
  );
}

export function injectCopyForkLlamaLibTask(content) {
  if (/\[copyForkLlamaLib\]/.test(content)) {
    return ensureCopyForkLlamaLibCloudGuard(content);
  }
  const block =
    `\n// Bundle the buun-llama-cpp fork's android-arm64 .so into the APK so\n` +
    `// mobile gets DFlash + TurboQuant KV cache + QJL kernels. Stock\n` +
    `// llama-cpp-capacitor's .so still ships when the fork lib dir is missing.\n` +
    `def resolveForkLlamaLibDir = { ->\n` +
    `    def fromProp = project.findProperty('eliza.dflash.android.libdir')\n` +
    `    if (fromProp) return fromProp.toString()\n` +
    `    def fromEnv = System.getenv('ELIZA_DFLASH_ANDROID_LIBDIR')\n` +
    `    if (fromEnv) return fromEnv\n` +
    `    def stateDir = System.getenv('ELIZA_STATE_DIR') ?: "\${System.getProperty('user.home')}/.eliza"\n` +
    `    def candidates = ['vulkan', 'cpu'].collect { backend ->\n` +
    `        "\${stateDir}/local-inference/bin/dflash/android-arm64-\${backend}"\n` +
    `    }\n` +
    `    return candidates.find { new File(it).isDirectory() }\n` +
    `}\n` +
    `\n` +
    `task copyForkLlamaLib {\n` +
    `    doLast {\n` +
    `        if (project.findProperty('elizaCloudBuild') == 'true') {\n` +
    `            println "[copyForkLlamaLib] skipped for cloud build"\n` +
    `            return\n` +
    `        }\n` +
    `        def libDir = resolveForkLlamaLibDir()\n` +
    `        if (!libDir) {\n` +
    `            println "[copyForkLlamaLib] no fork lib dir configured (set -Peliza.dflash.android.libdir or build via packages/app-core/scripts/build-llama-cpp-dflash.mjs --target android-arm64-vulkan); APK ships stock llama-cpp-capacitor only"\n` +
    `            return\n` +
    `        }\n` +
    `        def srcDir = new File(libDir.toString())\n` +
    `        if (!srcDir.isDirectory()) {\n` +
    `            println "[copyForkLlamaLib] fork lib dir \${libDir} does not exist; APK ships stock llama-cpp-capacitor only"\n` +
    `            return\n` +
    `        }\n` +
    `        def jniDir = file('src/main/jniLibs/arm64-v8a')\n` +
    `        jniDir.mkdirs()\n` +
    `        def assetsDir = file('src/main/assets')\n` +
    `        assetsDir.mkdirs()\n` +
    `        int copied = 0\n` +
    `        srcDir.eachFile { src ->\n` +
    `            if (src.name.endsWith('.so')) {\n` +
    `                def dst = new File(jniDir, src.name)\n` +
    `                dst.bytes = src.bytes\n` +
    `                copied++\n` +
    `            }\n` +
    `            if (src.name == 'kernels.json') {\n` +
    `                def dst = new File(assetsDir, 'llama-cpp-kernels.json')\n` +
    `                dst.bytes = src.bytes\n` +
    `                println "[copyForkLlamaLib] staged kernels.json as assets/llama-cpp-kernels.json"\n` +
    `            }\n` +
    `        }\n` +
    `        println "[copyForkLlamaLib] copied \${copied} .so file(s) from \${libDir} to \${jniDir}"\n` +
    `    }\n` +
    `}\n` +
    `\n` +
    `afterEvaluate {\n` +
    `    tasks.matching { it.name == 'preBuild' }.all { it.dependsOn copyForkLlamaLib }\n` +
    `}\n`;
  const androidOpen = content.search(/\n\s*android\s*\{/);
  if (androidOpen < 0) return content;
  let depth = 0;
  let i = content.indexOf("{", androidOpen);
  while (i < content.length) {
    const ch = content[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(0, i + 1) + block + content.slice(i + 1);
      }
    }
    i += 1;
  }
  return content;
}

function ensureCloudBuildAssetThinning(content) {
  if (/\[cloud-app-thinning\]/.test(content)) return content;
  return (
    content +
    `\n// [cloud-app-thinning] Cloud builds must never package the local agent payload.\n` +
    `// This second hook patches older generated projects whose existing\n` +
    `// [app-thinning] block only honored -PelizaStripAndroidAgentAssets.\n` +
    `afterEvaluate {\n` +
    `    tasks.matching { it.name.startsWith('merge') && it.name.endsWith('Assets') }.all { mergeTask ->\n` +
    `        mergeTask.inputs.property('elizaCloudBuild', project.findProperty('elizaCloudBuild') ?: 'false')\n` +
    `        mergeTask.doLast {\n` +
    `            if (project.findProperty('elizaCloudBuild') == 'true') {\n` +
    `                def assetsDir = mergeTask.outputDir.get().asFile\n` +
    `                def agentDir = new File(assetsDir, 'agent')\n` +
    `                if (agentDir.exists()) {\n` +
    `                    println "[cloud-app-thinning] removing assets/agent/ from \${mergeTask.name}"\n` +
    `                    agentDir.deleteDir()\n` +
    `                }\n` +
    `            }\n` +
    `        }\n` +
    `    }\n` +
    `}\n`
  );
}

export function injectAospAssetThinning(content) {
  if (/\[app-thinning\]/.test(content)) {
    return ensureCloudBuildAssetThinning(content);
  }
  const block =
    `\n// Optional app thinning: keep assets/agent/ by default so stock\n` +
    `// Capacitor APKs can run the bundled local agent. Set\n` +
    `// -PelizaStripAgentAssets=true only for an explicitly cloud-only slim APK.\n` +
    `afterEvaluate {\n` +
    `    tasks.matching { it.name.startsWith('merge') && it.name.endsWith('Assets') }.all { mergeTask ->\n` +
    `        mergeTask.inputs.property('elizaAospBuild', project.findProperty('elizaAospBuild') ?: 'false')\n` +
    `        mergeTask.inputs.property('elizaStripAgentAssets', project.findProperty('elizaStripAgentAssets') ?: 'false')\n` +
    `        mergeTask.inputs.property('elizaCloudBuild', project.findProperty('elizaCloudBuild') ?: 'false')\n` +
    `        mergeTask.doLast {\n` +
    `            if (project.findProperty('elizaAospBuild') != 'true' && (project.findProperty('elizaStripAgentAssets') == 'true' || project.findProperty('elizaCloudBuild') == 'true')) {\n` +
    `                def assetsDir = mergeTask.outputDir.get().asFile\n` +
    `                def agentDir = new File(assetsDir, 'agent')\n` +
    `                if (agentDir.exists()) {\n` +
    `                    println "[app-thinning] removing assets/agent/ from \${mergeTask.name} (cloud/slim Capacitor build)"\n` +
    `                    agentDir.deleteDir()\n` +
    `                }\n` +
    `            } else {\n` +
    `                println "[app-thinning] keeping assets/agent/ in \${mergeTask.name} (local-agent capable build)"\n` +
    `            }\n` +
    `        }\n` +
    `    }\n` +
    `}\n`;
  const androidOpen = content.search(/\n\s*android\s*\{/);
  if (androidOpen < 0) return content;
  let depth = 0;
  let i = content.indexOf("{", androidOpen);
  while (i < content.length) {
    const ch = content[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(0, i + 1) + block + content.slice(i + 1);
      }
    }
    i += 1;
  }
  return ensureCloudBuildAssetThinning(content);
}

const ANDROID_OFFICIAL_CAPACITOR_PACKAGES = [
  "@capacitor/app",
  "@capacitor/barcode-scanner",
  "@capacitor/background-runner",
  "@capacitor-community/background-runner",
  "@capacitor/browser",
  "@capacitor/haptics",
  "@capacitor/keyboard",
  "@capacitor/preferences",
  "@capacitor/push-notifications",
  "@capacitor/status-bar",
];

function patchInstalledCapacitorPluginGradleForAgp9(pkgName) {
  const pkgRel = resolvePackagePath(pkgName, androidDir);
  if (!pkgRel) return;
  patchGradleFileForAgp9(
    path.resolve(androidDir, pkgRel, "android", "build.gradle"),
    pkgName,
  );
}

function patchOfficialCapacitorGradleForAgp9() {
  for (const pkgName of ANDROID_OFFICIAL_CAPACITOR_PACKAGES) {
    patchInstalledCapacitorPluginGradleForAgp9(pkgName);
  }
}

function patchLlamaCppCapacitorGradle() {
  const pkgRel = resolvePackagePath("llama-cpp-capacitor", androidDir);
  if (!pkgRel) return;
  patchGradleFileForAgp9(
    path.resolve(androidDir, pkgRel, "android", "build.gradle"),
    "llama-cpp-capacitor",
  );
}

function patchGradleFileForAgp9(filePath, label) {
  if (!fs.existsSync(filePath)) return;
  const current = fs.readFileSync(filePath, "utf8");
  const patched = current
    .replace(
      /^\s*apply plugin:\s*['"](org\.jetbrains\.kotlin\.android|kotlin-android)['"]\s*\r?\n/gm,
      "",
    )
    .replace(/\n\s*kotlin\s*\{\s*jvmToolchain\(\d+\)\s*\}\s*/g, "\n")
    .replace(
      /getDefaultProguardFile\('proguard-android\.txt'\)/g,
      "getDefaultProguardFile('proguard-android-optimize.txt')",
    );
  if (patched !== current) {
    fs.writeFileSync(filePath, patched, "utf8");
    console.log(`[mobile-build] Patched ${label} Gradle for AGP 9.`);
  }
}

function patchNativePluginGradleForAgp9() {
  if (!fs.existsSync(nativePluginsDir)) return;
  for (const entry of fs.readdirSync(nativePluginsDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    patchGradleFileForAgp9(
      path.join(nativePluginsDir, entry.name, "android", "build.gradle"),
      `@elizaos/capacitor-${entry.name}`,
    );
  }
}

function appendMissingAndroidManifestBlock(xml, marker, block) {
  if (xml.includes(marker)) return xml;
  return xml.replace("</manifest>", `${block}\n</manifest>`);
}

function appendMissingApplicationBlock(xml, marker, block) {
  if (xml.includes(marker)) return xml;
  return xml.replace("</application>", `${block}\n    </application>`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeApplicationComponentBlock(xml, componentName) {
  const escapedName = escapeRegExp(componentName);
  const componentRe = new RegExp(
    `\\n\\s*<(activity|service|receiver)\\b(?=[^>]*android:name="${escapedName}")[\\s\\S]*?<\\/\\1>\\s*`,
    "g",
  );
  return xml.replace(componentRe, "\n");
}

function removeApplicationComponentClassBlock(xml, className) {
  const escapedName = escapeRegExp(className);
  const pairedRe = new RegExp(
    `\\n\\s*<(activity|service|receiver)\\b(?=[^>]*android:name="[^"]*\\.?${escapedName}")[\\s\\S]*?<\\/\\1>\\s*`,
    "g",
  );
  const selfClosingRe = new RegExp(
    `\\n\\s*<(activity|service|receiver)\\b(?=[^>]*android:name="[^"]*\\.?${escapedName}")[^>]*/>\\s*`,
    "g",
  );
  return xml.replace(pairedRe, "\n").replace(selfClosingRe, "\n");
}

function removeStaleAndroidJavaSourceRoots(dstJava) {
  const candidates = [
    "ai.elizaos.app",
    "com.elizaai.eliza",
    "com.miladyai.milady",
    APP.appId,
  ];
  for (const packageName of candidates) {
    const candidate = path.join(
      androidDir,
      "app",
      "src",
      "main",
      "java",
      packageNameToPath(packageName),
    );
    if (candidate !== dstJava && fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
}

// Replace the BRAND_USER_AGENT_MARKERS array contents in the templated
// MainActivity.java with framework default + entries from
// `app.config.ts > android.userAgentMarkers`. Idempotent: re-running on
// already-injected source produces the same result because we re-emit
// the canonical default + configured set every time.
function injectBrandUserAgentMarkers(javaSource, markers) {
  const arrayRe =
    /(private static final UserAgentMarker\[\] BRAND_USER_AGENT_MARKERS = new UserAgentMarker\[\]\s*\{)([\s\S]*?)(\};)/m;
  if (!arrayRe.test(javaSource)) {
    return javaSource;
  }
  const lines = [
    `        new UserAgentMarker("ro.elizaos.product", "ElizaOS/"),`,
  ];
  for (const marker of markers) {
    const systemProp = escapeJavaString(marker.systemProp);
    const uaPrefix = escapeJavaString(marker.uaPrefix);
    lines.push(`        new UserAgentMarker("${systemProp}", "${uaPrefix}"),`);
  }
  return javaSource.replace(arrayRe, `$1\n${lines.join("\n")}\n    $3`);
}

function ensureElizaOsActivityFilters(xml) {
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

function ensureAndroidMainActivityUrlSchemeFilter(xml) {
  const mainActivityRe =
    /(<activity\b(?=[\s\S]*?android:name="\.?MainActivity")[\s\S]*?)(\n\s*<\/activity>)/m;
  const match = xml.match(mainActivityRe);
  if (!match) return xml;

  const mainActivity = `${match[1]}${match[2]}`;
  const hasCustomSchemeFilter =
    mainActivity.includes("android.intent.action.VIEW") &&
    mainActivity.includes("android.intent.category.BROWSABLE") &&
    (mainActivity.includes('android:scheme="@string/custom_url_scheme"') ||
      mainActivity.includes(`android:scheme="${APP.urlScheme}"`));
  if (hasCustomSchemeFilter) return xml;

  const authFilter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="@string/custom_url_scheme" />
            </intent-filter>
`;
  return xml.replace(mainActivityRe, `$1${authFilter}$2`);
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
  const androidPackage = APP.appId;
  const dstJava = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    packageNameToPath(androidPackage),
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
    removeStaleAndroidJavaSourceRoots(dstJava);
    for (const staleJava of [legacyJava, appIdJava]) {
      if (staleJava !== dstJava) {
        fs.rmSync(staleJava, { recursive: true, force: true });
      }
    }
    fs.mkdirSync(dstJava, { recursive: true });
    for (const file of [
      "GatewayConnectionService.java",
      "AgentPlugin.java",
      "AndroidVirtualizationBridge.java",
      "BatteryOptimizationPlugin.java",
      "ElizaNativeBridge.java",
      "MainActivity.java",
      "ElizaAgentService.java",
      "ElizaAssistActivity.java",
      "ElizaBootReceiver.java",
      "ElizaBrowserActivity.java",
      "ElizaCalendarActivity.java",
      "ElizaCameraActivity.java",
      "ElizaClockActivity.java",
      "ElizaContactsActivity.java",
      "ElizaDialActivity.java",
      "ElizaInCallService.java",
      "ElizaMmsReceiver.java",
      "ElizaRespondViaMessageService.java",
      "ElizaSmsComposeActivity.java",
      "ElizaSmsReceiver.java",
      "ElizaTasksWorker.java",
      "ElizaWorkScheduler.java",
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
      // Source Java declares `import app.eliza.{BuildConfig,R};` because the
      // upstream gradle namespace is `app.eliza` and that is where the
      // generated symbols live. For overlay apps the namespace becomes
      // `${APP.appId}` (see gradle namespace patch at ~L2226), so BuildConfig
      // and R are emitted under `${androidPackage}` instead. Rewrite the
      // imports here so compilation finds them. Without this rewrite gradle
      // fails with `error: package app.eliza does not exist` on every Java
      // source that touches BuildConfig or R.
      code = code.replaceAll(
        /\bimport\s+app\.eliza\.(BuildConfig|R)\s*;/g,
        `import ${androidPackage}.$1;`,
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
      if (file === "MainActivity.java") {
        code = injectBrandUserAgentMarkers(code, APP.userAgentMarkers ?? []);
      }
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
    const withElizaOsActivityFilters = ensureElizaOsActivityFilters(xml);
    if (withElizaOsActivityFilters !== xml) {
      xml = withElizaOsActivityFilters;
      dirty = true;
    }
    const withUrlSchemeFilter = ensureAndroidMainActivityUrlSchemeFilter(xml);
    if (withUrlSchemeFilter !== xml) {
      xml = withUrlSchemeFilter;
      dirty = true;
    }
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

    // ElizaAgentService — special-use foreground service that owns the
    // local Eliza agent process. Nested <property> tag carries the Android
    // 14+ specialUse subtype. Pattern matches both self-closing and
    // explicit-close forms so re-runs collapse cleanly.
    const agentServiceName = `${androidPackage}.ElizaAgentService`;
    const agentServiceSelfClosingPattern =
      /\n\s*<service\b[^>]*android:name="[^"]*ElizaAgentService"[^>]*\/>\s*/g;
    const agentServicePairedPattern =
      /\n\s*<service\b[^>]*android:name="[^"]*ElizaAgentService"[\s\S]*?<\/service>\s*/g;
    const withoutAgentServiceSelfClose = xml.replace(
      agentServiceSelfClosingPattern,
      "\n",
    );
    if (withoutAgentServiceSelfClose !== xml) {
      xml = withoutAgentServiceSelfClose;
      dirty = true;
    }
    const withoutAgentServicePaired = xml.replace(
      agentServicePairedPattern,
      "\n",
    );
    if (withoutAgentServicePaired !== xml) {
      xml = withoutAgentServicePaired;
      dirty = true;
    }
    xml = xml.replace(
      "</application>",
      `\n        <service\n            android:name="${agentServiceName}"\n            android:exported="false"\n            android:foregroundServiceType="specialUse">\n            <property\n                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"\n                android:value="local-agent-runtime" />\n        </service>\n    </application>`,
    );
    dirty = true;
    for (const component of [
      "ElizaDialActivity",
      "ElizaAssistActivity",
      "ElizaInCallService",
      "ElizaSmsReceiver",
      "ElizaMmsReceiver",
      "ElizaRespondViaMessageService",
      "ElizaSmsComposeActivity",
      "ElizaBootReceiver",
      "ElizaBrowserActivity",
      "ElizaContactsActivity",
      "ElizaCameraActivity",
      "ElizaClockActivity",
      "ElizaCalendarActivity",
    ]) {
      const nextXml = removeApplicationComponentBlock(
        xml,
        `${androidPackage}.${component}`,
      );
      if (nextXml !== xml) {
        xml = nextXml;
        dirty = true;
      }
    }
    for (const component of [
      "ElizaDialActivity",
      "ElizaAssistActivity",
      "ElizaInCallService",
      "ElizaSmsReceiver",
      "ElizaMmsReceiver",
      "ElizaRespondViaMessageService",
      "ElizaSmsComposeActivity",
      "ElizaBootReceiver",
      "ElizaBrowserActivity",
      "ElizaContactsActivity",
      "ElizaCameraActivity",
      "ElizaClockActivity",
      "ElizaCalendarActivity",
      "MiladyDialActivity",
      "MiladyAssistActivity",
      "MiladyInCallService",
      "MiladySmsReceiver",
      "MiladyMmsReceiver",
      "MiladyRespondViaMessageService",
      "MiladySmsComposeActivity",
      "MiladyBootReceiver",
    ]) {
      const nextXml = removeApplicationComponentClassBlock(xml, component);
      if (nextXml !== xml) {
        xml = nextXml;
        dirty = true;
      }
    }
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaDialActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaDialActivity"
            android:exported="true"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.DIAL" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.DIAL" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:scheme="tel" />
            </intent-filter>
        </activity>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaAssistActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaAssistActivity"
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
      `${androidPackage}.ElizaInCallService`,
      `
        <service
            android:name="${androidPackage}.ElizaInCallService"
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
      `${androidPackage}.ElizaSmsReceiver`,
      `
        <receiver
            android:name="${androidPackage}.ElizaSmsReceiver"
            android:exported="true"
            android:permission="android.permission.BROADCAST_SMS">
            <intent-filter>
                <action android:name="android.provider.Telephony.SMS_DELIVER" />
            </intent-filter>
        </receiver>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaMmsReceiver`,
      `
        <receiver
            android:name="${androidPackage}.ElizaMmsReceiver"
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
      `${androidPackage}.ElizaRespondViaMessageService`,
      `
        <service
            android:name="${androidPackage}.ElizaRespondViaMessageService"
            android:exported="true"
            android:permission="android.permission.SEND_RESPOND_VIA_MESSAGE">
            <intent-filter>
                <action android:name="android.intent.action.RESPOND_VIA_MESSAGE" />
                <data android:scheme="sms" />
                <data android:scheme="smsto" />
                <data android:scheme="mms" />
                <data android:scheme="mmsto" />
            </intent-filter>
        </service>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaSmsComposeActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaSmsComposeActivity"
            android:exported="true"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.SENDTO" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:scheme="sms" />
                <data android:scheme="smsto" />
                <data android:scheme="mms" />
                <data android:scheme="mmsto" />
            </intent-filter>
        </activity>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaBootReceiver`,
      `
        <receiver
            android:name="${androidPackage}.ElizaBootReceiver"
            android:directBootAware="true"
            android:exported="false">
            <intent-filter>
                <action android:name="android.intent.action.LOCKED_BOOT_COMPLETED" />
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>`,
    );
    // Browser: replaces stripped Browser2 as the only http(s) handler.
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaBrowserActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaBrowserActivity"
            android:exported="true"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="http" />
                <data android:scheme="https" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.WEB_SEARCH" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>`,
    );
    // Contacts: replaces stripped Contacts. Handles content://contacts.
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaContactsActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaContactsActivity"
            android:exported="true"
            android:label="Contacts"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
                <category android:name="android.intent.category.APP_CONTACTS" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="vnd.android.cursor.dir/contact" />
                <data android:mimeType="vnd.android.cursor.dir/person" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="vnd.android.cursor.item/contact" />
                <data android:mimeType="vnd.android.cursor.item/person" />
            </intent-filter>
        </activity>`,
    );
    // Camera: replaces stripped Camera2. STILL_IMAGE_CAMERA + IMAGE_CAPTURE.
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaCameraActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaCameraActivity"
            android:exported="true"
            android:label="Camera"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.media.action.STILL_IMAGE_CAMERA" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.media.action.IMAGE_CAPTURE" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.media.action.VIDEO_CAPTURE" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>`,
    );
    // Clock: replaces stripped DeskClock. SET_ALARM is critical.
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaClockActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaClockActivity"
            android:exported="true"
            android:label="Clock"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SET_ALARM" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SHOW_ALARMS" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SET_TIMER" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SHOW_TIMERS" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.DISMISS_ALARM" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>`,
    );
    // Calendar: replaces stripped Calendar.
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaCalendarActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaCalendarActivity"
            android:exported="true"
            android:label="Calendar"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
                <category android:name="android.intent.category.APP_CALENDAR" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="vnd.android.cursor.item/event" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.INSERT" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="vnd.android.cursor.dir/event" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.EDIT" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="vnd.android.cursor.item/event" />
            </intent-filter>
        </activity>`,
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

  // Copy ProGuard rules, rewriting the elizaOS default package to match the
  // app's actual namespace. Without this rewrite, R8 may strip Eliza-only
  // manifest-referenced classes (Dial/Assist/InCall/Boot) when the app is
  // namespaced as e.g. com.elizaai.eliza.
  const srcPro = path.join(
    platformsDir,
    "android",
    "app",
    "proguard-rules.pro",
  );
  if (fs.existsSync(srcPro)) {
    let proguardRules = fs.readFileSync(srcPro, "utf8");
    if (androidPackage && androidPackage !== "ai.elizaos.app") {
      proguardRules = proguardRules.replaceAll(
        "ai.elizaos.app.**",
        `${androidPackage}.**`,
      );
    }
    fs.writeFileSync(
      path.join(androidDir, "app", "proguard-rules.pro"),
      proguardRules,
      "utf8",
    );
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

export const IOS_OFFICIAL_PODS = [
  ["CapacitorApp", "@capacitor/app"],
  // Preferences is intentionally installed through CocoaPods on iOS because
  // Capacitor's generated SPM package is stripped below for this plugin.
  ["CapacitorPreferences", "@capacitor/preferences"],
  ["CapacitorKeyboard", "@capacitor/keyboard"],
  ["CapacitorBrowser", "@capacitor/browser"],
];

const IOS_INCOMPATIBLE_SPM_PLUGINS = new Set([
  "CapacitorApp",
  "CapacitorPreferences",
  "CapacitorStatusBar",
]);

const IOS_COCOAPODS_OWNED_SPM_PLUGINS = new Set(["LlamaCppCapacitor"]);

const IOS_BONJOUR_SERVICES = [
  "_eliza-gw._tcp",
  "_elizaos-gw._tcp",
  "_eliza._tcp",
];

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
    // UIBackgroundModes and BGTaskSchedulerPermittedIdentifiers are MERGED,
    // not force-set: the template Info.plist already declares the modes the
    // ElizaTasks plugin needs (`processing`, `remote-notification`) and the
    // BGTaskScheduler identifiers (`ai.eliza.tasks.refresh`,
    // `ai.eliza.tasks.processing`). The overlay only guarantees the baseline
    // `fetch` mode is present and that the ElizaTasks identifiers survive a
    // regeneration where a downstream embedder forgot to copy them.
    const nextPlist = ensurePlistUrlScheme(
      ensurePlistArrayStrings(
        ensurePlistArrayStrings(
          ensurePlistArrayStrings(
            replaceOrInsertPlistString(
              plist,
              "CFBundleDisplayName",
              "$(ELIZA_DISPLAY_NAME)",
            ),
            "NSBonjourServices",
            IOS_BONJOUR_SERVICES,
          ),
          "UIBackgroundModes",
          ["fetch", "processing", "remote-notification"],
        ),
        "BGTaskSchedulerPermittedIdentifiers",
        ["ai.eliza.tasks.refresh", "ai.eliza.tasks.processing"],
      ),
      APP.urlScheme,
    );
    if (nextPlist !== plist) {
      plist = nextPlist;
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
    ent = ent.replace("group.app.eliza", `group.${APP.appId}`);
    fs.writeFileSync(path.join(targetAppDir, "App.entitlements"), ent, "utf8");
    console.log(
      `[mobile-build] Copied iOS entitlements (app group: group.${APP.appId}).`,
    );
  }

  // Patch xcconfigs to include CocoaPods settings
  for (const cfg of ["debug", "release"]) {
    const xcPath = path.join(appDir, "ios", `${cfg}.xcconfig`);
    if (fs.existsSync(xcPath)) {
      const xc = fs.readFileSync(xcPath, "utf8");
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

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function isIosSimulatorBuildTarget(buildTarget) {
  return (
    buildTarget?.sdk === "iphonesimulator" ||
    /\bSimulator\b/i.test(buildTarget?.destination ?? "")
  );
}

export function prepareIosOverlay({ buildTarget = null } = {}) {
  const syncedFiles = syncPlatformTemplateFiles("ios");
  overlayIos();
  stripSpmIncompatiblePlugins();
  const includeLlama =
    isTruthyEnv(process.env.ELIZA_IOS_INCLUDE_LLAMA) ||
    isTruthyEnv(process.env.MILADY_IOS_INCLUDE_LLAMA);
  if (isIosSimulatorBuildTarget(buildTarget) || !includeLlama) {
    // Strip the SPM LlamaCppCapacitor entry whenever we're not bundling the
    // pod — either because the simulator build replaces it with a CocoaPod
    // (existing behavior) or because the build deliberately omits llama
    // (cloud-only / App Store thin client).
    stripSpmPlugins(IOS_COCOAPODS_OWNED_SPM_PLUGINS, {
      reason: includeLlama ? "CocoaPods-owned" : "llama excluded",
    });
  }
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

  // LlamaCppCapacitor ships an on-device llama.cpp xcframework. It is only
  // needed when the iOS build includes on-device inference. The default
  // App Store target is the `cloud` runtime mode, which is a thin HTTP
  // client and must NOT bundle the llama.cpp binary. Gate the pod on
  // ELIZA_IOS_INCLUDE_LLAMA / MILADY_IOS_INCLUDE_LLAMA — kept in sync with
  // `resolveIosBuildTarget()` so the pod, the xcframework path, and the
  // build destination all agree on a single inclusion decision.
  const includeLlama =
    isTruthyEnv(process.env.ELIZA_IOS_INCLUDE_LLAMA) ||
    isTruthyEnv(process.env.MILADY_IOS_INCLUDE_LLAMA);
  const customPods = [
    ["ElizaosCapacitorAgent", "@elizaos/capacitor-agent"],
    ["ElizaosCapacitorAppblocker", "@elizaos/capacitor-appblocker"],
    ["ElizaosCapacitorCamera", "@elizaos/capacitor-camera"],
    ["ElizaosCapacitorCalendar", "@elizaos/capacitor-calendar"],
    ["ElizaosCapacitorCanvas", "@elizaos/capacitor-canvas"],
    ["ElizaosCapacitorElizaTasks", "@elizaos/capacitor-eliza-tasks"],
    ["ElizaosCapacitorGateway", "@elizaos/capacitor-gateway"],
    ["ElizaosCapacitorLocation", "@elizaos/capacitor-location"],
    ["ElizaosCapacitorMobileSignals", "@elizaos/capacitor-mobile-signals"],
    ["ElizaosCapacitorScreencapture", "@elizaos/capacitor-screencapture"],
    ["ElizaosCapacitorSwabble", "@elizaos/capacitor-swabble"],
    ["ElizaosCapacitorTalkmode", "@elizaos/capacitor-talkmode"],
    ["ElizaosCapacitorWebsiteblocker", "@elizaos/capacitor-websiteblocker"],
    ...(includeLlama ? [["LlamaCppCapacitor", "llama-cpp-capacitor"]] : []),
  ];
  if (!includeLlama) {
    console.log(
      "[mobile-build] iOS Podfile: omitting LlamaCppCapacitor (ELIZA_IOS_INCLUDE_LLAMA / MILADY_IOS_INCLUDE_LLAMA not set)",
    );
  }

  const lines = [
    `  pod 'Capacitor', :path => node_package_path('@capacitor/ios')`,
    `  pod 'CapacitorCordova', :path => node_package_path('@capacitor/ios')`,
  ];

  for (const [name, pkg] of IOS_OFFICIAL_PODS) {
    const p = resolvePackagePath(pkg, podfileDir);
    if (p) lines.push(`  pod '${name}', :path => node_package_path('${pkg}')`);
  }

  for (const [name, pkg] of customPods) {
    const p = resolveNativePluginPackagePath(pkg, podfileDir);
    if (p) {
      lines.push(`  pod '${name}', :path => '${p}'`);
    }
  }

  fs.writeFileSync(
    path.join(podfileDir, "Podfile"),
    `\
def node_package_path(package_name)
  package_json = \`node --print "require.resolve('#{package_name}/package.json')"\`.strip
  if package_json.empty?
    raise "Unable to resolve #{package_name}; run bun install before pod install"
  end
  File.dirname(package_json)
end

capacitor_ios_path = node_package_path('@capacitor/ios')

require_relative File.join(capacitor_ios_path, 'scripts/pods_helpers')

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

function stripSpmPlugins(
  pluginNames,
  { reason = "incompatible SPM plugin" } = {},
) {
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
    for (const name of pluginNames) {
      if (line.includes(`"${name}"`)) return false;
    }
    return true;
  });
  const changed = filtered.length !== lines.length;
  content = filtered.join("\n");

  if (changed) {
    content = content.replace(/,(\s*[\])])/g, "$1").replace(/\n{3,}/g, "\n\n");
    fs.writeFileSync(pkgPath, content, "utf8");
    console.log(
      `[mobile-build] Stripped ${reason} SPM plugins: ${Array.from(
        pluginNames,
      ).join(", ")}`,
    );
  }
}

/** Strip incompatible official plugins from SPM Package.swift. */
function stripSpmIncompatiblePlugins() {
  stripSpmPlugins(IOS_INCOMPATIBLE_SPM_PLUGINS, {
    reason: "incompatible",
  });
}

function patchAndroidGradleWrapperForReleaseCompat() {
  const wrapperPath = path.join(
    androidDir,
    "gradle",
    "wrapper",
    "gradle-wrapper.properties",
  );
  if (!fs.existsSync(wrapperPath)) return;
  const current = fs.readFileSync(wrapperPath, "utf8");
  const patched = current.replace(
    /^distributionUrl=.*$/m,
    "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.4.1-all.zip",
  );
  if (patched !== current) {
    fs.writeFileSync(wrapperPath, patched, "utf8");
    console.log("[mobile-build] Patched Android Gradle wrapper for AGP 9.");
  }
}

// llama-cpp-capacitor 0.x ships Android Gradle DSL 8 syntax in its own
// build.gradle. AGP 9 + Gradle 9 demand explicit `=` assignment for the
// project-level DSL keys it uses (`namespace`, `version`, `ndkVersion`,
// `lintOptions.abortOnError`) and rejects the legacy whitespace form, and
// the legacy proguard file path is no longer shipped. Patch the installed
// node_modules copy in place each build — modifying node_modules survives
// the gradle invocation but a fresh `bun install` will re-clobber it,
// which is fine because this function runs before every build.
function patchInstalledLlamaCapacitorBuildGradle() {
  const candidates = [
    path.join(
      appDir,
      "node_modules",
      "llama-cpp-capacitor",
      "android",
      "build.gradle",
    ),
    path.join(
      repoRoot,
      "node_modules",
      "llama-cpp-capacitor",
      "android",
      "build.gradle",
    ),
  ];
  const bunStores = [
    path.join(appDir, "node_modules", ".bun"),
    path.join(repoRoot, "node_modules", ".bun"),
  ];
  for (const bunStore of bunStores) {
    if (!fs.existsSync(bunStore)) continue;
    for (const entry of fs.readdirSync(bunStore, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("llama-cpp-capacitor@")) continue;
      candidates.push(
        path.join(
          bunStore,
          entry.name,
          "node_modules",
          "llama-cpp-capacitor",
          "android",
          "build.gradle",
        ),
      );
    }
  }
  for (const gradlePath of candidates) {
    if (!fs.existsSync(gradlePath)) continue;
    const current = fs.readFileSync(gradlePath, "utf8");
    let patched = current
      .replaceAll(
        'namespace "ai.annadata.plugin.capacitor"',
        'namespace = "ai.annadata.plugin.capacitor"',
      )
      .replaceAll('version "3.22.1"', 'version = "3.22.1"')
      .replaceAll('ndkVersion "29.0.13113456"', 'ndkVersion = "29.0.13113456"')
      .replaceAll("abortOnError false", "abortOnError = false")
      .replaceAll(
        "getDefaultProguardFile('proguard-android.txt')",
        "getDefaultProguardFile('proguard-android-optimize.txt')",
      );
    patched = patched.replace(
      /\n\s*\/\/ Disable clean tasks[^\n]*\n\s*tasks\.whenTaskAdded\s*\{\s*task\s*->\s*\n\s*if\s*\(\s*task\.name\.contains\(["']Clean["']\)\s*&&\s*task\.name\.contains\(["']Debug["']\)\s*\)\s*\{\s*\n\s*task\.enabled\s*=\s*false\s*\n\s*\}\s*\n\s*\}\s*/g,
      "\n",
    );
    if (patched !== current) {
      fs.writeFileSync(gradlePath, patched, "utf8");
      console.log(
        `[mobile-build] Patched llama-cpp-capacitor build.gradle for AGP 9: ${path.relative(repoRoot, gradlePath)}`,
      );
    }
  }
}

function patchAndroidGradle() {
  patchAndroidGradleWrapperForReleaseCompat();
  patchInstalledLlamaCapacitorBuildGradle();
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
    patched = replaceOrInsertGradleString(patched, "applicationId", APP.appId);
    patched = appendMissingGradleDependency(
      patched,
      "com.google.code.gson:gson:2.13.2",
    );
    patched = appendMissingGradleDependency(
      patched,
      "com.google.firebase:firebase-common-ktx:21.0.0",
    );
    patched = patched.replace(
      /getDefaultProguardFile\('proguard-android\.txt'\)/g,
      "getDefaultProguardFile('proguard-android-optimize.txt')",
    );
    patched = injectBuildConfigAospField(patched);
    patched = injectNoCompressTarGz(patched);
    patched = injectNativeLibLegacyPackaging(patched);
    patched = injectAospAssetThinning(patched);
    patched = injectCopyForkLlamaLibTask(patched);
    if (patched !== current) {
      fs.writeFileSync(appGradlePath, patched, "utf8");
      console.log(
        `[mobile-build] Applied Android package identity ${APP.appId}.`,
      );
    }
  }

  patchOfficialCapacitorGradleForAgp9();
  patchLlamaCppCapacitorGradle();
  patchNativePluginGradleForAgp9();

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
      console.log(
        `[mobile-build] Applied Android app strings for ${APP.appName}.`,
      );
    }
  }
}

function sanitizeAndroidManifestWhenPlatformTemplatesMissing() {
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
  if (fs.existsSync(srcJava)) return;

  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (!fs.existsSync(manifestPath)) return;

  let xml = fs.readFileSync(manifestPath, "utf8");
  const original = xml;
  const removeComponent = (source, className) => {
    const escapedName = escapeRegExp(className);
    const pairedRe = new RegExp(
      `\\n\\s*<(activity|service|receiver)\\b(?=[^>]*android:name="[^"]*\\.?${escapedName}")[\\s\\S]*?<\\/\\1>\\s*`,
      "g",
    );
    const selfClosingRe = new RegExp(
      `\\n\\s*<(activity|service|receiver)\\b(?=[^>]*android:name="[^"]*\\.?${escapedName}")[^>]*/>\\s*`,
      "g",
    );
    return source.replace(pairedRe, "\n").replace(selfClosingRe, "\n");
  };

  for (const component of [
    "ElizaAgentService",
    "ElizaDialActivity",
    "ElizaAssistActivity",
    "ElizaInCallService",
    "ElizaSmsReceiver",
    "ElizaMmsReceiver",
    "ElizaRespondViaMessageService",
    "ElizaSmsComposeActivity",
    "ElizaBootReceiver",
    "ElizaBrowserActivity",
    "ElizaContactsActivity",
    "ElizaCameraActivity",
    "ElizaClockActivity",
    "ElizaCalendarActivity",
  ]) {
    xml = removeComponent(xml, component);
  }
  if (xml !== original) {
    fs.writeFileSync(manifestPath, xml, "utf8");
    console.log(
      "[mobile-build] Removed Android components that need packaged platform templates.",
    );
  }
}

const ANDROID_LAUNCHER_ICON_SIZES = {
  "mipmap-mdpi": 48,
  "mipmap-hdpi": 72,
  "mipmap-xhdpi": 96,
  "mipmap-xxhdpi": 144,
  "mipmap-xxxhdpi": 192,
};

const ANDROID_SPLASH_SIZES = {
  drawable: [480, 320],
  "drawable-port-mdpi": [320, 480],
  "drawable-port-hdpi": [480, 720],
  "drawable-port-xhdpi": [640, 960],
  "drawable-port-xxhdpi": [960, 1440],
  "drawable-port-xxxhdpi": [1280, 1920],
  "drawable-land-mdpi": [480, 320],
  "drawable-land-hdpi": [720, 480],
  "drawable-land-xhdpi": [960, 640],
  "drawable-land-xxhdpi": [1440, 960],
  "drawable-land-xxxhdpi": [1920, 1280],
};

async function loadImageToolForBrandAssets(platform) {
  try {
    return { kind: "sharp", sharp: (await import("sharp")).default };
  } catch (error) {
    const magick = resolveExecutable("magick");
    if (magick) {
      console.warn(
        `[mobile-build] sharp is unavailable for ${platform} brand assets; using ImageMagick fallback.`,
      );
      return { kind: "magick", magick };
    }
    throw new Error(
      `sharp is required to generate ${platform} brand assets for ${APP.appName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function writeCoverPng(
  tool,
  source,
  output,
  width,
  height,
  options = {},
) {
  if (tool.kind === "sharp") {
    let image = tool.sharp(source).resize(width, height, {
      fit: "cover",
      position: "center",
    });
    if (options.flattenBackground) {
      image = image.flatten({ background: options.flattenBackground });
    }
    await image.png().toFile(output);
    return;
  }

  const args = [
    source,
    "-resize",
    `${width}x${height}^`,
    "-gravity",
    "center",
    "-extent",
    `${width}x${height}`,
  ];
  if (options.flattenBackground) {
    args.push(
      "-background",
      options.flattenBackground,
      "-alpha",
      "remove",
      "-alpha",
      "off",
    );
  }
  args.push(output);
  await run(tool.magick, args);
}

async function writeAndroidForegroundPng(tool, source, output, size) {
  if (tool.kind === "sharp") {
    const foregroundSize = Math.round(size * 0.7);
    const padding = Math.round(size * 0.4);
    await tool
      .sharp(source)
      .resize(foregroundSize, foregroundSize, { fit: "contain" })
      .extend({
        top: padding,
        bottom: padding,
        left: padding,
        right: padding,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .resize(Math.round(size * 1.5), Math.round(size * 1.5), {
        fit: "contain",
      })
      .png()
      .toFile(output);
    return;
  }

  await run(tool.magick, [
    source,
    "-resize",
    `${Math.round(size * 0.7)}x${Math.round(size * 0.7)}`,
    "-background",
    "none",
    "-gravity",
    "center",
    "-extent",
    `${Math.round(size * 1.5)}x${Math.round(size * 1.5)}`,
    output,
  ]);
}

function resolveBrandSources() {
  return {
    iconSource: firstExisting([
      path.join(appDir, "public", "android-chrome-512x512.png"),
      path.join(appDir, "public", "apple-touch-icon.png"),
      path.join(appDir, "public", "favicon-256x256.png"),
    ]),
    splashSource: firstExisting([
      path.join(appDir, "public", "splash-bg.png"),
      path.join(appDir, "public", "splash-bg.jpg"),
    ]),
  };
}

async function generateIosBrandAssets() {
  const assetDir = path.join(iosDir, "App", "Assets.xcassets");
  if (!fs.existsSync(assetDir)) return;

  const { iconSource, splashSource } = resolveBrandSources();
  if (!iconSource && !splashSource) return;

  const imageTool = await loadImageToolForBrandAssets("iOS");

  if (iconSource) {
    const iconSetDir = path.join(assetDir, "AppIcon.appiconset");
    const contentsPath = path.join(iconSetDir, "Contents.json");
    if (fs.existsSync(contentsPath)) {
      const contents = JSON.parse(fs.readFileSync(contentsPath, "utf8"));
      for (const image of contents.images ?? []) {
        if (!image.filename || !image.size || !image.scale) continue;
        const [width] = String(image.size).split("x");
        const scale = Number.parseFloat(String(image.scale));
        const pixels = Math.round(Number.parseFloat(width) * scale);
        if (!Number.isFinite(pixels) || pixels <= 0) continue;
        await writeCoverPng(
          imageTool,
          iconSource,
          path.join(iconSetDir, image.filename),
          pixels,
          pixels,
          { flattenBackground: "#000000" },
        );
      }
    }
  }

  if (splashSource) {
    const splashSetDir = path.join(assetDir, "Splash.imageset");
    const contentsPath = path.join(splashSetDir, "Contents.json");
    if (fs.existsSync(contentsPath)) {
      const contents = JSON.parse(fs.readFileSync(contentsPath, "utf8"));
      for (const image of contents.images ?? []) {
        if (!image.filename) continue;
        await writeCoverPng(
          imageTool,
          splashSource,
          path.join(splashSetDir, image.filename),
          2732,
          2732,
        );
      }
    }
  }

  console.log(`[mobile-build] Generated iOS brand assets for ${APP.appName}.`);
}

async function generateAndroidBrandAssets() {
  const resDir = path.join(androidDir, "app", "src", "main", "res");
  if (!fs.existsSync(resDir)) return;

  const { iconSource, splashSource } = resolveBrandSources();
  if (!iconSource && !splashSource) return;

  const imageTool = await loadImageToolForBrandAssets("Android");

  if (iconSource) {
    for (const [dir, size] of Object.entries(ANDROID_LAUNCHER_ICON_SIZES)) {
      const out = path.join(resDir, dir);
      fs.mkdirSync(out, { recursive: true });
      await writeCoverPng(
        imageTool,
        iconSource,
        path.join(out, "ic_launcher.png"),
        size,
        size,
      );
      await writeCoverPng(
        imageTool,
        iconSource,
        path.join(out, "ic_launcher_round.png"),
        size,
        size,
      );
      await writeAndroidForegroundPng(
        imageTool,
        iconSource,
        path.join(out, "ic_launcher_foreground.png"),
        size,
      );
    }
  }

  if (splashSource) {
    for (const [dir, [width, height]] of Object.entries(ANDROID_SPLASH_SIZES)) {
      const out = path.join(resDir, dir);
      fs.mkdirSync(out, { recursive: true });
      await writeCoverPng(
        imageTool,
        splashSource,
        path.join(out, "splash.png"),
        width,
        height,
      );
    }
  }

  console.log(
    `[mobile-build] Generated Android brand assets for ${APP.appName}.`,
  );
}

// ── Phase 6: Native builds ──────────────────────────────────────────────

export function patchLlamaCppCapacitorPodspecForXcframework(
  packageDir,
  {
    xcframeworkRelPath = "ios/Frameworks-xcframework/LlamaCpp.xcframework",
  } = {},
) {
  const podspecPath = path.join(packageDir, "LlamaCppCapacitor.podspec");
  if (!fs.existsSync(podspecPath)) return;
  const current = fs.readFileSync(podspecPath, "utf8");
  let patched = current.replace(
    "s.vendored_frameworks = 'ios/Frameworks/llama-cpp.framework'",
    `s.vendored_frameworks = '${xcframeworkRelPath}'`,
  );
  patched = patched.replace(
    "s.vendored_frameworks = 'ios/Frameworks/LlamaCpp.framework'",
    `s.vendored_frameworks = '${xcframeworkRelPath}'`,
  );
  patched = patched.replace(
    "s.vendored_frameworks = 'ios/Frameworks/llama-cpp.xcframework'",
    `s.vendored_frameworks = '${xcframeworkRelPath}'`,
  );
  patched = patched.replace(
    "s.vendored_frameworks = 'ios/Frameworks/LlamaCpp.xcframework'",
    `s.vendored_frameworks = '${xcframeworkRelPath}'`,
  );
  patched = patched.replace(
    /\n\s*s\.pod_target_xcconfig\s*=\s*\{\s*\n\s*['"]FRAMEWORK_SEARCH_PATHS['"]\s*=>\s*['"]\$\(inherited\) "\$\(PODS_TARGET_SRCROOT\)\/ios\/Frameworks"['"]\s*\n\s*\}\s*/m,
    "\n",
  );
  // The published podspec also injects `ios/Frameworks` into
  // FRAMEWORK_SEARCH_PATHS, which contains the device-only
  // `llama-cpp.framework` next to the xcframework. The linker scans
  // -F paths in order and resolves `-framework llama-cpp` against the
  // device-only slice first, producing
  //   ld: building for 'iOS-simulator', but linking in dylib (...
  //   /llama-cpp.framework/llama-cpp) built for 'iOS'
  // on iphonesimulator builds. Drop the explicit search path so the
  // xcframework's per-platform slice is picked up via the standard
  // XCFrameworkIntermediates path the Xcode build system maintains.
  patched = patched.replace(
    /\s*s\.pod_target_xcconfig\s*=\s*\{[^}]*'FRAMEWORK_SEARCH_PATHS'\s*=>\s*'[^']*'[^}]*\}\s*/,
    "\n",
  );
  if (patched !== current) {
    fs.writeFileSync(podspecPath, patched, "utf8");
    console.log(
      "[mobile-build] Patched llama-cpp-capacitor podspec for xcframework + dropped FRAMEWORK_SEARCH_PATHS device-only override.",
    );
  }
}

// Wave-4-F (iOS pipeline rewire): the iOS LlamaCpp.xcframework is now
// produced by `build-llama-cpp-dflash.mjs --target ios-arm64-metal` +
// `--target ios-arm64-simulator-metal` and assembled by
// `ios-xcframework/build-xcframework.mjs --verify`. The previous in-process
// cmake invocation that built `llama-cpp-capacitor`'s bundled `ios/`
// source produced a STOCK llama.cpp framework with none of the milady
// kernels (TurboQuant / QJL / PolarQuant / DFlash) and silently violated
// AGENTS.md §3 on every iOS build. Delegating to the dflash builder
// ensures the same kernel-set lands on iOS as on darwin/linux/android.
//
// AGENTS.md §3 enforcement: build-llama-cpp-dflash.mjs hard-throws on
// missing kernels via writeCapabilities()/requiredKernelsMissing(); the
// xcframework packaging --verify step additionally greps the static
// archives for AGENTS.md §3 kernel symbols. Either failure aborts the
// iOS build before the npm-bundled stock framework can be linked.
const DFLASH_BUILD_SCRIPT = path.resolve(
  __dirname,
  "build-llama-cpp-dflash.mjs",
);
const IOS_XCFRAMEWORK_BUILD_SCRIPT = path.resolve(
  __dirname,
  "ios-xcframework",
  "build-xcframework.mjs",
);

function elizaStateDirForBuild() {
  const env = process.env.ELIZA_STATE_DIR?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".eliza");
}

function dflashTargetOutDir(target) {
  return path.join(
    elizaStateDirForBuild(),
    "local-inference",
    "bin",
    "dflash",
    target,
  );
}

async function ensureDflashIosTarget(target) {
  const outDir = dflashTargetOutDir(target);
  const capabilities = path.join(outDir, "CAPABILITIES.json");
  if (fs.existsSync(capabilities)) {
    console.log(
      `[mobile-build] Reusing existing dflash artifact for ${target} at ${outDir}`,
    );
    return outDir;
  }
  console.log(`[mobile-build] Building dflash artifact for ${target}`);
  await run("node", [DFLASH_BUILD_SCRIPT, "--target", target]);
  if (!fs.existsSync(capabilities)) {
    throw new Error(
      `[mobile-build] dflash build for ${target} did not produce CAPABILITIES.json at ${capabilities}. ` +
        `AGENTS.md §3 forbids shipping an iOS framework without the full kernel set; aborting.`,
    );
  }
  return outDir;
}

async function ensureIosLlamaCppVendoredFramework({
  buildTarget: _buildTarget,
}) {
  // When llama is excluded from the build (cloud-only / App Store thin
  // client), the pod is not generated and the vendored framework is not
  // referenced. Skipping here avoids spinning up xcodebuild for an
  // xcframework that nothing consumes.
  const includeLlama =
    isTruthyEnv(process.env.ELIZA_IOS_INCLUDE_LLAMA) ||
    isTruthyEnv(process.env.MILADY_IOS_INCLUDE_LLAMA);
  if (!includeLlama) return;

  if (process.platform !== "darwin") {
    throw new Error(
      "[mobile-build] iOS llama.cpp xcframework build requires a macOS host with Xcode. " +
        "Either run on macOS or unset ELIZA_IOS_INCLUDE_LLAMA / MILADY_IOS_INCLUDE_LLAMA.",
    );
  }

  const packageDir = resolvePackageAbsolutePath("llama-cpp-capacitor");
  if (!packageDir) {
    throw new Error(
      "[mobile-build] llama-cpp-capacitor package not found in node_modules; " +
        "either install it or unset ELIZA_IOS_INCLUDE_LLAMA / MILADY_IOS_INCLUDE_LLAMA.",
    );
  }

  const frameworksDir = path.join(packageDir, "ios", "Frameworks");
  const xcframeworksDir = path.join(
    packageDir,
    "ios",
    "Frameworks-xcframework",
  );
  const xcframeworkDir = path.join(xcframeworksDir, "LlamaCpp.xcframework");
  patchLlamaCppCapacitorPodspecForXcframework(packageDir);

  // Build (or reuse) both per-platform slices via the dflash builder so
  // the iOS xcframework carries the same milady kernel set as every
  // other supported backend. Per AGENTS.md §3, missing kernels here are
  // a hard error: build-llama-cpp-dflash.mjs already enforces that and
  // throws via writeCapabilities() before producing CAPABILITIES.json.
  await ensureDflashIosTarget("ios-arm64-metal");
  await ensureDflashIosTarget("ios-arm64-simulator-metal");

  fs.mkdirSync(xcframeworksDir, { recursive: true });
  fs.rmSync(xcframeworkDir, { recursive: true, force: true });
  await run("node", [
    IOS_XCFRAMEWORK_BUILD_SCRIPT,
    "--output",
    xcframeworkDir,
    "--device-archive-dir",
    dflashTargetOutDir("ios-arm64-metal"),
    "--sim-archive-dir",
    dflashTargetOutDir("ios-arm64-simulator-metal"),
    "--verify",
  ]);

  // CocoaPods adds the parent directory of every `vendored_frameworks`
  // entry to FRAMEWORK_SEARCH_PATHS. The npm package ships a stock
  // device-only `LlamaCpp.framework` / `llama-cpp.framework` next to
  // the (now-replaced) xcframework slot. With both present the linker
  // resolves `-framework LlamaCpp` to the stock .framework first and
  // fails simulator builds with:
  //   ld: building for 'iOS-simulator', but linking in dylib (...) built for 'iOS'
  // Move the npm-bundled stock frameworks out of the search path so the
  // xcframework's per-platform slice is the only resolvable target.
  for (const stale of [
    path.join(frameworksDir, "LlamaCpp.framework"),
    path.join(frameworksDir, "llama-cpp.framework"),
  ]) {
    if (!fs.existsSync(stale)) continue;
    const archived = path.join(
      packageDir,
      "ios",
      `.${path.basename(stale, ".framework")}-stock-archive`,
    );
    fs.rmSync(archived, { recursive: true, force: true });
    fs.renameSync(stale, archived);
    console.log(
      `[mobile-build] Archived stock npm framework: ${stale} -> ${archived} ` +
        `(stock build has no Eliza-1 kernels — see AGENTS.md §3).`,
    );
  }
  console.log(
    "[mobile-build] iOS LlamaCpp.xcframework wired to milady-built kernels (device + simulator slices).",
  );
}

export function shouldRunIosPodInstall(syncedFiles = []) {
  return syncedFiles.includes(path.join("App", "Podfile"));
}

export function resolveIosBuildTarget({
  env = process.env,
  appDirValue = appDir,
} = {}) {
  const explicitDestination = env.ELIZA_IOS_BUILD_DESTINATION;
  const explicitSdk = env.ELIZA_IOS_BUILD_SDK;

  if (explicitDestination || explicitSdk) {
    return {
      destination: explicitDestination ?? "generic/platform=iOS Simulator",
      sdk: explicitSdk ?? "iphonesimulator",
      reason: "explicit environment override",
    };
  }

  const includeDeviceOnlyLlama =
    isTruthyEnv(env.ELIZA_IOS_INCLUDE_LLAMA) ||
    isTruthyEnv(env.MILADY_IOS_INCLUDE_LLAMA);
  const llamaCppFramework = firstExisting([
    path.join(
      appDirValue,
      "node_modules",
      "llama-cpp-capacitor",
      "ios",
      "Frameworks",
      "LlamaCpp.framework",
      "LlamaCpp",
    ),
    path.join(
      appDirValue,
      "node_modules",
      "llama-cpp-capacitor",
      "ios",
      "Frameworks",
      "llama-cpp.framework",
      "llama-cpp",
    ),
  ]);

  if (includeDeviceOnlyLlama && llamaCppFramework) {
    return {
      destination: "generic/platform=iOS",
      sdk: "iphoneos",
      reason: "explicit device llama.cpp framework build",
    };
  }

  return {
    destination: "generic/platform=iOS Simulator",
    sdk: "iphonesimulator",
    reason: "default cloud simulator build",
  };
}

// ── Android cloud (Play-Store) strip set ────────────────────────────────
//
// The default Android target injects an on-device agent runtime, default
// roles (dialer, SMS, browser, contacts, camera, calendar, clock,
// assistant, in-call), a boot receiver, and the privileged appop /
// usage-stats permissions that AOSP needs but Play Store rejects. The
// `android-cloud` target produces a thin Capacitor client backed by Eliza
// Cloud and must not ship any of those components.
//
// Components deleted from the manifest (and from app/src/main/java/...):
const ANDROID_CLOUD_STRIPPED_COMPONENTS = [
  "ElizaAgentService",
  "ElizaDialActivity",
  "ElizaAssistActivity",
  "ElizaInCallService",
  "ElizaSmsReceiver",
  "ElizaMmsReceiver",
  "ElizaRespondViaMessageService",
  "ElizaSmsComposeActivity",
  "ElizaBootReceiver",
  "ElizaBrowserActivity",
  "ElizaContactsActivity",
  "ElizaCameraActivity",
  "ElizaClockActivity",
  "ElizaCalendarActivity",
];

// Permissions removed from the manifest. Anything that triggers a Play
// Store policy review (sensitive runtime perms, system-only signature
// perms, default-role / call / SMS perms, background location) gets
// dropped. The remainder — INTERNET, POST_NOTIFICATIONS, FOREGROUND_SERVICE
// + FOREGROUND_SERVICE_DATA_SYNC for the Gateway sync service, WAKE_LOCK,
// scoped storage SDK fallbacks, RECORD_AUDIO/CAMERA/LOCATION needed for
// Capacitor plugins the cloud renderer still uses — stays in place.
const ANDROID_CLOUD_STRIPPED_PERMISSIONS = [
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
  "ACCESS_BACKGROUND_LOCATION",
  "FOREGROUND_SERVICE_SPECIAL_USE",
  "RECEIVE_BOOT_COMPLETED",
  "SYSTEM_ALERT_WINDOW",
  "PACKAGE_USAGE_STATS",
  "MANAGE_APP_OPS_MODES",
  "MANAGE_VIRTUAL_MACHINE",
  "BIND_DEVICE_ADMIN",
];

// Java sources removed from the merged sources tree so they don't
// reference manifest-stripped classes and break compilation.
const ANDROID_CLOUD_STRIPPED_JAVA_FILES = [
  "AndroidVirtualizationBridge.java",
  "ElizaAgentService.java",
  "ElizaAssistActivity.java",
  "ElizaBootReceiver.java",
  "ElizaBrowserActivity.java",
  "ElizaCalendarActivity.java",
  "ElizaCameraActivity.java",
  "ElizaClockActivity.java",
  "ElizaContactsActivity.java",
  "ElizaDialActivity.java",
  "ElizaInCallService.java",
  "ElizaMmsReceiver.java",
  "ElizaRespondViaMessageService.java",
  "ElizaSmsComposeActivity.java",
  "ElizaSmsReceiver.java",
];

const ANDROID_CLOUD_STRIPPED_ASSET_FILES = new Set(["llama-cpp-kernels.json"]);

const ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS = [
  ["@elizaos/capacitor-agent", "elizaos-capacitor-agent"],
  ["@elizaos/capacitor-appblocker", "elizaos-capacitor-appblocker"],
  ["@elizaos/capacitor-contacts", "elizaos-capacitor-contacts"],
  ["@elizaos/capacitor-messages", "elizaos-capacitor-messages"],
  ["@elizaos/capacitor-mobile-signals", "elizaos-capacitor-mobile-signals"],
  ["@elizaos/capacitor-phone", "elizaos-capacitor-phone"],
  ["@elizaos/capacitor-system", "elizaos-capacitor-system"],
  ["@elizaos/capacitor-websiteblocker", "elizaos-capacitor-websiteblocker"],
  ["@elizaos/capacitor-wifi", "elizaos-capacitor-wifi"],
  ["llama-cpp-capacitor", "llama-cpp-capacitor"],
];

function isCloudBannedNativeLibrary(fileName) {
  return (
    fileName.startsWith("libeliza_") ||
    fileName === "libsigsys-handler.so" ||
    /^lib.*llama.*\.so$/i.test(fileName)
  );
}

function isCloudBannedAsset(filePath) {
  const base = path.basename(filePath);
  return (
    ANDROID_CLOUD_STRIPPED_ASSET_FILES.has(base) ||
    base === "bun" ||
    base.endsWith(".gguf")
  );
}

function cloudBrandUserAgentMarkerLines() {
  const markers = [
    { systemProp: "ro.elizaos.product", uaPrefix: "ElizaOS/" },
    ...(APP.userAgentMarkers ?? []),
  ];
  return markers
    .map(
      (marker) =>
        `        new UserAgentMarker("${escapeJavaString(marker.systemProp)}", "${escapeJavaString(marker.uaPrefix)}"),`,
    )
    .join("\n");
}

function cloudSafeMainActivityJava(androidPackage) {
  return `package ${androidPackage};

import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import ${androidPackage}.BuildConfig;

import java.lang.reflect.Method;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "ElizaMainActivity";

    private static final class UserAgentMarker {
        final String systemProp;
        final String uaPrefix;

        UserAgentMarker(String systemProp, String uaPrefix) {
            this.systemProp = systemProp;
            this.uaPrefix = uaPrefix;
        }
    }

    private static final UserAgentMarker[] BRAND_USER_AGENT_MARKERS = new UserAgentMarker[] {
${cloudBrandUserAgentMarkerLines()}
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        registerPlugin(AgentPlugin.class);
        super.onCreate(savedInstanceState);

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            applyBrandUserAgentMarkers(settings);
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        if (!isFinishing()) {
            GatewayConnectionService.start(this);
        }
    }

    @Override
    public void onDestroy() {
        if (isFinishing()) {
            GatewayConnectionService.stop(this);
        }
        super.onDestroy();
    }

    private void applyBrandUserAgentMarkers(WebSettings settings) {
        StringBuilder newUa = null;
        String currentUa = settings.getUserAgentString();
        for (UserAgentMarker marker : BRAND_USER_AGENT_MARKERS) {
            if (marker.systemProp == null || marker.systemProp.isEmpty()) {
                continue;
            }
            String tag = readSystemProperty(marker.systemProp);
            if (tag == null || tag.isEmpty()) {
                continue;
            }
            String token = marker.uaPrefix + tag;
            if (currentUa != null && currentUa.contains(token)) {
                continue;
            }
            if (newUa == null) {
                newUa = new StringBuilder(currentUa == null ? "" : currentUa);
            }
            if (newUa.length() > 0) {
                newUa.append(" ");
            }
            newUa.append(token);
        }
        if (newUa != null) {
            settings.setUserAgentString(newUa.toString());
        }
    }

    private static String readSystemProperty(String key) {
        try {
            Class<?> spClass = Class.forName("android.os.SystemProperties");
            Method get = spClass.getMethod("get", String.class);
            Object result = get.invoke(null, key);
            return result instanceof String ? (String) result : "";
        } catch (ReflectiveOperationException | SecurityException e) {
            Log.w(TAG, "SystemProperties.get failed for " + key, e);
            return "";
        }
    }
}
`;
}

function cloudSafeAgentPluginJava(androidPackage) {
  return `package ${androidPackage};

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

@CapacitorPlugin(name = "Agent")
public class AgentPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        call.resolve(cloudOnlyStatus());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("cloudOnly", true);
        call.resolve(result);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(cloudOnlyStatus());
    }

    @PluginMethod
    public void getLocalAgentToken(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", false);
        result.put("token", JSONObject.NULL);
        result.put("cloudOnly", true);
        call.resolve(result);
    }

    @PluginMethod
    public void request(PluginCall call) {
        call.reject("Local agent runtime is not bundled in the android-cloud build");
    }

    private static JSObject cloudOnlyStatus() {
        JSObject result = new JSObject();
        result.put("state", "cloud_only");
        result.put("agentName", JSONObject.NULL);
        result.put("port", JSONObject.NULL);
        result.put("startedAt", JSONObject.NULL);
        result.put("error", JSONObject.NULL);
        result.put("cloudOnly", true);
        return result;
    }
}
`;
}

function rewriteCloudJavaSources(javaRoots, androidPackage) {
  let touched = 0;
  for (const root of javaRoots) {
    if (!fs.existsSync(root)) continue;
    const mainActivity = path.join(root, "MainActivity.java");
    if (fs.existsSync(mainActivity)) {
      fs.writeFileSync(
        mainActivity,
        cloudSafeMainActivityJava(androidPackage),
        "utf8",
      );
      touched += 1;
    }
    const agentPlugin = path.join(root, "AgentPlugin.java");
    if (fs.existsSync(agentPlugin)) {
      fs.writeFileSync(
        agentPlugin,
        cloudSafeAgentPluginJava(androidPackage),
        "utf8",
      );
      touched += 1;
    }
    const nativeBridge = path.join(root, "ElizaNativeBridge.java");
    if (fs.existsSync(nativeBridge)) {
      fs.rmSync(nativeBridge);
      touched += 1;
    }
  }
  if (touched > 0) {
    console.log(
      `[mobile-build] Rewrote ${touched} local-agent Java source(s) for android-cloud.`,
    );
  }
}

function removeCloudNativeArtifacts() {
  const assetsRoot = path.join(androidDir, "app", "src", "main", "assets");
  const stagedAgentAssets = path.join(assetsRoot, "agent");
  if (fs.existsSync(stagedAgentAssets)) {
    fs.rmSync(stagedAgentAssets, { recursive: true, force: true });
    console.log(
      "[mobile-build] Removed staged on-device agent runtime under assets/agent/.",
    );
  }

  let removedAssetCount = 0;
  walkFiles(assetsRoot, (filePath) => {
    if (isCloudBannedAsset(filePath)) {
      fs.rmSync(filePath, { force: true });
      removedAssetCount += 1;
    }
  });
  if (removedAssetCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedAssetCount} native inference/runtime asset(s) from android-cloud source tree.`,
    );
  }

  const stagedJniLibs = path.join(androidDir, "app", "src", "main", "jniLibs");
  let removedLibCount = 0;
  walkFiles(stagedJniLibs, (filePath) => {
    if (isCloudBannedNativeLibrary(path.basename(filePath))) {
      fs.rmSync(filePath, { force: true });
      removedLibCount += 1;
    }
  });
  if (removedLibCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedLibCount} native runtime/inference library(s) from jniLibs/.`,
    );
  }
}

function stripAndroidCloudNativePlugins() {
  const strippedPkgs = new Set(
    ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS.map(([pkg]) => pkg),
  );
  const settingsPath = path.join(androidDir, "capacitor.settings.gradle");
  if (fs.existsSync(settingsPath)) {
    let patched = fs.readFileSync(settingsPath, "utf8");
    const current = patched;
    for (const [, gradleProject] of ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS) {
      const escaped = escapeRegExp(gradleProject);
      patched = patched
        .replace(new RegExp(`\\ninclude ':${escaped}'\\s*`, "g"), "\n")
        .replace(
          new RegExp(
            `\\nproject\\(':${escaped}'\\)\\.projectDir = new File\\([^\\n]+\\)\\s*`,
            "g",
          ),
          "\n",
        );
    }
    if (patched !== current) {
      fs.writeFileSync(settingsPath, patched, "utf8");
      console.log(
        "[mobile-build] Stripped cloud-disallowed native plugins from capacitor.settings.gradle.",
      );
    }
  }

  const capacitorBuildPath = path.join(
    androidDir,
    "app",
    "capacitor.build.gradle",
  );
  if (fs.existsSync(capacitorBuildPath)) {
    let patched = fs.readFileSync(capacitorBuildPath, "utf8");
    const current = patched;
    for (const [, gradleProject] of ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS) {
      const escaped = escapeRegExp(gradleProject);
      patched = patched.replace(
        new RegExp(`\\n\\s*implementation project\\(':${escaped}'\\)\\s*`, "g"),
        "\n",
      );
    }
    if (patched !== current) {
      fs.writeFileSync(capacitorBuildPath, patched, "utf8");
      console.log(
        "[mobile-build] Stripped cloud-disallowed native plugins from capacitor.build.gradle.",
      );
    }
  }

  const pluginManifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "assets",
    "capacitor.plugins.json",
  );
  if (fs.existsSync(pluginManifestPath)) {
    try {
      const plugins = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"));
      if (Array.isArray(plugins)) {
        const filtered = plugins.filter(
          (plugin) => !strippedPkgs.has(plugin?.pkg),
        );
        if (filtered.length !== plugins.length) {
          fs.writeFileSync(
            pluginManifestPath,
            `${JSON.stringify(filtered, null, "\t")}\n`,
            "utf8",
          );
          console.log(
            "[mobile-build] Stripped cloud-disallowed native plugins from capacitor.plugins.json.",
          );
        }
      }
    } catch (error) {
      throw new Error(
        `[mobile-build] Could not parse capacitor.plugins.json while stripping android-cloud native plugins: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function auditAndroidCloudSource(phase) {
  const failures = [];
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (fs.existsSync(manifestPath)) {
    const xml = fs.readFileSync(manifestPath, "utf8");
    if (xml.includes("ElizaAgentService")) {
      failures.push("AndroidManifest.xml still references ElizaAgentService");
    }
    for (const component of ANDROID_CLOUD_STRIPPED_COMPONENTS) {
      if (xml.includes(component)) {
        failures.push(`AndroidManifest.xml still references ${component}`);
      }
    }
    for (const perm of ANDROID_CLOUD_STRIPPED_PERMISSIONS) {
      const full = `android.permission.${perm}`;
      if (xml.includes(full)) {
        failures.push(`AndroidManifest.xml still requests ${full}`);
      }
    }
    if (/usesCleartextTraffic="true"/.test(xml)) {
      failures.push(
        "AndroidManifest.xml still allows global cleartext traffic",
      );
    }
  }

  const javaRoot = path.join(androidDir, "app", "src", "main", "java");
  walkFiles(javaRoot, (filePath) => {
    const base = path.basename(filePath);
    if (base === "ElizaAgentService.java") {
      failures.push(path.relative(androidDir, filePath));
      return;
    }
    if (!base.endsWith(".java")) return;
    const source = fs.readFileSync(filePath, "utf8");
    if (source.includes("ElizaAgentService")) {
      failures.push(
        `${path.relative(androidDir, filePath)} still references ElizaAgentService`,
      );
    }
    if (source.includes("new ElizaNativeBridge(")) {
      failures.push(
        `${path.relative(androidDir, filePath)} still installs ElizaNativeBridge`,
      );
    }
  });

  const assetsRoot = path.join(androidDir, "app", "src", "main", "assets");
  if (fs.existsSync(path.join(assetsRoot, "agent"))) {
    failures.push("app/src/main/assets/agent still exists");
  }
  walkFiles(assetsRoot, (filePath) => {
    if (isCloudBannedAsset(filePath)) {
      failures.push(path.relative(androidDir, filePath));
    }
  });

  const jniRoot = path.join(androidDir, "app", "src", "main", "jniLibs");
  walkFiles(jniRoot, (filePath) => {
    if (isCloudBannedNativeLibrary(path.basename(filePath))) {
      failures.push(path.relative(androidDir, filePath));
    }
  });

  for (const relPath of [
    "capacitor.settings.gradle",
    path.join("app", "capacitor.build.gradle"),
    path.join("app", "src", "main", "assets", "capacitor.plugins.json"),
  ]) {
    const filePath = path.join(androidDir, relPath);
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    for (const [pkg, gradleProject] of ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS) {
      if (source.includes(pkg) || source.includes(gradleProject)) {
        failures.push(`${relPath} still references ${pkg}/${gradleProject}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[mobile-build] android-cloud ${phase} audit failed:\n` +
        failures.map((failure) => `  - ${failure}`).join("\n"),
    );
  }
  console.log(`[mobile-build] android-cloud ${phase} audit passed.`);
}

/**
 * Strip the Play-Store-noncompliant manifest components, permissions, and
 * Java sources, plus any previously-staged on-device agent runtime
 * artifacts (assets/agent + jniLibs/libeliza_*.so), from a freshly
 * overlaid Android project.
 *
 * Idempotent: safe to re-run on an already-stripped tree.
 */
function stripAndroidForCloud() {
  const androidPackage = APP.appId;

  // 1. Strip manifest components, permissions, and BootReceiver/SMS/etc.
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (fs.existsSync(manifestPath)) {
    let xml = fs.readFileSync(manifestPath, "utf8");
    const original = xml;

    for (const component of ANDROID_CLOUD_STRIPPED_COMPONENTS) {
      xml = removeApplicationComponentBlock(
        xml,
        `${androidPackage}.${component}`,
      );
      xml = removeApplicationComponentClassBlock(xml, component);
    }

    for (const perm of ANDROID_CLOUD_STRIPPED_PERMISSIONS) {
      const escaped = escapeRegExp(`android.permission.${perm}`);
      const re = new RegExp(
        `\\n\\s*<uses-permission\\b[^>]*android:name="${escaped}"[^>]*/>\\s*`,
        "g",
      );
      xml = xml.replace(re, "\n");
    }
    xml = xml.replace(
      /android:usesCleartextTraffic="true"/g,
      'android:usesCleartextTraffic="false"',
    );

    if (xml !== original) {
      fs.writeFileSync(manifestPath, xml, "utf8");
      console.log(
        "[mobile-build] Stripped Play-Store-noncompliant components and permissions from AndroidManifest.xml.",
      );
    }
  }

  // 2. Remove the matching Java sources so the build doesn't reference
  //    manifest-stripped classes. The merged sources live under
  //    app/src/main/java/<package-path>/, and overlayAndroid() may also
  //    have left a legacy ai/elizaos/app copy if the Java rename ran on a
  //    fresh tree — wipe both.
  const javaRoots = [
    path.join(
      androidDir,
      "app",
      "src",
      "main",
      "java",
      packageNameToPath(androidPackage),
    ),
    path.join(androidDir, "app", "src", "main", "java", "ai", "elizaos", "app"),
  ];
  let removedJavaCount = 0;
  for (const root of javaRoots) {
    if (!fs.existsSync(root)) continue;
    for (const file of ANDROID_CLOUD_STRIPPED_JAVA_FILES) {
      const target = path.join(root, file);
      if (fs.existsSync(target)) {
        fs.rmSync(target);
        removedJavaCount += 1;
      }
    }
  }
  if (removedJavaCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedJavaCount} Play-Store-noncompliant Java source(s).`,
    );
  }
  rewriteCloudJavaSources(javaRoots, androidPackage);

  // 3. Wipe any previously-staged on-device agent runtime. These are
  //    build artifacts (.gitignore covers them) — the cloud APK must not
  //    embed bun, musl, libstdc++, libgcc, llama-server, or the
  //    libeliza_*.so jniLibs disguise.
  removeCloudNativeArtifacts();
  stripAndroidCloudNativePlugins();
}

async function buildAndroid() {
  const sdk = resolveAndroidSdkRoot();
  const jdk = resolveJavaHome();
  if (!sdk)
    throw new Error(
      "Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME.",
    );
  if (!jdk) throw new Error("JDK 21 not found. Set JAVA_HOME.");

  console.warn(
    "[mobile-build] WARNING: target `android` produces an APK that embeds " +
      "the on-device agent runtime (libeliza_bun.so disguise) and requests " +
      "system-only permissions (MANAGE_APP_OPS_MODES, PACKAGE_USAGE_STATS). " +
      "It is SIDELOAD-ONLY and will be rejected by the Play Store. Use " +
      "`build:android:cloud` for a Play-Store-compliant thin client, or " +
      "`build:android:system` for the AOSP privileged platform-signed APK.",
  );

  await buildWeb("android");
  await buildMobileAgentBundle();
  await ensurePlatform("android");
  await runCapacitor(["sync", "android"]);

  patchAndroidGradle();
  await generateAndroidBrandAssets();
  overlayAndroid();
  sanitizeAndroidManifestWhenPlatformTemplatesMissing();
  await stageAndroidAgentRuntime({
    androidDir,
    spikeDir: androidAgentSpikeDir,
  });

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

  // Mirror the AOSP gradle property forwarding from buildAndroidSystem so
  // a developer iterating with `bun run build:android` under ELIZA_AOSP_BUILD=1
  // gets BuildConfig.AOSP_BUILD=true in the debug APK as well.
  const settingsGradle = fs.readFileSync(
    path.join(androidDir, "capacitor.settings.gradle"),
    "utf8",
  );
  const gradleArgs = [];
  if (settingsGradle.includes(":elizaos-capacitor-websiteblocker")) {
    gradleArgs.push(":elizaos-capacitor-websiteblocker:testDebugUnitTest");
  }
  gradleArgs.push(":app:assembleDebug");
  if (
    process.env.ELIZA_GRADLE_AOSP_BUILD === "true" ||
    process.env.ELIZA_GRADLE_AOSP_BUILD === "1"
  ) {
    gradleArgs.unshift("-PelizaAospBuild=true");
  }
  await run(
    "./gradlew",
    [":capacitor-cordova-android-plugins:writeDebugAarMetadata"],
    {
      cwd: androidDir,
      env,
    },
  );
  await run("./gradlew", gradleArgs, {
    cwd: androidDir,
    env,
  });
}

function findAndroidCloudAab() {
  const releaseBundleDir = path.join(
    androidDir,
    "app",
    "build",
    "outputs",
    "bundle",
    "release",
  );
  if (!fs.existsSync(releaseBundleDir)) return null;
  const candidates = fs
    .readdirSync(releaseBundleDir)
    .filter((name) => name.endsWith(".aab"))
    .map((name) => path.join(releaseBundleDir, name));
  return firstExisting(candidates);
}

function findAndroidCloudDebugApk() {
  return firstExisting([
    path.join(
      androidDir,
      "app",
      "build",
      "outputs",
      "apk",
      "debug",
      "app-debug.apk",
    ),
  ]);
}

function auditAndroidCloudArtifact({ debug = false, javaHome } = {}) {
  const artifact = debug ? findAndroidCloudDebugApk() : findAndroidCloudAab();
  if (!artifact) {
    throw new Error(
      `[mobile-build] android-cloud ${debug ? "debug APK" : "release AAB"} was not found under app/build/outputs/.`,
    );
  }
  const jar = path.join(
    javaHome,
    "bin",
    process.platform === "win32" ? "jar.exe" : "jar",
  );
  const result = spawnSync(jar, ["tf", artifact], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `[mobile-build] Could not inspect ${artifact}: ${
        result.stderr || result.stdout || `jar exited with ${result.status}`
      }`,
    );
  }
  const offenders = result.stdout
    .split(/\r?\n/)
    .filter((entry) =>
      /(^|\/)assets\/agent\/|libeliza_|libllama|libsigsys-handler\.so|llama-cpp-kernels\.json/i.test(
        entry,
      ),
    );
  if (offenders.length > 0) {
    throw new Error(
      `[mobile-build] android-cloud artifact contains local runtime payloads:\n` +
        offenders.map((entry) => `  - ${entry}`).join("\n"),
    );
  }
  console.log(
    `[mobile-build] android-cloud artifact audit passed: ${artifact}`,
  );
  return artifact;
}

async function buildAndroidCloud({ debug = false } = {}) {
  const sdk = resolveAndroidSdkRoot();
  const jdk = resolveJavaHome();
  if (!sdk)
    throw new Error(
      "Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME.",
    );
  if (!jdk) throw new Error("JDK 21 not found. Set JAVA_HOME.");

  await buildWeb(debug ? "android-cloud-debug" : "android-cloud");
  await ensurePlatform("android");
  await runCapacitor(["sync", "android"]);

  patchAndroidGradle();
  await generateAndroidBrandAssets();
  overlayAndroid();
  sanitizeAndroidManifestWhenPlatformTemplatesMissing();
  // The cloud target is a thin Capacitor client backed by Eliza Cloud.
  // It must NOT embed the on-device agent runtime, NOT declare default
  // role activities (dialer, SMS, browser, contacts, camera, calendar,
  // clock, assistant, in-call), NOT register a BootReceiver, and NOT
  // request system-only permissions (MANAGE_APP_OPS_MODES,
  // PACKAGE_USAGE_STATS) or sensitive runtime permissions
  // (READ/SEND/RECEIVE_SMS, CALL_PHONE, ACCESS_BACKGROUND_LOCATION).
  // overlayAndroid() injects all of these unconditionally; we strip them
  // here as a post-overlay pass so the merge logic remains a single
  // source of truth across all three Android targets.
  stripAndroidForCloud();
  auditAndroidCloudSource("pre-gradle");

  const env = {
    ...process.env,
    ELIZA_ANDROID_CLOUD_BUILD: "1",
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    JAVA_HOME: jdk,
    PATH: prependPath(process.env, [
      path.join(jdk, "bin"),
      path.join(sdk, "platform-tools"),
    ]),
  };

  // The Play-Store target intentionally builds without `-PelizaAospBuild`,
  // so BuildConfig.AOSP_BUILD = false at runtime. It does pass the cloud
  // flags, which make injected Gradle hooks skip DFlash/native restaging and
  // strip any merged assets/agent tree that an older generated project kept.
  const settingsGradle = fs.readFileSync(
    path.join(androidDir, "capacitor.settings.gradle"),
    "utf8",
  );
  const cloudGradleFlags = [
    "-PelizaCloudBuild=true",
    "-PelizaStripAgentAssets=true",
  ];
  const gradleArgs = [...cloudGradleFlags];
  if (debug && settingsGradle.includes(":elizaos-capacitor-websiteblocker")) {
    gradleArgs.push(":elizaos-capacitor-websiteblocker:testDebugUnitTest");
  }
  gradleArgs.push(debug ? ":app:assembleDebug" : ":app:bundleRelease");
  await run(
    "./gradlew",
    [
      ...cloudGradleFlags,
      debug
        ? ":capacitor-cordova-android-plugins:writeDebugAarMetadata"
        : ":capacitor-cordova-android-plugins:writeReleaseAarMetadata",
    ],
    {
      cwd: androidDir,
      env,
    },
  );
  await run("./gradlew", gradleArgs, {
    cwd: androidDir,
    env,
  });
  auditAndroidCloudSource("post-gradle");
  const artifact = auditAndroidCloudArtifact({ debug, javaHome: jdk });
  if (!debug)
    console.log(`[mobile-build] android-cloud release AAB: ${artifact}`);
}

function findAndroidSystemApk() {
  // Release-only. Staging a debug APK ships without R8 shrinking and
  // bypasses the release signing config — both invariants the AOSP
  // prebuilt path assumes hold. Soong re-signs with the platform key
  // either way, so a debug fallback is never an acceptable substitute.
  const candidates = [
    path.join(
      androidDir,
      "app",
      "build",
      "outputs",
      "apk",
      "release",
      "app-release-unsigned.apk",
    ),
    path.join(
      androidDir,
      "app",
      "build",
      "outputs",
      "apk",
      "release",
      "app-release.apk",
    ),
  ];
  return firstExisting(candidates);
}

function stageAndroidSystemApk() {
  const apk = findAndroidSystemApk();
  if (!apk) {
    throw new Error(
      "No release APK found at app/build/outputs/apk/release/. Run :app:assembleRelease before staging the ElizaOS prebuilt — debug APKs are not accepted.",
    );
  }
  fs.mkdirSync(elizaOsApkDir, { recursive: true });
  const target = path.join(elizaOsApkDir, elizaOsApkName);
  fs.copyFileSync(apk, target);
  console.log(`[mobile-build] Staged ${elizaOsApkName} at ${target}.`);
}

async function buildAndroidSystem() {
  const sdk = resolveAndroidSdkRoot();
  const jdk = resolveJavaHome();
  if (!sdk)
    throw new Error(
      "Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME.",
    );
  if (!jdk) throw new Error("JDK 21 not found. Set JAVA_HOME.");

  await buildWeb("android-system");
  await buildMobileAgentBundle();
  await ensurePlatform("android");
  await runCapacitor(["sync", "android"]);

  patchAndroidGradle();
  await generateAndroidBrandAssets();
  overlayAndroid();
  sanitizeAndroidManifestWhenPlatformTemplatesMissing();
  await stageAndroidAgentRuntime({
    androidDir,
    spikeDir: androidAgentSpikeDir,
  });

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

  // This target always produces the privileged AOSP APK, so bake the local
  // agent flag into BuildConfig and preserve assets/agent. The regular
  // Capacitor target leaves this property unset and strips those assets.
  const gradleArgs = ["-PelizaAospBuild=true", ":app:assembleRelease"];
  await run(
    "./gradlew",
    [":capacitor-cordova-android-plugins:writeReleaseAarMetadata"],
    {
      cwd: androidDir,
      env,
    },
  );
  await run("./gradlew", gradleArgs, {
    cwd: androidDir,
    env,
  });
  stageAndroidSystemApk();
}

function setDefaultProcessEnv(key, value) {
  if (process.env[key] == null || process.env[key] === "") {
    process.env[key] = value;
  }
}

function configureIosLocalBuildDefaults() {
  setDefaultProcessEnv("ELIZA_IOS_RUNTIME_MODE", "local");
  setDefaultProcessEnv("MILADY_IOS_RUNTIME_MODE", "local");
  setDefaultProcessEnv("VITE_ELIZA_IOS_RUNTIME_MODE", "local");
  setDefaultProcessEnv("VITE_MILADY_IOS_RUNTIME_MODE", "local");
  setDefaultProcessEnv("ELIZA_IOS_INCLUDE_LLAMA", "1");
  setDefaultProcessEnv("MILADY_IOS_INCLUDE_LLAMA", "1");
  setDefaultProcessEnv("ELIZA_IOS_BUILD_DESTINATION", "generic/platform=iOS");
  setDefaultProcessEnv("ELIZA_IOS_BUILD_SDK", "iphoneos");
}

async function buildIos({ local = false } = {}) {
  if (process.platform !== "darwin")
    throw new Error("iOS builds require macOS and Xcode.");

  if (local) {
    configureIosLocalBuildDefaults();
  }

  const cocoapodsScript = path.join(
    appCoreRoot,
    "scripts",
    "prepare-ios-cocoapods.sh",
  );

  await buildWeb(local ? "ios-local" : "ios");
  await ensurePlatform("ios");
  if (fs.existsSync(cocoapodsScript)) {
    await run("bash", [cocoapodsScript], { cwd: repoRoot });
  }
  await runCapacitor(["sync", "ios"]);

  const buildTarget = resolveIosBuildTarget();
  console.log(
    `[mobile-build] iOS build target: ${buildTarget.destination} (${buildTarget.sdk}; ${buildTarget.reason})`,
  );
  const syncedFiles = prepareIosOverlay({ buildTarget });
  await generateIosBrandAssets();
  await ensureIosLlamaCppVendoredFramework({ buildTarget });

  // CocoaPods compiles Capacitor from source, avoiding SPM binary API issues.
  // CocoaPods 1.16.x crashes with `Pod::Config#installation_root` when the
  // terminal locale is not UTF-8 (it warns "CocoaPods requires your terminal
  // to be using UTF-8 encoding"). Force the spawned `pod` process to a UTF-8
  // locale regardless of the host shell so builds don't fail under tmux,
  // CI runners, or background launchers that ship without LANG set.
  if (
    fs.existsSync(path.join(iosDir, "Podfile")) ||
    shouldRunIosPodInstall(syncedFiles)
  ) {
    await run("pod", ["install"], {
      cwd: iosDir,
      env: {
        ...process.env,
        LANG: process.env.LANG?.includes("UTF-8")
          ? process.env.LANG
          : "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL?.includes("UTF-8")
          ? process.env.LC_ALL
          : "en_US.UTF-8",
      },
    });
  }

  const wsPath = path.join(iosDir, "App.xcworkspace");
  const projectArgs = fs.existsSync(wsPath)
    ? ["-workspace", "App.xcworkspace"]
    : ["-project", "App.xcodeproj"];
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
      `CODE_SIGNING_ALLOWED=${process.env.ELIZA_IOS_CODE_SIGNING_ALLOWED ?? "NO"}`,
      ...(isIosSimulatorBuildTarget(buildTarget)
        ? ["ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES", "EXCLUDED_ARCHS=x86_64"]
        : []),
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
    target !== "android-cloud" &&
    target !== "android-cloud-debug" &&
    target !== "android-system" &&
    target !== "ios" &&
    target !== "ios-local" &&
    target !== "ios-overlay"
  ) {
    console.error(
      "Usage: node scripts/run-mobile-build.mjs <android|android-cloud|android-cloud-debug|android-system|ios|ios-local|ios-overlay>",
    );
    process.exit(1);
  }
  if (target === "android") {
    await buildAndroid();
  } else if (target === "android-cloud") {
    await buildAndroidCloud();
  } else if (target === "android-cloud-debug") {
    await buildAndroidCloud({ debug: true });
  } else if (target === "android-system") {
    await buildAndroidSystem();
  } else if (target === "ios") {
    await buildIos();
  } else if (target === "ios-local") {
    await buildIos({ local: true });
  } else {
    prepareIosOverlay();
    await generateIosBrandAssets();
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  console.log(`[mobile-build] App: ${APP.appName} (${APP.appId})`);
  await main();
}
