#!/usr/bin/env node
/**
 * Read-only device build-status report for the MVP mobile evidence fleet.
 *
 * The report answers the question stale mobile evidence usually hides: which
 * renderer build is installed on each connected device, and does it match the
 * fresh local dist and develop HEAD? Android and simulators are read directly;
 * physical iOS devices use the deploy ledger written by ios-device-deploy.mjs
 * because iOS app containers are not host-readable.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDevicectlDeviceList } from "./ios-device-devicectl.mjs";
import { DEFAULT_APP_BUNDLE_ID } from "./ios-device-lib.mjs";
import {
  APP_ID,
  readInstalledRendererStamp,
  resolveAdb,
} from "./lib/android-device.mjs";
import {
  evaluateRendererFreshness,
  freshRendererManifestPath,
  latestIosDeployLedgerEntry,
  readIosDeployLedgerEntries,
  readRendererManifestFile,
  shortSha,
} from "./lib/device-renderer-status.mjs";
import {
  readRendererManifest,
  rendererManifestPathFromAppPath,
} from "./lib/ios-renderer-stamp.mjs";

const appDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const repoRoot = path.resolve(appDir, "..", "..");

function has(flag) {
  return process.argv.includes(flag);
}

function runText(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd ?? repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (options.optional) return null;
    throw error;
  }
}

function readDevelopHead() {
  if (!has("--no-fetch")) {
    runText("git", ["fetch", "origin", "develop", "--quiet"]);
  }
  return runText("git", ["rev-parse", "origin/develop"]);
}

function readFreshDistStamp() {
  const manifestPath = freshRendererManifestPath({ appDir });
  if (!fs.existsSync(manifestPath)) return null;
  return readRendererManifestFile(manifestPath, "fresh dist");
}

function rowForStamp({
  platform,
  kind,
  id,
  name,
  source,
  installed,
  fresh,
  developHead,
}) {
  const status = evaluateRendererFreshness({ installed, fresh, developHead });
  return {
    platform,
    kind,
    id,
    name: name ?? "",
    source,
    verdict: status.verdict,
    reason: status.reason,
    installedBuildId: installed?.buildId ?? null,
    installedCommit: installed?.commit ?? null,
    freshBuildId: fresh?.buildId ?? null,
    developHead,
  };
}

function nARow(platform, kind, reason) {
  return {
    platform,
    kind,
    id: "",
    name: "",
    source: "host",
    verdict: "N/A",
    reason,
    installedBuildId: null,
    installedCommit: null,
    freshBuildId: null,
    developHead: null,
  };
}

function readAndroidDeviceLines(adbBin) {
  return runText(adbBin, ["devices", "-l"])
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const serial = parts[0];
      const state = parts[1];
      const model = parts
        .find((part) => part.startsWith("model:"))
        ?.slice("model:".length);
      return { serial, state, model: model ?? "" };
    })
    .filter((device) => device.state === "device");
}

function androidRows({ fresh, developHead }) {
  let adbBin;
  try {
    adbBin = resolveAdb();
  } catch (error) {
    return [nARow("android", "device", error?.message ?? String(error))];
  }
  const devices = readAndroidDeviceLines(adbBin);
  if (devices.length === 0) return [];
  return devices.map((device) => {
    try {
      const installed = readInstalledRendererStamp(adbBin, device.serial);
      return rowForStamp({
        platform: "android",
        kind: device.serial.startsWith("emulator-") ? "emulator" : "device",
        id: device.serial,
        name: device.model,
        source: APP_ID,
        installed,
        fresh,
        developHead,
      });
    } catch (error) {
      return {
        ...nARow("android", "device", error?.message ?? String(error)),
        id: device.serial,
        name: device.model,
        verdict: "UNKNOWN",
      };
    }
  });
}

function bootedSimulatorRows({ fresh, developHead, bundleId }) {
  if (process.platform !== "darwin") {
    return [nARow("ios", "simulator", "not macOS")];
  }
  const output = runText("xcrun", ["simctl", "list", "devices", "--json"], {
    optional: true,
  });
  if (!output) return [nARow("ios", "simulator", "simctl unavailable")];
  const payload = JSON.parse(output);
  const sims = Object.values(payload.devices ?? {})
    .flat()
    .filter((device) => device?.state === "Booted");
  return sims.map((sim) => {
    const appPath = runText(
      "xcrun",
      ["simctl", "get_app_container", sim.udid, bundleId, "app"],
      { optional: true },
    );
    const installed = appPath
      ? readRendererManifest(
          rendererManifestPathFromAppPath(appPath),
          `simulator ${sim.name}`,
        )
      : null;
    return rowForStamp({
      platform: "ios",
      kind: "simulator",
      id: sim.udid,
      name: sim.name,
      source: appPath ?? bundleId,
      installed,
      fresh,
      developHead,
    });
  });
}

function physicalIosRows({ fresh, developHead, bundleId }) {
  if (process.platform !== "darwin") {
    return [nARow("ios", "device", "not macOS")];
  }
  let payload;
  try {
    payload = readDevicectlDeviceList({ quiet: true });
  } catch (error) {
    return [
      nARow(
        "ios",
        "device",
        `devicectl unavailable: ${error?.message ?? error}`,
      ),
    ];
  }
  const ledgerEntries = readIosDeployLedgerEntries();
  const devices = payload?.result?.devices ?? [];
  return devices
    .map((device) => ({
      identifier: String(device?.identifier ?? ""),
      udid: String(device?.hardwareProperties?.udid ?? ""),
      name: String(device?.deviceProperties?.name ?? ""),
    }))
    .filter((device) => device.identifier && device.udid)
    .map((device) => {
      const entry = latestIosDeployLedgerEntry({
        entries: ledgerEntries,
        udid: device.udid,
        bundleId,
      });
      const installed = entry
        ? {
            buildId: entry.buildId,
            commit: entry.commit,
            builtAt: entry.builtAt,
            variant: entry.variant,
            capacitorTarget: entry.capacitorTarget,
            runtimeMode: entry.runtimeMode,
          }
        : null;
      return rowForStamp({
        platform: "ios",
        kind: "device",
        id: device.identifier,
        name: device.name,
        source: entry ? "ios-device-deploy ledger" : "no deploy ledger entry",
        installed,
        fresh,
        developHead,
      });
    });
}

function pad(text, width) {
  const value = String(text ?? "");
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

function printTable(rows) {
  const columns = [
    ["platform", 8],
    ["kind", 10],
    ["device", 24],
    ["verdict", 8],
    ["installed", 12],
    ["commit", 12],
    ["develop", 12],
    ["reason", 0],
  ];
  console.log(columns.map(([name, width]) => pad(name, width)).join("  "));
  console.log(
    columns
      .map(([name, width]) => "-".repeat(width || Math.max(6, name.length)))
      .join("  "),
  );
  for (const row of rows) {
    const device = row.name ? `${row.name} ${row.id}` : row.id || row.source;
    const values = [
      row.platform,
      row.kind,
      device.slice(0, 24),
      row.verdict,
      row.installedBuildId ? row.installedBuildId.slice(0, 12) : "-",
      shortSha(row.installedCommit) ?? "-",
      shortSha(row.developHead) ?? "-",
      row.reason,
    ];
    console.log(
      values.map((value, index) => pad(value, columns[index][1])).join("  "),
    );
  }
}

async function main() {
  const json = has("--json");
  const requireFresh = has("--require-fresh");
  const bundleId =
    process.env.ELIZA_IOS_BUNDLE_ID?.trim() || DEFAULT_APP_BUNDLE_ID;
  const developHead = readDevelopHead();
  const fresh = readFreshDistStamp();
  const rows = [
    ...androidRows({ fresh, developHead }),
    ...bootedSimulatorRows({ fresh, developHead, bundleId }),
    ...physicalIosRows({ fresh, developHead, bundleId }),
  ];
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    printTable(rows);
    console.log(
      `\nfresh dist: ${fresh ? `${fresh.buildId.slice(0, 12)} commit=${shortSha(fresh.commit) ?? "unknown"}` : "missing"}`,
    );
    console.log(`develop HEAD: ${shortSha(developHead)}`);
  }
  if (
    requireFresh &&
    rows.some((row) => row.verdict !== "FRESH" && row.verdict !== "N/A")
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[devices:status] FAILED: ${error?.stack ?? error}`);
  process.exit(1);
});
