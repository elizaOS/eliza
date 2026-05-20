#!/usr/bin/env node
/**
 * Strict physical Android SMS gateway verifier.
 *
 * This command installs/prepares the SMS gateway app, clears logcat, then
 * waits for the real runtime milestones produced by an inbound SMS:
 * receiver -> gateway work queued -> cloud accepted -> SMS reply sent.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const installScript = path.join(scriptDir, "install-android-sms-gateway.mjs");
const adbPath = "/opt/homebrew/share/android-commandlinetools/platform-tools/adb";
const defaultEvidencePath = path.join(
  repoRoot,
  ".eliza-local",
  "android-sms-gateway-e2e-latest.json",
);

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
    "  --evidence <path>       Write structured proof JSON. Defaults to .eliza-local/android-sms-gateway-e2e-latest.json.",
    "  --no-evidence           Do not write a proof JSON file.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    serial: null,
    waitDeviceSeconds: 300,
    timeoutSeconds: 180,
    install: true,
    from: null,
    evidencePath: defaultEvidencePath,
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
    else if (arg === "--evidence") args.evidencePath = path.resolve(next());
    else if (arg === "--no-evidence") args.evidencePath = null;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (key === "serial" || key === "install" || key === "from" || key === "evidencePath") {
      continue;
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${key} must be a non-negative integer`);
    }
  }
  return args;
}

function writeEvidence({ evidencePath, ok, serial, from, timeoutSeconds, seen, missing, buffer }) {
  if (!evidencePath) return;
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const evidence = {
    ok,
    gatewayPhoneNumber: "+14159611510",
    serial,
    from: from ?? null,
    timeoutSeconds,
    checkedAt: new Date().toISOString(),
    milestones: milestones.map((milestone) => ({
      key: milestone.key,
      label: milestone.label,
      seen: seen.has(milestone.key),
      line: seen.get(milestone.key) ?? null,
    })),
    missing,
    logTail: buffer.split(/\r?\n/).filter(Boolean).slice(-80),
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[sms-gateway-e2e] evidence=${evidencePath}`);
}

function parseAdbService(line) {
  const parts = String(line).trim().split(/\s+/);
  return {
    name: parts[0] ?? "",
    type: parts[1] ?? "",
    endpoint: parts[2] ?? "",
    raw: line,
  };
}

function writeNoDeviceEvidence({ evidencePath, waitDeviceSeconds, from, services }) {
  if (!evidencePath) return;
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  const parsedServices = services.map(parseAdbService);
  const evidence = {
    ok: false,
    gatewayPhoneNumber: "+14159611510",
    serial: null,
    from: from ?? null,
    waitDeviceSeconds,
    checkedAt: new Date().toISOString(),
    blocker: "no_adb_device",
    adbServices: parsedServices,
    pairingEndpointAdvertised: parsedServices.some((service) =>
      service.type.includes("_adb-tls-pairing"),
    ),
    connectEndpointAdvertised: parsedServices.some((service) =>
      service.type.includes("_adb-tls-connect"),
    ),
    milestones: milestones.map((milestone) => ({
      key: milestone.key,
      label: milestone.label,
      seen: false,
      line: null,
    })),
    missing: milestones.map((milestone) => milestone.key),
    nextSteps: [
      "Open Android Developer Options > Wireless debugging > Pair device with pairing code.",
      "Run: bun run --cwd packages/app-core sms-gateway:watch:pair",
      "Then run: bun run --cwd packages/app-core sms-gateway:verify",
    ],
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[sms-gateway-e2e] evidence=${evidencePath}`);
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

function adbMdnsServices() {
  const result = run(adbPath, ["mdns", "services"], { allowFailure: true });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^List of discovered mdns services/i.test(line));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveSerial(args) {
  if (args.serial) return args.serial;
  const deadline = Date.now() + args.waitDeviceSeconds * 1000;
  let lastServices = [];
  while (Date.now() <= deadline) {
    const devices = listDevices();
    if (devices.length === 1) return devices[0];
    if (devices.length > 1) {
      throw new Error(`Multiple adb devices are connected; pass --serial. Devices: ${devices.join(", ")}`);
    }
    lastServices = adbMdnsServices();
    await sleep(1000);
  }
  const services = lastServices.length
    ? ` Advertised wireless ADB services: ${lastServices.join("; ")}.`
    : " No wireless ADB pairing/connect services are currently advertised.";
  writeNoDeviceEvidence({
    evidencePath: args.evidencePath,
    waitDeviceSeconds: args.waitDeviceSeconds,
    from: args.from,
    services: lastServices,
  });
  throw new Error(
    `Timed out waiting ${args.waitDeviceSeconds}s for an adb device.${services} ` +
      "Open Android Developer Options > Wireless debugging > Pair device with pairing code, then run: " +
      "node packages/app-core/scripts/install-android-sms-gateway.mjs --pair auto --wait-pair 300 --connect auto --wait-device 60 --grant-role --clear-logcat --watch-logs 60",
  );
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
    writeEvidence({
      evidencePath: args.evidencePath,
      ok: false,
      serial,
      from: args.from,
      timeoutSeconds: args.timeoutSeconds,
      seen: result.seen,
      missing,
      buffer: result.buffer,
    });
    throw new Error(`Missing SMS gateway milestones: ${missing.join(", ")}`);
  }
  writeEvidence({
    evidencePath: args.evidencePath,
    ok: true,
    serial,
    from: args.from,
    timeoutSeconds: args.timeoutSeconds,
    seen: result.seen,
    missing: [],
    buffer: result.buffer,
  });
  console.log("[sms-gateway-e2e] Physical Android SMS gateway verification passed.");
}

main().catch((error) => {
  console.error(`[sms-gateway-e2e] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
