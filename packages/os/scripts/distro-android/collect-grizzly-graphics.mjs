#!/usr/bin/env node
/** Collect fail-closed Pixel graphics bring-up evidence without mutating the device. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function fail(message) {
  throw new Error(`[distro-android:grizzly-graphics] ${message}`);
}

export function parseArgs(argv) {
  const options = {
    adb: process.env.ADB || "adb",
    serial: process.env.ANDROID_SERIAL || "",
    outputDir: path.join(repoRoot, "out/grizzly-graphics-evidence"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--adb" && value) {
      // Only resolve paths; a bare command name ("adb") must stay a PATH
      // lookup instead of becoming $PWD/adb.
      options.adb = value.includes(path.sep) ? path.resolve(value) : value;
      index += 1;
    } else if ((argument === "--serial" || argument === "-s") && value) {
      options.serial = value;
      index += 1;
    } else if (argument === "--output-dir" && value) {
      options.outputDir = path.resolve(value);
      index += 1;
    } else {
      fail(`unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}

function adbArguments(serial, args) {
  return serial ? ["-s", serial, ...args] : args;
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function runProbe({ adb, serial, outputDir }, probe) {
  const args = adbArguments(serial, probe.args);
  const result = spawnSync(adb, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: probe.timeoutMs ?? 60_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const stdoutPath = path.join(outputDir, `${probe.name}.stdout.txt`);
  const stderrPath = path.join(outputDir, `${probe.name}.stderr.txt`);
  fs.writeFileSync(stdoutPath, stdout);
  fs.writeFileSync(stderrPath, stderr);
  return {
    name: probe.name,
    argv: [adb, ...args],
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout: {
      path: path.basename(stdoutPath),
      bytes: Buffer.byteLength(stdout),
      sha256: digest(stdout),
    },
    stderr: {
      path: path.basename(stderrPath),
      bytes: Buffer.byteLength(stderr),
      sha256: digest(stderr),
    },
  };
}

export const GRAPHICS_PROBES = [
  { name: "properties", args: ["shell", "getprop"] },
  {
    name: "graphics-properties",
    args: ["shell", "getprop"],
  },
  {
    name: "graphics-libraries",
    args: ["shell", "find /vendor/lib64 /system/lib64 -maxdepth 3 -type f"],
  },
  {
    name: "graphics-library-contexts",
    args: [
      "shell",
      "ls -laZ /vendor/lib64/egl /vendor/lib64/hw /system/lib64/egl /system/lib64/hw 2>&1",
    ],
  },
  { name: "services", args: ["shell", "service list"] },
  { name: "hal-services", args: ["shell", "lshal"] },
  {
    name: "surfaceflinger-service",
    args: ["shell", "getprop init.svc.surfaceflinger"],
  },
  {
    name: "surfaceflinger-dump",
    args: ["shell", "dumpsys SurfaceFlinger"],
    timeoutMs: 120_000,
  },
  { name: "gpu-dump", args: ["shell", "dumpsys gpu"] },
  { name: "vulkan-json", args: ["shell", "cmd gpu vkjson"] },
  {
    name: "vendor-vintf",
    // Record absent optional fragments but retain failures reading existing ones.
    args: [
      "shell",
      'status=0; for f in /vendor/etc/vintf/manifest.xml /vendor/etc/vintf/manifest/*.xml; do if [ -e "$f" ]; then echo "===$f"; cat "$f" || status=1; else echo "ABSENT $f"; fi; done; exit "$status"',
    ],
  },
  {
    name: "graphics-processes",
    // Capture the raw inventory; filtering must not mask collection failures.
    args: ["shell", "ps -AZ"],
  },
  {
    name: "kernel-graphics",
    // dmesg is root-only on a booted userdebug device; the denial lands in
    // stderr as evidence and must remain a failed probe.
    args: ["shell", "dmesg"],
  },
  {
    name: "logcat-all",
    args: ["logcat", "-b", "all", "-d", "-v", "threadtime"],
    timeoutMs: 120_000,
  },
];

export function probeSucceeded(probe) {
  return probe.status === 0 && probe.signal === null && probe.error === null;
}

function requireReachableDevice(options) {
  const result = spawnSync(
    options.adb,
    adbArguments(options.serial, ["get-state"]),
    { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
  );
  if (result.status !== 0 || result.stdout.trim() !== "device") {
    fail(
      `adb device is not reachable: ${result.error?.message ?? (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`)}`,
    );
  }
}

export function collectGraphicsEvidence(options) {
  requireReachableDevice(options);
  fs.mkdirSync(options.outputDir, { recursive: true });
  const probes = GRAPHICS_PROBES.map((probe) => runProbe(options, probe));
  const failedProbeNames = probes
    .filter((probe) => !probeSucceeded(probe))
    .map((probe) => probe.name);
  const manifest = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    deviceSerial: options.serial || "adb-default-device",
    readOnly: true,
    complete: failedProbeNames.length === 0,
    failedProbeNames,
    probes,
  };
  const manifestPath = path.join(options.outputDir, "evidence-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, manifest };
}

export function main(argv = process.argv.slice(2)) {
  const result = collectGraphicsEvidence(parseArgs(argv));
  process.stdout.write(
    `${JSON.stringify({ event: "grizzly_graphics_evidence_collected", manifest: result.manifestPath, probes: result.manifest.probes.length })}\n`,
  );
  if (!result.manifest.complete) {
    fail(
      `incomplete evidence; failed probes: ${result.manifest.failedProbeNames.join(", ")}`,
    );
  }
}

const isMain = isMainModule(import.meta);

if (isMain) main();
