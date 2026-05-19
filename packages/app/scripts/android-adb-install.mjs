#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");

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
  const result = run("command", ["-v", command], { stdio: "ignore" });
  return result.status === 0;
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

function latestApk() {
  const roots = [
    path.join(appRoot, "android", "app", "build", "outputs", "apk"),
    path.join(appRoot, "android", "app", "build", "outputs"),
  ];
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        if (entry.isFile() && entry.name.endsWith(".apk")) {
          const stat = fs.statSync(full);
          candidates.push({ path: full, mtimeMs: stat.mtimeMs });
        }
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path ?? null;
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

const apkPath = apkArg ? path.resolve(apkArg) : latestApk();
if (!apkPath || !fs.existsSync(apkPath)) {
  fail(
    "APK not found",
    "Pass --apk <path> or run with --build to produce a sideload APK first.",
  );
}

const appId = readAppId();
console.log(
  `Installing ${path.relative(process.cwd(), apkPath)} to ${serial ?? onlineDevices[0]}`,
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

if (shouldLaunch) {
  const launch = run("adb", adbArgs(["shell", "monkey", "-p", appId, "1"]), {
    stdio: "inherit",
  });
  if (launch.status !== 0) {
    fail("installed app, but launch failed");
  }
}

console.log(`Android install verified for ${appId}.`);
