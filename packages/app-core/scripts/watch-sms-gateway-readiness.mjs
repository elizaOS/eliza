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

function listWirelessAdbServices() {
  const result = run(adbPath, ["mdns", "services"]);
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("List of discovered"))
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        name: parts[0] ?? "",
        type: parts[1] ?? "",
        endpoint: parts[2] ?? "",
      };
    })
    .filter((service) => service.name && service.type && service.endpoint);
}

function listHostUsbDevices() {
  if (process.platform !== "darwin") return [];
  const result = run("ioreg", ["-p", "IOUSB", "-l", "-w", "0"]);
  if (result.status !== 0 || !result.stdout.trim()) return [];

  const devices = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const nameMatch = line.match(/"USB Product Name"\s*=\s*"([^"]+)"/);
    const registryMatch = line.match(/\+\-o\s+([^@<]+)@/);
    const name = nameMatch?.[1] ?? registryMatch?.[1];
    if (!name) continue;
    const trimmed = name.trim();
    if (!trimmed || /Root Hub|XHCI|\bUSB\s*(?:3\.|2\.|1\.|Bus)\b/i.test(trimmed)) {
      continue;
    }
    if (!devices.includes(trimmed)) devices.push(trimmed);
  }
  return devices.slice(0, 10);
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
    const wirelessAdb = listWirelessAdbServices();
    const hostUsbDevices = listHostUsbDevices();
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

    const pairing = wirelessAdb.find((service) => service.type.includes("_adb-tls-pairing"));
    if (pairing) {
      console.log(
        `[sms-gateway-watch] wireless pairing ready: ${pairing.endpoint}. Run: ADB_PAIR_CODE=<pairing-code> node packages/app-core/scripts/install-android-sms-gateway.mjs --pair ${pairing.endpoint} --connect auto --wait-device 60 --grant-role --clear-logcat --watch-logs 60`,
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
      `[sms-gateway-watch] waiting: adb devices=0; wireless=${wirelessAdb.map((service) => `${service.type}:${service.endpoint}`).join(", ") || "none"}; host-usb=${hostUsbDevices.join(", ") || "none"}; bridge=${bridgeDoctor?.status ?? "unknown"}${bridgeSummary ? ` (${bridgeSummary})` : ""}`,
    );
    await sleep(Math.max(1, args.intervalSeconds) * 1000);
  }

  throw new Error(`Timed out waiting ${args.timeoutSeconds}s for an SMS gateway path`);
}

main().catch((error) => {
  console.error(`[sms-gateway-watch] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
