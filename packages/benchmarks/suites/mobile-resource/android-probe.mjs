/**
 * Android host-side resource probe (adb).
 *
 * Reads thermal status, battery level/energy, and PSS/available-RAM over `adb`
 * — the OS-level counterpart to the in-app `ResourceProbe.getResourceSnapshot`
 * native bridge. Every reader returns `null` on any failure (no adb, no device,
 * unparseable output) so the runner degrades to "not available on this
 * platform" rather than failing or fabricating a value.
 *
 * Energy: `dumpsys batterystats` is the aggregated source; we expose a coarse
 * charge-counter delta (µAh) which, paired with the level delta, is the nightly
 * trend signal. Per-run instrumented current draw needs an external power meter
 * (see #8800 open question) and is out of scope here.
 */

import { tryExec } from "./lib.mjs";

const ADB = process.env.ADB_PATH || "adb";

/** Booted device serial, or null when adb is missing or no device is attached. */
export function detectAndroidDevice() {
  const out = tryExec(ADB, ["devices"], { timeoutMs: 8000 });
  if (out == null) return null;
  const line = out
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .find((l) => l.endsWith("\tdevice"));
  return line ? line.split("\t")[0] : null;
}

function shell(serial, args, opts = {}) {
  return tryExec(ADB, ["-s", serial, "shell", ...args], opts);
}

function toFiniteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapThermalStatus(raw) {
  // `dumpsys thermalservice` prints "Thermal Status: N" (0..6).
  switch (raw) {
    case 0:
      return "nominal";
    case 1:
    case 2:
      return "fair";
    case 3:
    case 4:
      return "serious";
    case 5:
    case 6:
      return "critical";
    default:
      return "unknown";
  }
}

export function readAndroidThermalState(serial) {
  const out = shell(serial, ["dumpsys", "thermalservice"]);
  if (out == null) return "unknown";
  const m = out.match(/Thermal Status:\s*(\d+)/i);
  if (!m) return "unknown";
  return mapThermalStatus(Number(m[1]));
}

export function readAndroidBattery(serial) {
  const dump = shell(serial, ["dumpsys", "battery"]);
  let levelPct = null;
  let isCharging = null;
  if (dump != null) {
    const level = dump.match(/level:\s*(\d+)/i);
    if (level) levelPct = toFiniteOrNull(level[1]);
    const status = dump.match(/status:\s*(\d+)/i);
    // BatteryManager.BATTERY_STATUS_CHARGING = 2, FULL = 5.
    if (status) isCharging = status[1] === "2" || status[1] === "5";
  }
  const charge = shell(serial, [
    "cat",
    "/sys/class/power_supply/battery/charge_counter",
  ]);
  const current = shell(serial, [
    "cat",
    "/sys/class/power_supply/battery/current_now",
  ]);
  return {
    batteryLevelPct: levelPct,
    // charge_counter is in µAh on most devices.
    batteryChargeMicroAmpHours: charge != null ? toFiniteOrNull(charge) : null,
    batteryCurrentMicroAmps: current != null ? toFiniteOrNull(current) : null,
    isCharging,
  };
}

export function readAndroidMemoryMb(serial, packageName) {
  let residentMemoryMb = null;
  if (packageName) {
    const meminfo = shell(serial, ["dumpsys", "meminfo", packageName]);
    if (meminfo != null) {
      // "TOTAL PSS:  812345  TOTAL RSS: ..." (KB) — prefer TOTAL PSS.
      const m =
        meminfo.match(/TOTAL\s+PSS:\s*(\d+)/i) ||
        meminfo.match(/TOTAL:\s*(\d+)/i);
      if (m) residentMemoryMb = Number(m[1]) / 1024;
    }
  }
  let availableRamMb = null;
  const procMem = shell(serial, ["cat", "/proc/meminfo"]);
  if (procMem != null) {
    const m = procMem.match(/MemAvailable:\s*(\d+)\s*kB/i);
    if (m) availableRamMb = Number(m[1]) / 1024;
  }
  return { residentMemoryMb, availableRamMb };
}

export function readAndroidLowPowerMode(serial) {
  const out = shell(serial, ["settings", "get", "global", "low_power"]);
  if (out == null) return null;
  const t = out.trim();
  if (t === "1") return true;
  if (t === "0") return false;
  return null;
}

/**
 * Full host-side snapshot for the runner's sampling loop.
 * @param {string} serial
 * @param {string|undefined} packageName
 * @param {number} nowMs
 */
export function androidResourceSnapshot(serial, packageName, nowMs) {
  const battery = readAndroidBattery(serial);
  const mem = readAndroidMemoryMb(serial, packageName);
  return {
    platform: "android",
    atMs: nowMs,
    thermalState: readAndroidThermalState(serial),
    lowPowerMode: readAndroidLowPowerMode(serial),
    cpuTimeMs: null, // host-side process CPU lives in the in-app bridge
    ...battery,
    ...mem,
  };
}

/** Reset batterystats so a subsequent read reflects only the workload window. */
export function resetAndroidBatteryStats(serial) {
  shell(serial, ["dumpsys", "batterystats", "--reset"], { timeoutMs: 20_000 });
}
