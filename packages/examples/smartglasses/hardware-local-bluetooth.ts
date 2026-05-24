import { execFileSync } from "node:child_process";
import type { GlassSide } from "../../../plugins/plugin-facewear/src/index.js";

export type LocalBluetoothPreflight = {
  bluetoothAdapter: {
    available: boolean;
    state?: string | null;
    discoverable?: string | null;
    chipset?: string | null;
    address?: string | null;
    error?: string;
  };
  pairedG1Devices: Array<{
    name: string;
    side: GlassSide;
    connected: boolean;
    section?: string | null;
  }>;
};

type BluetoothProfilerReader = () => string;

let cachedPreflight: LocalBluetoothPreflight | null | undefined;

export function inspectLocalBluetoothPreflight(
  options: { cache?: boolean; read?: BluetoothProfilerReader } = {},
): LocalBluetoothPreflight | null {
  const read = options.read ?? readSystemBluetoothProfiler;
  const useCache = options.cache ?? read === readSystemBluetoothProfiler;
  if (useCache && cachedPreflight !== undefined) return cachedPreflight;
  try {
    const preflight = parseSystemProfilerBluetooth(read());
    if (useCache) cachedPreflight = preflight;
    return preflight;
  } catch (error) {
    const preflight = {
      bluetoothAdapter: {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      },
      pairedG1Devices: [],
    };
    if (useCache) cachedPreflight = preflight;
    return preflight;
  }
}

export function clearLocalBluetoothPreflightCache(): void {
  cachedPreflight = undefined;
}

export function parseSystemProfilerBluetooth(
  source: string,
): LocalBluetoothPreflight {
  const lines = source.split(/\r?\n/);
  const bluetoothAdapter = {
    available: true,
    state: valueAfter(lines, "State:"),
    discoverable: valueAfter(lines, "Discoverable:"),
    chipset: valueAfter(lines, "Chipset:"),
    address: valueAfter(lines, "Address:"),
  };
  const pairedG1Devices: LocalBluetoothPreflight["pairedG1Devices"] = [];
  let section: string | null = null;
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
    pairedG1Devices.push({
      name: match[1],
      side: match[2].toUpperCase() === "L" ? "left" : "right",
      connected: section === "connected",
      section,
    });
  }
  return { bluetoothAdapter, pairedG1Devices };
}

function readSystemBluetoothProfiler(): string {
  return execFileSync("system_profiler", ["SPBluetoothDataType"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function valueAfter(lines: string[], prefix: string): string | null {
  const line = lines.find((candidate) => candidate.trim().startsWith(prefix));
  return line ? line.trim().slice(prefix.length).trim() : null;
}
