#!/usr/bin/env node
/**
 * Strict physical Android SMS gateway verifier.
 *
 * This command installs/prepares the SMS gateway app, clears logcat, then
 * waits for the real runtime milestones produced by an inbound SMS:
 * receiver -> gateway work queued -> cloud accepted -> SMS reply sent.
 */
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const installScript = path.join(scriptDir, "install-android-sms-gateway.mjs");
const adbPath = "/opt/homebrew/share/android-commandlinetools/platform-tools/adb";

const milestones = [
  {
    key: "receiver",
    label: "SMS receiver observed inbound delivery",
    pattern: /ElizaSmsReceiver/,
  },
  {
    key: "queued",
    label: "gateway work queued",
    pattern: /ElizaSmsGateway.*Queued SMS gateway work/,
  },
  {
    key: "cloud",
    label: "cloud gateway accepted inbound SMS",
    pattern: /ElizaSmsGateway.*Cloud gateway accepted SMS/,
  },
  {
    key: "sending",
    label: "reply SMS send attempted",
    pattern: /ElizaSmsGateway.*Sending SMS gateway reply/,
  },
  {
    key: "persisted",
    label: "reply SMS persisted",
    pattern: /ElizaSmsGateway.*SMS gateway reply sent and persisted/,
  },
];

function usage() {
  return [
    "Usage: node packages/app-core/scripts/verify-android-sms-gateway-e2e.mjs [options]",
    "",
    "Options:",
    "  --serial <serial>       adb serial. Defaults to the only connected device.",
    "  --wait-device <seconds> Wait for an adb device before installing. Defaults to 300.",
    "  --timeout <seconds>     Wait for SMS milestones. Defaults to 180.",
    "  --skip-install          Do not install or grant role before watching logs.",
    "  --from <number>         Optional sender number to display in instructions.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    serial: null,
    waitDeviceSeconds: 300,
    timeoutSeconds: 180,
    install: true,
    from: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--serial") args.serial = next();
    else if (arg === "--wait-device") args.waitDeviceSeconds = Number.parseInt(next(), 10);
    else if (arg === "--timeout") args.timeoutSeconds = Number.parseInt(next(), 10);
    else if (arg === "--skip-install") args.install = false;
    else if (arg === "--from") args.from = next();
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (key === "serial" || key === "install" || key === "from") continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${key} must be a non-negative integer`);
    }
  }
  return args;
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function listDevices() {
  const result = run(adbPath, ["devices", "-l"]);
  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\bdevice\b/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveSerial(args) {
  if (args.serial) return args.serial;
  const deadline = Date.now() + args.waitDeviceSeconds * 1000;
  while (Date.now() <= deadline) {
    const devices = listDevices();
    if (devices.length === 1) return devices[0];
    if (devices.length > 1) {
      throw new Error(`Multiple adb devices are connected; pass --serial. Devices: ${devices.join(", ")}`);
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting ${args.waitDeviceSeconds}s for an adb device`);
}

function installAndPrepare(serial) {
  const result = spawnSync(
    "node",
    [
      installScript,
      "--serial",
      serial,
      "--grant-role",
      "--clear-logcat",
      "--logcat-lines",
      "25",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`install/prepare failed with exit code ${result.status}`);
  }
}

function adbArgs(serial, args) {
  return ["-s", serial, ...args];
}

async function watchMilestones({ serial, timeoutSeconds, from }) {
  const seen = new Map();
  console.log(
    `[sms-gateway-e2e] Send a real SMS${from ? ` from ${from}` : ""} to +14159611510 now.`,
  );
  console.log(
    `[sms-gateway-e2e] Waiting ${timeoutSeconds}s for: ${milestones.map((m) => m.key).join(", ")}`,
  );

  const child = spawn(
    adbPath,
    adbArgs(serial, [
      "logcat",
      "-v",
      "time",
      "ElizaSmsGateway:D",
      "ElizaSmsReceiver:D",
      "AndroidRuntime:E",
      "*:S",
    ]),
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const deadline = Date.now() + timeoutSeconds * 1000;
  let buffer = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    buffer += text;
    for (const line of text.split(/\r?\n/)) {
      for (const milestone of milestones) {
        if (!seen.has(milestone.key) && milestone.pattern.test(line)) {
          seen.set(milestone.key, line);
          console.log(`[sms-gateway-e2e] PASS ${milestone.label}: ${line.trim()}`);
        }
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    buffer += chunk.toString();
  });

  while (Date.now() <= deadline) {
    if (milestones.every((milestone) => seen.has(milestone.key))) {
      child.kill("SIGTERM");
      return { ok: true, seen, buffer };
    }
    await sleep(500);
  }

  child.kill("SIGTERM");
  return { ok: false, seen, buffer };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serial = await resolveSerial(args);
  console.log(`[sms-gateway-e2e] Using adb device ${serial}`);

  if (args.install) installAndPrepare(serial);
  else run(adbPath, adbArgs(serial, ["logcat", "-c"]), { allowFailure: true });

  const result = await watchMilestones({
    serial,
    timeoutSeconds: args.timeoutSeconds,
    from: args.from,
  });
  if (!result.ok) {
    const missing = milestones
      .filter((milestone) => !result.seen.has(milestone.key))
      .map((milestone) => milestone.key);
    throw new Error(`Missing SMS gateway milestones: ${missing.join(", ")}`);
  }
  console.log("[sms-gateway-e2e] Physical Android SMS gateway verification passed.");
}

main().catch((error) => {
  console.error(`[sms-gateway-e2e] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
