/**
 * Canonical Capacitor iOS/Android trees live under `packages/app-core/platforms/{ios,android}`.
 * They are copied into the host app (e.g. `packages/app/ios`) by sync scripts and mobile build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultAppCoreRoot = path.resolve(__dirname, "..", "..");

const SKIPPED_TEMPLATE_DIRS = new Set([
  ".git",
  ".gradle",
  ".idea",
  ".turbo",
  ".cxx",
  ".externalNativeBuild",
  "build",
  "DerivedData",
  "node_modules",
  "Pods",
  "vendor",
  "xcuserdata",
]);

const SKIPPED_TEMPLATE_FILES = new Set([
  ".DS_Store",
  "local.properties",
  path.join("app", "src", "main", "assets", "capacitor.config.json"),
  path.join("app", "src", "main", "assets", "capacitor.plugins.json"),
  path.join("app", "src", "main", "res", "xml", "config.xml"),
  path.join("App", "App", "capacitor.config.json"),
  path.join("App", "App", "config.xml"),
]);

const SKIPPED_TEMPLATE_PREFIXES = [
  path.join("app", "src", "main", "assets", "agent"),
  path.join("app", "src", "main", "assets", "public"),
  path.join("App", "App", "public"),
  path.join("App", "CapApp-SPM"),
  "capacitor-cordova-ios-plugins",
];

const SKIPPED_TEMPLATE_EXTENSIONS = new Set([
  ".aab",
  ".apk",
  ".ap_",
  ".class",
  ".dex",
  ".hprof",
  ".iml",
  ".jks",
  ".keystore",
  ".log",
]);

const PLATFORM_OVERRIDE_DIRS = ["native-overrides", "platform-overrides"];
const REPLACED_ASSET_CATALOG_DIRS = [
  path.join("App", "App", "Assets.xcassets", "AppIcon.appiconset"),
  path.join("App", "App", "Assets.xcassets", "Splash.imageset"),
];

function hasSkippedPrefix(relPath) {
  return SKIPPED_TEMPLATE_PREFIXES.some(
    (prefix) =>
      relPath === prefix || relPath.startsWith(`${prefix}${path.sep}`),
  );
}

function shouldCopyTemplatePath(relPath) {
  const segments = relPath.split(path.sep);
  if (segments.some((segment) => SKIPPED_TEMPLATE_DIRS.has(segment))) {
    return false;
  }
  if (SKIPPED_TEMPLATE_FILES.has(relPath) || hasSkippedPrefix(relPath)) {
    return false;
  }
  const filename = segments.at(-1) ?? "";
  if (
    SKIPPED_TEMPLATE_FILES.has(filename) ||
    SKIPPED_TEMPLATE_EXTENSIONS.has(path.extname(filename))
  ) {
    return false;
  }
  return true;
}

function collectTemplateFiles(root, dir = root) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath);
    if (!shouldCopyTemplatePath(relPath)) continue;
    if (entry.isDirectory()) {
      files.push(...collectTemplateFiles(root, fullPath));
    } else if (entry.isFile()) {
      files.push(relPath);
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
    path.join("App", "App", "ElizaIntentPlugin.swift"),
    path.join("App", "App", "PrivacyInfo.xcprivacy"),
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
    path.join(
      "App",
      "App",
      "WebsiteBlockerContentExtension",
      "PrivacyInfo.xcprivacy",
    ),
  ];
  const index = priority.indexOf(relPath);
  return `${String(index === -1 ? priority.length : index).padStart(4, "0")}:${relPath}`;
}

/**
 * @param {"ios"|"android"} platform
 * @param {{ repoRootValue: string }} options
 */
export function resolvePlatformTemplateRoot(
  platform,
  { repoRootValue, appCoreRootValue = defaultAppCoreRoot },
) {
  const candidates = [
    path.join(repoRootValue, "packages", "app-core", "platforms", platform),
    path.join(
      repoRootValue,
      "eliza",
      "packages",
      "app-core",
      "platforms",
      platform,
    ),
    path.join(appCoreRootValue, "platforms", platform),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolvePlatformOverrideRoots(platform, { appDirValue }) {
  return PLATFORM_OVERRIDE_DIRS.map((dirName) =>
    path.join(appDirValue, dirName, platform),
  ).filter((candidate) => fs.existsSync(candidate));
}

function copyPlatformFiles({ files, platform, sourceRoot, targetRoot }) {
  removeStaleAssetCatalogImages({ sourceRoot, targetRoot });
  const copied = [];
  for (const relPath of files.sort((a, b) =>
    templateFilePriority(platform, a).localeCompare(
      templateFilePriority(platform, b),
    ),
  )) {
    const source = path.join(sourceRoot, relPath);
    const targetPath = path.join(targetRoot, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(source, targetPath);
    fs.chmodSync(targetPath, fs.statSync(source).mode & 0o777);
    copied.push(relPath);
  }
  return copied;
}

function removeStaleAssetCatalogImages({ sourceRoot, targetRoot }) {
  for (const relDir of REPLACED_ASSET_CATALOG_DIRS) {
    const sourceDir = path.join(sourceRoot, relDir);
    const targetDir = path.join(targetRoot, relDir);
    if (!fs.existsSync(sourceDir) || !fs.existsSync(targetDir)) continue;

    const sourcePngs = new Set(
      fs
        .readdirSync(sourceDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
        .map((entry) => entry.name),
    );
    for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        entry.name.endsWith(".png") &&
        !sourcePngs.has(entry.name)
      ) {
        fs.rmSync(path.join(targetDir, entry.name));
      }
    }
  }
}

function syncPlatformOverrideFiles(
  platform,
  { appDirValue, targetRoot, log = console.log },
) {
  const copied = [];
  for (const overrideRoot of resolvePlatformOverrideRoots(platform, {
    appDirValue,
  })) {
    copied.push(
      ...copyPlatformFiles({
        files: collectTemplateFiles(overrideRoot),
        platform,
        sourceRoot: overrideRoot,
        targetRoot,
      }),
    );
  }
  if (copied.length > 0) {
    log(
      `[mobile-build] Applied ${copied.length} ${platform} app override file(s).`,
    );
  }
  return copied;
}

/**
 * @param {"ios"|"android"} platform
 * @param {{ repoRootValue: string, appDirValue: string, log?: (msg: string) => void }} options
 * @returns {string[]}
 */
export function syncPlatformTemplateFiles(
  platform,
  { repoRootValue, appDirValue, log = console.log },
) {
  const templateRoot = resolvePlatformTemplateRoot(platform, { repoRootValue });
  if (!templateRoot) return [];
  const targetRoot = path.join(appDirValue, platform);
  const copied = copyPlatformFiles({
    files: collectTemplateFiles(templateRoot),
    platform,
    sourceRoot: templateRoot,
    targetRoot,
  });
  if (copied.length > 0) {
    log(
      `[mobile-build] Synced ${copied.length} ${platform} platform template file(s).`,
    );
  }
  return [
    ...copied,
    ...syncPlatformOverrideFiles(platform, {
      appDirValue,
      targetRoot,
      log,
    }),
  ];
}

/**
 * @param {"ios"|"android"} platform
 * @param {{ appDirValue: string }} options
 */
export function isCapacitorPlatformReady(platform, { appDirValue }) {
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
      fs.existsSync(path.join(appDirValue, "android", "app", "build.gradle")) &&
      fs.existsSync(
        path.join(
          appDirValue,
          "android",
          "app",
          "src",
          "main",
          "AndroidManifest.xml",
        ),
      )
    );
  }
  return false;
}
