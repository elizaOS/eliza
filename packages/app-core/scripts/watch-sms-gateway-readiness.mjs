#!/usr/bin/env node
/**
 * Wait until one physical SMS gateway path becomes actionable.
 *
 * By default this only reports the command to run. Pass --run-install to run
 * the Android install/watch flow automatically once exactly one adb device is
 * visible.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const installScript = path.join(scriptDir, "install-android-sms-gateway.mjs");
const adbPath = "/opt/homebrew/share/android-commandlinetools/platform-tools/adb";

function usage() {
  return [
    "Usage: node packages/app-core/scripts/watch-sms-gateway-readiness.mjs [options]",
    "",
    "Options:",
    "  --timeout <seconds>   Stop waiting after this many seconds. Defaults to 300.",
    "  --interval <seconds>  Poll interval. Defaults to 5.",
    "  --run-install         Run Android install/watch flow when one adb device appears.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    timeoutSeconds: 300,
    intervalSeconds: 5,
    runInstall: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--timeout") args.timeoutSeconds = Number.parseInt(next(), 10);
    else if (arg === "--interval") args.intervalSeconds = Number.parseInt(next(), 10);
    else if (arg === "--run-install") args.runInstall = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (key === "runInstall") continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${key} must be a non-negative integer`);
    }
  }
  return args;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

function listAdbDevices() {
  const result = run(adbPath, ["devices", "-l"]);
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\bdevice\b/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

function readBridgeDoctor() {
  const result = run("curl", ["-sS", "--max-time", "5", "http://127.0.0.1:8795/doctor"]);
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function bridgeOutboundReady(doctor) {
  if (!Array.isArray(doctor?.checks)) return false;
  return doctor.checks.every(
    (check) => check.name === "pending-replies" || check.status === "pass",
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runInstallFlow() {
  const result = spawnSync(
    "node",
    [
      installScript,
      "--wait-device",
      "1",
      "--grant-role",
      "--clear-logcat",
      "--watch-logs",
      "60",
    ],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + args.timeoutSeconds * 1000;

  while (Date.now() <= deadline) {
    const devices = listAdbDevices();
    const bridgeDoctor = readBridgeDoctor();
    const bridgeReady = bridgeOutboundReady(bridgeDoctor);

    if (devices.length === 1) {
      console.log(`[sms-gateway-watch] adb device ready: ${devices[0]}`);
      if (args.runInstall) runInstallFlow();
      console.log(
        "Run: node packages/app-core/scripts/install-android-sms-gateway.mjs --grant-role --clear-logcat --watch-logs 60",
      );
      return;
    }

    if (devices.length > 1) {
      console.log(
        `[sms-gateway-watch] multiple adb devices: ${devices.join(", ")}; pass --serial to install script`,
      );
      return;
    }

    if (bridgeReady) {
      console.log("[sms-gateway-watch] BlueBubbles outbound is ready.");
      console.log(
        "Run: node packages/app-core/scripts/verify-bluebubbles-gateway-e2e.mjs",
      );
      return;
    }

    const bridgeSummary = bridgeDoctor?.checks
      ?.filter((check) => check.status === "blocked")
      .map((check) => `${check.name}: ${check.detail}`)
      .join(" | ");
    console.log(
      `[sms-gateway-watch] waiting: adb devices=0; bridge=${bridgeDoctor?.status ?? "unknown"}${bridgeSummary ? ` (${bridgeSummary})` : ""}`,
    );
    await sleep(Math.max(1, args.intervalSeconds) * 1000);
  }

  throw new Error(`Timed out waiting ${args.timeoutSeconds}s for an SMS gateway path`);
}

main().catch((error) => {
  console.error(`[sms-gateway-watch] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
