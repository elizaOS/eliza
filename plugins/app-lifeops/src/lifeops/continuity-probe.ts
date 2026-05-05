/**
 * Continuity / paired-iPhone presence probe for macOS hosts.
 *
 * When the Eliza iOS app is not installed, the owner's iPhone is still
 * visible to the Mac via:
 *   - `xcrun devicectl list devices --json-output -` — developer-tools
 *     device list that includes paired iPhones with current connection
 *     state. Requires Xcode to be installed.
 *   - `system_profiler SPBluetoothDataType -json` — Bluetooth pairing
 *     metadata including whether the phone is currently connected.
 *
 * We query both sources and emit a `mobile_device` activity signal whenever
 * the connected state transitions. The probe is enabled only on darwin and
 * only when there is no recent `mobile_device` signal from a Capacitor
 * source (to avoid double-counting when the iOS app is already reporting).
 *
 * See `eliza/plugins/app-lifeops/docs/telemetry-event-families.md` §2.6 for
 * the canonical payload shape.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createLifeOpsActivitySignal,
  type LifeOpsRepository,
} from "./repository.js";

const execFileAsync = promisify(execFile);

const CONTINUITY_LOOKBACK_MS = 15 * 60 * 1_000;
const CONTINUITY_COMMAND_TIMEOUT_MS = 5_000;

/**
 * Injectable shell-runner used by the continuity probe. Defaults to a real
 * `execFile`-backed runner; tests override this with a deterministic stub
 * instead of touching `xcrun` / `system_profiler` on the developer machine.
 */
export interface ContinuityShellRunner {
  run(
    command: string,
    args: readonly string[],
    options: { timeoutMs: number; maxBuffer: number },
  ): Promise<{ stdout: string }>;
}

const defaultContinuityShellRunner: ContinuityShellRunner = {
  async run(command, args, options) {
    const { stdout } = await execFileAsync(command, [...args], {
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
    });
    return { stdout };
  },
};

/** Shape of a single paired-iPhone presence observation. */
interface PairedDevicePresence {
  deviceId: string;
  displayName: string;
  connected: boolean;
  source: "xcrun_devicectl" | "system_profiler_bluetooth";
  observedAt: string;
}

interface DevicectlDevice {
  identifier?: unknown;
  deviceProperties?: {
    name?: unknown;
    deviceType?: unknown;
  };
  connectionProperties?: {
    pairingState?: unknown;
    tunnelState?: unknown;
  };
}

interface DevicectlPayload {
  result?: {
    devices?: DevicectlDevice[];
  };
}

interface BluetoothRawEntry {
  device_name?: unknown;
  device_address?: unknown;
  device_minorType?: unknown;
  device_connected?: unknown;
}

interface BluetoothPayload {
  SPBluetoothDataType?: Array<{
    device_title?: unknown;
    device_connected?: unknown;
    device_not_connected?: unknown;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

async function readDevicectlPairedIphones(
  nowIso: string,
  shell: ContinuityShellRunner,
): Promise<PairedDevicePresence[]> {
  try {
    const { stdout } = await shell.run(
      "xcrun",
      ["devicectl", "list", "devices", "--json-output", "-"],
      { timeoutMs: CONTINUITY_COMMAND_TIMEOUT_MS, maxBuffer: 512 * 1024 },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) return [];
    const payload = parsed as DevicectlPayload;
    const devices = payload.result?.devices ?? [];
    return devices
      .map((device): PairedDevicePresence | null => {
        const identifier = normalizeString(device.identifier);
        if (!identifier) return null;
        const deviceType = normalizeString(device.deviceProperties?.deviceType);
        // Only report iPhones / iPads; ignore Vision Pro, Apple Watch, etc.
        if (
          deviceType !== "iPhone" &&
          deviceType !== "iPad" &&
          deviceType !== "appleTV"
        ) {
          // deviceType is free-form — also accept values that include "iPhone".
          if (!deviceType?.toLowerCase().includes("iphone")) {
            return null;
          }
        }
        const pairingState = normalizeString(
          device.connectionProperties?.pairingState,
        );
        const tunnelState = normalizeString(
          device.connectionProperties?.tunnelState,
        );
        const connected =
          pairingState?.toLowerCase() === "paired" &&
          (tunnelState?.toLowerCase() === "connected" ||
            tunnelState?.toLowerCase() === "available");
        return {
          deviceId: identifier,
          displayName:
            normalizeString(device.deviceProperties?.name) ??
            deviceType ??
            "iPhone",
          connected,
          source: "xcrun_devicectl",
          observedAt: nowIso,
        };
      })
      .filter((entry): entry is PairedDevicePresence => entry !== null);
  } catch {
    // `xcrun devicectl` is unavailable when Xcode isn't installed — fall
    // through to the bluetooth probe silently.
    return [];
  }
}

async function readBluetoothPairedIphones(
  nowIso: string,
  shell: ContinuityShellRunner,
): Promise<PairedDevicePresence[]> {
  try {
    const { stdout } = await shell.run(
      "system_profiler",
      ["SPBluetoothDataType", "-json"],
      { timeoutMs: CONTINUITY_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) return [];
    const payload = parsed as BluetoothPayload;
    const roots = payload.SPBluetoothDataType ?? [];
    const results: PairedDevicePresence[] = [];
    for (const root of roots) {
      const connectedGroup = isRecord(root.device_connected)
        ? root.device_connected
        : null;
      const notConnectedGroup = isRecord(root.device_not_connected)
        ? root.device_not_connected
        : null;
      const processGroup = (
        group: Record<string, unknown>,
        connected: boolean,
      ) => {
        for (const [name, rawEntry] of Object.entries(group)) {
          if (!isRecord(rawEntry)) continue;
          const entry = rawEntry as BluetoothRawEntry;
          const minorType =
            normalizeString(entry.device_minorType)?.toLowerCase() ?? "";
          if (!minorType.includes("phone")) continue;
          const address = normalizeString(entry.device_address);
          if (!address) continue;
          results.push({
            deviceId: address,
            displayName: name,
            connected,
            source: "system_profiler_bluetooth",
            observedAt: nowIso,
          });
        }
      };
      if (connectedGroup) processGroup(connectedGroup, true);
      if (notConnectedGroup) processGroup(notConnectedGroup, false);
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Emits `mobile_device` activity signals for any paired-iPhone presence
 * transitions observed since the last probe run. Idempotent per
 * `(deviceId, connected, observedAt)` tuple.
 */
export async function probeContinuityDevices(args: {
  repository: LifeOpsRepository;
  agentId: string;
  now?: Date;
  /**
   * Optional shell runner override. Tests inject a stub to avoid spawning
   * `xcrun` and `system_profiler` on the host machine.
   */
  shell?: ContinuityShellRunner;
}): Promise<void> {
  if (process.platform !== "darwin") return;
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();
  const shell = args.shell ?? defaultContinuityShellRunner;

  // Skip if a Capacitor mobile-signals source has been active recently —
  // the iOS app is authoritative when it's running.
  const recentSignals = await args.repository.listActivitySignals(
    args.agentId,
    {
      sinceAt: new Date(now.getTime() - CONTINUITY_LOOKBACK_MS).toISOString(),
      limit: 64,
    },
  );
  const hasAuthoritativeMobile = recentSignals.some(
    (signal) =>
      signal.source === "mobile_device" &&
      typeof signal.platform === "string" &&
      signal.platform.startsWith("capacitor"),
  );
  if (hasAuthoritativeMobile) {
    return;
  }

  const [devicectl, bluetooth] = await Promise.all([
    readDevicectlPairedIphones(nowIso, shell),
    readBluetoothPairedIphones(nowIso, shell),
  ]);

  // Merge by deviceId — devicectl wins over bluetooth for the same device.
  const merged = new Map<string, PairedDevicePresence>();
  for (const entry of bluetooth) {
    merged.set(entry.deviceId, entry);
  }
  for (const entry of devicectl) {
    merged.set(entry.deviceId, entry);
  }

  for (const entry of merged.values()) {
    const previouslySeen = recentSignals.some(
      (signal) =>
        signal.source === "mobile_device" &&
        signal.platform === `macos_continuity:${entry.source}` &&
        typeof signal.metadata.deviceId === "string" &&
        signal.metadata.deviceId === entry.deviceId &&
        signal.state === (entry.connected ? "active" : "background"),
    );
    if (previouslySeen) continue;
    await args.repository.createActivitySignal(
      createLifeOpsActivitySignal({
        agentId: args.agentId,
        source: "mobile_device",
        platform: `macos_continuity:${entry.source}`,
        state: entry.connected ? "active" : "background",
        observedAt: entry.observedAt,
        idleState: entry.connected ? "active" : "idle",
        idleTimeSeconds: null,
        onBattery: null,
        health: null,
        metadata: {
          probe: "continuity",
          deviceId: entry.deviceId,
          displayName: entry.displayName,
          source: entry.source,
        },
      }),
    );
  }
}
