#!/usr/bin/env node
/**
 * One-command iOS DEVICE log retrieval.
 *
 * Two capture surfaces, both usable in one invocation:
 *   1. Console: relaunches the app with `devicectl … launch --console`
 *      attached and captures stdout/stderr for a BOUNDED duration
 *      (--duration, default 120 s), then detaches. This is the capture that
 *      produced device-boot-console.log in the #11030 evidence. NOTE: it
 *      relaunches the app — pass --no-console if you only want the trace file.
 *   2. Boot-trace file: pulls the boot-trace JSON from the app's data
 *      container via `devicectl device copy from` (--pull-boot-trace).
 *      Path defaults to DEFAULT_BOOT_TRACE_CONTAINER_PATH (see the D1
 *      coupling note in ios-device-lib.mjs); override with
 *      ELIZA_IOS_BOOT_TRACE_PATH or --boot-trace-path.
 *
 * Usage:
 *   node scripts/ios-device-logs.mjs [--device <id>] [--duration <sec>]
 *     [--output <file>] [--no-console] [--pull-boot-trace]
 *     [--boot-trace-path <container-relative>] [--bundle-id <id>]
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDevicectlDeviceList } from "./ios-device-devicectl.mjs";
import {
  BOOT_TRACE_SIBLING_CONTAINER_PATHS,
  DEFAULT_APP_BUNDLE_ID,
  DEFAULT_BOOT_TRACE_CONTAINER_PATH,
  findDeviceRecord,
  parseCliArgs,
  resolveDeviceId,
} from "./ios-device-lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");

const log = (message) => console.log(`[ios-device-logs] ${message}`);
const fail = (message) => {
  console.error(`[ios-device-logs] ERROR: ${message}`);
  process.exit(1);
};

function resolveDevice(deviceId) {
  const payload = readDevicectlDeviceList();
  const record = findDeviceRecord(payload, deviceId);
  if (!record)
    fail(`device "${deviceId}" not found. xcrun devicectl list devices`);
  return record;
}

function captureConsole({ device, bundleId, durationSeconds, outputFile }) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const out = fs.openSync(outputFile, "w");
  log(
    `relaunching ${bundleId} with console attached for ${durationSeconds}s → ${outputFile}`,
  );
  const child = spawn(
    "xcrun",
    [
      "devicectl",
      "device",
      "process",
      "launch",
      "--terminate-existing",
      "--console",
      "--device",
      device.identifier,
      bundleId,
    ],
    { stdio: ["ignore", out, out] },
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      // Bounded capture: detach by killing the attached console process.
      // The trailing "terminated due to signal 15" in the log is this kill,
      // not an app crash (same pattern as the #11030 evidence capture).
      child.kill("SIGTERM");
    }, durationSeconds * 1000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(out);
      if (settled) return;
      settled = true;
      const lines = fs.readFileSync(outputFile, "utf8").split("\n").length;
      log(
        `console capture finished (exit=${code ?? `signal ${signal}`}, ${lines} lines)`,
      );
      if (signal !== "SIGTERM" && code !== 0 && code !== null) {
        reject(
          new Error(
            `devicectl console exited early with ${code}. Is the phone unlocked and paired? See ${outputFile}`,
          ),
        );
        return;
      }
      resolve();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function copyFromDataContainer({
  device,
  bundleId,
  containerPath,
  outputFile,
}) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  return spawnSync(
    "xcrun",
    [
      "devicectl",
      "device",
      "copy",
      "from",
      "--device",
      device.identifier,
      "--domain-type",
      "appDataContainer",
      "--domain-identifier",
      bundleId,
      "--source",
      containerPath,
      "--destination",
      outputFile,
    ],
    { encoding: "utf8" },
  );
}

function pullBootTrace({ device, bundleId, containerPath, outputFile }) {
  log(`pulling boot trace ${containerPath} from ${bundleId} data container…`);
  const result = copyFromDataContainer({
    device,
    bundleId,
    containerPath,
    outputFile,
  });
  if (result.status !== 0) {
    // COUPLING (leg D1): the ElizaStartupTrace.swift sink may not be in the
    // installed build / may not have written yet — surface that as an
    // actionable message, not a stack trace.
    fail(
      `boot-trace pull failed (devicectl exit ${result.status}).\n${(result.stderr || "").trim()}\n` +
        `Likely causes: the app has not written ${containerPath} yet (the boot-trace ` +
        "sink in ElizaStartupTrace.swift must be in the installed build and a boot " +
        "must have run), or the path changed — override with --boot-trace-path / " +
        "ELIZA_IOS_BOOT_TRACE_PATH.",
    );
  }
  log(`boot trace → ${outputFile}`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    booleans: ["no-console", "pull-boot-trace", "help"],
  });
  if (args.help) {
    console.log(
      "Usage: node scripts/ios-device-logs.mjs [--device <id>] [--duration <sec>] [--output <file>] [--no-console] [--pull-boot-trace] [--boot-trace-path <path>] [--bundle-id <id>]",
    );
    return;
  }
  if (process.platform !== "darwin") fail("devicectl requires macOS.");

  const deviceId = resolveDeviceId({ flagValue: args.device ?? null });
  if (!deviceId) {
    fail(
      "no device given. Pass --device or set ELIZA_IOS_DEVICE_ID. List: xcrun devicectl list devices",
    );
  }
  const device = resolveDevice(deviceId);
  log(`device: ${device.name} (identifier ${device.identifier})`);

  const bundleId = args["bundle-id"] || DEFAULT_APP_BUNDLE_ID;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultDir = path.join(appRoot, "ios", "build", "device-logs");

  if (!args["no-console"]) {
    const durationSeconds = Number.parseInt(args.duration ?? "120", 10);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      fail(
        `--duration must be a positive integer of seconds, got ${args.duration}`,
      );
    }
    const outputFile =
      args.output || path.join(defaultDir, `console-${stamp}.log`);
    await captureConsole({ device, bundleId, durationSeconds, outputFile });
  }

  if (args["pull-boot-trace"]) {
    const containerPath =
      args["boot-trace-path"] ||
      process.env.ELIZA_IOS_BOOT_TRACE_PATH ||
      DEFAULT_BOOT_TRACE_CONTAINER_PATH;
    const outputRoot = path.dirname(args.output || path.join(defaultDir, "x"));
    const outputFile = path.join(
      outputRoot,
      `boot-trace-${stamp}${path.extname(containerPath) || ".jsonl"}`,
    );
    pullBootTrace({ device, bundleId, containerPath, outputFile });
    // Best-effort sibling: the rotated generation (eliza-boot-trace.prev.jsonl).
    // A missing file is expected (fresh install, no rotation yet) — not fatal.
    for (const sibling of BOOT_TRACE_SIBLING_CONTAINER_PATHS) {
      const siblingOut = path.join(
        outputRoot,
        `boot-trace-${stamp}-${path.basename(sibling)}`,
      );
      const result = copyFromDataContainer({
        device,
        bundleId,
        containerPath: sibling,
        outputFile: siblingOut,
      });
      if (result.status === 0) {
        log(`boot trace sibling → ${siblingOut}`);
      } else {
        log(
          `sibling ${sibling} not present (ok — rotation/renderer stream may not exist yet)`,
        );
      }
    }
  }

  if (args["no-console"] && !args["pull-boot-trace"]) {
    fail("--no-console without --pull-boot-trace leaves nothing to do.");
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => fail(error?.stack ?? String(error)));
}
