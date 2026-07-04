#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const defaultMaxAgeMs = Number(
  process.env.SMARTGLASSES_COMPLETION_MAX_AGE_MS ?? 600000,
);

if (isMain(import.meta.url, process.argv[1])) {
  const reportPath =
    process.argv.find((arg) => arg.endsWith(".json")) ??
    process.env.SMARTGLASSES_REPORT_PATH ??
    "/tmp/smartglasses-hardware-report-latest.json";

  console.log(
    JSON.stringify(
      createHardwareDoctorReport(reportPath, { maxAgeMs: defaultMaxAgeMs }),
      null,
      2,
    ),
  );
}

export function createHardwareDoctorReport(reportPath, options = {}) {
  const bluetooth = inspectBluetooth();
  const latestReport = inspectLatestReport(reportPath, options);
  return createHardwareDoctorSummary({ bluetooth, latestReport });
}

export function createHardwareDoctorSummary({ bluetooth, latestReport }) {
  const pairedG1Sides = new Set(
    bluetooth.g1Devices.map((device) => device.side),
  );
  const wholeHeadsetPaired =
    pairedG1Sides.has("left") && pairedG1Sides.has("right");
  const wholeHeadsetConnected =
    latestReport?.wholeHeadsetConnected ??
    bluetooth.g1Devices.some((device) => device.connected);
  const nextAction = chooseNextAction({
    wholeHeadsetPaired,
    wholeHeadsetConnected,
    latestReport,
  });

  return {
    ok: Boolean(latestReport?.ok),
    adapter: bluetooth.adapter,
    pairedG1Devices: bluetooth.g1Devices,
    wholeHeadsetPaired,
    latestReport,
    nextAction,
  };
}

export function inspectBluetooth() {
  try {
    const output = execFileSync("system_profiler", ["SPBluetoothDataType"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseSystemProfilerBluetooth(output);
  } catch (error) {
    return {
      adapter: {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      },
      g1Devices: [],
    };
  }
}

export function parseSystemProfilerBluetooth(source) {
  const lines = source.split(/\r?\n/);
  const adapter = {
    available: true,
    state: valueAfter(lines, "State:"),
    discoverable: valueAfter(lines, "Discoverable:"),
    chipset: valueAfter(lines, "Chipset:"),
    address: valueAfter(lines, "Address:"),
  };
  const devices = [];
  let section = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "Connected:") {
      section = "connected";
      continue;
    }
    if (trimmed === "Not Connected:") {
      section = "not_connected";
      continue;
    }
    const match = trimmed.match(/^(Even\s+G1[^:]*_(L|R)_[^:]+):$/i);
    if (!match) continue;
    devices.push({
      name: match[1],
      side: match[2].toUpperCase() === "L" ? "left" : "right",
      connected: section === "connected",
      section,
    });
  }
  return { adapter, g1Devices: devices };
}

function valueAfter(lines, prefix) {
  const line = lines.find((candidate) => candidate.trim().startsWith(prefix));
  return line ? line.trim().slice(prefix.length).trim() : null;
}

export function inspectLatestReport(path, options = {}) {
  if (!existsSync(path)) return null;
  const report = JSON.parse(readFileSync(path, "utf8"));
  const reportAgeMs = hardwareReportAgeMs(report, options.nowMs);
  const maxAgeMs = options.maxAgeMs ?? defaultMaxAgeMs;
  return {
    reportPath: path,
    ok: Boolean(report.ok),
    startedAt: report.startedAt ?? null,
    finishedAt: report.finishedAt ?? null,
    reportAgeMs,
    maxAgeMs,
    stale: reportAgeMs === null || reportAgeMs > maxAgeMs,
    scanDiagnosis: report.scanDiagnosis ?? null,
    discoveredDeviceCount: report.discoveredDevices?.length ?? 0,
    discoveredG1DeviceCount:
      report.discoveredDevices?.filter((device) => device.matchesG1).length ??
      0,
    wholeHeadsetConnected: Boolean(
      report.status?.connected &&
        report.lenses?.left?.connected &&
        report.lenses?.right?.connected &&
        report.status?.connectedLenses?.left?.connected &&
        report.status?.connectedLenses?.right?.connected,
    ),
    physicalBlocker: physicalBlocker(report),
    serial: report.status?.lastSerialNumber ?? null,
    audioChunks: report.audio?.length ?? 0,
  };
}

export function hardwareReportAgeMs(report, nowMs = Date.now()) {
  const timestamp = Date.parse(report.finishedAt ?? report.startedAt ?? "");
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : null;
}

export function physicalBlocker(report) {
  const anyLens =
    report.lenses?.left?.connected ||
    report.lenses?.right?.connected ||
    report.status?.connectedLenses?.left?.connected ||
    report.status?.connectedLenses?.right?.connected;
  if (report.status && !report.status.available) return "transport_unavailable";
  if (report.status?.available && !anyLens) return "headset_not_found";
  if (!report.status?.connected) return "disconnected";
  if (!report.lenses?.left?.connected || !report.lenses?.right?.connected)
    return "partial_headset";
  return report.headsetState?.physical === "wearing"
    ? null
    : "wearing_state_missing";
}

export function chooseNextAction({
  wholeHeadsetPaired,
  wholeHeadsetConnected,
  latestReport,
}) {
  if (!wholeHeadsetPaired) {
    return "Pair both G1 lenses with macOS or use the native mobile bridge before running hardware proof.";
  }
  if (
    !wholeHeadsetConnected &&
    latestReport?.physicalBlocker === "headset_not_found"
  ) {
    return "Both G1 lenses are paired but not advertising/connectable. Remove them from the charging base, wear them, keep them near this Mac, then run `bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch` from the repo root.";
  }
  if (!wholeHeadsetConnected) {
    return "Reconnect both paired G1 lenses, then run `bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch` from the repo root.";
  }
  return "Wear the connected glasses, single tap, speak, then double tap until hardware validation passes.";
}

function isMain(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(argvPath).href;
}
