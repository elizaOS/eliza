#!/usr/bin/env node
/**
 * Mobile peak-RSS / thermal harness — STUB (needs a real iOS/Android device).
 *
 * AGENTS.md §8 requires "peak RSS, thermal/battery (mobile)" to be recorded
 * in the manifest evals and meet tier gates. Those numbers can only be
 * obtained on a physical phone running the packaged app under a
 * representative voice session (the simulator does not model thermals or a
 * real memory pressure cap). This harness is the *runner*: on a host that
 * is not a device, it records a structured "needs-device" report and exits
 * 0 — it does NOT fabricate RSS / thermal numbers (AGENTS.md §3 / §7).
 *
 * When run on-device (via the mobile QA harness with `--device <udid>`),
 * the same script reads `peak_rss_mb`, `thermal_throttle_pct`, and
 * `battery_drain_pct_per_hour` off the device-side instrumentation and
 * writes them into the report's `summary`. The collector
 * (`eliza1_gates_collect.mjs`) folds those into `eliza1_gates.yaml`'s
 * `peak_rss_mb` / `thermal_throttle_pct` gates and the manifest evals;
 * until then those gates stay `needs_hardware: true`.
 *
 * Usage:
 *   node packages/inference/verify/mobile_peak_rss_harness.mjs \
 *     [--device <udid>] [--platform ios|android] [--tier 0_8b|2b|...] [--report PATH] [--json]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv) {
  const args = {
    device: null,
    platform: null,
    tier: null,
    report: path.join(
      __dirname,
      "..",
      "reports",
      "mobile-rss",
      `mobile-peak-rss-${timestamp()}.json`,
    ),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--device") {
      i += 1;
      args.device = argv[i];
    } else if (a === "--platform") {
      i += 1;
      args.platform = argv[i];
    } else if (a === "--tier") {
      i += 1;
      args.tier = argv[i];
    } else if (a === "--report") {
      i += 1;
      args.report = argv[i];
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node mobile_peak_rss_harness.mjs [--device <udid>] [--platform ios|android] [--tier <tier>] [--report PATH] [--json]",
      );
      process.exit(0);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // No device → no real numbers. This is the expected path off-device.
  const onDevice = Boolean(args.device);

  const report = {
    generatedAt: new Date().toISOString(),
    harness: path.relative(process.cwd(), __filename),
    platform: args.platform,
    tier: args.tier,
    device: args.device,
    available: false,
    reason: onDevice
      ? "device-side instrumentation bridge not yet wired to this harness — pending the mobile QA harness integration"
      : "needs a physical iOS/Android device — peak RSS and thermal/battery cannot be measured off-device (simulator does not model thermals or the real memory pressure cap)",
    // Schema the collector / manifest evals writer keys off. All null =
    // "needs device" — recorded, not faked.
    summary: {
      peakRssMb: null,
      thermalThrottlePct: null,
      batteryDrainPctPerHour: null,
    },
  };

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`wrote ${args.report}`);
    console.log(`mobile-peak-rss: available=false — ${report.reason}`);
  }
  // Exit 0: recording a needs-device entry is success, like the dflash bench.
  process.exit(0);
}

main();
