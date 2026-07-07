/**
 * Device resource-snapshot bridge.
 *
 * Calls the native resource probe — `ElizaIntent.getResourceSnapshot()` on iOS,
 * `ResourceProbe.getResourceSnapshot()` on Android — and normalises the raw
 * Capacitor payload into a typed `DeviceResourceSnapshot` for the Mobile
 * Resource Workbench (issue #8800).
 *
 * The native side returns JSON `null` (iOS `NSNull()` / Android
 * `JSONObject.NULL`) for any quantity the OS cannot measure, so the normaliser
 * coerces every numeric field through a strict finite-number check and reports
 * `null` otherwise — never a fabricated zero (AGENTS.md §3/§7).
 *
 * Only `normalizeResourceSnapshot` is pure/unit-tested; `getDeviceResourceSnapshot`
 * is the thin native call.
 */

import { Capacitor } from "@capacitor/core";
import { getNativePlugin } from "../../bridge/native-plugins";

export type SnapshotThermalState =
  | "nominal"
  | "fair"
  | "serious"
  | "critical"
  | "unknown";

const THERMAL_STATES: readonly SnapshotThermalState[] = [
  "nominal",
  "fair",
  "serious",
  "critical",
  "unknown",
];

export interface DeviceResourceSnapshot {
  platform: "ios" | "android" | null;
  thermalState: SnapshotThermalState;
  lowPowerMode: boolean | null;
  /** Process resident footprint in MB (iOS phys_footprint / Android total PSS). */
  residentMemoryMb: number | null;
  /** Device-wide available RAM in MB before memory pressure. */
  availableRamMb: number | null;
  /** Device total physical RAM in MB (feeds RAM-tier gating, #14390). */
  totalRamMb: number | null;
  /** Cumulative process CPU time in ms. */
  cpuTimeMs: number | null;
  batteryLevelPct: number | null;
  /** Cumulative charge counter in µAh (Android only). */
  batteryChargeMicroAmpHours: number | null;
  /** Instantaneous current draw in µA (Android only). */
  batteryCurrentMicroAmps: number | null;
  isCharging: boolean | null;
  /** Sample timestamp in ms (epoch). */
  capturedAtMs: number;
}

interface ResourceProbePlugin extends Record<string, unknown> {
  getResourceSnapshot?: () => Promise<unknown>;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asThermalState(value: unknown): SnapshotThermalState {
  return typeof value === "string" &&
    (THERMAL_STATES as readonly string[]).includes(value)
    ? (value as SnapshotThermalState)
    : "unknown";
}

/**
 * Normalise a raw native resource-snapshot payload into a typed snapshot.
 * Pure — coerces every field and substitutes `null` for anything missing or
 * non-finite. `capturedAtMs` falls back to the supplied `nowMs` when the native
 * side did not stamp it.
 */
export function normalizeResourceSnapshot(
  raw: unknown,
  nowMs: number,
): DeviceResourceSnapshot {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const platform =
    r.platform === "ios" || r.platform === "android" ? r.platform : null;
  return {
    platform,
    thermalState: asThermalState(r.thermalState),
    lowPowerMode: boolOrNull(r.lowPowerMode),
    residentMemoryMb: finiteOrNull(r.residentMemoryMb),
    availableRamMb: finiteOrNull(r.availableRamMb),
    totalRamMb: finiteOrNull(r.totalRamMb),
    cpuTimeMs: finiteOrNull(r.cpuTimeMs),
    batteryLevelPct: finiteOrNull(r.batteryLevelPct),
    batteryChargeMicroAmpHours: finiteOrNull(r.batteryChargeMicroAmpHours),
    batteryCurrentMicroAmps: finiteOrNull(r.batteryCurrentMicroAmps),
    isCharging: boolOrNull(r.isCharging),
    capturedAtMs: finiteOrNull(r.capturedAtMs) ?? nowMs,
  };
}

/** The native plugin name that carries `getResourceSnapshot` per platform. */
function resourceProbePluginName(): string | null {
  const platform = Capacitor.getPlatform();
  if (platform === "ios") return "ElizaIntent";
  if (platform === "android") return "ResourceProbe";
  return null;
}

/**
 * Read a live resource snapshot from the native probe, or `null` when no native
 * probe is reachable (web / desktop / unregistered plugin). Never throws — a
 * probe failure resolves to `null` so the caller treats it as "not available on
 * this platform" rather than a hard error.
 */
export async function getDeviceResourceSnapshot(
  nowMs: number = Date.now(),
): Promise<DeviceResourceSnapshot | null> {
  const name = resourceProbePluginName();
  if (!name) return null;
  const plugin = getNativePlugin<ResourceProbePlugin>(name);
  if (typeof plugin.getResourceSnapshot !== "function") return null;
  try {
    const raw = await plugin.getResourceSnapshot();
    return normalizeResourceSnapshot(raw, nowMs);
  } catch {
    // error-policy:J4 capability probe — a failed native snapshot reads as
    // "no resource telemetry on this device", not fabricated numbers.
    return null;
  }
}
