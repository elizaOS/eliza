#!/usr/bin/env node
/**
 * Smoke probe for the buun-llama-cpp fork binaries installed under
 * `$ELIZA_STATE_DIR/local-inference/bin/dflash/<platform>-<arch>-<backend>/`.
 *
 * For each per-target directory found, runs `<binary> --version`, parses the
 * version line, and prints a single status row. Used by CI immediately after
 * the fork build step to fail fast on broken binaries.
 *
 * Exit-code contract:
 *   0  no targets found, or every target produced a recognizable version line.
 *   1  at least one target's binary failed to execute or did not print a
 *      recognizable version line.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const EXECUTABLE_NAMES = [
  "llama-server",
  "llama-cli",
  "llama-speculative-simple",
];

function stateDir() {
  return (
    process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza")
  );
}

function dflashRoot() {
  return path.join(stateDir(), "local-inference", "bin", "dflash");
}

function listTargets(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Decide whether `target` (e.g. "android-arm64-cpu") can plausibly execute
 * on the current host. Cross-compiled binaries (Android arm64 on Linux x64,
 * Windows on POSIX, etc.) are recognised as `--version` failures only because
 * they're for a different platform — not because they're broken. We skip
 * those with a clear log line so CI runners don't false-fail on cross builds.
 */
function targetMatchesHost(target) {
  const [targetPlatform, targetArch] = target.split("-");
  const hostPlatform = process.platform;
  const hostArch = process.arch;
  // platform: linux | darwin | win32 | android | windows
  const platformMatch =
    targetPlatform === hostPlatform ||
    (targetPlatform === "windows" && hostPlatform === "win32");
  // arch: x64 | arm64 | armv7l | ... (matches Node's process.arch)
  const archMatch = targetArch === hostArch;
  return platformMatch && archMatch;
}

function probeBinary(binaryPath) {
  if (!fs.existsSync(binaryPath)) {
    return { ok: false, reason: `missing: ${binaryPath}` };
  }
  const result = spawnSync(binaryPath, ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) {
    return { ok: false, reason: `spawn error: ${result.error.message}` };
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().split(/\r?\n/)[0] ?? "";
    return { ok: false, reason: `exit ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const versionLine =
    out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(
        (line) =>
          /version[:\s]/i.test(line) ||
          /\bbuild\b/i.test(line) ||
          /^llama\s/i.test(line),
      ) ?? out.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
  if (!versionLine) {
    return { ok: false, reason: "no version line printed" };
  }
  return { ok: true, version: versionLine };
}

function probeTarget(targetDir, target) {
  const rows = [];
  for (const name of EXECUTABLE_NAMES) {
    const bin = path.join(targetDir, name);
    if (!fs.existsSync(bin)) continue;
    const probe = probeBinary(bin);
    if (probe.ok) {
      console.log(`OK ${target} ${name} ${probe.version}`);
      rows.push({ ok: true });
    } else {
      console.log(`FAIL ${target} ${name} ${probe.reason}`);
      rows.push({ ok: false });
    }
  }
  if (rows.length === 0) {
    console.log(`FAIL ${target} no recognized executables in ${targetDir}`);
    return false;
  }
  return rows.every((row) => row.ok);
}

function main() {
  const root = dflashRoot();
  const targets = listTargets(root);
  if (targets.length === 0) {
    console.log(`no targets found under ${root}, skipping`);
    process.exit(0);
  }
  let allOk = true;
  for (const target of targets) {
    if (!targetMatchesHost(target)) {
      console.log(
        `SKIP ${target} cross-compiled for ${process.platform}-${process.arch} host (verify on a matching device)`,
      );
      continue;
    }
    const targetDir = path.join(root, target);
    const ok = probeTarget(targetDir, target);
    if (!ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

main();
