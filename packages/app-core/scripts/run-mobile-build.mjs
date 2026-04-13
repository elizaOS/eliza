#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const appDir = path.join(repoRoot, "apps", "app");
const iosDir = path.join(appDir, "ios", "App");
const androidDir = path.join(appDir, "android");
const prepareIosCocoapodsScript = path.join(
  repoRoot,
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
  await run("bun", ["run", "cap:sync:android"], { cwd: appDir });

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
      ":miladyai-capacitor-websiteblocker:testDebugUnitTest",
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
  await run("bash", [prepareIosCocoapodsScript], { cwd: repoRoot });
  await run("bun", ["run", "cap:sync:ios"], { cwd: appDir });
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

if (target === "android") {
  await buildAndroid();
} else {
  await buildIos();
}
