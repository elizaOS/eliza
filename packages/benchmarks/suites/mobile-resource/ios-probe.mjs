/**
 * iOS host-side resource probe (xcrun simctl).
 *
 * iOS has no `adb`-style host probe for live RSS/thermal/battery — those come
 * from the in-app `ElizaIntent.getResourceSnapshot` native bridge (the runner
 * evaluates it in the WebView). What the host *can* do is pull the MetricKit
 * payloads the app wrote to its container (`ElizaMetricKit/`), the Apple
 * -sanctioned CPU/energy source. Simulators cannot report real energy or
 * thermal (#8800 open question), so on a sim the runner records those as
 * "not available on this platform" rather than fabricating them.
 *
 * Every reader returns null/[] on any failure so the runner degrades cleanly.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tryExec } from "./lib.mjs";

const SIMCTL = ["xcrun", "simctl"];

/** Booted simulator udid, or null when simctl is missing / no sim booted. */
export function detectBootedSimulator() {
  const out = tryExec(SIMCTL[0], [SIMCTL[1], "list", "devices", "booted"], {
    timeoutMs: 10_000,
  });
  if (out == null) return null;
  // "    iPhone 16 Pro (UDID) (Booted)"
  const m = out.match(/\(([0-9A-Fa-f-]{36})\)\s*\(Booted\)/);
  return m ? m[1] : null;
}

/** Whether the target is a simulator (true) — physical iOS is devicectl-driven. */
export function isSimulatorTarget(udid) {
  return typeof udid === "string" && udid.length === 36;
}

/**
 * Pull MetricKit payload JSON the app stored under its container's
 * Application Support/ElizaMetricKit directory. Returns parsed objects.
 */
export function pullMetricKitPayloads(udid, bundleId) {
  const container = tryExec(
    SIMCTL[0],
    [SIMCTL[1], "get_app_container", udid, bundleId, "data"],
    { timeoutMs: 10_000 },
  );
  if (container == null || !existsSync(container)) return [];
  const dir = join(
    container,
    "Library",
    "Application Support",
    "ElizaMetricKit",
  );
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
    } catch {
      // skip an unparseable payload file
    }
  }
  return out;
}

/** Total physical memory of the host machine (sim runs in-host) in MB, or null. */
export function readHostTotalRamMb() {
  const out = tryExec("sysctl", ["-n", "hw.memsize"], { timeoutMs: 5000 });
  const n = out == null ? Number.NaN : Number(out);
  return Number.isFinite(n) ? n / 1_048_576 : null;
}
