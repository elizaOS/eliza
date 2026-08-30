#!/usr/bin/env bun
/**
 * Ensures a source checkout can run the fused desktop inference backend after
 * `bun install`. The installer initializes the pinned native submodule,
 * provisions missing host build prerequisites where supported, and delegates
 * freshness verification plus staging to the canonical app-core build script.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "..", "..", "..");

function log(message) {
  console.log(`[ensure-fused-inference] ${message}`);
}

function commandResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    env: options.env,
  });
}

function commandAvailable(command, args = ["--version"]) {
  const result = commandResult(command, args);
  return !result.error && result.status === 0;
}

function runChecked(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const result = commandResult(command, args, {
    ...options,
    stdio: options.stdio ?? "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? result.signal}`);
  }
}

function linuxPackagesMissing() {
  const packages = [];
  if (!commandAvailable("cmake")) packages.push("cmake");
  if (!commandAvailable("c++") && !commandAvailable("g++")) {
    packages.push("build-essential");
  }
  if (!commandAvailable("ninja", ["--version"])) packages.push("ninja-build");
  if (!commandAvailable("pkg-config", ["--version"])) {
    packages.push("pkg-config");
  }
  const espeak = commandResult("pkg-config", ["--exists", "espeak-ng"]);
  if (espeak.status !== 0) packages.push("libespeak-ng-dev");
  return packages;
}

function provisionLinuxPackages(packages, run = runChecked) {
  if (packages.length === 0) return;
  if (!commandAvailable("apt-get", ["--version"])) {
    throw new Error(
      `missing native build prerequisites: ${packages.join(", ")}. ` +
        "Install the equivalent packages for this Linux distribution and rerun bun install.",
    );
  }

  const root = typeof process.getuid === "function" && process.getuid() === 0;
  const prefix = root ? [] : ["-n"];
  if (!root) {
    const sudo = commandResult("sudo", ["-n", "true"]);
    if (sudo.error || sudo.status !== 0) {
      throw new Error(
        `missing native build prerequisites: ${packages.join(", ")}. ` +
          `Run \`sudo apt-get update && sudo apt-get install -y ${packages.join(" ")}\`, then rerun bun install.`,
      );
    }
  }

  const command = root ? "apt-get" : "sudo";
  run(command, [...prefix, "apt-get", "update"].slice(root ? 1 : 0));
  run(
    command,
    [...prefix, "apt-get", "install", "-y", ...packages].slice(root ? 1 : 0),
  );
}

function provisionMacPackages(run = runChecked) {
  const packages = [];
  if (!commandAvailable("cmake")) packages.push("cmake");
  if (!commandAvailable("ninja", ["--version"])) packages.push("ninja");
  if (!commandAvailable("pkg-config", ["--version"]))
    packages.push("pkg-config");
  const espeak = commandResult("pkg-config", ["--exists", "espeak-ng"]);
  if (espeak.status !== 0) packages.push("espeak-ng");
  if (packages.length === 0) return;
  if (!commandAvailable("brew", ["--version"])) {
    throw new Error(
      `missing native build prerequisites: ${packages.join(", ")}. Install Homebrew and rerun bun install.`,
    );
  }
  run("brew", ["install", ...packages]);
}

export function ensureFusedInferenceInstall({
  env = process.env,
  platform = process.platform,
  repoRoot = defaultRepoRoot,
  bunExecutable = process.execPath,
  run = runChecked,
  provision = true,
  findLinuxPackages = linuxPackagesMissing,
  provisionLinux = provisionLinuxPackages,
  provisionMac = provisionMacPackages,
} = {}) {
  if (env.ELIZA_SKIP_FUSED_INFERENCE_SETUP === "1") {
    log("skipped by ELIZA_SKIP_FUSED_INFERENCE_SETUP=1");
    return { status: "skipped" };
  }
  if (!["linux", "darwin", "win32"].includes(platform)) {
    throw new Error(
      `unsupported desktop platform for fused inference: ${platform}`,
    );
  }

  const forkPath = "plugins/plugin-local-inference/native/llama.cpp";
  run("git", ["submodule", "update", "--init", "--recursive", forkPath], {
    cwd: repoRoot,
  });

  if (provision && platform === "linux") {
    provisionLinux(findLinuxPackages(), run);
  } else if (provision && platform === "darwin") {
    provisionMac(run);
  }

  const stageScript = path.join(
    repoRoot,
    "packages/app-core/scripts/stage-desktop-fused-lib.mjs",
  );
  run(bunExecutable, [stageScript, "--ensure"], { cwd: repoRoot, env });
  log("fused desktop inference is installed and current");
  return { status: "ready" };
}

if (import.meta.main) {
  try {
    ensureFusedInferenceInstall();
  } catch (error) {
    console.error(`[ensure-fused-inference] ERROR: ${error.message}`);
    process.exit(1);
  }
}
