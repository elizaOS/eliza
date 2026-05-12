#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const defaultSourceDir = path.join(packageRoot, "vendor", "bun");
const defaultArtifact = path.join(
  packageRoot,
  "artifacts",
  "ElizaBunEngine.xcframework",
);

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg === name) return "1";
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return fallback;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
}

function targetInfo(raw) {
  const target = raw === "device" ? "device" : "simulator";
  return target === "device"
    ? {
        target,
        zigTarget: "aarch64-ios",
        sdk: "iphoneos",
        platform: "iOS",
      }
    : {
        target,
        zigTarget: "aarch64-ios-simulator",
        sdk: "iphonesimulator",
        platform: "iOS Simulator",
      };
}

function fail(message) {
  console.error(`[bun-ios-runtime] ${message}`);
  process.exit(1);
}

const info = targetInfo(argValue("--target", "simulator"));
const verifyOnly = process.argv.includes("--verify-only");
const sourceDir = path.resolve(
  process.env.ELIZA_BUN_IOS_SOURCE_DIR || defaultSourceDir,
);
const artifact = path.resolve(
  process.env.ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK || defaultArtifact,
);

if (fs.existsSync(artifact)) {
  console.log(`[bun-ios-runtime] Found ${artifact}`);
  process.exit(0);
}

if (verifyOnly) {
  fail(
    `missing ${artifact}; build the Bun fork first or set ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK`,
  );
}

if (!fs.existsSync(sourceDir)) {
  fail(
    [
      `Bun source checkout not found at ${sourceDir}.`,
      "Set ELIZA_BUN_IOS_SOURCE_DIR to an elizaos/bun checkout, or clone the fork there.",
      "The public https://github.com/elizaos/bun repository is not currently available,",
      "and upstream oven-sh/bun does not ship an iOS target.",
    ].join(" "),
  );
}

if (!fs.existsSync(path.join(sourceDir, "build.zig"))) {
  fail(`${sourceDir} does not look like a Bun source checkout (missing build.zig)`);
}

const explicitCommand = process.env.ELIZA_BUN_IOS_BUILD_COMMAND;
const env = {
  ...process.env,
  ELIZA_BUN_IOS_TARGET: info.target,
  ELIZA_BUN_IOS_ZIG_TARGET: info.zigTarget,
  ELIZA_BUN_IOS_SDK: info.sdk,
  ELIZA_BUN_IOS_PLATFORM: info.platform,
  ELIZA_IOS_BUN_ENGINE_XCFRAMEWORK: artifact,
};

if (explicitCommand) {
  console.log(`[bun-ios-runtime] Running ELIZA_BUN_IOS_BUILD_COMMAND for ${info.platform}`);
  run("bash", ["-lc", explicitCommand], { cwd: sourceDir, env });
} else {
  console.log(`[bun-ios-runtime] Updating Bun submodules`);
  run("git", ["submodule", "update", "--init", "--recursive"], {
    cwd: sourceDir,
    env,
  });
  console.log(`[bun-ios-runtime] Building JavaScriptCore/WebKit prerequisites`);
  run("make", ["jsc"], { cwd: sourceDir, env });
  console.log(`[bun-ios-runtime] Building Bun iOS engine target ${info.zigTarget}`);
  run(
    "zig",
    [
      "build",
      `-Dtarget=${info.zigTarget}`,
      "-Doptimize=ReleaseFast",
      "-Deliza-ios-engine=true",
      `-Deliza-ios-xcframework=${artifact}`,
    ],
    { cwd: sourceDir, env },
  );
}

if (!fs.existsSync(artifact)) {
  fail(
    `build completed but did not produce ${artifact}; the Bun fork must emit ElizaBunEngine.xcframework`,
  );
}

console.log(`[bun-ios-runtime] Built ${artifact}`);
