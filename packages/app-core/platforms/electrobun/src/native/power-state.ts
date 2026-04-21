import * as fs from "node:fs";
import path from "node:path";

const LINUX_POWER_SUPPLY_ROOT = "/sys/class/power_supply";

/**
 * Returns whether any **Battery** supply in sysfs is currently **Discharging**.
 * Missing sysfs, permissions, or no battery → `false` (treat as AC / unknown).
 */
export function linuxSysfsOnBattery(
  batteryRoot: string = LINUX_POWER_SUPPLY_ROOT,
): boolean {
  if (!fs.existsSync(batteryRoot)) {
    return false;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(batteryRoot);
  } catch {
    return false;
  }

  for (const name of entries) {
    const supplyPath = path.join(batteryRoot, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(supplyPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      continue;
    }

    let type: string;
    try {
      type = fs.readFileSync(path.join(supplyPath, "type"), "utf8").trim();
    } catch {
      continue;
    }
    if (type !== "Battery") {
      continue;
    }

    let status: string;
    try {
      status = fs.readFileSync(path.join(supplyPath, "status"), "utf8").trim();
    } catch {
      continue;
    }
    if (status === "Discharging") {
      return true;
    }
  }

  return false;
}

/**
 * Parses stdout from PowerShell `PowerStatus.PowerLineStatus.ToString()`.
 * Last non-empty line wins (handles stray warnings above the value).
 */
export function parseWindowsPowerLineOutput(output: string): {
  onBattery: boolean;
  known: boolean;
} {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  let line = "";
  if (lines.length > 0) {
    line = lines[lines.length - 1] ?? "";
  }

  if (line === "Offline") {
    return { onBattery: true, known: true };
  }
  if (line === "Online" || line === "Unknown") {
    return { onBattery: false, known: true };
  }
  return { onBattery: false, known: false };
}

export function parseMacOsPowerSourceOutput(output: string): {
  onBattery: boolean;
  known: boolean;
} {
  if (output.includes("Battery Power")) {
    return { onBattery: true, known: true };
  }
  if (output.includes("AC Power")) {
    return { onBattery: false, known: true };
  }
  return { onBattery: false, known: false };
}

export function parseMacOsHidIdleTimeOutput(output: string): number | null {
  const match = output.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!match) {
    return null;
  }
  const idleTimeNs = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(idleTimeNs) || idleTimeNs < 0) {
    return null;
  }
  return Math.floor(idleTimeNs / 1_000_000_000);
}

export function parseMacOsSessionLockedOutput(output: string): boolean | null {
  const match = output.match(
    /(CGSSessionScreenIsLocked|screenIsLocked)\s*=\s*(\d)/,
  );
  if (!match) {
    return null;
  }
  return (match[2] ?? "0") === "1";
}
