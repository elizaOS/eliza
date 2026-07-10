#!/usr/bin/env node
/**
 * Command-line helper for the Android Adb Install app packaging, mobile, or
 * Playwright automation lane.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveApk } from "./lib/android-device.mjs";
import { assertAndroidApkRendererFresh } from "./lib/android-renderer-stamp.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(appRoot, "..", "..");

function readFlag(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  if (value) return value.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index !== -1) return process.argv[index + 1];
  return null;
}

const args = new Set(process.argv.slice(2));
const serial = readFlag("--serial") ?? process.env.ANDROID_SERIAL ?? null;
const apkArg = readFlag("--apk");
const shouldBuild = args.has("--build");
const shouldLaunch = !args.has("--no-launch");

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: options.cwd ?? appRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: options.stdio ?? "pipe",
  });
}

function fail(message, detail = "") {
  console.error(`android-adb-install: ${message}`);
  if (detail) console.error(detail.trim());
  process.exit(1);
}

function commandExists(command) {
  // `command -v` is a shell builtin — must run through a shell, or spawnSync
  // looks for a binary literally named "command" and always fails on Linux.
  const result = spawnSync(
    process.platform === "win32" ? "where" : "command",
    process.platform === "win32" ? [command] : ["-v", command],
    { encoding: "utf8", shell: true, stdio: "ignore" },
  );
  return result.status === 0;
}

/** Locate aapt2/aapt from the Android SDK build-tools (newest first), or PATH. */
function findAapt() {
  for (const name of ["aapt2", "aapt"]) {
    if (commandExists(name)) return name;
  }
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    path.join(process.env.HOME ?? "", "Android", "Sdk");
  const buildTools = path.join(sdk, "build-tools");
  if (!fs.existsSync(buildTools)) return null;
  const versions = fs.readdirSync(buildTools).sort().reverse();
  for (const v of versions) {
    for (const name of ["aapt2", "aapt"]) {
      const p = path.join(buildTools, v, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function adbArgs(extra) {
  return serial ? ["-s", serial, ...extra] : extra;
}

function readAppId() {
  const src = fs.readFileSync(path.join(appRoot, "app.config.ts"), "utf8");
  const appId = src.match(/appId:\s*["']([^"']+)["']/)?.[1];
  if (!appId) fail("could not parse appId from packages/app/app.config.ts");
  return appId;
}

/**
 * The package name baked INTO the APK. We assert it matches the expected appId
 * before installing — otherwise a wrong-brand build (for example, a custom app APK
 * produced when the repoRoot resolved to the wrapper) silently installs a
 * different package and never touches the one we think we're updating. Prefer
 * aapt; fall back to scanning the (binary) AndroidManifest for the package id.
 */
function readApkPackage(apkPath) {
  const aapt = findAapt();
  if (aapt) {
    const r = run(aapt, ["dump", "badging", apkPath]);
    const m = r.stdout?.match(/package:\s+name='([^']+)'/);
    if (m) return m[1];
  }
  // Fallback when aapt is absent: the package id lives in the binary
  // AndroidManifest string pool — UTF-16LE on older aapt, UTF-8 on newer. Try
  // both string encodings.
  for (const enc of ["l", "s"]) {
    const r = run("sh", [
      "-c",
      `unzip -p ${JSON.stringify(apkPath)} AndroidManifest.xml | strings -e ${enc} | grep -oE '[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+\\.app' | head -1`,
    ]);
    if (r.stdout?.trim()) return r.stdout.trim();
  }
  return null;
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function currentHeadCommit() {
  const result = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

if (!commandExists("adb")) {
  fail(
    "adb was not found",
    "Install Android SDK platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT so adb is on PATH.",
  );
}

if (shouldBuild) {
  const build = run("bun", ["run", "build:android"], { stdio: "inherit" });
  if (build.status !== 0) {
    fail("Android build failed");
  }
}

const devices = run("adb", ["devices"]);
if (devices.status !== 0) {
  fail("adb devices failed", devices.stderr || devices.stdout);
}

const onlineDevices = devices.stdout
  .split("\n")
  .slice(1)
  .map((line) => line.trim().split(/\s+/))
  .filter((parts) => parts.length >= 2 && parts[1] === "device")
  .map((parts) => parts[0]);

if (serial && !onlineDevices.includes(serial)) {
  fail(
    `ANDROID_SERIAL ${serial} is not online`,
    `Online devices: ${onlineDevices.join(", ") || "none"}`,
  );
}

if (!serial && onlineDevices.length !== 1) {
  fail(
    onlineDevices.length === 0
      ? "no online Android device found"
      : "multiple Android devices found; pass --serial",
    devices.stdout,
  );
}

let apkPath;
try {
  apkPath = resolveApk(apkArg);
} catch (error) {
  fail("APK not found", error instanceof Error ? error.message : String(error));
}

const appId = readAppId();

// Guard against installing the wrong brand/package: the APK's own package id must
// match the appId we expect. Catches the custom-package-built-while-expecting-
// `ai.elizaos.app` trap, where `install -r` "succeeds" by writing a different
// package and the app we're testing is never updated.
const apkPackage = readApkPackage(apkPath);
if (apkPackage && apkPackage !== appId) {
  fail(
    `APK package mismatch — refusing to install`,
    `app.config.ts expects "${appId}" but ${path.relative(process.cwd(), apkPath)} is package "${apkPackage}".\n` +
      `You likely built the wrong brand (check repoRoot / ELIZA_ANDROID_USE_APP_DIR). Pass the matching --apk.`,
  );
}

assertAndroidApkRendererFresh({
  apkPath,
  repoRoot,
  expectedCommit: currentHeadCommit(),
  label: path.relative(process.cwd(), apkPath),
  log: (message) => console.log(`android-adb-install: ${message}`),
});

console.log(
  `Installing ${path.relative(process.cwd(), apkPath)} (${apkPackage ?? appId}) to ${serial ?? onlineDevices[0]}`,
);
const install = run("adb", adbArgs(["install", "-r", apkPath]), {
  stdio: "inherit",
});
if (install.status !== 0) {
  fail("adb install failed");
}

const packageCheck = run("adb", adbArgs(["shell", "pm", "path", appId]));
if (packageCheck.status !== 0 || !packageCheck.stdout.includes(appId)) {
  fail(`installed package ${appId} was not found`, packageCheck.stderr);
}

// Verify the bytes actually landed: the on-device base.apk must hash-match the
// APK we just installed. This is the definitive "the install is what we expect"
// check — a stale/cached/redirected install fails here instead of silently
// running old code.
const onDevicePath = packageCheck.stdout
  .split("\n")
  .map((line) => line.replace("package:", "").trim())
  .find((line) => line.endsWith("base.apk"));
if (onDevicePath) {
  const deviceHash = run("adb", adbArgs(["shell", "sha256sum", onDevicePath]))
    .stdout?.trim()
    .split(/\s+/)[0];
  const localHash = sha256File(apkPath);
  if (deviceHash && deviceHash !== localHash) {
    fail(
      `on-device APK does not match the installed file`,
      `device sha256=${deviceHash}\nlocal  sha256=${localHash}\nThe install did not replace the on-device APK (storage/permission/installer issue).`,
    );
  }
  console.log(
    `Verified on-device APK hash matches (${localHash.slice(0, 12)}…).`,
  );
}

if (shouldLaunch) {
  const launch = run("adb", adbArgs(["shell", "monkey", "-p", appId, "1"]), {
    stdio: "inherit",
  });
  if (launch.status !== 0) {
    fail("installed app, but launch failed");
  }
}

console.log(`Android install verified for ${appId}.`);
