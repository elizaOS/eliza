#!/usr/bin/env node
/**
 * Collect the latest eval/bench/harness reports, apply the gates from
 * `packages/training/benchmarks/eliza1_gates.yaml`, and emit:
 *   - an aggregate report under `packages/inference/reports/gates/`,
 *   - a manifest `evals`-block fragment (the subset W11 owns:
 *     `dflash` + `thirtyTurnOk`/`e2eLoopOk` + `vadLatencyMs`-shaped
 *     entries) the publish orchestrator / manifest writer can merge.
 *
 * Sources scanned (newest file wins, by mtime):
 *   - dflash bench           — packages/inference/reports/dflash-bench/dflash-bench-*.json
 *   - VAD quality            — packages/inference/reports/vad/vad-quality-*.json
 *   - barge-in latency       — packages/inference/reports/bargein/bargein-latency-*.json
 *   - 30-turn endurance      — packages/inference/reports/endurance/thirty-turn-endurance-*.json
 *   - fused local E2E loop   — packages/inference/reports/local-e2e/<date>/e2e-loop-*.json
 *   - mobile peak RSS        — packages/inference/reports/mobile-rss/mobile-peak-rss-*.json
 *
 * Missing source → that metric is recorded as `null` ("not measured") and
 * its gate as `status: "needs-data"` — never a fabricated number
 * (AGENTS.md §3 / §7). A `required: true` gate that has a real measurement
 * and fails its threshold makes the run exit non-zero (so CI catches it);
 * a provisional gate that fails only warns.
 *
 * Usage:
 *   node packages/inference/verify/eliza1_gates_collect.mjs \
 *     [--tier 0_6b|1_7b|9b|27b|27b-256k|27b-1m] [--gates PATH] [--report PATH] [--json]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPORTS_ROOT = path.join(__dirname, "..", "reports");
const DEFAULT_GATES = path.join(
  __dirname,
  "..",
  "..",
  "training",
  "benchmarks",
  "eliza1_gates.yaml",
);

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv) {
  const args = {
    tier: "1_7b",
    gates: DEFAULT_GATES,
    report: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--tier") {
      i += 1;
      args.tier = argv[i];
    } else if (a === "--gates") {
      i += 1;
      args.gates = argv[i];
    } else if (a === "--report") {
      i += 1;
      args.report = argv[i];
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node eliza1_gates_collect.mjs [--tier <tier>] [--gates PATH] [--report PATH] [--json]",
      );
      process.exit(0);
    }
  }
  if (!args.report) {
    args.report = path.join(
      REPORTS_ROOT,
      "gates",
      `eliza1-gates-${args.tier}-${timestamp()}.json`,
    );
  }
  return args;
}

async function loadYaml(file) {
  const text = fs.readFileSync(file, "utf8");
  const { parse } = await import("yaml");
  return parse(text);
}

/** Newest (by mtime) file matching `<dir>/<prefix>*.json`, or null. */
function newestReport(dir, prefix) {
  if (!fs.existsSync(dir)) return null;
  const matches = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => {
      const full = path.join(dir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (matches.length === 0) return null;
  try {
    return {
      path: matches[0].full,
      data: JSON.parse(fs.readFileSync(matches[0].full, "utf8")),
    };
  } catch {
    return null;
  }
}

/** Newest (by mtime) recursive file matching `prefix*.json`, or null. */
function newestReportRecursive(dir, prefix) {
  if (!fs.existsSync(dir)) return null;
  const matches = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".json")) {
        matches.push({ full, mtime: fs.statSync(full).mtimeMs });
      }
    }
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  for (const match of matches) {
    try {
      return {
        path: match.full,
        data: JSON.parse(fs.readFileSync(match.full, "utf8")),
      };
    } catch {
      // Try the next newest report if this one was partially written.
    }
  }
  return null;
}

/** Apply one gate. `measured` may be null (not measured). */
function applyGate(name, op, threshold, measured) {
  if (measured === null || measured === undefined) {
    return { name, op, threshold, measured: null, status: "needs-data" };
  }
  let pass;
  if (op === "bool") pass = measured === true;
  else if (op === ">=") pass = measured >= threshold;
  else if (op === "<=") pass = measured <= threshold;
  else pass = false;
  return {
    name,
    op,
    threshold,
    measured,
    status: pass ? "pass" : "fail",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gatesDoc = await loadYaml(args.gates);
  const tierGates = gatesDoc?.tiers?.[args.tier];
  if (!tierGates) {
    console.error(
      `[eliza1-gates-collect] unknown tier "${args.tier}" — not in ${path.relative(process.cwd(), args.gates)}`,
    );
    process.exit(2);
  }
  const gateDefs = gatesDoc?.gates ?? {};

  // ── Collect measured values from the latest reports ──────────────────
  const dflashBench = newestReport(
    path.join(REPORTS_ROOT, "dflash-bench"),
    "dflash-bench-",
  );
  const vadQuality = newestReport(
    path.join(REPORTS_ROOT, "vad"),
    "vad-quality-",
  );
  const bargein = newestReport(
    path.join(REPORTS_ROOT, "bargein"),
    "bargein-latency-",
  );
  const endurance = newestReport(
    path.join(REPORTS_ROOT, "endurance"),
    "thirty-turn-endurance-",
  );
  const mobileRss = newestReport(
    path.join(REPORTS_ROOT, "mobile-rss"),
    "mobile-peak-rss-",
  );
  const e2eLoop = newestReportRecursive(
    path.join(REPORTS_ROOT, "local-e2e"),
    "e2e-loop-",
  );

  const dflashAcceptance =
    dflashBench?.data?.summary?.dflashAcceptanceRate ??
    e2eLoop?.data?.summary?.dflashAcceptanceRateOverall ??
    e2eLoop?.data?.summary?.dflashAcceptanceRateMean ??
    null;
  const dflashSpeedup = dflashBench?.data?.summary?.dflashSpeedup ?? null;
  const vadLatencyMs = vadQuality?.data?.summary?.vadLatencyMs ?? null;
  const vadBoundaryMaeMs = vadQuality?.data?.summary?.vadBoundaryMaeMs ?? null;
  const vadEndpointP95Ms = vadQuality?.data?.summary?.vadEndpointP95Ms ?? null;
  const vadFalseBargeInPerHour =
    vadQuality?.data?.summary?.vadFalseBargeInPerHour ?? null;
  const bargeInCancelMs =
    bargein?.data?.summary?.bargeInCancelMs ??
    e2eLoop?.data?.summary?.bargeInCancelMs ??
    null;
  const thirtyTurnOk =
    endurance?.data?.summary?.thirtyTurnOk ??
    e2eLoop?.data?.thirtyTurnOk ??
    null;
  const e2eLoopOk =
    endurance?.data?.summary?.e2eLoopOk ??
    e2eLoop?.data?.e2eLoopOk ??
    null;
  const voiceRtf =
    e2eLoop?.data?.summary?.ttsRtfMedian ??
    e2eLoop?.data?.summary?.ttsRtfMean ??
    null;
  const asrWer = e2eLoop?.data?.summary?.asrWerMean ?? null;
  const firstTokenLatencyMs =
    e2eLoop?.data?.summary?.firstTokenMsMedian ??
    e2eLoop?.data?.summary?.firstTokenMsP50 ??
    null;
  const firstAudioLatencyMs =
    e2eLoop?.data?.summary?.firstAudioFromMicMsMedian ?? null;
  const peakRssMb =
    endurance?.data?.summary?.peakRssMb ??
    e2eLoop?.data?.summary?.serverPeakRssMb ??
    mobileRss?.data?.summary?.peakRssMb ??
    null;
  const thermalThrottlePct =
    mobileRss?.data?.summary?.thermalThrottlePct ?? null;

  // Map metric name → measured value. Text and expressive quality stay null
  // here — they come from the training-side eval blob, not runtime harnesses.
  const measured = {
    text_eval: null,
    voice_rtf: voiceRtf,
    asr_wer: asrWer,
    vad_latency_ms: vadLatencyMs,
    vad_boundary_mae_ms: vadBoundaryMaeMs,
    vad_endpoint_p95_ms: vadEndpointP95Ms,
    vad_false_bargein_per_hour: vadFalseBargeInPerHour,
    first_token_latency_ms: firstTokenLatencyMs,
    first_audio_latency_ms: firstAudioLatencyMs,
    barge_in_cancel_ms: bargeInCancelMs,
    thirty_turn_ok: thirtyTurnOk,
    e2e_loop_ok: e2eLoopOk,
    dflash_acceptance: dflashAcceptance,
    dflash_speedup: dflashSpeedup,
    expressive_tag_faithfulness: null,
    expressive_mos: null,
    expressive_tag_leakage: null,
    peak_rss_mb: peakRssMb,
    thermal_throttle_pct: thermalThrottlePct,
  };

  // ── Apply the gates ──────────────────────────────────────────────────
  const results = [];
  for (const [name, cfg] of Object.entries(tierGates)) {
    const def = gateDefs[name] ?? {};
    const op = def.op ?? "bool";
    const r = applyGate(name, op, cfg?.threshold, measured[name] ?? null);
    r.required = Boolean(cfg?.required);
    r.provisional = Boolean(cfg?.provisional ?? def?.provisional);
    r.needsHardware = Boolean(cfg?.needs_hardware ?? def?.needs_hardware);
    results.push(r);
  }

  const hardFailures = results.filter(
    (r) => r.status === "fail" && r.required && !r.provisional,
  );
  const softFailures = results.filter(
    (r) => r.status === "fail" && (!r.required || r.provisional),
  );
  const needsData = results.filter((r) => r.status === "needs-data");

  // ── Manifest evals fragment (the subset W11 owns) ────────────────────
  const dflashEval = {
    acceptanceRate: dflashAcceptance,
    speedup: dflashSpeedup,
    // Passed only when both numbers exist AND clear the dflash: section's
    // thresholds (which are provisional, so this never blocks defaultEligible).
    passed:
      dflashAcceptance !== null &&
      dflashSpeedup !== null &&
      dflashAcceptance >= (gatesDoc?.dflash?.minAcceptanceRate ?? 0.65) &&
      dflashSpeedup >= (gatesDoc?.dflash?.minSpeedup ?? 1.5),
  };
  const vadGateNames = [
    "vad_latency_ms",
    "vad_boundary_mae_ms",
    "vad_endpoint_p95_ms",
    "vad_false_bargein_per_hour",
  ];
  const vadQualityMeasured = [
    vadLatencyMs,
    vadBoundaryMaeMs,
    vadEndpointP95Ms,
    vadFalseBargeInPerHour,
  ].some((v) => v !== null);
  const vadLatencyEval = vadQualityMeasured && {
    median: vadLatencyMs ?? -1,
    ...(vadBoundaryMaeMs !== null ? { boundaryMs: vadBoundaryMaeMs } : {}),
    ...(vadEndpointP95Ms !== null ? { endpointMs: vadEndpointP95Ms } : {}),
    ...(vadFalseBargeInPerHour !== null
      ? { falseBargeInRate: Math.min(1, vadFalseBargeInPerHour) }
      : {}),
    passed: results
      .filter((r) => vadGateNames.includes(r.name))
      .filter((r) => r.measured !== null)
      .every((r) => r.status === "pass"),
  };
  const manifestEvalsFragment = {
    // Only emit `thirtyTurnOk`/`e2eLoopOk` when actually measured (true or
    // false from a real run). `null` means "not measured" — the publish
    // side keeps whatever it had / treats it as not-ready.
    ...(thirtyTurnOk !== null ? { thirtyTurnOk } : {}),
    ...(e2eLoopOk !== null ? { e2eLoopOk } : {}),
    ...(vadLatencyEval ? { vadLatencyMs: vadLatencyEval } : {}),
    dflash: dflashEval,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    collector: path.relative(process.cwd(), __filename),
    tier: args.tier,
    gatesFile: path.relative(process.cwd(), args.gates),
    gatesVersion: gatesDoc?.version ?? null,
    sources: {
      dflashBench: dflashBench
        ? path.relative(process.cwd(), dflashBench.path)
        : null,
      vadQuality: vadQuality
        ? path.relative(process.cwd(), vadQuality.path)
        : null,
      bargein: bargein ? path.relative(process.cwd(), bargein.path) : null,
      endurance: endurance
        ? path.relative(process.cwd(), endurance.path)
        : null,
      e2eLoop: e2eLoop ? path.relative(process.cwd(), e2eLoop.path) : null,
      mobileRss: mobileRss
        ? path.relative(process.cwd(), mobileRss.path)
        : null,
    },
    measured,
    gateResults: results,
    summary: {
      total: results.length,
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      needsData: needsData.length,
      hardFailures: hardFailures.map((r) => r.name),
      softFailures: softFailures.map((r) => r.name),
      blocking: hardFailures.length > 0,
    },
    manifestEvalsFragment,
  };

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`wrote ${args.report}`);
    console.log(
      `eliza1-gates(${args.tier}): pass=${report.summary.pass} fail=${report.summary.fail} ` +
        `needs-data=${report.summary.needsData} blocking=${report.summary.blocking}`,
    );
    if (hardFailures.length > 0) {
      console.error(
        `[eliza1-gates-collect] BLOCKING gate failures: ${hardFailures.map((r) => `${r.name}(${r.measured} vs ${r.op}${r.threshold})`).join(", ")}`,
      );
    }
    if (softFailures.length > 0) {
      console.warn(
        `[eliza1-gates-collect] provisional/non-required gate failures (not blocking): ${softFailures.map((r) => r.name).join(", ")}`,
      );
    }
  }
  process.exit(report.summary.blocking ? 1 : 0);
}

main().catch((err) => {
  console.error(`[eliza1-gates-collect] failed: ${err?.stack || err}`);
  process.exit(1);
});
