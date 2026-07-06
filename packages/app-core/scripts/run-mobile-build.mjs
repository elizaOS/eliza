#!/usr/bin/env node
/**
 * Mobile build orchestrator for elizaOS apps.
 *
 * Builds an iOS or Android app from any elizaOS host app (Eliza, etc.).
 * Reads app identity from the host's app.config.ts so web, desktop, and
 * native builds share one canonical app contract.
 *
 * Usage: node scripts/run-mobile-build.mjs <android|android-sms-gateway|android-cloud|android-cloud-debug|android-system|ios|ios-local|ios-overlay>
 *
 * Android targets:
 *   - android         Sideload-only debug APK with the on-device agent runtime
 *                     and AOSP/system-only permissions. NOT Play-Store-shippable.
 *   - android-cloud   Play-Store-compliant release AAB thin client backed by
 *                     Eliza Cloud. No on-device agent, no default-role
 *                     activities, no system-only permissions.
 *   - android-cloud-debug
 *                     Debug APK for cloud-client iteration. Not for Play.
 *   - android-sms-gateway
 *                     Sideload-only debug APK for running the shared Eliza
 *                     Cloud SMS gateway as the default Android SMS app. Keeps
 *                     SMS/MMS/default-message components but strips local
 *                     inference/native runtime pieces.
 *   - android-system  Privileged platform-signed AOSP release APK for
 *                     Eliza OS / ElizaOS device builds.
 *
 * Phases:
 *   1. Resolve config       — read app.config.ts for appId / appName
 *   2. Build web            — vite build → dist/
 *   3. Capacitor sync       — generate native platform projects
 *   4. Overlay native       — permissions, services, entitlements, Podfile
 *   5. Platform patches     — Gradle template, SPM compat, xcconfig
 *   5b. Stage Android agent — bun + musl + libstdc++ + libgcc + bundle
 *                             into packages/app-core/platforms/android/app/src/main/assets/agent/
 *                             (Android targets only; see
 *                             scripts/lib/stage-android-agent.mjs and
 *                             docs/agent-on-mobile.md).
 *   6. Native build         — gradlew / xcodebuild
 *
 * iOS targets:
 *   - ios         App Store iOS cloud-hybrid build. Keeps the App Store-safe
 *                 no-JIT local runtime path when available, but strips
 *                 local-yolo bridges and native model runtimes.
 *   - ios-local   Dev/sideload iOS build. Bakes runtimeMode=local with
 *                 ELIZA_RUNTIME_MODE=local-safe, stages the agent payload,
 *                 and defaults to JSContext/compat unless full Bun is
 *                 explicitly requested.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  appStoreExecutionProfile,
  findForbiddenRuntimeImportGroups,
  findForbiddenRuntimeStrings,
  formatForbiddenRuntimeFindings,
} from "../../native/bun-runtime/scripts/ios-app-store-runtime-policy.mjs";
import {
  loadAospVariantConfig,
  resolveAppConfigPath,
} from "./aosp/lib/load-variant-config.mjs";
import { resolveMainAppDir } from "./lib/app-dir.mjs";
import { artifactStaleness } from "./lib/artifact-staleness.mjs";
import {
  isCapacitorPlatformReady as isCapacitorPlatformReadyImpl,
  resolvePlatformTemplateRoot as resolvePlatformTemplateRootImpl,
  syncPlatformTemplateFiles as syncPlatformTemplateFilesImpl,
} from "./lib/capacitor-platform-templates.mjs";
import {
  androidUsesAppDirFor,
  MTP_FORK_SRC_CANDIDATES,
  mtpForceRebuildRequested,
  mtpSliceReuse,
} from "./lib/mobile-build-decisions.mjs";
import {
  evaluateIosLocalLaneRuntime,
  rendererLaneStampMismatches,
  resolveExpectedRendererStamp,
} from "./lib/mobile-lane-stamp.mjs";
import {
  formatMobileWebDistProblems,
  mobileWebDistReuseStatus,
} from "./lib/mobile-web-build-reuse.mjs";
import {
  assertStagedRendererMatchesBuild,
  overlayFreshRendererIntoPublic,
  readRendererBuildManifest,
} from "./lib/renderer-build-manifest.mjs";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";
import {
  RUNTIME_PROVENANCE_FILENAME,
  stageAndroidAgentRuntime,
} from "./lib/stage-android-agent.mjs";
import { resolveAndroidGradleCommandsForTarget } from "./mobile/android-gradle.mjs";
import {
  appendMissingAndroidManifestBlock,
  appendMissingApplicationBlock,
  applyAndroidCleartextPolicy,
  ensureAndroidMainActivityShortcutsMetadata,
  ensureAndroidMainActivityUrlSchemeFilter,
  ensureAndroidPermissionRemovalMarkers,
  ensureElizaOsActivityFilters,
  ensureManifestApplicationClosedBeforeTopLevelEntries,
  hasAndroidPermissionRequest,
  patchAndroidAppActionsXmlResource,
  removeAndroidPermissionRequests,
  removeApplicationComponentBlock,
  removeApplicationComponentClassBlock,
  removeXmlCommentsContaining,
  stripXmlComments,
  validateAndroidAppActionsXmlResource,
} from "./mobile/android-manifest.mjs";
import { escapeRegExp, escapeXmlText } from "./mobile/escape.mjs";
import {
  mergeIosInfoPlist,
  removePbxListEntries,
  replaceIosAppGroupPlaceholders,
} from "./mobile/ios-plist.mjs";
import {
  ANDROID_OFFICIAL_CAPACITOR_PACKAGES,
  IOS_COCOAPODS_OWNED_SPM_PLUGINS,
  IOS_INCOMPATIBLE_SPM_PLUGINS,
  IOS_OFFICIAL_PODS,
  resolveIosCustomPods,
} from "./mobile/ios-pods.mjs";
import { resolveAndroidBuildTarget } from "./mobile/targets/android.mjs";

export {
  androidUsesAppDirFor,
  MTP_FORK_SRC_CANDIDATES,
  mtpBuilderRepoRoot,
  mtpForceRebuildRequested,
  mtpSliceReuse,
} from "./lib/mobile-build-decisions.mjs";
export {
  ANDROID_APP_ACTION_CAPABILITIES,
  ANDROID_APP_ACTION_FORBIDDEN_MARKERS,
  ANDROID_APP_ACTION_REQUIRED_DEEP_LINKS,
  ANDROID_APP_ACTION_SHORTCUT_IDS,
  appendMissingAndroidManifestBlock,
  appendMissingApplicationBlock,
  applyAndroidCleartextPolicy,
  ensureAndroidMainActivityShortcutsMetadata,
  ensureAndroidMainActivityUrlSchemeFilter,
  ensureAndroidPermissionRemovalMarkers,
  ensureElizaOsActivityFilters,
  ensureManifestApplicationClosedBeforeTopLevelEntries,
  hasAndroidPermissionRequest,
  patchAndroidAppActionsXmlResource,
  removeAndroidPermissionRequests,
  removeApplicationComponentBlock,
  removeApplicationComponentClassBlock,
  removeXmlCommentsContaining,
  stripXmlComments,
  validateAndroidAppActionsXmlResource,
} from "./mobile/android-manifest.mjs";
export {
  ANDROID_OFFICIAL_CAPACITOR_PACKAGES,
  IOS_COCOAPODS_OWNED_SPM_PLUGINS,
  IOS_INCOMPATIBLE_SPM_PLUGINS,
  IOS_OFFICIAL_PODS,
  MOBILE_CAPACITOR_PLUGIN_MANIFEST,
  resolveIosCustomPods,
} from "./mobile/ios-pods.mjs";
export {
  ANDROID_BUILD_TARGETS,
  resolveAndroidBuildTarget,
} from "./mobile/targets/android.mjs";

// ── Paths ───────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// When this elizaOS checkout is nested inside a consumer monorepo that
// wraps it as `eliza/`, the repo-root walk resolves to the OUTER
// repo and the build targets the consumer's app. Allow an explicit override
// so the elizaOS app itself can be built standalone from the nested checkout.
const repoRoot = process.env.ELIZA_MOBILE_REPO_ROOT?.trim()
  ? path.resolve(process.env.ELIZA_MOBILE_REPO_ROOT.trim())
  : resolveRepoRootFromImportMeta(import.meta.url, {
      fallbackToCwd: true,
    });
const appCoreRoot = path.resolve(__dirname, "..");
const elizaCheckoutRoot = path.resolve(appCoreRoot, "..", "..");
const packagesRoot = path.resolve(appCoreRoot, "..");
const elizaRepoRoot = path.resolve(packagesRoot, "..");
const appDir = resolveMainAppDir(repoRoot, "app");
const iosDir = path.join(appDir, "ios", "App");
// Android build target. By default this is the canonical elizaOS platform tree
// (app-core/platforms/android), which the elizaOS app itself builds in. A
// whitelabel consumer that embeds the elizaOS checkout must NOT
// build in that shared tree — the identity overlay rewrites it in place, so
// after a whitelabel build the tree carries the consumer's package and a subsequent
// elizaOS build (or vice versa) is corrupted. Setting ELIZA_ANDROID_USE_APP_DIR=1
// builds in the host app's own dir (appDir/android, like iOS already does),
// treating app-core/platforms/android as a read-only template copied in by
// overlayAndroid/patchAndroidGradle/syncAndroidAppActionsResources. That keeps
// the two brands' Android builds fully separate.
const androidBuildAppId = readAppIdentity().appId;
const androidUsesAppDir = androidUsesAppDirFor(androidBuildAppId, process.env);
const androidDir = androidUsesAppDir
  ? path.join(appDir, "android")
  : path.join(appCoreRoot, "platforms", "android");
const localArtifactsDir = path.join(elizaRepoRoot, ".eliza-local", "artifacts");
const androidSmsGatewayDebugApkArtifact = path.join(
  localArtifactsDir,
  "eliza-android-sms-gateway-debug.apk",
);
const IOS_DEFAULT_DEPLOYMENT_TARGET = "16.0";
const IOS_FULL_BUN_DEPLOYMENT_TARGET = "16.0";

// AOSP system APK staging path. Brand-aware: forks declare their vendor
// dir + APK name in `app.config.ts > aosp:`. When that block is present
// (Eliza, etc.), stage to `<repoRoot>/os/android/vendor/<vendorDir>/
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
const nativePluginsDir = path.join(packagesRoot, "native", "plugins");
const androidAgentSpikeDir = path.join(
  repoRoot,
  "scripts",
  "spike-android-agent",
);
const IOS_BUN_ENGINE_FRAMEWORK_NAME = "ElizaBunEngine";
const IOS_BUN_ENGINE_ABI_VERSION = "3";
const iosBunRuntimePackageRoot = path.join(
  packagesRoot,
  "native",
  "bun-runtime",
);
const RM_PATH_RECURSIVE_SCRIPT = path.join(
  packagesRoot,
  "scripts",
  "rm-path-recursive.mjs",
);
const defaultIosBunEngineXcframework = path.join(
  iosBunRuntimePackageRoot,
  "artifacts",
  `${IOS_BUN_ENGINE_FRAMEWORK_NAME}.xcframework`,
);
const IOS_BUN_ENGINE_REQUIRED_SYMBOLS = [
  "_eliza_bun_engine_abi_version",
  "_eliza_bun_engine_last_error",
  "_eliza_bun_engine_set_host_callback",
  "_eliza_bun_engine_start",
  "_eliza_bun_engine_stop",
  "_eliza_bun_engine_is_running",
  "_eliza_bun_engine_call",
  "_eliza_bun_engine_free",
];
const IOS_BUN_ENGINE_EXECUTION_PROFILE = appStoreExecutionProfile;
export const IOS_AGENT_RUNTIME_ASSETS = [
  "agent-bundle.js",
  "pglite.wasm",
  "initdb.wasm",
  "pglite.data",
  "vector.tar.gz",
  "fuzzystrmatch.tar.gz",
  "plugins-manifest.json",
];
export const IOS_AGENT_ROOT_EXTENSION_ASSETS = [
  "vector.tar.gz",
  "fuzzystrmatch.tar.gz",
];
// Extension targets stripped for personal-team builds: personal-team
// entitlements are emptied (no App Groups), so every extension whose
// entitlements reference the app group — including the ElizaWidgets
// widget/controls extension — must drop out of the build to keep automatic
// signing viable.
const IOS_PRIVILEGED_EXTENSION_LIST_ENTRY_IDS = [
  "WBCB00010000000000000201",
  "WBCB00010000000000000702",
  "DAMON000100000000000702",
  "DAREP000100000000000702",
  "EWDG00010000000000000702",
  "EKBD00010000000000000702",
  "WBCB00010000000000000401",
  "DAMON000100000000000401",
  "DAREP000100000000000401",
  "EWDG00010000000000000401",
  "EKBD00010000000000000401",
];
const IOS_PERSONAL_TEAM_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>
`;
// ── Phase 1: Resolve app identity from app.config.ts ────────────────────

function readAppIdentity() {
  const cfgPath = path.join(appDir, "app.config.ts");
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`app.config.ts not found at ${cfgPath}`);
  }
  const src = fs.readFileSync(cfgPath, "utf8");
  const configAppId = src.match(/appId:\s*["']([^"']+)["']/)?.[1];
  const appId =
    process.env.ELIZA_APP_ID?.trim() ||
    process.env.ELIZA_IOS_APP_ID?.trim() ||
    configAppId;
  const appName = src.match(/appName:\s*["']([^"']+)["']/)?.[1];
  const urlScheme = src.match(/urlScheme:\s*["']([^"']+)["']/)?.[1] ?? appId;
  if (!appId || !appName) {
    throw new Error("Could not parse appId/appName from app.config.ts");
  }
  // Opaque background the icon mark is flattened onto (iOS app icon + Android
  // legacy launcher + adaptive-icon background). Whitelabel seam: each app sets
  // its own brand color in app.config.ts (web.iconBackgroundColor). Falls back
  // to the upstream elizaOS accent so a config without the field is unchanged.
  const iconBackgroundColor =
    process.env.ELIZA_ICON_BACKGROUND?.trim() ||
    src.match(/iconBackgroundColor:\s*["']([^"']+)["']/)?.[1] ||
    "#FF5800";
  // android.userAgentMarkers is an optional array literal nested under
  // `android: { ... }`. Parse the array body via regex (rather than
  // executing the TS file) so this script stays bun-import-free.
  const userAgentMarkers = parseAndroidUserAgentMarkers(src);
  return { appId, appName, urlScheme, iconBackgroundColor, userAgentMarkers };
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

const MOBILE_BUILD_NODE_HEAP_OPTION = "--max-old-space-size=6144";

function withMobileBuildNodeOptions(env = process.env) {
  const current = String(env.NODE_OPTIONS ?? "").trim();
  if (/\b--max-old-space-size(?:=|\s+)/.test(current)) {
    return env;
  }
  return {
    ...env,
    NODE_OPTIONS: [current, MOBILE_BUILD_NODE_HEAP_OPTION]
      .filter(Boolean)
      .join(" "),
  };
}

function run(command, args, { cwd, env = process.env } = {}) {
  // Windows: gradlew is gradlew.bat, and Node cannot spawn `./gradlew` (ENOENT)
  // nor a .bat/.cmd directly (EINVAL since CVE-2024-27980). Translate
  // ./gradlew -> the sibling gradlew.bat (resolved against cwd) and run any
  // .bat/.cmd through cmd.exe with args as separate argv (no shell:true).
  let spawnCmd = command;
  let spawnArgs = args;
  if (process.platform === "win32") {
    if (command === "./gradlew" || command === "gradlew") {
      spawnCmd = path.join(cwd || process.cwd(), "gradlew.bat");
    }
    if (/.(?:bat|cmd)$/i.test(spawnCmd)) {
      spawnArgs = ["/d", "/s", "/c", spawnCmd, ...args];
      spawnCmd = process.env.ComSpec || "cmd.exe";
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(spawnCmd, spawnArgs, { cwd, env, stdio: "inherit" });
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`${command} killed by ${signal}`));
      if ((code ?? 1) !== 0)
        return reject(new Error(`${command} exited with code ${code ?? 1}`));
      resolve();
    });
  });
}

function resolveNodeExecutable() {
  if (!process.versions?.bun) return process.execPath;
  return process.env.NODE?.trim() || "node";
}

export function resolveCapacitorCli({
  appDirValue = appDir,
  repoRootValue = repoRoot,
} = {}) {
  const capacitorCliPackage = resolvePackageAbsolutePath("@capacitor/cli", {
    appDirValue,
    repoRootValue,
  });
  const capacitorCli = capacitorCliPackage
    ? path.join(capacitorCliPackage, "bin", "capacitor")
    : null;
  if (!capacitorCli || !fs.existsSync(capacitorCli)) {
    throw new Error("@capacitor/cli not found; run bun install");
  }
  return capacitorCli;
}

function runCapacitor(args) {
  return run(resolveNodeExecutable(), [resolveCapacitorCli(), ...args], {
    cwd: appDir,
  });
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

function runCaptureSync(command, args, { cwd = repoRoot, maxBuffer } = {}) {
  return spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer,
  });
}

function rmRecursive(pathToRemove) {
  const result = spawnSync(
    process.execPath,
    [RM_PATH_RECURSIVE_SCRIPT, path.resolve(pathToRemove)],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    const reason =
      result.stderr?.trim() ||
      result.stdout?.trim() ||
      result.error?.message ||
      `exit status ${String(result.status)}`;
    throw new Error(
      `[mobile-build] failed to recursively remove ${pathToRemove}: ${reason}`,
    );
  }
}

function resolveBunExecutable() {
  if (process.versions.bun) return process.execPath;
  return resolveExecutable("bun");
}

function resolveAndroidSdkRoot(env = process.env) {
  return firstExisting([
    env.ANDROID_SDK_ROOT,
    env.ANDROID_HOME,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
    path.join(
      env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Android",
      "Sdk",
    ),
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

function javaMajorVersion(javaHome) {
  if (!javaHome || !fs.existsSync(javaHome)) return null;
  // `release` is the cheapest, most reliable source (no JVM spawn).
  const releaseFile = path.join(javaHome, "release");
  if (fs.existsSync(releaseFile)) {
    const m = fs
      .readFileSync(releaseFile, "utf8")
      .match(/JAVA_VERSION="?(\d+)/);
    if (m) return Number.parseInt(m[1], 10);
  }
  const javaBin = path.join(
    javaHome,
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
  if (fs.existsSync(javaBin)) {
    const r = spawnSync(javaBin, ["-version"], { encoding: "utf8" });
    const m = `${r.stderr ?? ""}${r.stdout ?? ""}`.match(/version "?(\d+)/);
    if (m) return Number.parseInt(m[1], 10);
  }
  return null;
}

// Auto-select a JDK >= 21 so a plain `build:android` "just works" with no
// JAVA_HOME juggling. JAVA_HOME is honored ONLY when it actually is >= 21;
// otherwise we fall through to the well-known JDK 21 install paths and finally
// scan /usr/lib/jvm. (AGP 9 + the Android toolchain require 21.)
function resolveJavaHome(env = process.env) {
  const candidates = [
    env.JAVA_HOME,
    "/opt/homebrew/opt/openjdk@21",
    "/usr/local/opt/openjdk@21",
    "/usr/lib/jvm/temurin-21-jdk-amd64",
    "/usr/lib/jvm/java-21-openjdk-amd64",
    "/usr/lib/jvm/java-21-openjdk",
  ];
  for (const candidate of candidates) {
    if (candidate && (javaMajorVersion(candidate) ?? 0) >= 21) return candidate;
  }
  const jvmRoot = "/usr/lib/jvm";
  if (fs.existsSync(jvmRoot)) {
    for (const name of fs.readdirSync(jvmRoot)) {
      const full = path.join(jvmRoot, name);
      if ((javaMajorVersion(full) ?? 0) >= 21) return full;
    }
  }
  if (process.platform === "win32") {
    const programFiles = env.ProgramFiles || "C:\\Program Files";
    for (const vendor of ["Eclipse Adoptium", "Microsoft", "Java", "Zulu"]) {
      const vendorRoot = path.join(programFiles, vendor);
      if (!fs.existsSync(vendorRoot)) continue;
      for (const name of fs.readdirSync(vendorRoot)) {
        const full = path.join(vendorRoot, name);
        if ((javaMajorVersion(full) ?? 0) >= 21) return full;
      }
    }
  }
  // Nothing >= 21 found — return the first path that exists so the caller's
  // "JDK 21 not found" error fires with a concrete (if wrong-version) hint.
  return firstExisting(candidates);
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

function escapeXcodeBuildSetting(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

function resolvePackageAbsolutePath(
  pkgName,
  { appDirValue = appDir, repoRootValue = repoRoot } = {},
) {
  const candidates = resolvePackageAbsolutePathCandidates(pkgName, {
    appDirValue,
    repoRootValue,
  });
  const linked = candidates.find((candidate) => fs.existsSync(candidate));
  if (!linked) return null;
  return fs.realpathSync(linked);
}

function resolvePackageAbsolutePathCandidates(
  pkgName,
  { appDirValue = appDir, repoRootValue = repoRoot } = {},
) {
  const roots = [
    ...new Set(
      [appDirValue, repoRootValue, elizaCheckoutRoot].map((root) =>
        path.resolve(root),
      ),
    ),
  ];
  const candidates = roots.map((root) =>
    path.join(root, "node_modules", ...pkgName.split("/")),
  );
  for (const bunStore of roots.map((root) =>
    path.join(root, "node_modules", ".bun"),
  )) {
    if (!fs.existsSync(bunStore)) continue;
    for (const entry of fs.readdirSync(bunStore, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push(
        path.join(bunStore, entry.name, "node_modules", ...pkgName.split("/")),
      );
    }
  }
  return [
    ...new Set(
      candidates
        .filter((candidate) => fs.existsSync(candidate))
        .map((candidate) => fs.realpathSync(candidate)),
    ),
  ];
}

function resolveNativePluginPackagePath(pkgName, relativeTo) {
  if (pkgName === "@elizaos/bun-ios-runtime") {
    const localPackageRoot = path.join(packagesRoot, "native", "bun-runtime");
    if (fs.existsSync(path.join(localPackageRoot, "package.json"))) {
      return path.relative(relativeTo, localPackageRoot);
    }
  }
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

function replaceIosAppGroupPlaceholdersInFile(filePath, appGroup) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf8");
  const next = replaceIosAppGroupPlaceholders(content, appGroup);
  if (next === content) return false;
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

function shouldDisableIosPrivilegedCapabilities(env = process.env) {
  return (
    isTruthyEnv(env.ELIZA_IOS_DISABLE_PRIVILEGED_CAPABILITIES) ||
    isTruthyEnv(env.ELIZA_IOS_PERSONAL_TEAM_PROFILE)
  );
}

function writeIosPersonalTeamEntitlements(filePath) {
  if (
    fs.existsSync(filePath) &&
    fs.readFileSync(filePath, "utf8") === IOS_PERSONAL_TEAM_ENTITLEMENTS
  ) {
    return false;
  }
  fs.writeFileSync(filePath, IOS_PERSONAL_TEAM_ENTITLEMENTS, "utf8");
  return true;
}

function stripIosPrivilegedExtensionTargets({
  appDirValue = appDir,
  log = console.log,
} = {}) {
  const projectPath = path.join(
    appDirValue,
    "ios",
    "App",
    "App.xcodeproj",
    "project.pbxproj",
  );
  if (!fs.existsSync(projectPath)) return false;
  const project = fs.readFileSync(projectPath, "utf8");
  const next = removePbxListEntries(
    project,
    IOS_PRIVILEGED_EXTENSION_LIST_ENTRY_IDS,
  );
  if (next === project) return false;
  fs.writeFileSync(projectPath, next, "utf8");
  log("[mobile-build] Disabled privileged iOS extension targets.");
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
  developmentTeam = process.env.ELIZA_IOS_DEVELOPMENT_TEAM ?? null,
  versionName = process.env.ELIZAOS_VERSION_NAME?.trim() || null,
  versionCode = process.env.ELIZAOS_VERSION_CODE?.trim() || null,
  log = console.log,
} = {}) {
  const iosAppRoot = path.join(appDirValue, "ios", "App");
  const changed = [];
  const privilegedCapabilitiesDisabled =
    shouldDisableIosPrivilegedCapabilities();
  const projectPath = path.join(iosAppRoot, "App.xcodeproj", "project.pbxproj");
  if (fs.existsSync(projectPath)) {
    let project = fs.readFileSync(projectPath, "utf8");
    const original = project;
    const extensionBundleSuffixes = [
      "WebsiteBlockerContentExtension",
      "DeviceActivityMonitorExtension",
      "DeviceActivityReportExtension",
      "ElizaWidgets",
      "ElizaKeyboard",
    ];
    for (const suffix of extensionBundleSuffixes) {
      project = project.replace(
        new RegExp(
          `PRODUCT_BUNDLE_IDENTIFIER = [A-Za-z0-9_.-]+\\.${escapeRegExp(suffix)};`,
          "g",
        ),
        `PRODUCT_BUNDLE_IDENTIFIER = ${appId}.${suffix};`,
      );
    }
    const extensionSuffixAlternation = extensionBundleSuffixes
      .map(escapeRegExp)
      .join("|");
    project = project.replace(
      new RegExp(
        `PRODUCT_BUNDLE_IDENTIFIER = (?![A-Za-z0-9_.-]+\\.(?:${extensionSuffixAlternation});)[A-Za-z0-9_.-]+;`,
        "g",
      ),
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
    // Thread the real release version into every target (app + all extension
    // targets) so the PR-evidence "confirm the running build is yours
    // (versionName)" check is possible on iOS. Mirrors the Android contract
    // (ELIZAOS_VERSION_CODE/ELIZAOS_VERSION_NAME in
    // platforms/android/app/build.gradle). Must run after the
    // ELIZA_DISPLAY_NAME insertion above, which anchors on the template's
    // literal `MARKETING_VERSION = 1.0;` line.
    if (versionName) {
      if (!/^\d+(\.\d+){0,2}$/.test(versionName)) {
        throw new Error(
          `ELIZAOS_VERSION_NAME must be 1-3 dot-separated integers (CFBundleShortVersionString), got ${versionName}`,
        );
      }
      project = project.replace(
        /MARKETING_VERSION = [^;]+;/g,
        `MARKETING_VERSION = ${versionName};`,
      );
    }
    if (versionCode) {
      if (!/^\d+(\.\d+){0,2}$/.test(versionCode)) {
        throw new Error(
          `ELIZAOS_VERSION_CODE must be 1-3 dot-separated integers (CFBundleVersion), got ${versionCode}`,
        );
      }
      project = project.replace(
        /CURRENT_PROJECT_VERSION = [^;]+;/g,
        `CURRENT_PROJECT_VERSION = ${versionCode};`,
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

  if (privilegedCapabilitiesDisabled) {
    const entitlementPath = path.join(iosAppRoot, "App", "App.entitlements");
    if (writeIosPersonalTeamEntitlements(entitlementPath)) {
      changed.push(path.join("App", "App.entitlements"));
    }
    if (stripIosPrivilegedExtensionTargets({ appDirValue, log })) {
      changed.push(path.relative(iosAppRoot, projectPath));
    }
  }
  for (const relPath of [
    path.join("App", "App.entitlements"),
    path.join("App", "ScreenTimeSupport.swift"),
    path.join("App", "ComputerUseBridge.swift"),
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
    // The DeviceActivity extensions hardcode group.ai.elizaos.app in their
    // template entitlements; without rewriting them to the app's group, a
    // non-eliza branded full-team device build fails codesign with
    // "provisioning profile doesn't support the group.ai.elizaos.app App Group".
    path.join(
      "App",
      "DeviceActivityMonitorExtension",
      "DeviceActivityMonitorExtension.entitlements",
    ),
    path.join(
      "App",
      "DeviceActivityReportExtension",
      "DeviceActivityReportExtension.entitlements",
    ),
    path.join("App", "ElizaWidgets", "ElizaWidgets.entitlements"),
    path.join("App", "ElizaKeyboard", "ElizaKeyboard.entitlements"),
  ]) {
    const filePath = path.join(iosAppRoot, relPath);
    if (
      !privilegedCapabilitiesDisabled &&
      replaceIosAppGroupPlaceholdersInFile(filePath, appGroup)
    ) {
      changed.push(relPath);
    }
  }

  const extensionId = [
    `${appId}.WebsiteBlockerContentExtension`,
    `${appId}.DeviceActivityMonitorExtension`,
    `${appId}.DeviceActivityReportExtension`,
    `${appId}.ElizaWidgets`,
    `${appId}.ElizaKeyboard`,
  ].join(",");
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
      : platform === "ios"
        ? "cloud-hybrid"
        : platform === "ios-overlay"
          ? "cloud"
          : null;
  const runtimeExecutionMode =
    platform === "android-cloud" || platform === "android-cloud-debug"
      ? "cloud"
      : platform === "android" || platform === "android-system"
        ? "local-yolo"
        : platform === "ios-local"
          ? "local-safe"
          : platform === "ios"
            ? "local-safe"
            : platform === "ios-overlay"
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
    runtimeExecutionMode,
    releaseAuthority,
    appControlledOta: false,
  };
}

async function buildWeb(platform) {
  const lanePolicy = resolveMobileBuildPolicy(platform);
  const laneExpected = resolveExpectedRendererStamp({
    policy: lanePolicy,
    env: process.env,
  });
  // Refuse to even START a renderer build that would bake the #11030 hang
  // combination (ios-local + non-local runtime mode + no Agent.apiBase, which
  // can only happen via a leaked VITE_ELIZA_IOS_RUNTIME_MODE override).
  const laneRule = evaluateIosLocalLaneRuntime({
    platform,
    runtimeMode: laneExpected.runtimeMode,
    env: process.env,
  });
  if (!laneRule.ok) {
    throw new Error(`[mobile-build] ${laneRule.reason}`);
  }
  // Auto-skip the full Vite renderer build when it is NOT explicitly forced and
  // the existing dist is already up-to-date for this variant/target (#9626).
  // This reuses the same manifest + staleness checks as the explicit-skip path
  // below, so the loud-fail-on-stale guarantee is preserved: a stale or
  // mismatched dist simply does not match here and falls through to a rebuild.
  // Explicit ELIZA_MOBILE_SKIP_WEB_BUILD=1 keeps its force-reuse semantics below.
  if (process.env.ELIZA_MOBILE_SKIP_WEB_BUILD !== "1") {
    const autoStatus = mobileWebDistReuseStatus({
      appDir,
      repoRoot,
      expectedVariant: laneExpected.variant,
      expectedTarget: laneExpected.capacitorTarget,
      // A dist built for another lane's runtime mode (e.g. a cloud-hybrid
      // bundle left behind by an ios cloud build) must never be reused into
      // this lane — it falls through to a fresh rebuild instead (#11030).
      expectedRuntimeMode: laneExpected.runtimeMode,
    });
    if (autoStatus.reusable) {
      console.log(
        "[mobile-build] Auto-skipping web build: existing dist is up-to-date " +
          `(buildId=${autoStatus.manifest.buildId.slice(0, 12)})`,
      );
      return;
    }
  }
  if (process.env.ELIZA_MOBILE_SKIP_WEB_BUILD === "1") {
    const status = mobileWebDistReuseStatus({
      appDir,
      repoRoot,
      expectedVariant: laneExpected.variant,
      expectedTarget: laneExpected.capacitorTarget,
      expectedRuntimeMode: laneExpected.runtimeMode,
    });
    if (!fs.existsSync(status.indexPath)) {
      throw new Error(
        `[mobile-build] ELIZA_MOBILE_SKIP_WEB_BUILD=1 but ${status.indexPath} is missing.`,
      );
    }
    // Never SILENTLY reuse a stale renderer (issue #9309). The skip flag is an
    // explicit "reuse the existing dist" request, but it must still fail loudly
    // when that dist is stale relative to sources or was built for a different
    // variant/target than this build needs. A deliberate stale reuse can be
    // forced with ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE=1.
    const allowStale =
      process.env.ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE === "1";
    if (status.problems.length > 0) {
      const detail = formatMobileWebDistProblems(status.problems);
      if (!allowStale) {
        throw new Error(
          `[mobile-build] ELIZA_MOBILE_SKIP_WEB_BUILD=1 refused — the existing web build is stale or mismatched:\n${detail}\n` +
            `Drop ELIZA_MOBILE_SKIP_WEB_BUILD to rebuild, or set ` +
            `ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE=1 to ship this dist anyway (NOT recommended).`,
        );
      }
      console.warn(
        `[mobile-build] ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE=1 — shipping a renderer flagged as stale/mismatched:\n${detail}`,
      );
    }
    console.log(
      `[mobile-build] Reusing existing web build: ${path.relative(repoRoot, status.distDir)}` +
        (status.manifest
          ? ` (buildId=${status.manifest.buildId.slice(0, 12)})`
          : ""),
    );
    return;
  }
  const {
    capacitorTarget,
    buildVariant,
    androidRuntimeMode,
    iosRuntimeMode,
    runtimeExecutionMode,
    releaseAuthority,
  } = lanePolicy;
  const env = withMobileBuildNodeOptions({
    ...process.env,
    ELIZA_CAPACITOR_BUILD_TARGET: capacitorTarget,
    ELIZA_BUILD_VARIANT: process.env.ELIZA_BUILD_VARIANT || buildVariant,
    ELIZA_RELEASE_AUTHORITY:
      process.env.ELIZA_RELEASE_AUTHORITY || releaseAuthority,
    ...(androidRuntimeMode
      ? {
          VITE_ELIZA_ANDROID_RUNTIME_MODE: androidRuntimeMode,
        }
      : {}),
    ...(iosRuntimeMode
      ? {
          ELIZA_IOS_RUNTIME_MODE: iosRuntimeMode,
          // A pre-set VITE_ELIZA_IOS_RUNTIME_MODE (the value Vite bakes into the
          // renderer) wins over the policy default, mirroring ELIZA_BUILD_VARIANT
          // above. Without this, spreading the policy object clobbered an
          // explicitly chosen runtime mode.
          VITE_ELIZA_IOS_RUNTIME_MODE:
            process.env.VITE_ELIZA_IOS_RUNTIME_MODE || iosRuntimeMode,
        }
      : {}),
    ...(runtimeExecutionMode
      ? {
          ELIZA_RUNTIME_MODE: runtimeExecutionMode,
          RUNTIME_MODE: runtimeExecutionMode,
          LOCAL_RUNTIME_MODE: runtimeExecutionMode,
          VITE_ELIZA_RUNTIME_MODE: runtimeExecutionMode,
        }
      : {}),
    ...((platform === "ios" || platform === "ios-local") &&
    shouldIncludeIosFullBunEngine(process.env)
      ? {
          VITE_ELIZA_IOS_FULL_BUN_AVAILABLE: "1",
        }
      : {}),
    ...(platform === "ios-local" && isFullIosBunEngineRequested(process.env)
      ? {
          VITE_ELIZA_IOS_FULL_BUN_STRICT: "1",
        }
      : {}),
    ...(fs.existsSync(path.join(repoRoot, "eliza", "package.json"))
      ? {
          ELIZA_FORCE_LOCAL_UPSTREAMS:
            process.env.ELIZA_FORCE_LOCAL_UPSTREAMS ?? "1",
        }
      : {}),
  });
  const bun = resolveBunExecutable();
  const packageStylesPatch = path.join(
    repoRoot,
    "scripts",
    "patch-elizaos-package-styles.mjs",
  );
  if (fs.existsSync(packageStylesPatch)) {
    await run(process.execPath, [packageStylesPatch], { cwd: repoRoot, env });
  }
  if (bun) {
    const sharedEntry = path.join(packagesRoot, "shared", "dist", "index.js");
    if (!fs.existsSync(sharedEntry)) {
      console.log(
        "[mobile-build] Building workspace dependencies for mobile web bundle.",
      );
      await run(bun, ["run", "dev:prepare"], { cwd: repoRoot, env });
    }
    await run(bun, ["run", "build:web"], { cwd: appDir, env });
    return;
  }
  await run(process.execPath, [resolveViteCli(), "build"], {
    cwd: appDir,
    env,
  });
}

/**
 * Lane guard (#11030): assert packages/app/dist carries EXACTLY the renderer
 * stamp this lane bakes, immediately before Capacitor sync copies it into the
 * native project. Between buildWeb() and cap sync there is a window (agent
 * bundle build, CocoaPods, platform templating) in which another lane's build
 * can overwrite dist — that is how a cloud/store renderer left behind by
 * `install:ios:cloud:sideload` was baked into every later `build:ios:local`
 * artifact and hung real devices at "Booting up…".
 *
 * On mismatch the renderer is REBUILT for this lane (buildWeb already knows
 * how); a mismatched bundle is never staged silently. The explicit
 * ELIZA_MOBILE_SKIP_WEB_BUILD=1 + ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE=1
 * escape hatch keeps its ship-anyway semantics for variant/target/staleness,
 * but the known-broken ios-local hang combination (non-local runtime mode
 * with no Agent.apiBase) stays a hard failure even then — that bundle is not
 * merely stale, it cannot boot on a device.
 */
async function ensureRendererDistMatchesLane(platform) {
  const policy = resolveMobileBuildPolicy(platform);
  const expected = resolveExpectedRendererStamp({
    policy,
    env: process.env,
  });
  const distDir = path.join(appDir, "dist");
  let manifest = readRendererBuildManifest(distDir);
  let mismatches = rendererLaneStampMismatches(manifest, expected);
  if (mismatches.length > 0) {
    const detail = formatMobileWebDistProblems(mismatches);
    const skipWebBuild = process.env.ELIZA_MOBILE_SKIP_WEB_BUILD === "1";
    const allowStale =
      skipWebBuild &&
      process.env.ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE === "1";
    if (allowStale) {
      console.warn(
        `[mobile-build] ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE=1 — staging a renderer that does not match the '${platform}' lane:\n${detail}`,
      );
    } else if (skipWebBuild) {
      throw new Error(
        `[mobile-build] refusing to stage packages/app/dist into the native project — it was not built for the '${platform}' lane:\n${detail}\n` +
          `Drop ELIZA_MOBILE_SKIP_WEB_BUILD to rebuild for this lane, or set ` +
          `ELIZA_MOBILE_SKIP_WEB_BUILD_ALLOW_STALE=1 to ship it anyway (NOT recommended).`,
      );
    } else {
      console.warn(
        `[mobile-build] packages/app/dist does not match the '${platform}' lane — rebuilding the renderer for this lane instead of staging a wrong-lane bundle (#11030):\n${detail}`,
      );
      await buildWeb(platform);
      manifest = readRendererBuildManifest(distDir);
      mismatches = rendererLaneStampMismatches(manifest, expected);
      if (mismatches.length > 0) {
        throw new Error(
          `[mobile-build] packages/app/dist still does not match the '${platform}' lane after a rebuild:\n${formatMobileWebDistProblems(mismatches)}\n` +
            `An env override (ELIZA_BUILD_VARIANT / VITE_ELIZA_IOS_RUNTIME_MODE / VITE_ELIZA_ANDROID_RUNTIME_MODE / ELIZA_RUNTIME_MODE) ` +
            `is forcing a different stamp than this lane expects — unset it or use the matching build lane.`,
        );
      }
    }
  }
  // Hard #11030 rule on the ACTUAL bundle about to be staged — applies even
  // under the ALLOW_STALE escape hatch (a cloud-mode ios-local bundle with no
  // endpoint is known-broken on device, not merely stale).
  const distRule = evaluateIosLocalLaneRuntime({
    platform,
    runtimeMode: manifest?.runtimeMode ?? null,
    env: process.env,
  });
  if (!distRule.ok) {
    throw new Error(
      `[mobile-build] refusing to stage packages/app/dist into the native project: ${distRule.reason}`,
    );
  }
}

async function buildMobileAgentBundle({ target = "android" } = {}) {
  const bun = resolveBunExecutable();
  if (!bun) {
    throw new Error(
      "bun executable not found; run bun install before mobile local builds.",
    );
  }
  const script = target === "ios" ? "build:ios-bun" : "build:mobile";
  await run(bun, ["run", script], {
    cwd: path.join(packagesRoot, "agent"),
  });
}

export function resolveIosAgentRuntimeAssetPlan({
  appStoreBuild = false,
  includeFullBunEngine = false,
} = {}) {
  const includeAgentPayload = !appStoreBuild || includeFullBunEngine;
  return {
    agentAssets: includeAgentPayload ? IOS_AGENT_RUNTIME_ASSETS : null,
    rootAssets: includeAgentPayload ? IOS_AGENT_ROOT_EXTENSION_ASSETS : [],
  };
}

function countGgufFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) count += countGgufFiles(fullPath);
    else if (stats.isFile() && entry.toLowerCase().endsWith(".gguf"))
      count += 1;
  }
  return count;
}

function stageIosBundledLocalModels(targetDir) {
  const sourceDir = process.env.ELIZA_IOS_BUNDLED_MODELS_DIR?.trim();
  const requireModels = isTruthyEnv(process.env.ELIZA_IOS_REQUIRE_LOCAL_MODELS);
  if (!sourceDir) {
    if (requireModels) {
      throw new Error(
        "ELIZA_IOS_REQUIRE_LOCAL_MODELS is set but ELIZA_IOS_BUNDLED_MODELS_DIR is empty.",
      );
    }
    return 0;
  }
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(
      `ELIZA_IOS_BUNDLED_MODELS_DIR does not exist or is not a directory: ${sourceDir}`,
    );
  }
  const sourceCount = countGgufFiles(sourceDir);
  if (sourceCount === 0) {
    throw new Error(
      `ELIZA_IOS_BUNDLED_MODELS_DIR contains no GGUF model files: ${sourceDir}`,
    );
  }
  const sourceName = path.basename(sourceDir.replace(/[\\/]+$/, ""));
  const targetModelsDir = sourceName.endsWith(".bundle")
    ? path.join(targetDir, "models", sourceName)
    : path.join(targetDir, "models");
  fs.mkdirSync(targetModelsDir, { recursive: true });
  fs.cpSync(sourceDir, targetModelsDir, { recursive: true });
  const stagedCount = countGgufFiles(targetModelsDir);
  if (stagedCount === 0) {
    throw new Error(
      `No GGUF model files were staged into ${path.relative(repoRoot, targetModelsDir)}`,
    );
  }
  return stagedCount;
}

function stageIosAgentRuntime({
  appStoreBuild = false,
  includeFullBunEngine = false,
} = {}) {
  const sourceDir = path.join(packagesRoot, "agent", "dist-mobile-ios");
  const assetPlan = resolveIosAgentRuntimeAssetPlan({
    appStoreBuild,
    includeFullBunEngine,
  });
  const required = IOS_AGENT_RUNTIME_ASSETS;
  for (const file of required) {
    const p = path.join(sourceDir, file);
    if (!fs.existsSync(p)) {
      throw new Error(
        `[mobile-build] iOS local agent payload missing ${p}; run packages/agent build:ios-bun first.`,
      );
    }
  }

  // The agent bundle must be the freshly built one — never a stale leftover that
  // forces a manual hot-swap to get latest (issue #9309). buildIos rebuilds it
  // before staging, so this is a hard guarantee; fail loudly if it regressed.
  if (process.env.ELIZA_MOBILE_ALLOW_STALE_AGENT_BUNDLE !== "1") {
    const bundleStale = artifactStaleness(
      path.join(sourceDir, "agent-bundle.js"),
      { sourceDirs: [path.join(packagesRoot, "agent", "src")] },
    );
    if (bundleStale.stale) {
      throw new Error(
        `[mobile-build] iOS agent bundle is stale (${bundleStale.reason}). ` +
          `Run \`bun run --cwd packages/agent build:ios-bun\` to rebuild, or set ` +
          `ELIZA_MOBILE_ALLOW_STALE_AGENT_BUNDLE=1 to stage it anyway (NOT recommended).`,
      );
    }
  }

  const targetDir = path.join(iosDir, "App", "public", "agent");
  rmRecursive(targetDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const filesToStage = assetPlan.agentAssets ?? fs.readdirSync(sourceDir);
  for (const file of filesToStage) {
    const src = path.join(sourceDir, file);
    const dst = path.join(targetDir, file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
  // PGlite resolves extension bundles via new URL("../vector.tar.gz",
  // import.meta.url) from public/agent/agent-bundle.js, so iOS must stage
  // these two assets at public/ as well as keeping the manifest copy under
  // public/agent for build diagnostics.
  const publicDir = path.dirname(targetDir);
  for (const file of assetPlan.rootAssets) {
    fs.copyFileSync(path.join(sourceDir, file), path.join(publicDir, file));
  }
  // Verify the staged bundle is a faithful copy (catch a torn/partial copy that
  // would ship a corrupt agent runtime).
  if (assetPlan.agentAssets?.includes("agent-bundle.js")) {
    const sha = (p) =>
      crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    const srcSha = sha(path.join(sourceDir, "agent-bundle.js"));
    const dstSha = sha(path.join(targetDir, "agent-bundle.js"));
    if (srcSha !== dstSha) {
      throw new Error(
        `[mobile-build] staged iOS agent-bundle.js hash ${dstSha} != source ${srcSha} — partial/corrupt copy.`,
      );
    }
  }
  const stagedModelCount = stageIosBundledLocalModels(targetDir);
  console.log(
    `[mobile-build] Staged iOS Bun agent payload${appStoreBuild ? " (App Store allowlist)" : ""}: ${path.relative(repoRoot, targetDir)}${stagedModelCount > 0 ? ` with ${stagedModelCount} local model file(s)` : ""}`,
  );
}

function removeIosLocalExecutionAssets() {
  const publicDir = path.join(iosDir, "App", "public");
  const targets = [
    path.join(publicDir, "agent"),
    path.join(publicDir, "vector.tar.gz"),
    path.join(publicDir, "fuzzystrmatch.tar.gz"),
  ];
  let removed = 0;
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    rmRecursive(target);
    removed += 1;
  }
  if (removed > 0) {
    console.log(
      `[mobile-build] Removed ${removed} stale iOS local execution asset path(s) for App Store build.`,
    );
  }
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

/**
 * `cap sync android` copies the web bundle + capacitor runtime config into the
 * host app's Capacitor project (`<appDir>/android`). The gradle build and agent
 * staging, however, run against the canonical platform tree
 * (`androidDir` = `app-core/platforms/android`). When those are distinct
 * directories — e.g. this elizaOS checkout nested inside a consumer monorepo —
 * the freshly-synced renderer never reaches the dir gradle packages, so the APK
 * ships no web assets and the WebView 404s on index.html
 * (net::ERR_CONNECTION_REFUSED). Mirror the synced payload into androidDir.
 * No-op when both trees resolve to the same directory (standalone layout) or
 * when the synced public payload is missing.
 */
// `@elizaos/capacitor-bun-runtime` is an app-core-only native module (it powers
// the on-device Bun agent runtime) and is NOT a `packages/app` dependency, so
// `cap sync` never emits it. Now that `android.path` makes cap sync regenerate
// capacitor.settings.gradle / capacitor.build.gradle in place, those files would
// lose bun-runtime on every sync. Re-register it idempotently after each sync so
// the on-device agent keeps building (exact module name + projectDir the
// committed files used).
function ensureBunRuntimeRegistered() {
  const MODULE = "elizaos-capacitor-bun-runtime";
  // Resolve the projectDir relative to the ACTUAL androidDir, not a hardcoded
  // `../../../../` that only happens to be right for the eliza tree's depth
  // (`app-core/platforms/android`). A white-label consumer building in
  // `apps/app/android` (ELIZA_ANDROID_USE_APP_DIR=1) sits at a different depth,
  // so the hardcoded path resolved to a non-existent dir and gradle aborted
  // ("projectDirectory … does not exist"). path.relative gives the correct
  // hops from either androidDir to the bun-runtime plugin in the eliza checkout.
  const PROJECT_DIR = path
    .relative(
      androidDir,
      path.join(
        elizaRepoRoot,
        "plugins",
        "plugin-native-bun-runtime",
        "android",
      ),
    )
    .split(path.sep)
    .join("/");
  const settingsPath = path.join(androidDir, "capacitor.settings.gradle");
  const buildGradlePath = path.join(
    androidDir,
    "app",
    "capacitor.build.gradle",
  );

  if (fs.existsSync(settingsPath)) {
    let settings = fs.readFileSync(settingsPath, "utf8");
    if (!settings.includes(`':${MODULE}'`)) {
      settings = `${settings.trimEnd()}\ninclude ':${MODULE}'\nproject(':${MODULE}').projectDir = new File('${PROJECT_DIR}')\n`;
      fs.writeFileSync(settingsPath, settings);
      console.log(
        `[mobile-build] Re-registered ${MODULE} (cap sync omits this app-core-only module).`,
      );
    }
  }

  if (fs.existsSync(buildGradlePath)) {
    let build = fs.readFileSync(buildGradlePath, "utf8");
    if (!build.includes(`project(':${MODULE}')`)) {
      build = build.replace(
        /dependencies\s*\{/,
        `dependencies {\n    implementation project(':${MODULE}')`,
      );
      fs.writeFileSync(buildGradlePath, build);
    }
  }
}

function mirrorCapacitorWebPayloadIntoAndroidDir() {
  const syncedAssets = path.join(
    appDir,
    "android",
    "app",
    "src",
    "main",
    "assets",
  );
  const targetAssets = path.join(androidDir, "app", "src", "main", "assets");
  const targetPublic = path.join(targetAssets, "public");
  const syncedPublic = path.join(syncedAssets, "public");
  // Mirror the synced web payload only when cap sync wrote to a SEPARATE appDir
  // tree (the legacy two-tree split). When capacitor.config.ts unifies the trees
  // via android.path=../app-core/platforms/android (#8387), cap sync writes
  // straight into androidDir, so there's no syncedPublic to copy (or it's the
  // same tree). In that case the mirror is a no-op — but we MUST still run the
  // reconcile below on the android manifest, so the early-returns only skip the
  // copy, never the reconcile.
  const hasSyncedPublic = fs.existsSync(syncedPublic);
  const sameTree =
    hasSyncedPublic &&
    fs.existsSync(targetAssets) &&
    fs.realpathSync(syncedAssets) === fs.realpathSync(targetAssets);
  // STALE-MIRROR GUARD: with the unified tree (android.path =
  // ../app-core/platforms/android, #8387) cap sync writes the fresh
  // capacitor.plugins.json straight into androidDir — but a leftover legacy
  // appDir/android tree (with its own assets/public) makes hasSyncedPublic
  // true and !sameTree, so this mirror used to STOMP the freshly synced
  // manifest with a months-old copy. That silently dropped every
  // newer native plugin (ML Kit OCR, ScreenCapture, mobile-agent-bridge, …)
  // from auto-registration: "not implemented on android" at runtime
  // (verified live on emulator-5554). Only mirror when the synced manifest is
  // at least as fresh as the target's.
  const syncedManifest = path.join(syncedAssets, "capacitor.plugins.json");
  const targetManifest = path.join(targetAssets, "capacitor.plugins.json");
  const syncedIsStale =
    fs.existsSync(syncedManifest) &&
    fs.existsSync(targetManifest) &&
    fs.statSync(syncedManifest).mtimeMs < fs.statSync(targetManifest).mtimeMs;
  if (syncedIsStale && !sameTree) {
    console.log(
      `[mobile-build] Skipping Capacitor web-payload mirror: ${path.relative(repoRoot, syncedAssets)} is a stale legacy tree (its capacitor.plugins.json is older than the freshly synced ${path.relative(repoRoot, targetManifest)}).`,
    );
  }
  if (hasSyncedPublic && !sameTree && !syncedIsStale) {
    fs.mkdirSync(targetAssets, { recursive: true });
    rmRecursive(targetPublic);
    fs.cpSync(syncedPublic, targetPublic, { recursive: true });
    for (const cfg of ["capacitor.config.json", "capacitor.plugins.json"]) {
      const src = path.join(syncedAssets, cfg);
      if (fs.existsSync(src))
        fs.copyFileSync(src, path.join(targetAssets, cfg));
    }
    console.log(
      `[mobile-build] Mirrored Capacitor web payload into ${path.relative(repoRoot, targetAssets)}`,
    );
  }
  // `cap sync` generates capacitor.plugins.json from the
  // FULL appDir dependency set, but androidDir ships a committed
  // capacitor.settings.gradle that compiles only a curated subset of plugin
  // modules (plus app-core additions like elizaos-capacitor-bun-runtime that
  // cap sync never emits). Mirroring the full manifest into androidDir leaves
  // it listing classes that aren't on the dex — and Capacitor's
  // PluginManager.loadPluginClasses ABORTS the ENTIRE auto-registration on the
  // first missing class (PluginLoadException). The net effect is that NONE of
  // the auto-registered plugins load — including the compiled ones the app
  // actually needs (Preferences, LlamaCpp, every @elizaos/capacitor-*) — so
  // on-device local inference and Capacitor Preferences silently report
  // "not implemented on android". Reconcile the manifest with what gradle
  // actually compiles so loadPluginClasses succeeds.
  // STALE-WEB GUARD: cap sync (even unified via android.path) has been observed
  // to leave a STALE assets/public — an old entry hash in the gradle-packaged
  // tree, shipping an "ancient" UI despite a fresh build. The freshly vite-built
  // bundle in appDir/dist is the source of truth, so overlay it unconditionally:
  // clear the hashed assets/ then copy dist over public. cordova.js /
  // cordova_plugins.js are Capacitor-injected (NOT in dist) and survive because
  // we only clear assets/ and cpSync never deletes existing non-dist files;
  // capacitor.config.json / capacitor.plugins.json live in targetAssets (above
  // public) and are untouched.
  const freshWeb = path.join(appDir, "dist");
  if (
    fs.existsSync(path.join(freshWeb, "index.html")) &&
    fs.existsSync(targetAssets)
  ) {
    fs.mkdirSync(targetPublic, { recursive: true });
    rmRecursive(path.join(targetPublic, "assets"));
    fs.cpSync(freshWeb, targetPublic, { recursive: true });
    console.log(
      `[mobile-build] Stale-web guard: overlaid fresh ${path.relative(repoRoot, freshWeb)} → ${path.relative(repoRoot, targetPublic)}`,
    );
  }
  dropRetiredLlamaCppFromAndroidGradle();
  reconcilePluginManifestWithGradle(targetAssets);
  // Verify the staged Android renderer is exactly the freshly built one. The
  // overlay above makes it so; this turns "should be fresh" into a hard,
  // build-failing guarantee (issue #9309).
  if (fs.existsSync(path.join(freshWeb, "index.html"))) {
    assertStagedRendererMatchesBuild(freshWeb, targetPublic, {
      label: "android",
    });
  }
}

/**
 * iOS stale-web guard — the iOS counterpart to
 * mirrorCapacitorWebPayloadIntoAndroidDir. `cap sync ios` (and a skipped sync)
 * have both been observed to leave a STALE `ios/App/App/public` — an old entry
 * hash shipping an ancient UI despite a fresh `dist`. The freshly vite-built
 * bundle is the source of truth, so overlay it unconditionally: clear the hashed
 * assets/ then copy dist over public. The on-device agent payload
 * (`public/agent`) and PGlite root extension assets staged by
 * stageIosAgentRuntime live OUTSIDE dist and survive — we only clear
 * `public/assets` and cpSync never deletes existing non-dist files. After the
 * overlay we assert the staged renderer matches the build so a stale/missing UI
 * FAILS THE BUILD instead of shipping (issue #9309).
 */
function mirrorCapacitorWebPayloadIntoIosDir() {
  const freshWeb = path.join(appDir, "dist");
  const targetPublic = path.join(iosDir, "App", "public");
  overlayFreshRendererIntoPublic(freshWeb, targetPublic, { label: "ios" });
  console.log(
    `[mobile-build] Stale-web guard: overlaid fresh ${path.relative(repoRoot, freshWeb)} → ${path.relative(repoRoot, targetPublic)}`,
  );
}

/**
 * Remove the RETIRED llama-cpp-capacitor Android module from the gradle build
 * entirely — the `include ':llama-cpp-capacitor'` + project line in
 * capacitor.settings.gradle and the `implementation project(':llama-cpp-capacitor')`
 * in app/capacitor.build.gradle. `cap sync` re-adds these on every sync because
 * the package ships an android/ dir, but agent inference runs solely through the
 * fused libelizainference.so and nothing on Android loads this plugin's separate
 * libllama-cpp-arm64.so. Leaving the gradle project in only made gradle configure
 * its CMake — which built a no-op stub and used to require the
 * ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB opt-out. Dropping the project removes the
 * stub build outright (no flag needed). iOS is untouched: ios-local-agent-kernel
 * loads the package via a dynamic import, so the npm dependency stays.
 *
 * Opt back into the full second library (not the stub) with
 * ELIZA_ANDROID_INCLUDE_LLAMA_CPP_CAPACITOR=1. Idempotent.
 */
function dropRetiredLlamaCppFromAndroidGradle() {
  if (
    process.env.ELIZA_ANDROID_INCLUDE_LLAMA_CPP_CAPACITOR === "1" ||
    process.env.elizaIncludeLlamaCppCapacitor === "true"
  ) {
    return;
  }
  const targets = [
    path.join(androidDir, "capacitor.settings.gradle"),
    path.join(androidDir, "app", "capacitor.build.gradle"),
  ];
  let dropped = false;
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    const before = fs.readFileSync(target, "utf8");
    const after = before
      .split("\n")
      .filter((line) => !line.includes("llama-cpp-capacitor"))
      .join("\n");
    if (after !== before) {
      fs.writeFileSync(target, after, "utf8");
      dropped = true;
    }
  }
  if (dropped) {
    console.log(
      "[mobile-build] Dropped retired llama-cpp-capacitor from the Android gradle build (no stub CMake; libelizainference is the sole in-process inference lib).",
    );
  }
}

/**
 * Drop capacitor.plugins.json entries whose gradle module is not included in
 * androidDir/capacitor.settings.gradle. Uses Capacitor's canonical package →
 * gradle-project derivation (`pkg.replace(/@/g,"").replace(/\//g,"-")`), so
 * `@capacitor/preferences`→`capacitor-preferences`,
 * `@elizaos/capacitor-agent`→`elizaos-capacitor-agent`,
 * `llama-cpp-capacitor`→`llama-cpp-capacitor`. Keeping the manifest in lockstep
 * with the compiled module set is what stops PluginManager.loadPluginClasses
 * from throwing on a class that isn't on the dex.
 */
function reconcilePluginManifestWithGradle(targetAssets) {
  const manifestPath = path.join(targetAssets, "capacitor.plugins.json");
  const settingsPath = path.join(androidDir, "capacitor.settings.gradle");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(settingsPath)) return;

  const settings = fs.readFileSync(settingsPath, "utf8");
  const compiledProjects = new Set(
    [...settings.matchAll(/include ':([^']+)'/g)].map((m) => m[1]),
  );

  let plugins;
  try {
    plugins = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `[mobile-build] Could not parse capacitor.plugins.json for gradle reconciliation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(plugins)) return;

  const gradleProjectFor = (pkg) =>
    String(pkg ?? "")
      .replace(/@/g, "")
      .replace(/\//g, "-");
  // The llama-cpp-capacitor plugin is RETIRED on Android: agent inference runs
  // entirely through the single fused libelizainference.so, and nothing loads
  // this plugin's separate libllama-cpp-arm64.so (its JS adapter is retired).
  // dropRetiredLlamaCppFromAndroidGradle() (called above) removes its gradle
  // project outright, so its CMake never runs — there is no stub to register
  // and no ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB opt-out to set. We also drop it from
  // the plugins manifest here so the LlamaCpp class never auto-registers. The
  // device-bridge's optional LlamaCpp import resolves to a catchable "plugin not
  // implemented" JS error, which costs nothing. Opt the full second library back
  // in (gradle project + manifest) only with ELIZA_ANDROID_INCLUDE_LLAMA_CPP_CAPACITOR=1.
  const stubLlamaCpp =
    process.env.ELIZA_ANDROID_INCLUDE_LLAMA_CPP_CAPACITOR !== "1" &&
    process.env.elizaIncludeLlamaCppCapacitor !== "true";
  // Third-party Capacitor plugins that `cap sync` includes (they ship an
  // android/ dir, so they ARE in capacitor.settings.gradle) but whose Kotlin
  // plugin class never lands in the app dex on AGP 8.x: both rely on AGP's
  // built-in Kotlin instead of applying `org.jetbrains.kotlin.android`, so the
  // built-in kotlinc compiles the .kt but does NOT bundle the .class into the
  // library AAR. PluginManager.loadPluginClasses then throws "Could not find
  // class …" on the first one and aborts the ENTIRE plugin load, so EVERY
  // plugin (Browser, Haptics, Keyboard, …) silently fails to register. We can't
  // edit node_modules durably, and neither is needed for the core Android app —
  // background work uses WorkManager (ElizaWorkScheduler) and barcode scanning
  // is a companion-pairing-only feature — so drop them from the manifest. (Our
  // own native plugins fix this properly by applying the Kotlin plugin in their
  // android/build.gradle.)
  const nonBundlingThirdPartyPlugins = new Set([
    "@capacitor/background-runner",
    "@capacitor/barcode-scanner",
  ]);
  const isCompiledAndUsable = (plugin) => {
    if (!compiledProjects.has(gradleProjectFor(plugin?.pkg))) return false;
    if (stubLlamaCpp && plugin?.pkg === "llama-cpp-capacitor") return false;
    if (nonBundlingThirdPartyPlugins.has(plugin?.pkg)) return false;
    return true;
  };
  const kept = plugins.filter(isCompiledAndUsable);

  // `cap sync` wires `@capacitor/local-notifications` into the gradle project
  // (capacitor.settings.gradle / capacitor.build.gradle) but does NOT emit its
  // auto-register entry into capacitor.plugins.json — so the compiled
  // LocalNotificationsPlugin class never auto-registers and the JS bridge
  // (`Capacitor.Plugins.LocalNotifications`) resolves to undefined on-device.
  // Add it back when its module is compiled. (Verified on Pixel 9a: without
  // this entry LocalNotifications.schedule is unavailable; with it, native
  // notifications fire.)
  const LOCAL_NOTIFICATIONS_PKG = "@capacitor/local-notifications";
  if (
    compiledProjects.has("capacitor-local-notifications") &&
    !kept.some((plugin) => plugin?.pkg === LOCAL_NOTIFICATIONS_PKG)
  ) {
    kept.push({
      pkg: LOCAL_NOTIFICATIONS_PKG,
      classpath:
        "com.capacitorjs.plugins.localnotifications.LocalNotificationsPlugin",
    });
  }

  const before = JSON.stringify(plugins);
  const after = JSON.stringify(kept);
  if (before !== after) {
    const dropped = plugins
      .filter((plugin) => !isCompiledAndUsable(plugin))
      .map((plugin) => plugin?.pkg)
      .join(", ");
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(kept, null, "\t")}\n`,
      "utf8",
    );
    console.log(
      `[mobile-build] Reconciled capacitor.plugins.json with capacitor.settings.gradle (${dropped ? `dropped: ${dropped}; ` : ""}ensured LocalNotifications).`,
    );
  }
}

// ── Phase 4: Android native overlay ─────────────────────────────────────

/** Permissions that Capacitor sync doesn't generate (it only adds INTERNET). */
export const ANDROID_PERMISSIONS = [
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
  "FOREGROUND_SERVICE_MEDIA_PROJECTION",
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
  "READ_FRAME_BUFFER",
  "INJECT_EVENTS",
  "REAL_GET_TASKS",
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

function androidSmsGatewayBuildConfigFieldLines() {
  return [
    `        buildConfigField "boolean", "ELIZA_ANDROID_SMS_GATEWAY_ENABLED", "\${['1', 'true', 'yes'].contains((System.getenv('ELIZA_ANDROID_SMS_GATEWAY_ENABLED') ?: 'false').toLowerCase())}"`,
    `        buildConfigField "String", "ELIZA_ANDROID_SMS_GATEWAY_SECRET", "\\"${escapeJavaString(process.env.ELIZA_ANDROID_SMS_GATEWAY_SECRET ?? "")}\\""`,
    `        buildConfigField "String", "ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL", "\\"${escapeJavaString(process.env.ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL ?? "https://api.elizacloud.ai/api/webhooks/blooio/local?bridge=bluebubbles")}\\""`,
    `        buildConfigField "String", "ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER", "\\"${escapeJavaString(process.env.ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER ?? "+14159611510")}\\""`,
    `        buildConfigField "String", "ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL", "\\"${escapeJavaString(process.env.ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL ?? "Eliza Cloud Gateway (+14159611510)")}\\""`,
  ];
}

function injectAndroidSmsGatewayBuildConfigFields(content) {
  let next = injectBuildConfigAospField(content);
  const fields = androidSmsGatewayBuildConfigFieldLines();
  for (const field of fields) {
    const name = field.match(/,\s*"([^"]+)"/)?.[1];
    if (!name) continue;
    const existingRe = new RegExp(
      `\\n\\s*buildConfigField\\s+["'][^"']+["'],\\s*["']${escapeRegExp(name)}["'][^\\n]*`,
      "g",
    );
    next = next.replace(existingRe, "");
  }
  return next.replace(
    /defaultConfig\s*\{/,
    `defaultConfig {\n${fields.join("\n")}`,
  );
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
 * KV cache types (turbo3, turbo4, turbo3_tcq) and MTP spec-decoding kernels
 * live in this .so; without it, mobile only gets stock llama.cpp.
 *
 * Resolution order for the libdir:
 *   1. -Peliza.mtp.android.libdir=<path>   (gradle property)
 *   2. ELIZA_MTP_ANDROID_LIBDIR env var
 *   3. ~/.eliza/local-inference/bin/mtp/android-arm64-{cpu,vulkan}/
 *
 * Fails local builds when no path is configured or the dir doesn't exist. The
 * Android Capacitor JNI wrapper links against these MTP libraries and cannot
 * honestly support Eliza-1/Gemma 4 without them. Cloud builds skip the task.
 * A build with no fresh source dir falls back to the already-staged fused lib
 * set (the common dev case); only a genuinely missing arm64 lib is a hard error.
 *
 * Idempotent: re-runs are no-ops once the block is present.
 */
function ensureCopyForkLlamaLibGuards(content) {
  if (!/\[copyForkLlamaLib\]/.test(content)) return content;
  if (/ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB/.test(content)) return content;
  const guards =
    `        if (project.findProperty('elizaCloudBuild') == 'true' || System.getenv('ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB') == '1') {\n` +
    `            println "[copyForkLlamaLib] skipped for cloud/smoke build"\n` +
    `            return\n` +
    `        }\n`;
  const oldCloudOnlyGuard =
    `        if (project.findProperty('elizaCloudBuild') == 'true') {\n` +
    `            println "[copyForkLlamaLib] skipped for cloud build"\n` +
    `            return\n` +
    `        }\n`;
  if (content.includes(oldCloudOnlyGuard)) {
    return content.replace(oldCloudOnlyGuard, guards);
  }
  return content.replace(
    /(task copyForkLlamaLib\s*\{\s*\n\s*doLast\s*\{\s*\n)/,
    `$1${guards}`,
  );
}

export function injectCopyForkLlamaLibTask(content) {
  if (/\[copyForkLlamaLib\]/.test(content)) {
    return ensureCopyForkLlamaLibGuards(content);
  }
  const block =
    `\n// Bundle the MTP Android llama.cpp stack into the APK so mobile\n` +
    `// gets Eliza-1/Gemma 4 support across every supported Android ABI\n` +
    `// (arm64-v8a, x86_64, riscv64). The arm64-v8a slice is mandatory for\n` +
    `// local-agent capable builds; x86_64 and riscv64 ship when their\n` +
    `// per-ABI artifacts exist (Wave 2 cross-compiles land them\n` +
    `// incrementally). Cloud builds and explicitly opted-out CI smoke\n` +
    `// builds skip this task.\n` +
    `ext.elizaForkLlamaAbis = ['arm64-v8a', 'x86_64', 'riscv64']\n` +
    `\n` +
    `ext.forkLlamaAbiTokens = [\n` +
    `    'arm64-v8a': 'android-arm64',\n` +
    `    'x86_64': 'android-x86_64',\n` +
    `    'riscv64': 'android-riscv64'\n` +
    `]\n` +
    `\n` +
    `ext.forkLlamaLibompAbiTokens = [\n` +
    `    'arm64-v8a': 'aarch64',\n` +
    `    'x86_64': 'x86_64',\n` +
    `    'riscv64': 'riscv64'\n` +
    `]\n` +
    `\n` +
    `def resolveForkLlamaLibDir = { String abi ->\n` +
    `    // arm64-v8a keeps the legacy un-suffixed property/env names for\n` +
    `    // backwards compatibility; other ABIs use the suffixed forms.\n` +
    `    def propSuffix = abi == 'arm64-v8a' ? '' : ".\${abi}"\n` +
    `    def envSuffix = abi == 'arm64-v8a' ? '' : "_\${abi.replace('-', '_').toUpperCase()}"\n` +
    `    def fromProp = project.findProperty("eliza.mtp.android.libdir\${propSuffix}")\n` +
    `    if (fromProp) return fromProp.toString()\n` +
    `    def fromEnv = System.getenv("ELIZA_MTP_ANDROID_LIBDIR\${envSuffix}")\n` +
    `    if (fromEnv) return fromEnv\n` +
    `    def stateDir = System.getenv('ELIZA_STATE_DIR') ?: "\${System.getProperty('user.home')}/.eliza"\n` +
    `    def abiToken = project.ext.forkLlamaAbiTokens[abi]\n` +
    `    def candidates = ['vulkan', 'cpu'].collect { backend ->\n` +
    `        "\${stateDir}/local-inference/bin/mtp/\${abiToken}-\${backend}"\n` +
    `    }\n` +
    `    return candidates.find { new File(it).isDirectory() }\n` +
    `}\n` +
    `\n` +
    `def resolveAndroidLibompForAbi = { String abi ->\n` +
    `    def localProperties = new Properties()\n` +
    `    def localPropertiesFile = rootProject.file('local.properties')\n` +
    `    if (localPropertiesFile.isFile()) {\n` +
    `        localPropertiesFile.withInputStream { localProperties.load(it) }\n` +
    `    }\n` +
    `    def sdkPath = localProperties.getProperty('sdk.dir') ?:\n` +
    `        System.getenv('ANDROID_HOME') ?:\n` +
    `        System.getenv('ANDROID_SDK_ROOT') ?:\n` +
    `        "\${System.getProperty('user.home')}/Library/Android/sdk"\n` +
    `    def androidSdk = new File(sdkPath)\n` +
    `    def ndkRoots = []\n` +
    `    def declaredNdkVersion = android.ndkVersion?.toString()\n` +
    `    if (declaredNdkVersion) ndkRoots << new File(androidSdk, "ndk/\${declaredNdkVersion}")\n` +
    `    ndkRoots << new File(androidSdk, 'ndk/29.0.13113456')\n` +
    `    def ndkParent = new File(androidSdk, 'ndk')\n` +
    `    if (ndkParent.isDirectory()) {\n` +
    `        (ndkParent.listFiles() ?: [] as File[]).each { ndkRoots << it }\n` +
    `    }\n` +
    `    def libompAbiToken = project.ext.forkLlamaLibompAbiTokens[abi]\n` +
    `    for (def ndkDir : ndkRoots.unique { it.absolutePath }) {\n` +
    `        def prebuiltDir = new File(ndkDir, 'toolchains/llvm/prebuilt')\n` +
    `        if (!prebuiltDir.isDirectory()) continue\n` +
    `        def hosts = prebuiltDir.listFiles() ?: [] as File[]\n` +
    `        for (def hostDir : hosts) {\n` +
    `            def clangDir = new File(hostDir, 'lib/clang')\n` +
    `            def versions = clangDir.listFiles() ?: [] as File[]\n` +
    `            for (def versionDir : versions) {\n` +
    `                def libomp = new File(versionDir, "lib/linux/\${libompAbiToken}/libomp.so")\n` +
    `                if (libomp.isFile()) return libomp\n` +
    `            }\n` +
    `        }\n` +
    `    }\n` +
    `    return null\n` +
    `}\n` +
    `\n` +
    `// NOTE: despite the legacy "ForkLlama" name, this stages the SINGLE canonical\n` +
    `// fused inference lib — libelizainference.so — with its own DT_NEEDED runtime\n` +
    `// siblings (libggml*, libllama.so, libllama-common.so, libmtmd.so, libomp.so),\n` +
    `// which ARE libelizainference's GPU/CPU backends, NOT a separate llama.cpp fork.\n` +
    `// There is no second inference library; do NOT delete this task or its siblings.\n` +
    `task copyForkLlamaLib {\n` +
    `    doLast {\n` +
    `        if (project.findProperty('elizaCloudBuild') == 'true' || System.getenv('ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB') == '1') {\n` +
    `            println "[copyForkLlamaLib] skipped for cloud/smoke build"\n` +
    `            return\n` +
    `        }\n` +
    `        boolean stagedArm64 = false\n` +
    `        int totalCopied = 0\n` +
    `        boolean stagedKernels = false\n` +
    `        project.ext.elizaForkLlamaAbis.each { abi ->\n` +
    `            def libDir = resolveForkLlamaLibDir(abi)\n` +
    `            if (!libDir) {\n` +
    `                // No fresh source configured. If the fused lib set is already\n` +
    `                // staged in jniLibs (a prior build, the common dev case), use it\n` +
    `                // as-is so a plain build:android "just works" without any flag.\n` +
    `                def alreadyStaged = new File(file("src/main/jniLibs/\${abi}"), 'libelizainference.so')\n` +
    `                if (alreadyStaged.isFile()) {\n` +
    `                    logger.lifecycle("[copyForkLlamaLib] no source dir for \${abi}; libelizainference.so already staged in jniLibs — using the pre-staged fused lib set")\n` +
    `                    if (abi == 'arm64-v8a') stagedArm64 = true\n` +
    `                    return\n` +
    `                }\n` +
    `                if (abi == 'arm64-v8a') {\n` +
    `                    // arm64-v8a is the mandatory baseline ABI; missing it (and no pre-staged lib) is a hard error.\n` +
    `                    throw new GradleException("[copyForkLlamaLib] no fused inference lib for arm64-v8a (not configured, not pre-staged). Run packages/app-core/scripts/aosp/compile-libllama.mjs --target android-arm64-vulkan-fused (the Android cross-compiler; build-llama-cpp-mtp.mjs has no Android targets) or set -Peliza.mtp.android.libdir / ELIZA_MTP_ANDROID_LIBDIR.")\n` +
    `                }\n` +
    `                logger.lifecycle("[copyForkLlamaLib] no fork lib dir for ABI \${abi}; skipping")\n` +
    `                return\n` +
    `            }\n` +
    `            def srcDir = new File(libDir.toString())\n` +
    `            if (!srcDir.isDirectory()) {\n` +
    `                if (abi == 'arm64-v8a') {\n` +
    `                    throw new GradleException("[copyForkLlamaLib] MTP Android lib dir does not exist for arm64-v8a: \${libDir}")\n` +
    `                }\n` +
    `                logger.lifecycle("[copyForkLlamaLib] fork lib dir \${libDir} does not exist for ABI \${abi}; skipping")\n` +
    `                return\n` +
    `            }\n` +
    `            def jniDir = file("src/main/jniLibs/\${abi}")\n` +
    `            jniDir.mkdirs()\n` +
    `            def assetsDir = file('src/main/assets')\n` +
    `            assetsDir.mkdirs()\n` +
    `            int copied = 0\n` +
    `            srcDir.eachFile { src ->\n` +
    `                if (src.name.endsWith('.so')) {\n` +
    `                    def dst = new File(jniDir, src.name)\n` +
    `                    dst.bytes = src.bytes\n` +
    `                    copied++\n` +
    `                }\n` +
    `                // kernels.json is ABI-independent; stage once from the first ABI we see.\n` +
    `                if (src.name == 'kernels.json' && !stagedKernels) {\n` +
    `                    def dst = new File(assetsDir, 'llama-cpp-kernels.json')\n` +
    `                    dst.bytes = src.bytes\n` +
    `                    println "[copyForkLlamaLib] staged kernels.json as assets/llama-cpp-kernels.json (from \${abi})"\n` +
    `                    stagedKernels = true\n` +
    `                }\n` +
    `            }\n` +
    `            def libomp = resolveAndroidLibompForAbi(abi)\n` +
    `            if (libomp != null) {\n` +
    `                def dst = new File(jniDir, 'libomp.so')\n` +
    `                dst.bytes = libomp.bytes\n` +
    `                copied++\n` +
    `                println "[copyForkLlamaLib] staged Android OpenMP runtime for \${abi} from \${libomp}"\n` +
    `            } else if (abi == 'arm64-v8a') {\n` +
    `                throw new GradleException("[copyForkLlamaLib] Android arm64 libomp.so not found in the configured NDK; MTP CPU backend cannot load without it.")\n` +
    `            } else {\n` +
    `                logger.lifecycle("[copyForkLlamaLib] no libomp.so found for \${abi}; the .so set may not link on-device")\n` +
    `            }\n` +
    `            println "[copyForkLlamaLib] copied \${copied} .so file(s) from \${libDir} to \${jniDir}"\n` +
    `            totalCopied += copied\n` +
    `            if (abi == 'arm64-v8a') stagedArm64 = true\n` +
    `        }\n` +
    `        if (!stagedArm64) {\n` +
    `            throw new GradleException("[copyForkLlamaLib] arm64-v8a slice was not staged; aborting (this is the baseline ABI).")\n` +
    `        }\n` +
    `    }\n` +
    `}\n` +
    `\n` +
    `afterEvaluate {\n` +
    `    tasks.matching { it.name == 'preBuild' }.all { it.dependsOn copyForkLlamaLib }\n` +
    `}\n`;
  const androidOpen = content.search(/(^|\n)\s*android\s*\{/);
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

function patchInstalledCapacitorPluginGradleForAgp9(pkgName) {
  for (const pkgRoot of resolvePackageAbsolutePathCandidates(pkgName)) {
    patchGradleFileForAgp9(
      path.join(pkgRoot, "android", "build.gradle"),
      pkgName,
    );
  }
}

function patchOfficialCapacitorGradleForAgp9() {
  for (const pkgName of ANDROID_OFFICIAL_CAPACITOR_PACKAGES) {
    patchInstalledCapacitorPluginGradleForAgp9(pkgName);
  }
}

function patchLlamaCppCapacitorGradle() {
  for (const pkgRoot of resolvePackageAbsolutePathCandidates(
    "llama-cpp-capacitor",
  )) {
    const gradlePath = path.join(pkgRoot, "android", "build.gradle");
    patchGradleFileForAgp9(gradlePath, "llama-cpp-capacitor");
    restrictLlamaCapacitorToArm64(gradlePath);
  }
}

// llama-cpp-capacitor@0.1.5 is an arm64-only native package: its
// android/src/main/CMakeLists.txt unconditionally builds the arm64 target with
// `-march=armv8-a -mtune=cortex-a76`, and it ships only a
// jniLibs/arm64-v8a/libllama-cpp-arm64.so prebuilt — there is no x86_64 source
// path or prebuilt. Its build.gradle nonetheless declares
// `abiFilters 'arm64-v8a', 'x86_64'`, so AGP runs the arm64 NDK build under the
// x86_64 toolchain and clang rejects `-march=armv8-a` (unknown target CPU). Drop
// x86_64 from THIS library only, so the app still packages x86_64 for the other
// native libs (bun runtime, ggml) — llama-cpp-capacitor is simply absent there,
// which the plugin already tolerates.
function restrictLlamaCapacitorToArm64(gradlePath) {
  if (!fs.existsSync(gradlePath)) return;
  const current = fs.readFileSync(gradlePath, "utf8");
  const patched = current
    .replace(/(abiFilters\s+'arm64-v8a')\s*,\s*'x86_64'/g, "$1")
    .replace(
      /abiFilters\s+'x86_64'\s*,\s*'arm64-v8a'/g,
      "abiFilters 'arm64-v8a'",
    );
  if (patched !== current) {
    fs.writeFileSync(gradlePath, patched, "utf8");
    console.log(
      "[mobile-build] Restricted llama-cpp-capacitor to arm64-v8a (package has no x86_64 native build).",
    );
  }
}

export function injectAndroidBackgroundRunnerAarFlatDir(content) {
  if (/flatDir\s*\{[\s\S]*?dirs[\s\S]*?['"]libs['"][\s\S]*?\}/.test(content)) {
    return content;
  }
  if (/flatDir\s*\{\s*\n\s*dirs\s+/.test(content)) {
    return content.replace(
      /(flatDir\s*\{\s*\n\s*dirs\s+)/,
      "$1'libs',\n             ",
    );
  }
  return content.replace(
    /\nrepositories\s*\{\s*\n/,
    "\nrepositories {\n    flatDir { dirs 'libs' }\n",
  );
}

function stageBackgroundRunnerAndroidJsEngineAar() {
  const settingsPath = path.join(androidDir, "capacitor.settings.gradle");
  if (!fs.existsSync(settingsPath)) return;
  const settings = fs.readFileSync(settingsPath, "utf8");
  if (!settings.includes(":capacitor-background-runner")) return;

  const aarName = "android-js-engine-release.aar";
  const source = [
    "@capacitor/background-runner",
    "@capacitor-community/background-runner",
  ]
    .map((pkgName) => resolvePackageAbsolutePath(pkgName))
    .filter(Boolean)
    .map((pkgRoot) =>
      path.join(pkgRoot, "android", "src", "main", "libs", aarName),
    )
    .find((candidate) => fs.existsSync(candidate));

  if (!source) {
    throw new Error(
      `[mobile-build] ${aarName} not found in @capacitor/background-runner; reinstall dependencies or check the package tarball.`,
    );
  }

  const targetDir = path.join(androidDir, "app", "libs");
  const target = path.join(targetDir, aarName);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
  console.log(
    `[mobile-build] Staged Background Runner JS engine AAR: ${path.relative(repoRoot, target)}`,
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

export function shouldRemoveAndroidJavaSourceRoot(
  candidate,
  dstJava,
  protectedRoots = [],
) {
  const normalized = path.resolve(candidate);
  if (normalized === path.resolve(dstJava)) return false;
  return !protectedRoots.some((root) => normalized === path.resolve(root));
}

function removeStaleAndroidJavaSourceRoots(
  dstJava,
  { protectedRoots = [] } = {},
) {
  const candidates = [
    "ai.elizaos.app",
    "com.elizaai.eliza",
    "com.elizaai.eliza",
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
    if (
      shouldRemoveAndroidJavaSourceRoot(candidate, dstJava, protectedRoots) &&
      fs.existsSync(candidate)
    ) {
      rmRecursive(candidate);
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

export function androidAospRoleLauncherIntentFilter({
  enabled = false,
  category = null,
} = {}) {
  if (!enabled) return "";
  const extraCategory = category
    ? `\n                <category android:name="${category}" />`
    : "";
  return `
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />${extraCategory}
            </intent-filter>`;
}

function assertSharedTreeOnlyForEliza(what) {
  if (
    APP.appId !== "ai.elizaos.app" &&
    path.resolve(androidDir) === path.resolve(platformsDir, "android")
  ) {
    throw new Error(
      `[mobile-build] Refusing to ${what} for brand '${APP.appId}' in the shared elizaOS android tree (${androidDir}). ` +
        "Whitelabel builds must use apps/app/android (set ELIZA_ANDROID_USE_APP_DIR=1); the elizaOS build owns the shared tree.",
    );
  }
}

function syncAndroidAppActionsResources() {
  assertSharedTreeOnlyForEliza("patch app-actions resources");
  const templateResDir = path.join(
    platformsDir,
    "android",
    "app",
    "src",
    "main",
    "res",
  );
  const targetResDir = path.join(androidDir, "app", "src", "main", "res");
  const resourceFiles = [
    path.join("xml", "shortcuts.xml"),
    path.join("xml", "eliza_quick_actions_widget.xml"),
    path.join("xml", "eliza_accessibility_service.xml"),
    path.join("layout", "eliza_quick_actions_widget.xml"),
    path.join("drawable", "eliza_widget_background.xml"),
    path.join("drawable", "eliza_widget_button_background.xml"),
    path.join("xml", "method.xml"),
    path.join("xml", "eliza_voice_interaction_service.xml"),
    path.join("layout", "eliza_voice_ime.xml"),
    path.join("layout", "eliza_voice_interaction_bar.xml"),
    path.join("drawable", "ic_eliza_ime_keyboard.xml"),
    path.join("drawable", "ic_eliza_ime_mic.xml"),
    path.join("drawable", "ic_eliza_ime_open.xml"),
    path.join("drawable", "eliza_ime_mic_bg.xml"),
    path.join("drawable", "eliza_voice_bar_bg.xml"),
    path.join("drawable", "eliza_voice_bar_dot.xml"),
    path.join("values", "android_app_actions.xml"),
  ];
  for (const relPath of resourceFiles) {
    const templatePath = path.join(templateResDir, relPath);
    const targetPath = path.join(targetResDir, relPath);
    if (!fs.existsSync(templatePath)) continue;
    const templateContent = fs.readFileSync(templatePath);
    if (
      fs.existsSync(targetPath) &&
      fs.readFileSync(targetPath).equals(templateContent)
    ) {
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, templateContent);
    console.log(
      `[mobile-build] Synced Android App Actions resource ${relPath}.`,
    );
  }
  syncAndroidVoiceStringResources(templateResDir, targetResDir);

  // The staged App Actions drawables reference @color/eliza_orange, defined in
  // the eliza template's values/colors.xml. We don't copy colors.xml wholesale
  // (a white-label target keeps its own brand colors), so stage just the
  // referenced color into a dedicated file — and ONLY when the target doesn't
  // already define it, so the eliza tree (whose colors.xml already has it)
  // avoids a duplicate-resource merge error.
  const templateColorsXml = path.join(templateResDir, "values", "colors.xml");
  const elizaOrangeMatch = fs.existsSync(templateColorsXml)
    ? fs
        .readFileSync(templateColorsXml, "utf8")
        .match(/<color name="eliza_orange">([^<]+)<\/color>/)
    : null;
  if (elizaOrangeMatch) {
    const alreadyDefined = ["colors.xml", "eliza_app_actions_colors.xml"].some(
      (name) => {
        const p = path.join(targetResDir, "values", name);
        return (
          fs.existsSync(p) &&
          /name="eliza_orange"/.test(fs.readFileSync(p, "utf8"))
        );
      },
    );
    if (!alreadyDefined) {
      const colorFile = path.join(
        targetResDir,
        "values",
        "eliza_app_actions_colors.xml",
      );
      fs.mkdirSync(path.dirname(colorFile), { recursive: true });
      fs.writeFileSync(
        colorFile,
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="eliza_orange">${elizaOrangeMatch[1]}</color>\n</resources>\n`,
      );
      console.log(
        "[mobile-build] Staged @color/eliza_orange for App Actions widget (white-label target).",
      );
    }
  }

  const shortcutsPath = path.join(targetResDir, "xml", "shortcuts.xml");
  if (!fs.existsSync(shortcutsPath)) return;

  const current = fs.readFileSync(shortcutsPath, "utf8");
  const patched = patchAndroidAppActionsXmlResource(current, {
    androidPackage: APP.appId,
    urlScheme: APP.urlScheme,
  });
  if (patched !== current) {
    fs.writeFileSync(shortcutsPath, patched, "utf8");
    console.log(
      "[mobile-build] Rewrote Android App Actions package and scheme.",
    );
  }
}

export function syncAndroidVoiceStringResources(templateResDir, targetResDir) {
  const templateStringsPath = path.join(
    templateResDir,
    "values",
    "strings.xml",
  );
  const targetStringsPath = path.join(targetResDir, "values", "strings.xml");
  if (
    !fs.existsSync(templateStringsPath) ||
    !fs.existsSync(targetStringsPath)
  ) {
    return;
  }

  const voiceStringNames = [
    "assistant_session_prompt",
    "eliza_ime_label",
    "eliza_ime_subtype_voice",
    "eliza_ime_prompt",
    "eliza_ime_listening",
    "eliza_ime_transcribing",
    "eliza_ime_no_speech",
    "eliza_ime_hint",
    "eliza_ime_switch_back",
    "eliza_ime_engine_off",
    "eliza_ime_model_not_ready",
    "eliza_ime_permission_needed",
    "eliza_ime_error_mic",
    "eliza_ime_error_transcribe",
  ];
  const template = fs.readFileSync(templateStringsPath, "utf8");
  let target = fs.readFileSync(targetStringsPath, "utf8");
  const missing = [];
  for (const name of voiceStringNames) {
    const hasString = new RegExp(
      `<string\\s+name="${escapeRegExp(name)}"`,
    ).test(target);
    if (hasString) continue;
    const match = template.match(
      new RegExp(
        `<string\\s+name="${escapeRegExp(name)}"[^>]*>[\\s\\S]*?<\\/string>`,
      ),
    );
    if (!match) continue;
    missing.push(match[0].replace(/\bEliza\b/g, escapeXmlText(APP.appName)));
  }
  if (missing.length === 0) return;

  target = target.replace(
    /\s*<\/resources>\s*$/,
    `\n    <!-- Native voice assistant and voice-input resources. -->\n    ${missing.join("\n    ")}\n</resources>\n`,
  );
  fs.writeFileSync(targetStringsPath, target, "utf8");
  console.log(
    `[mobile-build] Added Android voice string resources (${missing.length}).`,
  );
}

function writeAndroidCleartextPolicy({ allowCleartext, label }) {
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (!fs.existsSync(manifestPath)) return;
  const xml = fs.readFileSync(manifestPath, "utf8");
  const patched = applyAndroidCleartextPolicy(xml, { allowCleartext });
  if (patched !== xml) {
    fs.writeFileSync(manifestPath, patched, "utf8");
    console.log(
      `[mobile-build] Android ${label} cleartext policy: ${allowCleartext ? "enabled for local loopback" : "disabled"}.`,
    );
  }
}

function restoreAndroidManifestFromPlatformTemplateIfMissing() {
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (fs.existsSync(manifestPath)) return false;

  const templatePath = path.join(
    platformsDir,
    "android",
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (!fs.existsSync(templatePath)) return false;

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.copyFileSync(templatePath, manifestPath);
  console.log(
    `[mobile-build] Restored missing AndroidManifest.xml from ${path.relative(
      repoRoot,
      templatePath,
    )}.`,
  );
  return true;
}

function overlayAndroid({ includeAospRoleLaunchers = false } = {}) {
  assertSharedTreeOnlyForEliza("overlay Java sources");
  const templateJavaRoot = path.join(
    platformsDir,
    "android",
    "app",
    "src",
    "main",
    "java",
  );
  const templateJava =
    [
      path.join(templateJavaRoot, "ai", "elizaos", "app"),
      path.join(templateJavaRoot, "app", "eliza"),
    ].find((candidate) => fs.existsSync(candidate)) ??
    path.join(templateJavaRoot, "ai", "elizaos", "app");
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
  const defaultJava = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    "app",
    "eliza",
  );
  const srcJava =
    [templateJava, dstJava, defaultJava, legacyJava].find((candidate) =>
      fs.existsSync(candidate),
    ) ?? templateJava;

  if (fs.existsSync(srcJava)) {
    const protectedJavaRoots = [srcJava, dstJava];
    removeStaleAndroidJavaSourceRoots(dstJava, {
      protectedRoots: protectedJavaRoots,
    });
    for (const staleJava of [legacyJava, appIdJava, defaultJava]) {
      if (
        shouldRemoveAndroidJavaSourceRoot(
          staleJava,
          dstJava,
          protectedJavaRoots,
        )
      ) {
        rmRecursive(staleJava);
      }
    }
    fs.mkdirSync(dstJava, { recursive: true });
    // Move EVERY .java file in the source package — never a hardcoded list. A
    // fixed list silently drops newly-added files (e.g. ElizaVoicePlugin.java /
    // ElizaVoiceNative.java from the fused-voice work), so the white-label
    // package overlay leaves them in the legacy package while MainActivity (and
    // the other moved files) reference them → "cannot find symbol" /
    // "package R does not exist" and the whole white-label build fails. The
    // package/import rewrite below makes any file in `ai.elizaos.app` resolve
    // under the brand package, so moving all of them is always correct.
    const javaFilesToOverlay = fs.existsSync(srcJava)
      ? fs.readdirSync(srcJava).filter((name) => name.endsWith(".java"))
      : [];
    for (const file of javaFilesToOverlay) {
      const src = path.join(srcJava, file);
      if (!fs.existsSync(src)) continue;
      let code = fs.readFileSync(src, "utf8");
      code = code.replace(
        /^package\s+(?:ai\.elizaos\.app|app\.eliza);/m,
        `package ${androidPackage};`,
      );
      code = code.replaceAll(
        "ai.elizaos.app.action.",
        `${androidPackage}.action.`,
      );
      // Generated symbols follow the Gradle namespace. Rewrite stale imports
      // from either the legacy package or the default package so R/BuildConfig
      // resolve after the package overlay.
      code = code.replaceAll(
        /\bimport\s+(?:ai\.elizaos\.app|app\.eliza)\.(BuildConfig|R)\s*;/g,
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
      // Rewrite the legacy-package copy's R/BuildConfig imports so any file left
      // behind in the old package still resolves — but ONLY when that copy lives
      // in THIS build's own android dir. NEVER write into the shared elizaOS
      // template tree (platforms/android): a whitelabel build
      // (ELIZA_ANDROID_USE_APP_DIR) reads that template READ-ONLY, and writing
      // the brand package back into it corrupts the elizaOS checkout's
      // ai/elizaos/app sources (the recurring "custom package does not exist"
      // pollution that breaks the next elizaOS build). srcJava resolves
      // to templateJava for a whitelabel build, so this guard is what keeps the
      // two brands' source trees separate.
      const srcInOwnAndroidDir = path
        .resolve(src)
        .startsWith(`${path.resolve(androidDir)}${path.sep}`);
      if (
        srcInOwnAndroidDir &&
        path.resolve(src) !== path.resolve(path.join(dstJava, file))
      ) {
        const legacyCode = fs
          .readFileSync(src, "utf8")
          .replaceAll(
            /\bimport\s+(?:ai\.elizaos\.app|app\.eliza)\.(BuildConfig|R)\s*;/g,
            `import ${androidPackage}.$1;`,
          );
        fs.writeFileSync(src, legacyCode, "utf8");
      }
    }
    if (
      path.resolve(srcJava) !== path.resolve(templateJava) &&
      path.resolve(srcJava) !== path.resolve(dstJava)
    ) {
      rmRecursive(srcJava);
    }
    console.log("[mobile-build] Overlaid Android Java sources.");
  }
  const templateElizaVoiceJni = path.join(
    platformsDir,
    "android",
    "app",
    "src",
    "main",
    "elizavoice-jni",
  );
  const targetElizaVoiceJni = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "elizavoice-jni",
  );
  if (
    fs.existsSync(templateElizaVoiceJni) &&
    path.resolve(templateElizaVoiceJni) !== path.resolve(targetElizaVoiceJni)
  ) {
    rmRecursive(targetElizaVoiceJni);
    fs.cpSync(templateElizaVoiceJni, targetElizaVoiceJni, { recursive: true });
    console.log("[mobile-build] Overlaid Android elizavoice JNI sources.");
  }

  // Merge AndroidManifest.xml
  restoreAndroidManifestFromPlatformTemplateIfMissing();
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

    const withLocalCleartext = applyAndroidCleartextPolicy(xml, {
      allowCleartext: true,
    });
    if (withLocalCleartext !== xml) {
      xml = withLocalCleartext;
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
    const withElizaOsActivityFilters = ensureElizaOsActivityFilters(xml, {
      enabled: includeAospRoleLaunchers,
    });
    if (withElizaOsActivityFilters !== xml) {
      xml = withElizaOsActivityFilters;
      dirty = true;
    }
    const withUrlSchemeFilter = ensureAndroidMainActivityUrlSchemeFilter(xml, {
      urlScheme: APP.urlScheme,
    });
    if (withUrlSchemeFilter !== xml) {
      xml = withUrlSchemeFilter;
      dirty = true;
    }
    const withShortcutsMetadata =
      ensureAndroidMainActivityShortcutsMetadata(xml);
    if (withShortcutsMetadata !== xml) {
      xml = withShortcutsMetadata;
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
      "ElizaQuickActionsWidgetProvider",
      "ElizaShareActivity",
      "ElizaVoiceTileService",
      "ElizaAccessibilityService",
      "ElizaInCallService",
      "ElizaNotificationListenerService",
      "ElizaSmsReceiver",
      "ElizaMmsReceiver",
      "ElizaSmsGatewayService",
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
      "ElizaQuickActionsWidgetProvider",
      "ElizaShareActivity",
      "ElizaVoiceTileService",
      "ElizaAccessibilityService",
      "ElizaInCallService",
      "ElizaNotificationListenerService",
      "ElizaSmsReceiver",
      "ElizaMmsReceiver",
      "ElizaSmsGatewayService",
      "ElizaRespondViaMessageService",
      "ElizaSmsComposeActivity",
      "ElizaBootReceiver",
      "ElizaBrowserActivity",
      "ElizaContactsActivity",
      "ElizaCameraActivity",
      "ElizaClockActivity",
      "ElizaCalendarActivity",
      "ElizaDialActivity",
      "ElizaAssistActivity",
      "ElizaInCallService",
      "ElizaSmsReceiver",
      "ElizaMmsReceiver",
      "ElizaRespondViaMessageService",
      "ElizaSmsComposeActivity",
      "ElizaBootReceiver",
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
            <intent-filter>
                <action android:name="android.intent.action.VOICE_COMMAND" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaShareActivity`,
      `
        <activity
            android:name="${androidPackage}.ElizaShareActivity"
            android:exported="true"
            android:label="@string/app_action_smart_reply_long"
            android:theme="@style/AppTheme.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.PROCESS_TEXT" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
            </intent-filter>
        </activity>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaVoiceTileService`,
      `
        <service
            android:name="${androidPackage}.ElizaVoiceTileService"
            android:exported="true"
            android:icon="@mipmap/ic_launcher_monochrome"
            android:label="@string/app_action_voice_long"
            android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
            <intent-filter>
                <action android:name="android.service.quicksettings.action.QS_TILE" />
            </intent-filter>
            <meta-data
                android:name="android.service.quicksettings.TOGGLEABLE_TILE"
                android:value="false" />
        </service>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaQuickActionsWidgetProvider`,
      `
        <receiver
            android:name="${androidPackage}.ElizaQuickActionsWidgetProvider"
            android:exported="true">
            <intent-filter>
                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
            </intent-filter>
            <meta-data
                android:name="android.appwidget.provider"
                android:resource="@xml/eliza_quick_actions_widget" />
        </receiver>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaAccessibilityService`,
      `
        <service
            android:name="${androidPackage}.ElizaAccessibilityService"
            android:exported="true"
            android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
            <intent-filter>
                <action android:name="android.accessibilityservice.AccessibilityService" />
            </intent-filter>
            <meta-data
                android:name="android.accessibilityservice"
                android:resource="@xml/eliza_accessibility_service" />
        </service>`,
    );
    xml = appendMissingApplicationBlock(
      xml,
      `${androidPackage}.ElizaNotificationListenerService`,
      `
        <service
            android:name="${androidPackage}.ElizaNotificationListenerService"
            android:exported="true"
            android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
            <intent-filter>
                <action android:name="android.service.notification.NotificationListenerService" />
            </intent-filter>
        </service>`,
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
      `${androidPackage}.ElizaSmsGatewayService`,
      `
        <service
            android:name="${androidPackage}.ElizaSmsGatewayService"
            android:exported="false" />`,
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
            android:theme="@style/AppTheme.NoActionBar">${androidAospRoleLauncherIntentFilter(
              {
                enabled: includeAospRoleLaunchers,
                category: "android.intent.category.APP_CONTACTS",
              },
            )}
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
            android:theme="@style/AppTheme.NoActionBar">${androidAospRoleLauncherIntentFilter(
              {
                enabled: includeAospRoleLaunchers,
              },
            )}
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
            android:theme="@style/AppTheme.NoActionBar">${androidAospRoleLauncherIntentFilter(
              {
                enabled: includeAospRoleLaunchers,
              },
            )}
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
            android:theme="@style/AppTheme.NoActionBar">${androidAospRoleLauncherIntentFilter(
              {
                enabled: includeAospRoleLaunchers,
                category: "android.intent.category.APP_CALENDAR",
              },
            )}
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

function overlayIos() {
  const targetAppDir = path.join(appDir, "ios", "App", "App");

  // Merge Info.plist permission strings
  const plistPath = path.join(targetAppDir, "Info.plist");
  if (fs.existsSync(plistPath)) {
    let plist = fs.readFileSync(plistPath, "utf8");
    let dirty = false;
    // UIBackgroundModes and BGTaskSchedulerPermittedIdentifiers are MERGED,
    // not force-set: the template Info.plist already declares the modes the
    // ElizaTasks plugin needs (`processing`, `remote-notification`) and the
    // BGTaskScheduler identifiers (`ai.eliza.tasks.refresh`,
    // `ai.eliza.tasks.processing`). The overlay only guarantees the baseline
    // `fetch` mode is present and that the ElizaTasks identifiers survive a
    // regeneration where a downstream embedder forgot to copy them.
    const nextPlist = mergeIosInfoPlist(plist, {
      appName: APP.appName,
      urlScheme: APP.urlScheme,
    });
    if (nextPlist.changed) {
      plist = nextPlist.content;
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
    if (shouldDisableIosPrivilegedCapabilities()) {
      ent = IOS_PERSONAL_TEAM_ENTITLEMENTS;
    } else {
      ent = replaceIosAppGroupPlaceholders(ent, `group.${APP.appId}`);
    }
    fs.writeFileSync(path.join(targetAppDir, "App.entitlements"), ent, "utf8");
    if (shouldDisableIosPrivilegedCapabilities()) {
      console.log("[mobile-build] Copied minimal iOS entitlements.");
    } else {
      console.log(
        `[mobile-build] Copied iOS entitlements (app group: group.${APP.appId}).`,
      );
    }
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

function resolveIosBuildConfiguration(env = process.env) {
  const value = String(env.ELIZA_IOS_BUILD_CONFIGURATION ?? "Debug").trim();
  if (value === "Debug" || value === "Release") return value;
  throw new Error(
    `ELIZA_IOS_BUILD_CONFIGURATION must be Debug or Release, got ${value}`,
  );
}

function isFullIosBunEngineRequested(env = process.env) {
  return isTruthyEnv(env.ELIZA_IOS_FULL_BUN_ENGINE);
}

function isIosAppStoreLocalRuntimeEnabled(env = process.env) {
  return !/^(0|false|no|off)$/i.test(
    String(env.ELIZA_IOS_APP_STORE_LOCAL_RUNTIME ?? "1").trim(),
  );
}

function isIosLlamaRequested(env = process.env) {
  return isTruthyEnv(env.ELIZA_IOS_INCLUDE_LLAMA);
}

function shouldIncludeIosLlama(env = process.env) {
  return !isIosAppStoreBuild(env) && isIosLlamaRequested(env);
}

function shouldUseIosFusedLocalInference(env = process.env) {
  return (
    shouldIncludeIosLlama(env) &&
    (isTruthyEnv(env.ELIZA_IOS_FUSED_LOCAL_INFERENCE) ||
      isTruthyEnv(env.ELIZA_IOS_REQUIRE_LOCAL_MODELS))
  );
}

function shouldCleanIosBuildProducts(env = process.env) {
  return (
    isTruthyEnv(env.ELIZA_IOS_CLEAN_BUILD_PRODUCTS) ||
    shouldDisableIosPrivilegedCapabilities(env)
  );
}

function shouldSkipIosCapacitorSync(env = process.env) {
  return isTruthyEnv(env.ELIZA_IOS_SKIP_CAPACITOR_SYNC);
}

function shouldSkipIosPodInstall(env = process.env) {
  return isTruthyEnv(env.ELIZA_IOS_SKIP_POD_INSTALL);
}

// An iOS build ships the on-device no-JIT Bun engine (and thus a real local
// agent) when it is explicitly requested, OR when it is a store/App Store build
// with the local runtime left enabled (the default). App Store builds are
// cloud-hybrid: they keep the App Store-safe local runtime unless an operator
// opts into a cloud-only thin client via ELIZA_IOS_APP_STORE_LOCAL_RUNTIME=0.
// Exported so the release preflight + tests share one definition of "will the
// shipped IPA actually contain a local agent runtime".
export function shouldIncludeIosFullBunEngine(env = process.env) {
  return (
    isFullIosBunEngineRequested(env) ||
    (isIosAppStoreBuild(env) && isIosAppStoreLocalRuntimeEnabled(env))
  );
}

export function isIosAppStoreBuild(env = process.env) {
  return (
    env.ELIZA_RELEASE_AUTHORITY === "apple-app-store" ||
    env.ELIZA_BUILD_VARIANT?.toLowerCase() === "store"
  );
}

function resolveIosDeploymentTarget(env = process.env) {
  return shouldIncludeIosFullBunEngine(env)
    ? IOS_FULL_BUN_DEPLOYMENT_TARGET
    : IOS_DEFAULT_DEPLOYMENT_TARGET;
}

function isIosSimulatorBuildTarget(buildTarget) {
  return (
    buildTarget?.sdk === "iphonesimulator" ||
    /\bSimulator\b/i.test(buildTarget?.destination ?? "")
  );
}

function shouldEnforceIosBunEngineAppStoreRuntime(buildTarget) {
  return (
    !isIosSimulatorBuildTarget(buildTarget) ||
    isTruthyEnv(process.env.ELIZA_BUN_IOS_STRICT_APP_STORE_RUNTIME) ||
    isTruthyEnv(process.env.ELIZA_IOS_STRICT_APP_STORE_RUNTIME)
  );
}

function ensureIosCapacitorPluginClass(pluginClass) {
  const configPath = path.join(
    appDir,
    "ios",
    "App",
    "App",
    "capacitor.config.json",
  );
  if (!fs.existsSync(configPath)) return;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `[mobile-build] Failed to parse iOS capacitor.config.json: ${error.message}`,
    );
  }

  const classList = Array.isArray(parsed.packageClassList)
    ? parsed.packageClassList
    : [];
  if (classList.includes(pluginClass)) return;

  parsed.packageClassList = [...classList, pluginClass];
  fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, "\t")}\n`);
  console.log(`[mobile-build] Registered iOS Capacitor plugin ${pluginClass}.`);
}

export function prepareIosOverlay({ buildTarget = null } = {}) {
  const syncedFiles = syncPlatformTemplateFiles("ios");
  overlayIos();
  if (
    shouldIncludeIosFullBunEngine() ||
    process.env.ELIZA_IOS_RUNTIME_MODE === "local"
  ) {
    ensureIosCapacitorPluginClass("ElizaBunRuntimePlugin");
  }
  stripSpmIncompatiblePlugins();
  const includeLlama = shouldIncludeIosLlama();
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

  // LlamaCppCapacitor ships an on-device llama.cpp xcframework. The App Store
  // target ships the no-JIT Bun runtime by default, but still omits llama.cpp
  // unless explicitly requested because it is a separate native model backend.
  const includeLlama = shouldIncludeIosLlama();
  const appStoreBuild = isIosAppStoreBuild();
  const includeFullBunEngine = shouldIncludeIosFullBunEngine();
  const includeCompatBunRuntime =
    !includeFullBunEngine && process.env.ELIZA_IOS_RUNTIME_MODE === "local";
  const includeMobileAgentBridge =
    !appStoreBuild &&
    isTruthyEnv(process.env.ELIZA_IOS_INCLUDE_MOBILE_AGENT_BRIDGE);
  const customPods = resolveIosCustomPods({
    includeLlama,
    includeCompatBunRuntime,
    includeFullBunEngine,
    appStoreBuild,
    includeMobileAgentBridge,
  });
  if (!includeLlama) {
    console.log(
      "[mobile-build] iOS Podfile: omitting llama.cpp pod (ELIZA_IOS_INCLUDE_LLAMA not set)",
    );
  }
  if (includeCompatBunRuntime && !includeFullBunEngine) {
    console.log(
      "[mobile-build] iOS Podfile: including JSContext compatibility runtime pod",
    );
  } else if (includeFullBunEngine) {
    console.log("[mobile-build] iOS Podfile: requiring no-JIT Bun engine pod");
  }
  if (appStoreBuild) {
    console.log(
      "[mobile-build] iOS Podfile: App Store build keeps local Bun runtime and omits mobile-agent tunnel bridge",
    );
  }
  const deploymentTarget = resolveIosDeploymentTarget();
  if (includeFullBunEngine) {
    console.log(
      `[mobile-build] iOS full Bun deployment target: ${deploymentTarget}`,
    );
  }
  const useFrameworksLine = includeLlama
    ? "use_frameworks! :linkage => :static"
    : "use_frameworks!";

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

platform :ios, '${deploymentTarget}'
${useFrameworksLine}

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
    "distributionUrl=https\\://services.gradle.org/distributions/gradle-9.5.0-all.zip",
  );
  if (patched !== current) {
    fs.writeFileSync(wrapperPath, patched, "utf8");
    console.log("[mobile-build] Patched Android Gradle wrapper for AGP 9.");
  }
}

function ensureGradleProperty(content, key, value) {
  const re = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
  if (re.test(content)) return content.replace(re, `${key}=${value}`);
  return `${content.replace(/\s*$/, "")}\n${key}=${value}\n`;
}

function patchAndroidGradleProperties() {
  const propertiesPath = path.join(androidDir, "gradle.properties");
  if (!fs.existsSync(propertiesPath)) return;
  const current = fs.readFileSync(propertiesPath, "utf8");
  let patched = current;
  patched = patched.replace(
    /^android\.enableDexingArtifactTransform\.desugaring=.*\n?/m,
    "",
  );
  // Keep dexing on a full classpath to avoid fragile per-artifact transform
  // cache failures in generated local mobile builds.
  patched = ensureGradleProperty(
    patched,
    "android.useFullClasspathForDexingTransform",
    "true",
  );
  if (patched !== current) {
    fs.writeFileSync(propertiesPath, patched, "utf8");
    console.log("[mobile-build] Patched Android Gradle properties.");
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
  assertSharedTreeOnlyForEliza("patch gradle identity");
  patchAndroidGradleWrapperForReleaseCompat();
  patchAndroidGradleProperties();
  patchInstalledLlamaCapacitorBuildGradle();
  syncAndroidAppActionsResources();
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
  // Refresh app/build.gradle from the template every build so committed
  // template changes (e.g. the elizavoice-jni symbol gate) reach a white-label
  // android project. The initial template sync only runs when the project is
  // first materialized, so an existing apps/app/android would otherwise keep a
  // stale build.gradle across incremental builds. For the in-tree build the
  // template IS the target (same path) — skip so we don't self-copy.
  const templateAppGradle = path.join(
    platformsDir,
    "android",
    "app",
    "build.gradle",
  );
  if (
    fs.existsSync(templateAppGradle) &&
    path.resolve(templateAppGradle) !== path.resolve(appGradlePath)
  ) {
    const templateAppGradleContent = fs.readFileSync(templateAppGradle, "utf8");
    const currentAppGradle = fs.existsSync(appGradlePath)
      ? fs.readFileSync(appGradlePath, "utf8")
      : null;
    if (currentAppGradle !== templateAppGradleContent) {
      fs.mkdirSync(path.dirname(appGradlePath), { recursive: true });
      fs.writeFileSync(appGradlePath, templateAppGradleContent, "utf8");
      console.log("[mobile-build] Refreshed app/build.gradle from template.");
    }
  }
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
    patched = injectAndroidSmsGatewayBuildConfigFields(patched);
    patched = injectNoCompressTarGz(patched);
    patched = injectNativeLibLegacyPackaging(patched);
    patched = injectAospAssetThinning(patched);
    patched = injectCopyForkLlamaLibTask(patched);
    patched = injectAndroidBackgroundRunnerAarFlatDir(patched);
    // The template resolves `elizaRepoRoot` for the omnivoice FFI headers via a
    // relative `../../../..` walk from the gradle project dir. That only lands
    // on the eliza checkout when the android project is nested inside it (the
    // in-tree app-core/platforms/android build), where the relative form is
    // correct and portable — leave it alone. A white-label app builds in its
    // own android dir (appDir/android) OUTSIDE the checkout, so the same walk
    // overshoots the repo root (→ /home/.../plugins, header not found). Only
    // there do we pin it to the absolute checkout root this script resolved, so
    // we never rewrite the committed template with a machine-specific path.
    if (androidUsesAppDir) {
      patched = patched.replace(
        /def elizaRepoRoot = .*/,
        () =>
          `def elizaRepoRoot = new File(${JSON.stringify(elizaRepoRoot).replace(/\$/g, "\\$")})`,
      );
    }
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
  stageBackgroundRunnerAndroidJsEngineAar();

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
  const activeJava = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    packageNameToPath(APP.appId),
  );
  if (fs.existsSync(srcJava) || fs.existsSync(activeJava)) return;

  restoreAndroidManifestFromPlatformTemplateIfMissing();
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
    "ElizaVoiceInteractionService",
    "ElizaVoiceInteractionSessionService",
    "ElizaRecognitionService",
    "ElizaVoiceInputMethodService",
    "ElizaQuickActionsWidgetProvider",
    "ElizaShareActivity",
    "ElizaVoiceTileService",
    "ElizaInCallService",
    "ElizaSmsReceiver",
    "ElizaMmsReceiver",
    "ElizaSmsGatewayService",
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

// Opaque app-icon background on iOS and the Android adaptive-icon background
// color. Resolved per-brand from app.config.ts (web.iconBackgroundColor) by
// readAppIdentity so each whitelabel ships its own brand color; defaults to the
// upstream elizaOS accent when the field is absent.
const BRAND_ICON_BACKGROUND = APP.iconBackgroundColor;

const ANDROID_LAUNCHER_ICON_SIZES = {
  "mipmap-mdpi": 48,
  "mipmap-hdpi": 72,
  "mipmap-xhdpi": 96,
  "mipmap-xxhdpi": 144,
  "mipmap-xxxhdpi": 192,
};

// Adaptive-icon foreground + monochrome layers are authored on the standard
// 108dp canvas (scaled per density). Both layers use the same square sizes.
const ANDROID_ADAPTIVE_ICON_SIZES = {
  "mipmap-mdpi": 108,
  "mipmap-hdpi": 162,
  "mipmap-xhdpi": 216,
  "mipmap-xxhdpi": 324,
  "mipmap-xxxhdpi": 432,
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
    const sips =
      process.platform === "darwin" ? resolveExecutable("sips") : null;
    if (sips) {
      console.warn(
        `[mobile-build] sharp is unavailable for ${platform} brand assets; using macOS sips fallback.`,
      );
      return { kind: "sips", sips };
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

  if (tool.kind === "sips") {
    await run(tool.sips, [
      "--resampleHeightWidth",
      String(height),
      String(width),
      source,
      "--out",
      output,
    ]);
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

// Render the transparent icon mark centered in a square canvas, sized to the
// adaptive-icon safe zone (~66%). Used for both the adaptive foreground and
// the themed monochrome layer. `canvas` is the exact output pixel size.
async function writeAndroidForegroundPng(tool, source, output, canvas) {
  const art = Math.round(canvas * 0.66);
  if (tool.kind === "sharp") {
    const mark = await tool
      .sharp(source)
      .resize(art, art, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    await tool
      .sharp({
        create: {
          width: canvas,
          height: canvas,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
      .composite([{ input: mark, gravity: "center" }])
      .png()
      .toFile(output);
    return;
  }

  if (tool.kind === "sips") {
    await writeCoverPng(tool, source, output, canvas, canvas);
    return;
  }

  await run(tool.magick, [
    source,
    "-resize",
    `${art}x${art}`,
    "-background",
    "none",
    "-gravity",
    "center",
    "-extent",
    `${canvas}x${canvas}`,
    output,
  ]);
}

function resolveBrandSources() {
  return {
    // The icon mark is a transparent-background face chosen to contrast with
    // BRAND_ICON_BACKGROUND, so iOS can flatten it onto that color and Android
    // can drop it into the adaptive foreground/monochrome safe zone. The web
    // favicons share the accent hue, which would vanish when flattened onto it,
    // so the dedicated brand/app-icon.png master (authored for contrast against
    // the brand color) is preferred.
    iconSource: firstExisting([
      path.join(appDir, "public", "brand", "app-icon.png"),
      path.join(appDir, "public", "brand", "logos", "logo_white_nobg.svg"),
      path.join(appDir, "public", "android-chrome-512x512.png"),
      path.join(appDir, "public", "apple-touch-icon.png"),
      path.join(appDir, "public", "favicon-256x256.png"),
    ]),
    launchSource: firstExisting([
      path.join(appDir, "public", "launch-bg.png"),
      path.join(appDir, "public", "launch-bg.jpg"),
    ]),
  };
}

async function generateIosBrandAssets() {
  const assetDir = path.join(iosDir, "App", "Assets.xcassets");
  if (!fs.existsSync(assetDir)) return;

  const { iconSource, launchSource } = resolveBrandSources();
  if (!iconSource && !launchSource) return;

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
          { flattenBackground: BRAND_ICON_BACKGROUND },
        );
      }
    }
  }

  if (launchSource) {
    const splashSetDir = path.join(assetDir, "Splash.imageset");
    const contentsPath = path.join(splashSetDir, "Contents.json");
    if (fs.existsSync(contentsPath)) {
      const contents = JSON.parse(fs.readFileSync(contentsPath, "utf8"));
      for (const image of contents.images ?? []) {
        if (!image.filename) continue;
        await writeCoverPng(
          imageTool,
          launchSource,
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
  assertSharedTreeOnlyForEliza("write brand icons");
  const resDir = path.join(androidDir, "app", "src", "main", "res");
  if (!fs.existsSync(resDir)) return;

  const { iconSource, launchSource } = resolveBrandSources();
  if (!iconSource && !launchSource) return;

  const imageTool = await loadImageToolForBrandAssets("Android");

  if (iconSource) {
    for (const [dir, size] of Object.entries(ANDROID_LAUNCHER_ICON_SIZES)) {
      const out = path.join(resDir, dir);
      fs.mkdirSync(out, { recursive: true });
      // Legacy (pre-adaptive) launcher icons are opaque squares, so flatten
      // the transparent mark onto the brand background.
      await writeCoverPng(
        imageTool,
        iconSource,
        path.join(out, "ic_launcher.png"),
        size,
        size,
        { flattenBackground: BRAND_ICON_BACKGROUND },
      );
      await writeCoverPng(
        imageTool,
        iconSource,
        path.join(out, "ic_launcher_round.png"),
        size,
        size,
        { flattenBackground: BRAND_ICON_BACKGROUND },
      );
      // Adaptive foreground + themed monochrome both sit on the system
      // background (the brand color below), so they stay transparent.
      const adaptiveCanvas = ANDROID_ADAPTIVE_ICON_SIZES[dir] ?? size;
      await writeAndroidForegroundPng(
        imageTool,
        iconSource,
        path.join(out, "ic_launcher_foreground.png"),
        adaptiveCanvas,
      );
      await writeAndroidForegroundPng(
        imageTool,
        iconSource,
        path.join(out, "ic_launcher_monochrome.png"),
        adaptiveCanvas,
      );
    }
    // Adaptive-icon background color must match the brand accent. This is a
    // static resource Capacitor never regenerates, so write it here to keep
    // it from drifting back to a stale value.
    const valuesDir = path.join(resDir, "values");
    fs.mkdirSync(valuesDir, { recursive: true });
    fs.writeFileSync(
      path.join(valuesDir, "ic_launcher_background.xml"),
      `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BRAND_ICON_BACKGROUND}</color>\n</resources>\n`,
      "utf8",
    );
  }

  if (launchSource) {
    for (const [dir, [width, height]] of Object.entries(ANDROID_SPLASH_SIZES)) {
      const out = path.join(resDir, dir);
      fs.mkdirSync(out, { recursive: true });
      await writeCoverPng(
        imageTool,
        launchSource,
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
  if (fs.existsSync(podspecPath)) {
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

  const llamaPodspecPath = path.join(packageDir, "LlamaCpp.podspec");
  if (fs.existsSync(llamaPodspecPath)) {
    const current = fs.readFileSync(llamaPodspecPath, "utf8");
    let patched = current.replace(
      /^\s*s\.source_files\s*=.*$/m,
      "  s.source_files = []",
    );
    patched = patched.replace(
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
    if (patched !== current) {
      fs.writeFileSync(llamaPodspecPath, patched, "utf8");
      console.log(
        "[mobile-build] Patched LlamaCpp podspec for eliza-built xcframework.",
      );
    }
  }
}

// Wave-4-F (iOS pipeline rewire): the iOS LlamaCpp.xcframework is now
// produced by `build-llama-cpp-mtp.mjs --target ios-arm64-metal` +
// `--target ios-arm64-simulator-metal` and assembled by
// `ios-xcframework/build-xcframework.mjs --verify`. The previous in-process
// cmake invocation that built `llama-cpp-capacitor`'s bundled `ios/`
// source produced a STOCK llama.cpp framework with none of the eliza
// kernels (TurboQuant / QJL / PolarQuant / MTP) and silently violated
// AGENTS.md §3 on every iOS build. Delegating to the mtp builder
// ensures the same kernel-set lands on iOS as on darwin/linux/android.
//
// AGENTS.md §3 enforcement: build-llama-cpp-mtp.mjs hard-throws on
// missing kernels via writeCapabilities()/requiredKernelsMissing(); the
// xcframework packaging --verify step additionally greps the static
// archives for AGENTS.md §3 kernel symbols. Either failure aborts the
// iOS build before the npm-bundled stock framework can be linked.
const MTP_BUILD_SCRIPT = path.resolve(__dirname, "build-llama-cpp-mtp.mjs");
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

function mtpTargetOutDir(target) {
  return path.join(
    elizaStateDirForBuild(),
    "local-inference",
    "bin",
    "mtp",
    target,
  );
}

function resolveMtpForkSrc() {
  for (const candidate of MTP_FORK_SRC_CANDIDATES) {
    if (fs.existsSync(path.join(candidate, "CMakeLists.txt"))) return candidate;
  }
  return null;
}

/** `git describe --always --dirty` of the fork, or null when git/desc fails. */
function currentMtpForkRevision(forkSrc) {
  if (!forkSrc) return null;
  const result = spawnSync(
    "git",
    ["-C", forkSrc, "describe", "--always", "--dirty"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  return result.stdout?.trim() || null;
}

async function ensureMtpIosTarget(target) {
  const outDir = mtpTargetOutDir(target);
  const capabilities = path.join(outDir, "CAPABILITIES.json");
  const forkSrc = resolveMtpForkSrc();
  const reuse = mtpSliceReuse(
    capabilities,
    forkSrc,
    currentMtpForkRevision(forkSrc),
  );
  const forceRebuild = mtpForceRebuildRequested(reuse, process.env);
  if (!forceRebuild) {
    console.log(
      `[mobile-build] Reusing fresh mtp artifact for ${target} at ${outDir}`,
    );
    return outDir;
  }
  if (fs.existsSync(capabilities)) {
    console.log(
      `[mobile-build] Rebuilding mtp artifact for ${target} — ${process.env.ELIZA_IOS_REBUILD_MTP === "1" ? "ELIZA_IOS_REBUILD_MTP=1" : reuse.reason}`,
    );
  } else {
    console.log(`[mobile-build] Building mtp artifact for ${target}`);
  }
  // The child builder (build-llama-cpp-mtp.mjs) has its OWN presence-only reuse
  // gate keyed on ELIZA_MTP_FORCE_REBUILD. Without propagating it, the child
  // would see the stale CAPABILITIES.json and reuse it — turning this staleness
  // gate into a no-op. Force the child to actually rebuild (#9309).
  await run("node", [MTP_BUILD_SCRIPT, "--target", target], {
    env: { ...process.env, ELIZA_MTP_FORCE_REBUILD: "1" },
  });
  if (!fs.existsSync(capabilities)) {
    throw new Error(
      `[mobile-build] mtp build for ${target} did not produce CAPABILITIES.json at ${capabilities}. ` +
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
  const includeLlama = shouldIncludeIosLlama();
  if (!includeLlama) return;

  if (process.platform !== "darwin") {
    throw new Error(
      "[mobile-build] iOS llama.cpp xcframework build requires a macOS host with Xcode. " +
        "Either run on macOS or unset ELIZA_IOS_INCLUDE_LLAMA.",
    );
  }

  const packageDir = resolvePackageAbsolutePath("llama-cpp-capacitor");
  if (!packageDir) {
    throw new Error(
      "[mobile-build] llama-cpp-capacitor package not found in node_modules; " +
        "either install it or unset ELIZA_IOS_INCLUDE_LLAMA.",
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

  // Build (or reuse) both per-platform slices via the mtp builder so
  // the iOS xcframework carries the same eliza kernel set as every
  // other supported backend. Per AGENTS.md §3, missing kernels here are
  // a hard error: build-llama-cpp-mtp.mjs already enforces that and
  // throws via writeCapabilities() before producing CAPABILITIES.json.
  const useFusedLocalInference = shouldUseIosFusedLocalInference();
  const deviceTarget = useFusedLocalInference
    ? "ios-arm64-metal-fused"
    : "ios-arm64-metal";
  const simulatorTarget = useFusedLocalInference
    ? "ios-arm64-simulator-metal-fused"
    : "ios-arm64-simulator-metal";
  if (useFusedLocalInference) {
    console.log(
      "[mobile-build] Using fused iOS local-inference slices for bundled local models",
    );
  }
  await ensureMtpIosTarget(deviceTarget);
  await ensureMtpIosTarget(simulatorTarget);

  fs.mkdirSync(xcframeworksDir, { recursive: true });
  rmRecursive(xcframeworkDir);
  await run("node", [
    IOS_XCFRAMEWORK_BUILD_SCRIPT,
    "--output",
    xcframeworkDir,
    "--device-archive-dir",
    mtpTargetOutDir(deviceTarget),
    "--sim-archive-dir",
    mtpTargetOutDir(simulatorTarget),
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
    rmRecursive(archived);
    fs.renameSync(stale, archived);
    console.log(
      `[mobile-build] Archived stock npm framework: ${stale} -> ${archived} ` +
        `(stock build has no Eliza-1 kernels — see AGENTS.md §3).`,
    );
  }
  console.log(
    "[mobile-build] iOS LlamaCpp.xcframework wired to eliza-built kernels (device + simulator slices).",
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

  if (isIosAppStoreBuild(env)) {
    return {
      destination: "generic/platform=iOS",
      sdk: "iphoneos",
      reason: "App Store device build",
    };
  }

  const includeDeviceOnlyLlama = shouldIncludeIosLlama(env);
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

function resolveIosFullBunEngineXcframework({ buildTarget = null } = {}) {
  const candidates = [
    process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK,
    defaultIosBunEngineXcframework,
    path.join(
      iosBunRuntimePackageRoot,
      "build",
      isIosSimulatorBuildTarget(buildTarget) ? "simulator" : "device",
      `${IOS_BUN_ENGINE_FRAMEWORK_NAME}.xcframework`,
    ),
  ].filter(Boolean);
  const existing = candidates.filter((candidate) => fs.existsSync(candidate));
  if (process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK) {
    return existing[0] ?? null;
  }
  return (
    existing.find((candidate) =>
      xcframeworkContainsIosBunEngineLibrary(candidate, { buildTarget }),
    ) ??
    existing[0] ??
    null
  );
}

function xcframeworkContainsIosBunEngineLibrary(
  xcframework,
  { buildTarget = null } = {},
) {
  try {
    resolveIosBunEngineLibrary(xcframework, { buildTarget });
    return true;
  } catch {
    return false;
  }
}

function parsePlistJson(plistPath) {
  const result = runCaptureSync("plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    plistPath,
  ]);
  if (result.status !== 0) {
    const reason =
      result.stderr?.trim() ||
      result.error?.message ||
      `exit status ${String(result.status)}`;
    throw new Error(
      `[mobile-build] failed to parse ${plistPath} with plutil: ${reason}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `[mobile-build] malformed JSON from plutil for ${plistPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function resolveIosBunEngineLibrary(xcframework, { buildTarget = null } = {}) {
  const infoPlist = path.join(xcframework, "Info.plist");
  if (!fs.existsSync(infoPlist)) {
    throw new Error(
      `[mobile-build] ${IOS_BUN_ENGINE_FRAMEWORK_NAME}.xcframework is missing Info.plist: ${xcframework}`,
    );
  }
  const info = parsePlistJson(infoPlist);
  const libraries = Array.isArray(info.AvailableLibraries)
    ? info.AvailableLibraries
    : [];
  const wantSimulator = isIosSimulatorBuildTarget(buildTarget);
  const library = libraries.find((entry) => {
    if (entry?.SupportedPlatform !== "ios") return false;
    const variant = entry.SupportedPlatformVariant;
    return wantSimulator ? variant === "simulator" : !variant;
  });
  if (!library?.LibraryIdentifier) {
    const requested = wantSimulator ? "iOS Simulator" : "iOS device";
    const available = libraries
      .map(
        (entry) =>
          `${entry?.SupportedPlatform ?? "unknown"}${
            entry?.SupportedPlatformVariant
              ? `-${entry.SupportedPlatformVariant}`
              : ""
          }/${entry?.LibraryIdentifier ?? "missing-id"}`,
      )
      .join(", ");
    throw new Error(
      `[mobile-build] ${xcframework} does not contain a ${requested} ${IOS_BUN_ENGINE_FRAMEWORK_NAME} library. Available: ${available || "none"}`,
    );
  }
  const libraryRoot = path.join(xcframework, library.LibraryIdentifier);
  const frameworkRelPath =
    typeof library.LibraryPath === "string"
      ? library.LibraryPath
      : `${IOS_BUN_ENGINE_FRAMEWORK_NAME}.framework`;
  const frameworkDir = path.join(libraryRoot, frameworkRelPath);
  const binary = path.join(frameworkDir, IOS_BUN_ENGINE_FRAMEWORK_NAME);
  if (!fs.existsSync(binary)) {
    throw new Error(
      `[mobile-build] ${xcframework} selected ${library.LibraryIdentifier}, but ${binary} was not found`,
    );
  }
  return { binary, frameworkDir, libraryIdentifier: library.LibraryIdentifier };
}

function validateIosBunEngineSymbols(binary) {
  const result = runCaptureSync("nm", ["-gU", binary], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const reason =
      result.stderr?.trim() ||
      result.error?.message ||
      `exit status ${String(result.status)}`;
    throw new Error(
      `[mobile-build] failed to inspect ${binary} with nm: ${reason}`,
    );
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const missing = IOS_BUN_ENGINE_REQUIRED_SYMBOLS.filter(
    (symbol) => !output.includes(symbol),
  );
  if (missing.length > 0) {
    throw new Error(
      `[mobile-build] ${binary} is missing required full-Bun ABI symbols: ${missing.join(", ")}`,
    );
  }
}

function validateIosBunEngineNoJitDynamicCode(
  binary,
  { buildTarget = null } = {},
) {
  const imports = runCaptureSync("nm", ["-u", binary], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (imports.status !== 0) {
    const reason =
      imports.stderr?.trim() ||
      imports.error?.message ||
      `exit status ${String(imports.status)}`;
    throw new Error(
      `[mobile-build] failed to inspect ${binary} imports with nm: ${reason}`,
    );
  }
  const importedSymbols = `${imports.stdout}\n${imports.stderr}`;
  const importGroups = findForbiddenRuntimeImportGroups(importedSymbols);
  if (importGroups.length > 0) {
    const message = formatForbiddenRuntimeFindings({
      binary,
      importGroups,
    });
    if (shouldEnforceIosBunEngineAppStoreRuntime(buildTarget)) {
      throw new Error(message);
    }
    console.warn(
      `${message}. Continuing for iOS Simulator; device/App Store full-Bun builds remain strict.`,
    );
  }

  const strings = runCaptureSync("strings", ["-a", binary], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (strings.status !== 0) {
    const reason =
      strings.stderr?.trim() ||
      strings.error?.message ||
      `exit status ${String(strings.status)}`;
    throw new Error(
      `[mobile-build] failed to inspect ${binary} strings: ${reason}`,
    );
  }
  const binaryStrings = `${strings.stdout}\n${strings.stderr}`;
  const stringPatterns = findForbiddenRuntimeStrings(binaryStrings);
  if (stringPatterns.length > 0) {
    const message = formatForbiddenRuntimeFindings({
      binary,
      stringPatterns,
    });
    if (shouldEnforceIosBunEngineAppStoreRuntime(buildTarget)) {
      throw new Error(message);
    }
    console.warn(
      `${message}. Continuing for iOS Simulator; device/App Store full-Bun builds remain strict.`,
    );
  }
}

function validateIosFullBunEngineXcframework(
  xcframework,
  { buildTarget = null } = {},
) {
  const { binary, frameworkDir, libraryIdentifier } =
    resolveIosBunEngineLibrary(xcframework, { buildTarget });
  const frameworkInfoPlist = path.join(frameworkDir, "Info.plist");
  if (!fs.existsSync(frameworkInfoPlist)) {
    throw new Error(
      `[mobile-build] ${frameworkDir} is missing Info.plist; cannot verify full-Bun ABI metadata`,
    );
  }
  const frameworkInfo = parsePlistJson(frameworkInfoPlist);
  if (
    String(frameworkInfo.ElizaBunEngineABIVersion ?? "") !==
    IOS_BUN_ENGINE_ABI_VERSION
  ) {
    throw new Error(
      `[mobile-build] ${frameworkInfoPlist} has ElizaBunEngineABIVersion=${String(
        frameworkInfo.ElizaBunEngineABIVersion,
      )}; expected ${IOS_BUN_ENGINE_ABI_VERSION}`,
    );
  }
  if (frameworkInfo.ElizaBunEngineNoJIT !== true) {
    throw new Error(
      `[mobile-build] ${frameworkInfoPlist} must declare ElizaBunEngineNoJIT=true`,
    );
  }
  if (
    frameworkInfo.ElizaBunEngineExecutionProfile !==
    IOS_BUN_ENGINE_EXECUTION_PROFILE
  ) {
    throw new Error(
      `[mobile-build] ${frameworkInfoPlist} must declare ElizaBunEngineExecutionProfile=${IOS_BUN_ENGINE_EXECUTION_PROFILE}`,
    );
  }
  validateIosBunEngineSymbols(binary);
  validateIosBunEngineNoJitDynamicCode(binary, { buildTarget });
  console.log(
    `[mobile-build] iOS full Bun engine validated ${libraryIdentifier}: ${binary}`,
  );
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function stageIosFullBunEngineForPodspec(framework) {
  const resolved = path.resolve(framework);
  if (isPathInside(iosBunRuntimePackageRoot, resolved)) {
    return resolved;
  }
  if (resolved === path.resolve(defaultIosBunEngineXcframework)) {
    return resolved;
  }

  console.log(
    `[mobile-build] staging external iOS full Bun engine for CocoaPods: ${resolved} -> ${defaultIosBunEngineXcframework}`,
  );
  rmRecursive(defaultIosBunEngineXcframework);
  fs.mkdirSync(path.dirname(defaultIosBunEngineXcframework), {
    recursive: true,
  });
  fs.cpSync(resolved, defaultIosBunEngineXcframework, { recursive: true });
  return defaultIosBunEngineXcframework;
}

function ensureIosFullBunEngineArtifact({ buildTarget = null } = {}) {
  if (!shouldIncludeIosFullBunEngine()) return null;
  const framework = resolveIosFullBunEngineXcframework({ buildTarget });
  if (!framework) {
    const target = isIosSimulatorBuildTarget(buildTarget)
      ? "simulator"
      : "device";
    throw new Error(
      [
        "ELIZA_IOS_FULL_BUN_ENGINE is set, but ElizaBunEngine.xcframework was not found.",
        "Build the Bun fork first:",
        `  ELIZA_BUN_IOS_SOURCE_DIR=/path/to/elizaos-bun bun run --cwd packages/native/bun-runtime build:${target === "simulator" ? "sim" : "device"}`,
        "Or set ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK=/absolute/path/ElizaBunEngine.xcframework.",
        "Refusing to fall back to the JSContext compatibility host for a full-engine build.",
      ].join("\n"),
    );
  }
  validateIosFullBunEngineXcframework(framework, { buildTarget });
  const stagedFramework = stageIosFullBunEngineForPodspec(framework);
  if (stagedFramework !== framework) {
    validateIosFullBunEngineXcframework(stagedFramework, { buildTarget });
  }
  process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK = stagedFramework;
  console.log(`[mobile-build] iOS full Bun engine: ${stagedFramework}`);
  return stagedFramework;
}

// ── Android cloud (Play-Store) strip set ────────────────────────────────
//
// The local Android targets can inject an on-device agent runtime,
// role-resolver activities (dialer, SMS, browser, contacts, camera,
// calendar, clock, assistant, in-call), a boot receiver, and the privileged
// appop / usage-stats / full-control permissions that AOSP needs but Play
// Store rejects. Only the `android-system` target exposes those role
// activities as launcher/home surfaces; the stock sideload APK keeps a
// single app-drawer entry. The `android-cloud` target produces a thin
// Capacitor client backed by Eliza Cloud and must not ship any of those
// components.
//
// Components deleted from the manifest (and from app/src/main/java/...):
export const ANDROID_CLOUD_STRIPPED_COMPONENTS = [
  "ElizaAgentService",
  "ElizaDialActivity",
  "ElizaAssistActivity",
  "ElizaVoiceInteractionService",
  "ElizaVoiceInteractionSessionService",
  "ElizaRecognitionService",
  // Voice-input IME: its transcription depends on the on-device engine's
  // loopback ASR, which the cloud thin-client does not ship, so strip it here.
  "ElizaVoiceInputMethodService",
  "ElizaAccessibilityService",
  "ElizaInCallService",
  "ElizaNotificationListenerService",
  "ElizaVoiceCaptureService",
  "ElizaSmsReceiver",
  "ElizaMmsReceiver",
  "ElizaSmsGatewayService",
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
// Capacitor plugins the cloud renderer still uses — stays in place. Screen
// capture is AOSP/direct-only, so MediaProjection FGS and the native
// screencapture plugin are stripped here.
export const ANDROID_CLOUD_STRIPPED_PERMISSIONS = [
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
  "FOREGROUND_SERVICE_MEDIA_PROJECTION",
  "FOREGROUND_SERVICE_MICROPHONE",
  "FOREGROUND_SERVICE_SPECIAL_USE",
  "RECEIVE_BOOT_COMPLETED",
  "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  "SYSTEM_ALERT_WINDOW",
  "PACKAGE_USAGE_STATS",
  "MANAGE_APP_OPS_MODES",
  "MANAGE_VIRTUAL_MACHINE",
  "READ_FRAME_BUFFER",
  "INJECT_EVENTS",
  "REAL_GET_TASKS",
  "BIND_ACCESSIBILITY_SERVICE",
  "BIND_NOTIFICATION_LISTENER_SERVICE",
  "BIND_DEVICE_ADMIN",
];

// Some kept Capacitor plugins can reintroduce source-stripped permissions via
// library manifest merge. Add removal markers only for verified merge offenders;
// the artifact audit below still fails if any other stripped permission leaks.
export const ANDROID_CLOUD_MANIFEST_MERGER_REMOVED_PERMISSIONS = [
  "ACCESS_BACKGROUND_LOCATION",
  "RECEIVE_BOOT_COMPLETED",
];

// Java sources removed from the merged sources tree so they don't
// reference manifest-stripped classes and break compilation.
export const ANDROID_CLOUD_STRIPPED_JAVA_FILES = [
  "AndroidVirtualizationBridge.java",
  "ElizaAgentService.java",
  "ElizaAgentWatchdogPolicy.java",
  // On-device agent helpers that only ElizaAgentService drives: the cold-boot
  // asset-extraction policy (170 MB agent bundle staging) and the in-process
  // bionic/llama GPU inference server. They import/reference ElizaAgentService,
  // so they must be removed alongside it or the cloud target compiles a dangling
  // reference and auditAndroidCloudSource rejects the tree (#15106).
  "ElizaAssetExtractionPolicy.java",
  "ElizaBionicInferenceServer.java",
  "ElizaAccessibilityService.java",
  "ElizaAssistActivity.java",
  "ElizaVoiceInteractionService.java",
  "ElizaVoiceInteractionSessionService.java",
  "ElizaVoiceInteractionSession.java",
  "ElizaRecognitionService.java",
  "ElizaVoiceInputMethodService.java",
  "ElizaBootReceiver.java",
  "ElizaNotificationListenerService.java",
  "ElizaVoiceCaptureService.java",
  "VoiceCapturePlugin.java",
  "ElizaBrowserActivity.java",
  "ElizaCalendarActivity.java",
  "ElizaCameraActivity.java",
  "ElizaClockActivity.java",
  "ElizaContactsActivity.java",
  "ElizaDialActivity.java",
  "ElizaInCallService.java",
  "ElizaMmsReceiver.java",
  "ElizaSmsGatewayService.java",
  "ElizaRespondViaMessageService.java",
  "ElizaSmsComposeActivity.java",
  "ElizaSmsReceiver.java",
];

// Java sources that survive the cloud strip but are rewritten (or deleted) by
// rewriteCloudJavaSources() so that the android-cloud tree compiles without
// ElizaAgentService. Kept as an exported single source of truth so the strip
// list and the audit stay in agreement (#15106).
export const ANDROID_CLOUD_REWRITTEN_JAVA_FILES = [
  "MainActivity.java",
  "AgentPlugin.java",
  "ElizaTasksWorker.java",
  "ElizaNativeBridge.java",
];

export const ANDROID_CLOUD_STRIPPED_ASSET_FILES = new Set([
  "llama-cpp-kernels.json",
]);

export const ANDROID_CLOUD_STRIPPED_RESOURCE_FILES = [
  path.join("xml", "eliza_accessibility_service.xml"),
];

export const ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS = [
  ["@elizaos/capacitor-agent", "elizaos-capacitor-agent"],
  ["@elizaos/capacitor-bun-runtime", "elizaos-capacitor-bun-runtime"],
  ["@elizaos/capacitor-appblocker", "elizaos-capacitor-appblocker"],
  ["@elizaos/capacitor-contacts", "elizaos-capacitor-contacts"],
  ["@elizaos/capacitor-messages", "elizaos-capacitor-messages"],
  [
    "@elizaos/capacitor-mobile-agent-bridge",
    "elizaos-capacitor-mobile-agent-bridge",
  ],
  ["@elizaos/capacitor-mobile-signals", "elizaos-capacitor-mobile-signals"],
  ["@elizaos/capacitor-phone", "elizaos-capacitor-phone"],
  ["@elizaos/capacitor-screencapture", "elizaos-capacitor-screencapture"],
  ["@elizaos/capacitor-system", "elizaos-capacitor-system"],
  ["@elizaos/capacitor-websiteblocker", "elizaos-capacitor-websiteblocker"],
  ["@elizaos/capacitor-wifi", "elizaos-capacitor-wifi"],
  ["llama-cpp-capacitor", "llama-cpp-capacitor"],
];

const ANDROID_SMS_GATEWAY_COMPONENTS = new Set([
  "ElizaSmsReceiver",
  "ElizaMmsReceiver",
  "ElizaRespondViaMessageService",
  "ElizaSmsComposeActivity",
  "ElizaSmsGatewayService",
]);

const ANDROID_SMS_GATEWAY_PERMISSIONS = new Set([
  "READ_SMS",
  "SEND_SMS",
  "RECEIVE_SMS",
  "RECEIVE_MMS",
  "RECEIVE_WAP_PUSH",
]);

export const ANDROID_SMS_GATEWAY_STRIPPED_COMPONENTS =
  ANDROID_CLOUD_STRIPPED_COMPONENTS.filter(
    (component) => !ANDROID_SMS_GATEWAY_COMPONENTS.has(component),
  );

export const ANDROID_SMS_GATEWAY_STRIPPED_PERMISSIONS =
  ANDROID_CLOUD_STRIPPED_PERMISSIONS.filter(
    (permission) => !ANDROID_SMS_GATEWAY_PERMISSIONS.has(permission),
  );

export const ANDROID_SMS_GATEWAY_STRIPPED_JAVA_FILES =
  ANDROID_CLOUD_STRIPPED_JAVA_FILES.filter(
    (file) => !ANDROID_SMS_GATEWAY_COMPONENTS.has(file.replace(/\.java$/, "")),
  );

export const ANDROID_SMS_GATEWAY_STRIPPED_NATIVE_PLUGINS = [
  ...ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS,
  ["@capacitor/background-runner", "capacitor-background-runner"],
  ["@capacitor/barcode-scanner", "capacitor-barcode-scanner"],
  ["@capacitor/haptics", "capacitor-haptics"],
  ["@capacitor/network", "capacitor-network"],
  ["@capacitor/push-notifications", "capacitor-push-notifications"],
  ["@capacitor/status-bar", "capacitor-status-bar"],
  ["@elizaos/capacitor-camera", "elizaos-capacitor-camera"],
  ["@elizaos/capacitor-canvas", "elizaos-capacitor-canvas"],
  ["@elizaos/capacitor-gateway", "elizaos-capacitor-gateway"],
  ["@elizaos/capacitor-location", "elizaos-capacitor-location"],
  ["@elizaos/capacitor-swabble", "elizaos-capacitor-swabble"],
  ["@elizaos/capacitor-talkmode", "elizaos-capacitor-talkmode"],
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

function cloudSafeTasksWorkerJava(androidPackage) {
  return `package ${androidPackage};

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import org.json.JSONException;
import org.json.JSONObject;

public class ElizaTasksWorker extends Worker {

    private static final String TAG = "ElizaTasksWorker";
    private static final String CAPACITOR_PREFS_GROUP = "CapacitorStorage";
    private static final String KEY_DEVICE_SECRET = "eliza:device-secret";
    private static final String KEY_AGENT_BASE = "eliza:agent-base";
    private static final String WAKE_PATH = "/api/internal/wake";
    private static final int CONNECT_TIMEOUT_MS = 5_000;
    private static final int READ_TIMEOUT_MS = 25_000;
    private static final long DEADLINE_MS = 25_000L;

    public ElizaTasksWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = context.getSharedPreferences(
            CAPACITOR_PREFS_GROUP,
            Context.MODE_PRIVATE
        );

        String deviceSecret = prefs.getString(KEY_DEVICE_SECRET, null);
        String agentBase = prefs.getString(KEY_AGENT_BASE, null);
        if (deviceSecret == null || deviceSecret.isEmpty() || agentBase == null || agentBase.isEmpty()) {
            Log.w(TAG, "cloud wake credentials are not provisioned; skipping");
            return Result.failure();
        }

        String body;
        try {
            JSONObject json = new JSONObject();
            json.put("kind", "refresh");
            json.put("deadlineMs", System.currentTimeMillis() + DEADLINE_MS);
            body = json.toString();
        } catch (JSONException e) {
            Log.e(TAG, "failed to serialize wake body", e);
            return Result.failure();
        }

        String endpoint = trimTrailingSlash(agentBase) + WAKE_PATH;
        HttpURLConnection conn = null;
        try {
            URL url = new URL(endpoint);
            if (!"https".equalsIgnoreCase(url.getProtocol())) {
                Log.w(TAG, "cloud wake requires https agent base");
                return Result.failure();
            }
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setDoOutput(true);
            conn.setUseCaches(false);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + deviceSecret);

            try (OutputStream out = conn.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
                out.flush();
            }

            int status = conn.getResponseCode();
            if (status >= 200 && status < 300) {
                Log.i(TAG, "cloud wake delivered ok status=" + status);
                return Result.success();
            }
            if (status == HttpURLConnection.HTTP_UNAUTHORIZED
                || (status >= 400 && status < 500 && status != HttpURLConnection.HTTP_CLIENT_TIMEOUT)) {
                Log.w(TAG, "cloud wake rejected with permanent status=" + status + "; not retrying");
                return Result.failure();
            }
            Log.w(TAG, "cloud wake transient failure status=" + status + "; will retry");
            return Result.retry();
        } catch (IOException e) {
            Log.w(TAG, "cloud wake network failure; will retry", e);
            return Result.retry();
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static String trimTrailingSlash(String value) {
        if (value == null) return "";
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '/') {
            end--;
        }
        return value.substring(0, end);
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
    if (fs.existsSync(mainActivity) || fs.existsSync(agentPlugin)) {
      fs.writeFileSync(
        agentPlugin,
        cloudSafeAgentPluginJava(androidPackage),
        "utf8",
      );
      touched += 1;
    }
    const tasksWorker = path.join(root, "ElizaTasksWorker.java");
    if (fs.existsSync(tasksWorker)) {
      fs.writeFileSync(
        tasksWorker,
        cloudSafeTasksWorkerJava(androidPackage),
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

export function removeInactiveAndroidJavaSourceRoots(javaRoots, activeRoot) {
  const active = path.resolve(activeRoot);
  const seen = new Set();
  let removed = 0;
  for (const root of javaRoots) {
    const resolved = path.resolve(root);
    if (resolved === active || seen.has(resolved)) continue;
    seen.add(resolved);
    if (!fs.existsSync(root)) continue;
    rmRecursive(root);
    removed += 1;
  }
  return removed;
}

function removeCloudNativeArtifacts() {
  const assetsRoot = path.join(androidDir, "app", "src", "main", "assets");
  const stagedAgentAssets = path.join(assetsRoot, "agent");
  if (fs.existsSync(stagedAgentAssets)) {
    rmRecursive(stagedAgentAssets);
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

function stripAndroidNativePlugins(strippedPlugins, label) {
  const strippedPkgs = new Set(strippedPlugins.map(([pkg]) => pkg));
  const settingsPath = path.join(androidDir, "capacitor.settings.gradle");
  if (fs.existsSync(settingsPath)) {
    let patched = fs.readFileSync(settingsPath, "utf8");
    const current = patched;
    for (const [, gradleProject] of strippedPlugins) {
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
        `[mobile-build] Stripped ${label} native plugins from capacitor.settings.gradle.`,
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
    for (const [, gradleProject] of strippedPlugins) {
      const escaped = escapeRegExp(gradleProject);
      patched = patched.replace(
        new RegExp(`\\n\\s*implementation project\\(':${escaped}'\\)\\s*`, "g"),
        "\n",
      );
    }
    if (patched !== current) {
      fs.writeFileSync(capacitorBuildPath, patched, "utf8");
      console.log(
        `[mobile-build] Stripped ${label} native plugins from capacitor.build.gradle.`,
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
            `[mobile-build] Stripped ${label} native plugins from capacitor.plugins.json.`,
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

function stripAndroidCloudNativePlugins() {
  stripAndroidNativePlugins(
    ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS,
    "cloud-disallowed",
  );
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
    const xml = stripXmlComments(fs.readFileSync(manifestPath, "utf8"));
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
      if (hasAndroidPermissionRequest(xml, full)) {
        failures.push(`AndroidManifest.xml still requests ${full}`);
      }
    }
    for (const forbidden of [
      "android.intent.action.ASSIST",
      "android.intent.action.VOICE_COMMAND",
      "android.app.role.ASSISTANT",
      "android.permission.BIND_VOICE_INTERACTION",
    ]) {
      if (xml.includes(forbidden)) {
        failures.push(`AndroidManifest.xml still contains ${forbidden}`);
      }
    }
    if (/usesCleartextTraffic="true"/.test(xml)) {
      failures.push(
        "AndroidManifest.xml still allows global cleartext traffic",
      );
    }
    if (!xml.includes('android:name="android.app.shortcuts"')) {
      failures.push("AndroidManifest.xml does not register @xml/shortcuts");
    }
  }

  const shortcutsPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "res",
    "xml",
    "shortcuts.xml",
  );
  if (!fs.existsSync(shortcutsPath)) {
    failures.push("app/src/main/res/xml/shortcuts.xml is missing");
  } else {
    const shortcuts = fs.readFileSync(shortcutsPath, "utf8");
    failures.push(
      ...validateAndroidAppActionsXmlResource(shortcuts, {
        androidPackage: APP.appId,
        urlScheme: APP.urlScheme,
      }),
    );
  }

  const resRoot = path.join(androidDir, "app", "src", "main", "res");
  for (const relPath of ANDROID_CLOUD_STRIPPED_RESOURCE_FILES) {
    if (fs.existsSync(path.join(resRoot, relPath))) {
      failures.push(`app/src/main/res/${relPath} still exists`);
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

function auditAndroidSmsGatewaySource(phase) {
  const failures = [];
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  failures.push(...auditAndroidSmsGatewayManifest(manifestPath));
  failures.push(...missingAndroidSmsGatewayJavaFiles());
  failures.push(...androidCloudNativePluginReferenceFailures());

  if (failures.length > 0) {
    throw new Error(
      `[mobile-build] android-sms-gateway ${phase} audit failed:\n` +
        failures.map((failure) => `  - ${failure}`).join("\n"),
    );
  }
  console.log(`[mobile-build] android-sms-gateway ${phase} audit passed.`);
}

function auditAndroidSmsGatewayManifest(manifestPath) {
  const failures = [];
  if (!fs.existsSync(manifestPath)) {
    failures.push("AndroidManifest.xml is missing");
    return failures;
  }
  const xml = stripXmlComments(fs.readFileSync(manifestPath, "utf8"));
  for (const component of ANDROID_SMS_GATEWAY_COMPONENTS) {
    if (!xml.includes(component)) {
      failures.push(`AndroidManifest.xml is missing ${component}`);
    }
  }
  for (const perm of ANDROID_SMS_GATEWAY_PERMISSIONS) {
    const full = `android.permission.${perm}`;
    if (!xml.includes(full)) {
      failures.push(`AndroidManifest.xml is missing ${full}`);
    }
  }
  for (const component of ANDROID_SMS_GATEWAY_STRIPPED_COMPONENTS) {
    if (xml.includes(component)) {
      failures.push(`AndroidManifest.xml still references ${component}`);
    }
  }
  if (/usesCleartextTraffic="true"/.test(xml)) {
    failures.push("AndroidManifest.xml still allows global cleartext traffic");
  }
  return failures;
}

function missingAndroidSmsGatewayJavaFiles() {
  const missing = [];
  const javaRoot = path.join(androidDir, "app", "src", "main", "java");
  for (const file of ["ElizaSmsGatewayService.java", "ElizaSmsReceiver.java"]) {
    let found = false;
    walkFiles(javaRoot, (filePath) => {
      if (path.basename(filePath) === file) found = true;
    });
    if (!found) missing.push(`app/src/main/java is missing ${file}`);
  }
  return missing;
}

function androidCloudNativePluginReferenceFailures() {
  const failures = [];
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
  return failures;
}

function auditAndroidSystemSource(
  phase,
  { requireCapabilityManifest = true } = {},
) {
  const failures = [];
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (!fs.existsSync(manifestPath)) {
    failures.push("AndroidManifest.xml is missing");
  } else {
    const xml = fs.readFileSync(manifestPath, "utf8");
    for (const marker of [
      "ElizaAssistActivity",
      "android.intent.action.ASSIST",
      "android.intent.action.VOICE_COMMAND",
      "ElizaVoiceInteractionService",
      "ElizaVoiceInteractionSessionService",
      "ElizaRecognitionService",
      "android.permission.BIND_VOICE_INTERACTION",
      "android.service.voice.VoiceInteractionService",
      "@xml/eliza_voice_interaction_service",
      "android.speech.RecognitionService",
      "android.speech",
      "@xml/eliza_recognition_service",
      "ElizaVoiceInputMethodService",
      "android.permission.BIND_INPUT_METHOD",
      "android.view.InputMethod",
      "@xml/method",
      "ElizaAccessibilityService",
      "android.permission.BIND_ACCESSIBILITY_SERVICE",
      "android.accessibilityservice.AccessibilityService",
      "@xml/eliza_accessibility_service",
      "ElizaNotificationListenerService",
      "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
      "android.service.notification.NotificationListenerService",
      "ElizaAgentService",
      "ElizaBootReceiver",
      'android:directBootAware="true"',
      "ElizaVoiceCaptureService",
      "android.permission.PACKAGE_USAGE_STATS",
      "android.permission.MANAGE_APP_OPS_MODES",
      "android.permission.MANAGE_VIRTUAL_MACHINE",
      "android.permission.READ_FRAME_BUFFER",
      "android.permission.INJECT_EVENTS",
      "android.permission.REAL_GET_TASKS",
      "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
      "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
      "android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE",
    ]) {
      if (!xml.includes(marker)) {
        failures.push(`AndroidManifest.xml is missing ${marker}`);
      }
    }
  }

  const capabilityManifestPath = path.join(
    systemApkStaging.vendorDir,
    "manifests",
    "aosp-assistant-full-control.json",
  );
  if (requireCapabilityManifest && !fs.existsSync(capabilityManifestPath)) {
    failures.push(
      `${path.relative(repoRoot, capabilityManifestPath)} is missing`,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `[mobile-build] android-system ${phase} audit failed:\n` +
        failures.map((failure) => `  - ${failure}`).join("\n"),
    );
  }
  console.log(`[mobile-build] android-system ${phase} audit passed.`);
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
    xml = removeXmlCommentsContaining(xml, ANDROID_CLOUD_STRIPPED_COMPONENTS);
    xml = ensureManifestApplicationClosedBeforeTopLevelEntries(xml);

    xml = removeAndroidPermissionRequests(
      xml,
      ANDROID_CLOUD_STRIPPED_PERMISSIONS,
    );
    xml = ensureAndroidPermissionRemovalMarkers(
      xml,
      ANDROID_CLOUD_MANIFEST_MERGER_REMOVED_PERMISSIONS,
    );
    xml = applyAndroidCleartextPolicy(xml, { allowCleartext: false });

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
  const activeJavaRoot = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    packageNameToPath(androidPackage),
  );
  const javaRoots = [
    activeJavaRoot,
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
  const removedJavaRootCount = removeInactiveAndroidJavaSourceRoots(
    javaRoots,
    activeJavaRoot,
  );
  if (removedJavaRootCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedJavaRootCount} inactive Android Java source root(s).`,
    );
  }
  rewriteCloudJavaSources(javaRoots, androidPackage);

  const resRoot = path.join(androidDir, "app", "src", "main", "res");
  let removedResourceCount = 0;
  for (const relPath of ANDROID_CLOUD_STRIPPED_RESOURCE_FILES) {
    const target = path.join(resRoot, relPath);
    if (fs.existsSync(target)) {
      fs.rmSync(target);
      removedResourceCount += 1;
    }
  }
  if (removedResourceCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedResourceCount} Play-Store-noncompliant Android resource(s).`,
    );
  }

  // 3. Wipe any previously-staged on-device agent runtime. These are
  //    build artifacts (.gitignore covers them) — the cloud APK must not
  //    embed bun, musl, libstdc++, libgcc, llama-server, or the
  //    libeliza_*.so jniLibs disguise.
  removeCloudNativeArtifacts();
  stripAndroidCloudNativePlugins();
}

function stripAndroidForSmsGateway() {
  const androidPackage = APP.appId;
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

    for (const component of ANDROID_SMS_GATEWAY_STRIPPED_COMPONENTS) {
      xml = removeApplicationComponentBlock(
        xml,
        `${androidPackage}.${component}`,
      );
      xml = removeApplicationComponentClassBlock(xml, component);
    }

    xml = removeAndroidPermissionRequests(
      xml,
      ANDROID_SMS_GATEWAY_STRIPPED_PERMISSIONS,
    );
    xml = ensureAndroidPermissionRemovalMarkers(
      xml,
      ANDROID_CLOUD_MANIFEST_MERGER_REMOVED_PERMISSIONS.filter((permission) =>
        ANDROID_SMS_GATEWAY_STRIPPED_PERMISSIONS.includes(permission),
      ),
    );
    xml = applyAndroidCleartextPolicy(xml, { allowCleartext: false });

    if (xml !== original) {
      fs.writeFileSync(manifestPath, xml, "utf8");
      console.log(
        "[mobile-build] Stripped non-SMS local components and permissions from AndroidManifest.xml.",
      );
    }
  }

  const activeJavaRoot = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    packageNameToPath(androidPackage),
  );
  const javaRoots = [
    activeJavaRoot,
    path.join(androidDir, "app", "src", "main", "java", "ai", "elizaos", "app"),
  ];
  let removedJavaCount = 0;
  for (const root of javaRoots) {
    if (!fs.existsSync(root)) continue;
    for (const file of ANDROID_SMS_GATEWAY_STRIPPED_JAVA_FILES) {
      const target = path.join(root, file);
      if (fs.existsSync(target)) {
        fs.rmSync(target);
        removedJavaCount += 1;
      }
    }
  }
  if (removedJavaCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedJavaCount} non-SMS Java source(s).`,
    );
  }
  const removedJavaRootCount = removeInactiveAndroidJavaSourceRoots(
    javaRoots,
    activeJavaRoot,
  );
  if (removedJavaRootCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedJavaRootCount} inactive Android Java source root(s).`,
    );
  }
  rewriteCloudJavaSources(javaRoots, androidPackage);

  const resRoot = path.join(androidDir, "app", "src", "main", "res");
  for (const relPath of ANDROID_CLOUD_STRIPPED_RESOURCE_FILES) {
    const target = path.join(resRoot, relPath);
    if (fs.existsSync(target)) {
      fs.rmSync(target);
    }
  }

  removeCloudNativeArtifacts();
  stripAndroidNativePlugins(
    ANDROID_SMS_GATEWAY_STRIPPED_NATIVE_PLUGINS,
    "sms-gateway-disallowed",
  );
}

function enforceAndroidSideloadBuildPolicy({ env = process.env } = {}) {
  // Hard refusal: the default `android` target is sideload-only and will be
  // rejected by Play. If CI or a contributor signals Play-Store intent via
  // env vars, fail loudly and point them at the right target.
  const playStoreFlagged =
    env.ELIZA_PLAY_STORE_BUILD === "1" ||
    env.ELIZA_BUILD_VARIANT?.toLowerCase() === "store";
  if (playStoreFlagged) {
    console.error(
      "[mobile-build] Refusing target `android` under ELIZA_PLAY_STORE_BUILD / " +
        "ELIZA_BUILD_VARIANT=store. The default `android` APK embeds the " +
        "on-device agent runtime and requests Play-rejected permissions " +
        "(MANAGE_APP_OPS_MODES, PACKAGE_USAGE_STATS). Use " +
        "`build:android:cloud` (Play-Store-compliant thin client) or " +
        "`build:android:system` (AOSP privileged platform-signed APK).",
    );
    process.exit(2);
  }

  console.warn(
    "[mobile-build] WARNING: target `android` produces an APK that embeds " +
      "the on-device agent runtime (libeliza_bun.so disguise) and requests " +
      "system-only permissions (MANAGE_APP_OPS_MODES, PACKAGE_USAGE_STATS). " +
      "It is SIDELOAD-ONLY and will be rejected by the Play Store. Use " +
      "`build:android:cloud` for a Play-Store-compliant thin client, or " +
      "`build:android:system` for the AOSP privileged platform-signed APK.",
  );
}

function requireAndroidSmsGatewaySecret({ env = process.env } = {}) {
  if (!env.ELIZA_ANDROID_SMS_GATEWAY_SECRET) {
    throw new Error(
      "ELIZA_ANDROID_SMS_GATEWAY_SECRET is required for android-sms-gateway.",
    );
  }
}

const ANDROID_PREFLIGHTS = Object.freeze({
  sideload: enforceAndroidSideloadBuildPolicy,
});

const ANDROID_AFTER_TOOLCHAIN = Object.freeze({
  smsGatewaySecret: requireAndroidSmsGatewaySecret,
});

const ANDROID_SOURCE_STRIPS = Object.freeze({
  cloud: stripAndroidForCloud,
  smsGateway: stripAndroidForSmsGateway,
});

const ANDROID_SOURCE_AUDITS = Object.freeze({
  cloud: auditAndroidCloudSource,
  smsGateway: auditAndroidSmsGatewaySource,
  system: auditAndroidSystemSource,
});

const ANDROID_ARTIFACT_AUDITS = Object.freeze({
  sideload: ({ javaHome }) => auditAndroidSideloadArtifact({ javaHome }),
  cloud: ({ javaHome }) => auditAndroidCloudArtifact({ javaHome }),
  cloudDebug: ({ javaHome }) =>
    auditAndroidCloudArtifact({ debug: true, javaHome }),
  smsGateway: ({ androidSdkRoot, javaHome }) =>
    auditAndroidSmsGatewayArtifact({ androidSdkRoot, javaHome }),
  system: ({ javaHome }) => auditAndroidSystemArtifact({ javaHome }),
});

const ANDROID_POST_BUILDS = Object.freeze({
  logCloudRelease: ({ artifact }) =>
    console.log(`[mobile-build] android-cloud release AAB: ${artifact}`),
  preserveSmsGateway: ({ artifact }) => {
    preserveAndroidSmsGatewayArtifact(artifact);
    console.log(`[mobile-build] android-sms-gateway debug APK: ${artifact}`);
  },
  stageSystemApk: stageAndroidSystemApk,
});

function runAndroidTargetPhase(target, registry, keyField, ...args) {
  const key = target[keyField];
  if (!key) return undefined;
  const fn = registry[key];
  if (!fn) {
    throw new Error(
      `[mobile-build] Android target ${target.target} references unknown ${keyField}: ${key}`,
    );
  }
  return fn(...args);
}

export function resolveAndroidGradleCommands(
  targetName,
  { debug = false, env = process.env, settingsGradle = "" } = {},
) {
  const target = resolveAndroidBuildTarget(targetName, { debug });
  return resolveAndroidGradleCommandsForTarget(target, {
    env,
    settingsGradle,
  });
}

function resolveAndroidSmsGatewayEnvDefaults(env) {
  return {
    ELIZA_ANDROID_SMS_GATEWAY_ENABLED:
      env.ELIZA_ANDROID_SMS_GATEWAY_ENABLED ?? "true",
    ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL:
      env.ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL ??
      "https://api.elizacloud.ai/api/webhooks/blooio/local?bridge=bluebubbles",
    ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER:
      env.ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER ?? "+14159611510",
    ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL:
      env.ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL ??
      "Eliza Cloud Gateway (+14159611510)",
  };
}

function createAndroidBuildEnv(target, { androidSdkRoot, env, javaHome }) {
  return {
    ...env,
    ...target.env,
    ...(target.includeSmsGatewayEnvDefaults
      ? resolveAndroidSmsGatewayEnvDefaults(env)
      : {}),
    ANDROID_HOME: androidSdkRoot,
    ANDROID_SDK_ROOT: androidSdkRoot,
    JAVA_HOME: javaHome,
    PATH: prependPath(env, [
      path.join(javaHome, "bin"),
      path.join(androidSdkRoot, "platform-tools"),
    ]),
  };
}

function readAndroidSettingsGradle() {
  return fs.readFileSync(
    path.join(androidDir, "capacitor.settings.gradle"),
    "utf8",
  );
}

export async function runAndroidBuild(
  targetName,
  { debug = false, env = process.env } = {},
) {
  const target = resolveAndroidBuildTarget(targetName, { debug });
  runAndroidTargetPhase(target, ANDROID_PREFLIGHTS, "preflightKey", { env });

  const sdk = resolveAndroidSdkRoot(env);
  const jdk = resolveJavaHome(env);
  if (!sdk)
    throw new Error(
      "Android SDK not found. Set ANDROID_SDK_ROOT or ANDROID_HOME.",
    );
  if (!jdk) throw new Error("JDK 21 not found. Set JAVA_HOME.");
  runAndroidTargetPhase(
    target,
    ANDROID_AFTER_TOOLCHAIN,
    "afterToolchainResolvedKey",
    { env },
  );

  await buildWeb(target.webTarget);
  if (target.buildMobileAgentBundle) await buildMobileAgentBundle();
  await ensurePlatform("android");
  await ensureRendererDistMatchesLane(target.webTarget);
  await runCapacitor(["sync", "android"]);
  ensureBunRuntimeRegistered();
  mirrorCapacitorWebPayloadIntoAndroidDir();

  patchAndroidGradle();
  await generateAndroidBrandAssets();
  overlayAndroid(target.overlayOptions);
  sanitizeAndroidManifestWhenPlatformTemplatesMissing();
  writeAndroidCleartextPolicy(target.cleartextPolicy);
  if (target.agentRuntime) {
    await stageAndroidAgentRuntime({
      androidDir,
      spikeDir: androidAgentSpikeDir,
      ...target.agentRuntime,
    });
  }
  runAndroidTargetPhase(target, ANDROID_SOURCE_STRIPS, "stripSourceKey");
  runAndroidTargetPhase(
    target,
    ANDROID_SOURCE_AUDITS,
    "auditSourceKey",
    "pre-gradle",
  );

  const buildEnv = createAndroidBuildEnv(target, {
    androidSdkRoot: sdk,
    env,
    javaHome: jdk,
  });
  const { buildArgs, metadataArgs } = resolveAndroidGradleCommands(
    target.target,
    {
      env,
      settingsGradle: readAndroidSettingsGradle(),
    },
  );
  await run("./gradlew", metadataArgs, {
    cwd: androidDir,
    env: buildEnv,
  });
  await run("./gradlew", buildArgs, {
    cwd: androidDir,
    env: buildEnv,
  });
  runAndroidTargetPhase(
    target,
    ANDROID_SOURCE_AUDITS,
    "auditSourceKey",
    "post-gradle",
  );
  const artifact = runAndroidTargetPhase(
    target,
    ANDROID_ARTIFACT_AUDITS,
    "artifactAuditKey",
    {
      androidSdkRoot: sdk,
      javaHome: jdk,
    },
  );
  runAndroidTargetPhase(target, ANDROID_POST_BUILDS, "postBuildKey", {
    artifact,
    androidSdkRoot: sdk,
    javaHome: jdk,
  });
}

async function buildAndroid() {
  await runAndroidBuild("android");
}

/**
 * Audit the sideload (`android`) debug APK. The sideload target ships both the
 * web renderer and the on-device agent payload, so assert both are packaged —
 * a web-less sideload APK is the exact regression of elizaOS/eliza#8387
 * (ERR_CONNECTION_REFUSED on device).
 */
function auditAndroidSideloadArtifact({ javaHome } = {}) {
  const artifact = findAndroidCloudDebugApk();
  if (!artifact) {
    throw new Error(
      "[mobile-build] android sideload debug APK was not found under app/build/outputs/.",
    );
  }
  const entries = listAndroidArtifactEntries(artifact, javaHome);
  assertAndroidArtifactShipsWebPayload(artifact, entries, {
    requireAgent: true,
    label: "android",
  });
  console.log(
    `[mobile-build] android sideload artifact audit passed: ${artifact}`,
  );
  return artifact;
}

function auditAndroidSystemArtifact({ javaHome } = {}) {
  // The AOSP/system target gets the web-payload mirror like the other three
  // sync targets, but the privileged release APK still needs the same positive
  // artifact audit or it could ship web-less (ERR_CONNECTION_REFUSED) silently —
  // the exact regression class #8387 closes. `-PelizaAospBuild=true` preserves
  // assets/agent, so requireAgent stays true here like the sideload path.
  const artifact = findAndroidSystemApk();
  if (!artifact) {
    throw new Error(
      "[mobile-build] android-system release APK was not found under app/build/outputs/apk/release/.",
    );
  }
  const entries = listAndroidArtifactEntries(artifact, javaHome);
  assertAndroidArtifactShipsWebPayload(artifact, entries, {
    requireAgent: true,
    label: "android-system",
  });
  console.log(
    `[mobile-build] android-system artifact audit passed: ${artifact}`,
  );
  return artifact;
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

function resolveAndroidBuildTool(sdkRoot, toolName) {
  const buildToolsRoot = path.join(sdkRoot, "build-tools");
  if (!fs.existsSync(buildToolsRoot)) return null;
  const versions = fs
    .readdirSync(buildToolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .reverse();
  for (const version of versions) {
    const candidate = path.join(buildToolsRoot, version, toolName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * List the packaged entries of an APK/AAB via `jar tf`. Throws on inspect
 * failure so a broken artifact can never pass an audit by yielding an empty
 * listing.
 */
function resolveJarTool(javaHome) {
  // Prefer the JDK's own `jar`, but a JAVA_HOME pointing at a stripped JRE
  // (java/keytool only, no jdk tools) is common and would hard-fail a finished
  // build. Fall back to `jar` on PATH — `jar tf` is a plain zip listing and
  // works regardless of which JDK provides it.
  const exe = process.platform === "win32" ? "jar.exe" : "jar";
  const fromHome = javaHome ? path.join(javaHome, "bin", exe) : null;
  return fromHome && fs.existsSync(fromHome) ? fromHome : exe;
}

function listAndroidArtifactEntries(artifact, javaHome) {
  const jar = resolveJarTool(javaHome);
  const result = spawnSync(jar, ["tf", artifact], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `[mobile-build] Could not inspect ${artifact}: ${
        result.stderr || result.stdout || `jar exited with ${result.status}`
      }`,
    );
  }
  return result.stdout.split(/\r?\n/);
}

/**
 * Positive assertion that an installable APK actually ships the web renderer
 * (and, for local builds, the on-device agent). Without this, a sync that
 * lands the web payload in the wrong tree produces a web-less APK that boots
 * to net::ERR_CONNECTION_REFUSED — the failure this guard exists to prevent
 * (elizaOS/eliza#8387). `assets/public/index.html` is the WebView entrypoint,
 * `assets/capacitor.config.json` is the Capacitor runtime config, and
 * `assets/agent/` is the staged local-agent payload (only present on
 * local/sideload builds; cloud thin clients deliberately strip it).
 */
function assertAndroidArtifactShipsWebPayload(
  artifact,
  entries,
  { requireAgent = false, label = "android" } = {},
) {
  // APKs package assets at `assets/...`; AABs nest them under a module dir
  // (`base/assets/...`). Match on the canonical suffix so one assertion covers
  // both `:app:assembleDebug` (APK) and `:app:bundleRelease` (AAB) outputs.
  const hasAssetFile = (suffix) =>
    entries.some(
      (entry) =>
        entry === `assets/${suffix}` || entry.endsWith(`/assets/${suffix}`),
    );
  const hasAssetDir = (prefix) =>
    entries.some(
      (entry) =>
        entry.startsWith(`assets/${prefix}`) ||
        entry.includes(`/assets/${prefix}`),
    );
  const required = ["public/index.html", "capacitor.config.json"];
  const missing = required.filter((suffix) => !hasAssetFile(suffix));
  if (requireAgent && !hasAssetDir("agent/")) missing.push("assets/agent/");
  if (missing.length > 0) {
    throw new Error(
      `[mobile-build] ${label} artifact is missing required packaged payload — ` +
        `it would ship a web-less app that fails with ERR_CONNECTION_REFUSED:\n` +
        missing.map((entry) => `  - ${entry}`).join("\n") +
        `\n  artifact: ${artifact}`,
    );
  }
}

function auditAndroidCloudArtifact({ debug = false, javaHome } = {}) {
  const artifact = debug ? findAndroidCloudDebugApk() : findAndroidCloudAab();
  if (!artifact) {
    throw new Error(
      `[mobile-build] android-cloud ${debug ? "debug APK" : "release AAB"} was not found under app/build/outputs/.`,
    );
  }
  const entries = listAndroidArtifactEntries(artifact, javaHome);
  const offenders = entries.filter((entry) =>
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
  const aapt = resolveAndroidBuildTool(resolveAndroidSdkRoot(), "aapt");
  if (!aapt) {
    throw new Error(
      "[mobile-build] Could not find aapt under Android SDK build-tools for android-cloud artifact audit.",
    );
  }
  const badging = dumpAndroidArtifactBadging(aapt, artifact);
  const permissionOffenders = ANDROID_CLOUD_STRIPPED_PERMISSIONS.filter(
    (perm) =>
      badging.includes(`uses-permission: name='android.permission.${perm}'`),
  );
  if (permissionOffenders.length > 0) {
    throw new Error(
      "[mobile-build] android-cloud artifact still requests stripped permissions:\n" +
        permissionOffenders
          .map((perm) => `  - android.permission.${perm}`)
          .join("\n"),
    );
  }
  // Cloud is a thin client (no on-device agent), but it must still ship the
  // renderer — a web-less cloud APK is just as broken as a web-less sideload.
  assertAndroidArtifactShipsWebPayload(artifact, entries, {
    requireAgent: false,
    label: "android-cloud",
  });
  console.log(
    `[mobile-build] android-cloud artifact audit passed: ${artifact}`,
  );
  return artifact;
}

function auditAndroidSmsGatewayArtifact({ androidSdkRoot, javaHome } = {}) {
  const artifact = findAndroidCloudDebugApk();
  if (!artifact) {
    throw new Error(
      "[mobile-build] android-sms-gateway debug APK was not found under app/build/outputs/.",
    );
  }

  assertNoAndroidSmsGatewayPackagedOffenders(artifact, javaHome);
  assertAndroidArtifactShipsWebPayload(
    artifact,
    listAndroidArtifactEntries(artifact, javaHome),
    { requireAgent: false, label: "android-sms-gateway" },
  );

  const aapt = resolveAndroidBuildTool(androidSdkRoot, "aapt");
  if (!aapt) {
    throw new Error(
      "[mobile-build] Could not find aapt under Android SDK build-tools for android-sms-gateway artifact audit.",
    );
  }
  const badging = dumpAndroidArtifactBadging(aapt, artifact);
  assertAndroidSmsGatewayBadging(badging);
  const manifestText = dumpAndroidArtifactManifest(aapt, artifact);
  assertAndroidSmsGatewayArtifactManifest(manifestText);

  console.log(
    `[mobile-build] android-sms-gateway artifact audit passed: ${artifact}`,
  );
  return artifact;
}

function assertNoAndroidSmsGatewayPackagedOffenders(artifact, javaHome) {
  const jar = resolveJarTool(javaHome);
  const jarResult = spawnSync(jar, ["tf", artifact], { encoding: "utf8" });
  if (jarResult.status !== 0) {
    throw new Error(
      `[mobile-build] Could not inspect ${artifact}: ${
        jarResult.stderr ||
        jarResult.stdout ||
        `jar exited with ${jarResult.status}`
      }`,
    );
  }
  const packagedOffenders = jarResult.stdout
    .split(/\r?\n/)
    .filter((entry) =>
      /(^|\/)assets\/agent\/|libeliza_|libllama|libsigsys-handler\.so|llama-cpp-kernels\.json/i.test(
        entry,
      ),
    );
  if (packagedOffenders.length > 0) {
    throw new Error(
      `[mobile-build] android-sms-gateway artifact contains local runtime payloads:\n` +
        packagedOffenders.map((entry) => `  - ${entry}`).join("\n"),
    );
  }
}

function dumpAndroidArtifactBadging(aapt, artifact) {
  const badging = spawnSync(aapt, ["dump", "badging", artifact], {
    encoding: "utf8",
  });
  if (badging.status !== 0) {
    throw new Error(
      `[mobile-build] Could not inspect ${artifact} badging: ${
        badging.stderr || badging.stdout || `aapt exited with ${badging.status}`
      }`,
    );
  }
  return badging.stdout;
}

function assertAndroidSmsGatewayBadging(badging) {
  for (const perm of ANDROID_SMS_GATEWAY_PERMISSIONS) {
    if (
      !badging.includes(`uses-permission: name='android.permission.${perm}'`)
    ) {
      throw new Error(
        `[mobile-build] android-sms-gateway artifact is missing android.permission.${perm}`,
      );
    }
  }
}

function dumpAndroidArtifactManifest(aapt, artifact) {
  const manifest = spawnSync(
    aapt,
    ["dump", "xmltree", artifact, "AndroidManifest.xml"],
    { encoding: "utf8" },
  );
  if (manifest.status !== 0) {
    throw new Error(
      `[mobile-build] Could not inspect ${artifact} AndroidManifest.xml: ${
        manifest.stderr ||
        manifest.stdout ||
        `aapt exited with ${manifest.status}`
      }`,
    );
  }
  return manifest.stdout;
}

function assertAndroidSmsGatewayArtifactManifest(manifestText) {
  for (const component of ANDROID_SMS_GATEWAY_COMPONENTS) {
    if (!manifestText.includes(`${APP.appId}.${component}`)) {
      throw new Error(
        `[mobile-build] android-sms-gateway artifact manifest is missing ${APP.appId}.${component}`,
      );
    }
  }
  for (const marker of [
    "android.provider.Telephony.SMS_DELIVER",
    "android.provider.Telephony.WAP_PUSH_DELIVER",
    "android.intent.action.RESPOND_VIA_MESSAGE",
    "android.intent.action.SENDTO",
  ]) {
    if (!manifestText.includes(marker)) {
      throw new Error(
        `[mobile-build] android-sms-gateway artifact manifest is missing ${marker}`,
      );
    }
  }
  for (const component of ANDROID_SMS_GATEWAY_STRIPPED_COMPONENTS) {
    if (manifestText.includes(component)) {
      throw new Error(
        `[mobile-build] android-sms-gateway artifact manifest still references ${component}`,
      );
    }
  }
}

function preserveAndroidSmsGatewayArtifact(artifact) {
  fs.mkdirSync(localArtifactsDir, { recursive: true });
  fs.copyFileSync(artifact, androidSmsGatewayDebugApkArtifact);
  console.log(
    `[mobile-build] android-sms-gateway preserved APK: ${androidSmsGatewayDebugApkArtifact}`,
  );
}

async function buildAndroidCloud({ debug = false } = {}) {
  await runAndroidBuild("android-cloud", { debug });
}

async function buildAndroidSmsGateway() {
  await runAndroidBuild("android-sms-gateway");
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

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function currentGitRevision() {
  const result = runCaptureSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function writeAndroidSystemProvenance(apkPath) {
  const zip = resolveExecutable("zip");
  if (!zip) {
    throw new Error(
      "[mobile-build] zip not found on PATH; cannot embed AOSP APK provenance metadata.",
    );
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-aosp-apk-"));
  try {
    const rel = path.join("META-INF", "eliza", "aosp-build-provenance.json");
    const target = path.join(tmpDir, rel);
    const runtimeProvenancePath = path.join(
      androidDir,
      "app",
      "src",
      "main",
      "assets",
      "agent",
      RUNTIME_PROVENANCE_FILENAME,
    );
    const runtimeProvenance = fs.existsSync(runtimeProvenancePath)
      ? JSON.parse(fs.readFileSync(runtimeProvenancePath, "utf8"))
      : null;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `${JSON.stringify(
        {
          schema: "eliza.aosp_build_provenance.v1",
          staged_at: new Date().toISOString(),
          repo_root: ".",
          repo_root_provenance: "relative_to_git_checkout",
          git_revision: currentGitRevision(),
          apk_name: path.basename(apkPath),
          apk_sha256_before_provenance: sha256File(apkPath),
          runtime_provenance_entry: `assets/agent/${RUNTIME_PROVENANCE_FILENAME}`,
          runtime_provenance_sha256: runtimeProvenance
            ? sha256File(runtimeProvenancePath)
            : null,
          runtime_provenance: runtimeProvenance,
          android_system_variant: APP.appName,
          android_package: APP.appId,
          claim_boundary:
            "apk_packaging_provenance_only_not_aosp_boot_or_gui_runtime_evidence",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const result = spawnSync(zip, ["-q", "-X", apkPath, rel], {
      cwd: tmpDir,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `[mobile-build] Failed to embed AOSP APK provenance: ${
          result.stderr || result.stdout || `zip exited with ${result.status}`
        }`,
      );
    }
  } finally {
    rmRecursive(tmpDir);
  }
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
  writeAndroidSystemProvenance(target);
  console.log(`[mobile-build] Staged ${elizaOsApkName} at ${target}.`);
}

async function buildAndroidSystem() {
  await runAndroidBuild("android-system");
}

function setDefaultProcessEnv(key, value) {
  if (process.env[key] == null || process.env[key] === "") {
    process.env[key] = value;
  }
}

function resolveRubyUserGemBin() {
  const result = spawnSync("ruby", ["-rrubygems", "-e", "print Gem.user_dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const dir = result.stdout?.trim();
  if (!dir) return null;
  return path.join(dir, "bin");
}

function withCocoaPodsEnv(baseEnv = process.env) {
  const pathEntries = [
    resolveRubyUserGemBin(),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter((entry) => entry && fs.existsSync(entry));
  const existingPath = baseEnv.PATH ?? process.env.PATH ?? "";
  const rubyOpt = baseEnv.RUBYOPT ?? process.env.RUBYOPT ?? "";
  return {
    ...baseEnv,
    PATH:
      pathEntries.length > 0
        ? `${pathEntries.join(path.delimiter)}${path.delimiter}${existingPath}`
        : existingPath,
    RUBYOPT: rubyOpt.includes("-rlogger")
      ? rubyOpt
      : ["-rlogger", rubyOpt].filter(Boolean).join(" "),
  };
}

function configureIosLocalBuildDefaults() {
  setDefaultProcessEnv("ELIZA_IOS_RUNTIME_MODE", "local");
  setDefaultProcessEnv("VITE_ELIZA_IOS_RUNTIME_MODE", "local");
  setDefaultProcessEnv("ELIZA_RUNTIME_MODE", "local-safe");
  setDefaultProcessEnv("RUNTIME_MODE", "local-safe");
  setDefaultProcessEnv("LOCAL_RUNTIME_MODE", "local-safe");
  setDefaultProcessEnv("VITE_ELIZA_RUNTIME_MODE", "local-safe");
  if (isIosAppStoreBuild()) {
    process.env.ELIZA_IOS_INCLUDE_LLAMA = "0";
  } else {
    setDefaultProcessEnv("ELIZA_IOS_INCLUDE_LLAMA", "1");
  }
  setDefaultProcessEnv(
    "ELIZA_IOS_BUILD_DESTINATION",
    "generic/platform=iOS Simulator",
  );
  setDefaultProcessEnv("ELIZA_IOS_BUILD_SDK", "iphonesimulator");
}

export function configureIosAppStoreBuildDefaults() {
  setDefaultProcessEnv("ELIZA_BUILD_VARIANT", "store");
  setDefaultProcessEnv("ELIZA_RELEASE_AUTHORITY", "apple-app-store");
  setDefaultProcessEnv("ELIZA_IOS_RUNTIME_MODE", "cloud-hybrid");
  setDefaultProcessEnv("VITE_ELIZA_IOS_RUNTIME_MODE", "cloud-hybrid");
  setDefaultProcessEnv("ELIZA_RUNTIME_MODE", "local-safe");
  setDefaultProcessEnv("RUNTIME_MODE", "local-safe");
  setDefaultProcessEnv("LOCAL_RUNTIME_MODE", "local-safe");
  setDefaultProcessEnv("VITE_ELIZA_RUNTIME_MODE", "local-safe");
  process.env.ELIZA_IOS_INCLUDE_LLAMA = "0";
}

async function buildIos({ local = false } = {}) {
  if (process.platform !== "darwin")
    throw new Error("iOS builds require macOS and Xcode.");

  if (local) {
    configureIosLocalBuildDefaults();
  } else {
    configureIosAppStoreBuildDefaults();
  }

  const iosBuildPolicy = resolveMobileBuildPolicy(local ? "ios-local" : "ios");
  setDefaultProcessEnv(
    "ELIZA_CAPACITOR_BUILD_TARGET",
    iosBuildPolicy.capacitorTarget,
  );
  setDefaultProcessEnv("ELIZA_BUILD_VARIANT", iosBuildPolicy.buildVariant);
  setDefaultProcessEnv(
    "ELIZA_RELEASE_AUTHORITY",
    iosBuildPolicy.releaseAuthority,
  );

  const buildTarget = resolveIosBuildTarget();
  const includesFullBunRuntime = shouldIncludeIosFullBunEngine();
  const includesLocalAgentPayload = local || includesFullBunRuntime;
  if (includesFullBunRuntime) {
    setDefaultProcessEnv("VITE_ELIZA_IOS_FULL_BUN_AVAILABLE", "1");
  }
  if (local && isFullIosBunEngineRequested(process.env)) {
    setDefaultProcessEnv("VITE_ELIZA_IOS_FULL_BUN_STRICT", "1");
  }
  if (includesFullBunRuntime) {
    ensureIosFullBunEngineArtifact({ buildTarget });
  }
  if (includesLocalAgentPayload) {
    await buildMobileAgentBundle({ target: "ios" });
  }

  const cocoapodsScript = path.join(
    appCoreRoot,
    "scripts",
    "prepare-ios-cocoapods.sh",
  );

  await buildWeb(local ? "ios-local" : "ios");
  await ensurePlatform("ios");
  if (includesLocalAgentPayload) {
    // Stage once before CocoaPods/Capacitor native dependency work so a
    // missing local toolchain still leaves the iOS app bundle resources in an
    // inspectable state. Capacitor sync may rewrite app resources, so we stage
    // again immediately after sync.
    stageIosAgentRuntime({
      appStoreBuild: isIosAppStoreBuild() && !local,
      includeFullBunEngine: includesFullBunRuntime,
    });
  } else if (isIosAppStoreBuild()) {
    removeIosLocalExecutionAssets();
  }
  if (fs.existsSync(cocoapodsScript)) {
    await run("bash", [cocoapodsScript], { cwd: repoRoot });
  }
  // Whether sync runs or is skipped, dist is about to be staged into
  // ios/App/App/public (cap sync webDir copy and/or the mirror overlay just
  // below) — verify it matches this lane first (#11030).
  await ensureRendererDistMatchesLane(local ? "ios-local" : "ios");
  if (shouldSkipIosCapacitorSync()) {
    console.log("[mobile-build] Skipping Capacitor iOS sync.");
  } else {
    await runCapacitor(["sync", "ios"]);
  }
  // Overlay the freshly built renderer onto ios/App/App/public and assert it
  // matches the build — never ship a stale UI whether sync ran, was skipped, or
  // left old hashed assets behind (issue #9309). Runs before the post-sync agent
  // re-stage so the agent payload remains the final authority on public/agent.
  mirrorCapacitorWebPayloadIntoIosDir();
  if (includesLocalAgentPayload) {
    stageIosAgentRuntime({
      appStoreBuild: isIosAppStoreBuild() && !local,
      includeFullBunEngine: includesFullBunRuntime,
    });
  } else if (isIosAppStoreBuild()) {
    removeIosLocalExecutionAssets();
  }

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
  if (shouldSkipIosPodInstall()) {
    console.log("[mobile-build] Skipping CocoaPods install.");
  } else if (
    fs.existsSync(path.join(iosDir, "Podfile")) ||
    shouldRunIosPodInstall(syncedFiles)
  ) {
    await run("pod", ["install"], {
      cwd: iosDir,
      env: withCocoaPodsEnv({
        ...process.env,
        LANG: process.env.LANG?.includes("UTF-8")
          ? process.env.LANG
          : "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL?.includes("UTF-8")
          ? process.env.LC_ALL
          : "en_US.UTF-8",
      }),
    });
  }

  const wsPath = path.join(iosDir, "App.xcworkspace");
  const projectArgs = fs.existsSync(wsPath)
    ? ["-workspace", "App.xcworkspace"]
    : ["-project", "App.xcodeproj"];
  const developmentTeam = process.env.ELIZA_IOS_DEVELOPMENT_TEAM?.trim();
  const derivedDataPath = process.env.ELIZA_IOS_DERIVED_DATA_PATH?.trim();
  const provisioningArgs = isTruthyEnv(
    process.env.ELIZA_IOS_ALLOW_PROVISIONING_UPDATES,
  )
    ? ["-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration"]
    : [];
  await run(
    "xcodebuild",
    [
      ...projectArgs,
      "-scheme",
      "App",
      ...(derivedDataPath ? ["-derivedDataPath", derivedDataPath] : []),
      "-configuration",
      resolveIosBuildConfiguration(),
      "-destination",
      buildTarget.destination,
      "-sdk",
      buildTarget.sdk,
      ...provisioningArgs,
      `IPHONEOS_DEPLOYMENT_TARGET=${resolveIosDeploymentTarget()}`,
      `CODE_SIGNING_ALLOWED=${process.env.ELIZA_IOS_CODE_SIGNING_ALLOWED ?? "NO"}`,
      ...(developmentTeam ? [`DEVELOPMENT_TEAM=${developmentTeam}`] : []),
      ...(isIosSimulatorBuildTarget(buildTarget)
        ? ["ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES", "EXCLUDED_ARCHS=x86_64"]
        : []),
      ...(shouldCleanIosBuildProducts() ? ["clean"] : []),
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
    target !== "android-sms-gateway" &&
    target !== "android-cloud" &&
    target !== "android-cloud-debug" &&
    target !== "android-system" &&
    target !== "ios" &&
    target !== "ios-local" &&
    target !== "ios-overlay"
  ) {
    console.error(
      "Usage: node scripts/run-mobile-build.mjs <android|android-sms-gateway|android-cloud|android-cloud-debug|android-system|ios|ios-local|ios-overlay>",
    );
    process.exit(1);
  }
  if (target === "android") {
    await buildAndroid();
  } else if (target === "android-sms-gateway") {
    await buildAndroidSmsGateway();
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
    // The App Store release pipeline splits the build into `bun run build`
    // (web) + `cap:sync:ios` + this overlay + fastlane, so it never runs
    // buildIos()'s local-agent staging. When the build embeds the full Bun
    // engine, stage the agent runtime payload here (after cap sync, before
    // pod install / fastlane archive) so the shipped IPA actually contains the
    // agent the engine runs — without it the engine boots with nothing to
    // execute. The agent bundle must already be built (packages/agent
    // build:ios-bun); stageIosAgentRuntime throws with that hint if missing.
    if (shouldIncludeIosFullBunEngine()) {
      stageIosAgentRuntime({
        appStoreBuild: isIosAppStoreBuild(),
        includeFullBunEngine: true,
      });
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/**
 * Emit the wall-clock build duration so the startup-budget gate
 * (packages/app/scripts/check-startup-budget.mjs) can regression-check build
 * time (issue #14414). Opt-in via ELIZA_MOBILE_BUILD_TIMING_OUT so default
 * builds are byte-for-byte unchanged; the file records the wall-clock the
 * `build` budget target is defined against.
 */
function writeBuildTiming(target, buildMs) {
  const out = process.env.ELIZA_MOBILE_BUILD_TIMING_OUT;
  if (!out) return;
  const budgetTarget =
    process.env.ELIZA_MOBILE_BUILD_TIMING_TARGET ??
    (target.startsWith("ios") ? "ios-ipa" : "android-apk");
  fs.writeFileSync(
    out,
    `${JSON.stringify(
      {
        capturedAtIso: new Date().toISOString(),
        buildTarget: target,
        target: budgetTarget,
        buildMs: Math.round(buildMs),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `[mobile-build] build timing: ${Math.round(buildMs)}ms → ${out} (budget target ${budgetTarget})`,
  );
}

if (isMain) {
  console.log(`[mobile-build] App: ${APP.appName} (${APP.appId})`);
  const buildStart = Date.now();
  await main();
  writeBuildTiming(process.argv[2], Date.now() - buildStart);
}
