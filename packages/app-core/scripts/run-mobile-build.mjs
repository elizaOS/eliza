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
    "build.gradle",
    "settings.gradle",
    "variables.gradle",
    "capacitor.settings.gradle",
    path.join("app", "build.gradle"),
    path.join("app", "capacitor.build.gradle"),
  ],
  ios: [path.join("App", "Podfile")],
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

  for (const relativeFile of templateFiles) {
    const sourcePath = path.join(templateRoot, relativeFile);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }

    const destinationPath = path.join(targetRoot, relativeFile);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    copiedFiles.push(relativeFile);
  }

  if (copiedFiles.length > 0) {
    log(
      `[mobile-build] Synced ${platform} platform template files: ${copiedFiles.join(", ")}`,
    );
  }

  return copiedFiles;
}

function getCapacitorPlatformRoot(platform) {
  return platform === "android" ? androidDir : iosPlatformDir;
}

function isCapacitorPlatformReady(platform) {
  if (platform === "android") {
    return (
      fs.existsSync(path.join(androidDir, "gradlew")) &&
      fs.existsSync(path.join(androidDir, "app", "build.gradle"))
    );
  }

  return (
    fs.existsSync(path.join(iosDir, "Podfile")) &&
    fs.existsSync(path.join(iosDir, "App.xcodeproj", "project.pbxproj"))
  );
}

async function ensureCapacitorPlatform(platform) {
  if (isCapacitorPlatformReady(platform)) {
    return;
  }

  const platformRootDir = getCapacitorPlatformRoot(platform);
  if (fs.existsSync(platformRootDir)) {
    if (process.env.CI !== "true") {
      throw new Error(
        `Capacitor ${platform} platform at ${platformRootDir} is incomplete. Remove it or run 'bun x capacitor add ${platform}' before retrying.`,
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
  syncPlatformTemplateFiles("android");

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
  syncPlatformTemplateFiles("ios");
  await ensureIosWorkspace();
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
      "generic/platform=iOS Simulator",
      "-sdk",
      "iphonesimulator",
      "CODE_SIGNING_ALLOWED=NO",
      "build",
    ],
    { cwd: iosDir },
  );
}

export async function main(target = process.argv[2]) {
  if (target !== "android" && target !== "ios") {
    console.error("Usage: node scripts/run-mobile-build.mjs <android|ios>");
    process.exit(1);
  }

  if (target === "android") {
    await buildAndroid();
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
