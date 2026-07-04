#!/usr/bin/env node
/**
 * Command-line helper for the Ios Sideload Helper app packaging, mobile, or
 * Playwright automation lane.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const cloudMode = args.has("--cloud");

function optionValue(name) {
  const prefixed = `${name}=`;
  const inline = rawArgs.find((arg) => arg.startsWith(prefixed));
  if (inline) return inline.slice(prefixed.length).trim() || undefined;
  const index = rawArgs.indexOf(name);
  if (index === -1) return undefined;
  const next = rawArgs[index + 1]?.trim();
  return next && !next.startsWith("--") ? next : undefined;
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: options.cwd ?? appRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: options.stdio ?? "pipe",
  });
}

function fail(message, detail = "") {
  console.error(`ios-sideload-helper: ${message}`);
  if (detail) console.error(detail.trim());
  process.exit(1);
}

function resolveAppPath() {
  const explicitAppPath =
    optionValue("--app") ?? process.env.ELIZA_IOS_APP_PATH;
  if (explicitAppPath) return path.resolve(explicitAppPath);
  const derivedDataPath = process.env.ELIZA_IOS_DERIVED_DATA_PATH?.trim();
  if (!derivedDataPath) return undefined;
  const configuration =
    optionValue("--configuration") ??
    process.env.ELIZA_IOS_BUILD_CONFIGURATION ??
    "Debug";
  return path.join(
    path.resolve(derivedDataPath),
    "Build",
    "Products",
    `${configuration}-iphoneos`,
    "App.app",
  );
}

function requireDeviceId() {
  const deviceId = optionValue("--device") ?? process.env.ELIZA_IOS_DEVICE_ID;
  if (!deviceId) {
    fail("missing device id", "Pass --device=<id> or set ELIZA_IOS_DEVICE_ID.");
  }
  return deviceId;
}

const willBuild =
  args.has("--build-device") ||
  args.has("--build-cloud-device") ||
  args.has("--build-sim") ||
  args.has("--build-cloud-sim");

if (!args.has("--skip-preflight")) {
  // When a build step follows, the currently staged bundle is about to be
  // replaced — skip the staged-bundle check here and re-run it post-build
  // (below) against what will actually be installed (#11030).
  const preflight = run(
    "node",
    [
      "scripts/mobile-release-preflight.mjs",
      "--platform=ios",
      "--sideload",
      ...(willBuild ? ["--skip-staged"] : []),
    ],
    { stdio: "inherit" },
  );
  if (preflight.status !== 0) {
    fail("preflight failed");
  }
}

if (args.has("--build-device")) {
  const build = run(
    "bun",
    ["run", cloudMode ? "build:ios:cloud:device" : "build:ios:local:device"],
    {
      stdio: "inherit",
    },
  );
  if (build.status !== 0) fail("device build failed");
}

if (args.has("--build-cloud-device")) {
  const build = run("bun", ["run", "build:ios:cloud:device"], {
    stdio: "inherit",
  });
  if (build.status !== 0) fail("device build failed");
}

if (args.has("--build-sim")) {
  const build = run(
    "bun",
    ["run", cloudMode ? "build:ios:cloud:sim" : "build:ios:local:sim"],
    {
      stdio: "inherit",
    },
  );
  if (build.status !== 0) fail("simulator build failed");
}

if (args.has("--build-cloud-sim")) {
  const build = run("bun", ["run", "build:ios:cloud:sim"], {
    stdio: "inherit",
  });
  if (build.status !== 0) fail("simulator build failed");
}

if (willBuild && !args.has("--skip-preflight")) {
  // Re-validate the FRESHLY staged bundle before any install/launch: a
  // cloud-mode bundle with no Agent.apiBase hangs a sideloaded device at
  // "Booting up…" (#11030).
  const staged = run(
    "node",
    [
      "scripts/mobile-release-preflight.mjs",
      "--platform=ios",
      "--sideload",
      "--staged-only",
    ],
    { stdio: "inherit" },
  );
  if (staged.status !== 0) {
    fail("staged-bundle preflight failed after build");
  }
}

const shouldInstall = args.has("--install") || args.has("--install-device");
const shouldLaunch = args.has("--launch");
const deviceId = shouldInstall || shouldLaunch ? requireDeviceId() : undefined;

if (shouldInstall) {
  const appPath = resolveAppPath();
  if (!appPath) {
    fail(
      "missing app path",
      "Pass --app=<path> or set ELIZA_IOS_APP_PATH / ELIZA_IOS_DERIVED_DATA_PATH.",
    );
  }
  if (!fs.existsSync(appPath)) {
    fail("app path does not exist", appPath);
  }
  const install = run(
    "xcrun",
    [
      "devicectl",
      "device",
      "install",
      "app",
      "--device",
      deviceId,
      appPath,
      "--timeout",
      optionValue("--timeout") ?? "120",
    ],
    { stdio: "inherit" },
  );
  if (install.status !== 0) fail("device install failed");
}

if (shouldLaunch) {
  const bundleId =
    optionValue("--bundle-id") ??
    process.env.ELIZA_IOS_BUNDLE_ID ??
    process.env.ELIZA_IOS_APP_ID ??
    "ai.elizaos.app";
  const launchArgs = [
    "devicectl",
    "device",
    "process",
    "launch",
    "--device",
    deviceId,
    bundleId,
    "--timeout",
    optionValue("--timeout") ?? "120",
  ];
  if (!args.has("--no-terminate-existing")) {
    launchArgs.push("--terminate-existing");
  }
  const launch = run("xcrun", launchArgs, { stdio: "inherit" });
  if (launch.status !== 0) fail("device launch failed");
}

if (!args.has("--no-open") && !shouldInstall && !shouldLaunch) {
  const opened = run("open", ["ios/App/App.xcworkspace"], {
    stdio: "inherit",
  });
  if (opened.status !== 0) {
    fail("could not open Xcode workspace");
  }
}

console.log(`
iOS developer install next steps:
- Select your Apple development team in Xcode if signing is not automatic.
- Select a paired, unlocked device with Developer Mode enabled.
- Press Run in Xcode to install.
- On first install, trust the developer certificate on the device if iOS asks.
- Free development profiles can expire after roughly 7 days; paid development
  profiles can expire after roughly 1 year.
- Public iOS distribution still must use TestFlight or the App Store.
`);
