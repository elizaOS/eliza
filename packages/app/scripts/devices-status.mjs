#!/usr/bin/env node
/**
 * Read-only fleet freshness report for attached Android devices, booted iOS
 * simulators, and paired physical iOS devices. It compares each installed
 * renderer stamp against `origin/develop` so stale device coverage is visible
 * before a runner starts.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDevicectlDeviceList } from "./ios-device-devicectl.mjs";
import { DEFAULT_APP_BUNDLE_ID } from "./ios-device-lib.mjs";
import {
  APP_ID,
  listDevices,
  readInstalledRendererStamp,
  resolveAdb,
} from "./lib/android-device.mjs";
import {
  buildDeviceStatusRow,
  formatDeviceStatusTable,
  hasNonFreshDevice,
} from "./lib/devices-status.mjs";
import {
  readRendererManifest,
  rendererManifestPathFromAppPath,
} from "./lib/ios-renderer-stamp.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(appRoot, "..", "..");
export const IOS_DEVICE_DEPLOY_LEDGER = "ios-device-deploy-ledger.jsonl";

function hasArg(name) {
  return process.argv.includes(name);
}

function runText(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd ?? repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export function devicesStatusStateDir(env = process.env) {
  return path.resolve(
    env.ELIZA_DEVICES_STATUS_DIR?.trim() ||
      env.ELIZA_STATE_DIR?.trim() ||
      path.join(os.homedir(), ".local", "state", "eliza"),
  );
}

export function devicesStatusLedgerPath(env = process.env) {
  return path.join(devicesStatusStateDir(env), IOS_DEVICE_DEPLOY_LEDGER);
}

export function appendIosDeviceDeployLedger(entry, env = process.env) {
  const ledgerPath = devicesStatusLedgerPath(env);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
  return ledgerPath;
}

function readIosDeviceDeployLedger(env = process.env) {
  const ledgerPath = devicesStatusLedgerPath(env);
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function latestLedgerEntryForDevice(device, entries) {
  const identifiers = new Set(
    [device.udid, device.identifier, device.name].filter(Boolean).map(String),
  );
  return entries
    .filter((entry) =>
      [entry.udid, entry.identifier, entry.name].some((value) =>
        identifiers.has(String(value ?? "")),
      ),
    )
    .sort((a, b) =>
      String(b.deployedAt).localeCompare(String(a.deployedAt)),
    )[0];
}

function fetchDevelopHead() {
  spawnSync("git", ["fetch", "origin", "develop", "--quiet"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return runText("git", ["rev-parse", "origin/develop"]);
}

function androidRows(developHead) {
  let adb;
  try {
    adb = resolveAdb();
  } catch {
    return [
      buildDeviceStatusRow({
        platform: "android",
        id: "adb",
        name: "adb not available",
        kind: "n/a",
        stamp: null,
        developHead,
        source: "adb",
      }),
    ];
  }
  const devices = listDevices(adb);
  if (devices.length === 0) return [];
  return devices.map((serial) => {
    let stamp = null;
    try {
      stamp = readInstalledRendererStamp(adb, serial);
    } catch {
      stamp = null;
    }
    return buildDeviceStatusRow({
      platform: "android",
      id: serial,
      name: serial,
      kind: serial.startsWith("emulator-") ? "emulator" : "device",
      stamp,
      developHead,
      source: `adb:${APP_ID}`,
    });
  });
}

function bootedIosSimulators() {
  const raw = runText("xcrun", ["simctl", "list", "devices", "--json"]);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Object.values(parsed.devices ?? {})
    .flat()
    .filter((device) => device?.state === "Booted");
}

function iosSimulatorRows(developHead) {
  if (process.platform !== "darwin") {
    return [
      buildDeviceStatusRow({
        platform: "ios-sim",
        id: "simctl",
        name: "iOS simulator n/a",
        kind: "n/a",
        stamp: null,
        developHead,
        source: "not macOS",
      }),
    ];
  }
  return bootedIosSimulators().map((device) => {
    const appPath = runText("xcrun", [
      "simctl",
      "get_app_container",
      device.udid,
      DEFAULT_APP_BUNDLE_ID,
      "app",
    ]);
    let stamp = null;
    if (appPath) {
      try {
        stamp = readRendererManifest(
          rendererManifestPathFromAppPath(appPath),
          `iOS simulator ${device.name}`,
        );
      } catch {
        stamp = null;
      }
    }
    return buildDeviceStatusRow({
      platform: "ios-sim",
      id: device.udid,
      name: device.name,
      kind: "simulator",
      stamp,
      developHead,
      source: "simctl",
    });
  });
}

function physicalIosDevices() {
  if (process.platform !== "darwin") return [];
  try {
    return (readDevicectlDeviceList()?.result?.devices ?? []).map((device) => ({
      identifier: device.identifier,
      udid: device.hardwareProperties?.udid,
      name: device.deviceProperties?.name ?? device.identifier,
    }));
  } catch {
    return [];
  }
}

function iosPhysicalRows(developHead) {
  if (process.platform !== "darwin") {
    return [
      buildDeviceStatusRow({
        platform: "ios-device",
        id: "devicectl",
        name: "physical iOS n/a",
        kind: "n/a",
        stamp: null,
        developHead,
        source: "not macOS",
      }),
    ];
  }
  const ledger = readIosDeviceDeployLedger();
  return physicalIosDevices().map((device) => {
    const entry = latestLedgerEntryForDevice(device, ledger);
    const stamp = entry
      ? {
          buildId: entry.buildId,
          commit: entry.commit,
          builtAt: entry.builtAt,
        }
      : null;
    return buildDeviceStatusRow({
      platform: "ios-device",
      id: device.udid ?? device.identifier,
      name: device.name,
      kind: "physical",
      stamp,
      developHead,
      source: entry ? "deploy-ledger" : "no ledger entry",
    });
  });
}

export function collectDeviceStatus() {
  const developHead = fetchDevelopHead();
  return [
    ...androidRows(developHead),
    ...iosSimulatorRows(developHead),
    ...iosPhysicalRows(developHead),
  ];
}

function main() {
  const rows = collectDeviceStatus();
  if (hasArg("--json")) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(formatDeviceStatusTable(rows));
  }
  if (hasArg("--require-fresh") && hasNonFreshDevice(rows)) {
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
