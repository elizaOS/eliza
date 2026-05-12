#!/usr/bin/env node
/**
 * Collect the latest eval/bench/harness reports, apply the gates from
 * `packages/training/benchmarks/eliza1_gates.yaml`, and emit:
 *   - an aggregate report under `packages/inference/reports/gates/`,
 *   - a manifest `evals`-block fragment (the subset W11 owns:
 *     `voiceRtf`/`asrWer` + `dflash` + `thirtyTurnOk`/`e2eLoopOk` +
 *     `vadLatencyMs`-shaped entries) the publish orchestrator / manifest
 *     writer can merge.
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
 *     [--tier 0_8b|2b|9b|27b|27b-256k|27b-1m] [--gates PATH] [--report PATH] [--json]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPORTS_ROOT = path.join(__dirname, "..", "reports");
const VERIFY_ROOT = __dirname;
const BENCH_RESULTS_ROOT = path.join(VERIFY_ROOT, "bench_results");
const HARDWARE_RESULTS_ROOT = path.join(VERIFY_ROOT, "hardware-results");
const VERIFY_REPORTS_ROOT = path.join(VERIFY_ROOT, "reports");
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
    tier: "2b",
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

function parseTimeMs(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function reportTimeMs(data, mtime) {
  return (
    parseTimeMs(data?.generatedAt) ??
    parseTimeMs(data?.finishedAt) ??
    parseTimeMs(data?.startedAt) ??
    parseTimeMs(data?.capturedAt) ??
    parseTimeMs(data?.date) ??
    mtime
  );
}

function collectJsonFiles(dir, recursive = true) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) files.push(full);
    }
  }
  return files;
}

function newestJsonReportWhere(dirs, predicate, { recursive = true } = {}) {
  const matches = [];
  for (const dir of dirs) {
    for (const full of collectJsonFiles(dir, recursive)) {
      const stat = fs.statSync(full);
      try {
        const data = JSON.parse(fs.readFileSync(full, "utf8"));
        const meta = {
          full,
          name: path.basename(full),
          relative: path.relative(process.cwd(), full),
          mtime: stat.mtimeMs,
          time: reportTimeMs(data, stat.mtimeMs),
          data,
        };
        if (predicate(meta)) matches.push(meta);
      } catch {
        // Skip partially written reports.
      }
    }
  }
  matches.sort((a, b) => b.time - a.time || b.mtime - a.mtime);
  const match = matches[0];
  return match ? { path: match.full, data: match.data } : null;
}

/** Newest file matching `<dir>/<prefix>*.json`, or null. */
function newestReport(dir, prefix) {
  return newestJsonReportWhere(
    [dir],
    ({ name }) => name.startsWith(prefix),
    { recursive: false },
  );
}

/** Newest recursive file matching `prefix*.json`, or null. */
function newestReportRecursive(dir, prefix) {
  return newestReportRecursiveWhere(dir, prefix, () => true);
}

/** Newest recursive file matching `prefix*.json` and predicate. */
function newestReportRecursiveWhere(dir, prefix, predicate) {
  return newestJsonReportWhere(
    [dir],
    ({ name, data }) => name.startsWith(prefix) && predicate(data),
  );
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = finiteOrNull(value);
    if (n !== null) return n;
  }
  return null;
}

function firstNonNull(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function matchesTier(data, tier) {
  if (data?.tier === tier || data?.bundle?.tier === tier || data?.request?.tier === tier) {
    return true;
  }
  const needle = `eliza-1-${tier}.bundle`;
  return JSON.stringify(data).includes(needle);
}

function sourcePath(report) {
  return report ? path.relative(process.cwd(), report.path) : null;
}

function extractDflashAcceptance(data) {
  const summaryRate = finiteOrNull(data?.summary?.dflashAcceptanceRate);
  if (summaryRate !== null) return summaryRate;
  const directRate = finiteOrNull(data?.withDrafter?.acceptanceRate);
  if (directRate !== null) return directRate;

  const drafted = firstFinite(
    data?.withDrafter?.drafted,
    data?.summary?.dflashDraftedTotal,
  );
  const accepted = firstFinite(
    data?.withDrafter?.accepted,
    data?.summary?.dflashAcceptedTotal,
  );
  if (drafted !== null && accepted !== null) {
    return drafted > 0 ? accepted / drafted : 0;
  }
  return null;
}

function extractDflashSpeedup(data) {
  const drafted = firstFinite(
    data?.withDrafter?.drafted,
    data?.summary?.dflashDraftedTotal,
  );
  const accepted = firstFinite(
    data?.withDrafter?.accepted,
    data?.summary?.dflashAcceptedTotal,
  );
  const draftingActive =
    data?.draftingActive ??
    data?.summary?.dflashDraftingActive ??
    data?.withDrafter?.draftingActive ??
    (drafted !== null && drafted > 0 && accepted !== null);
  const tokenizerCompatible =
    data?.summary?.tokenizerCompatible ??
    data?.withDrafter?.tokenizerCompatible;
  if (draftingActive === false || tokenizerCompatible === false || drafted === 0) {
    return 0;
  }

  const summarySpeedup = finiteOrNull(data?.summary?.dflashSpeedup);
  if (summarySpeedup !== null) return summarySpeedup;
  const withTps = finiteOrNull(data?.withDrafter?.tokensPerSecond);
  const withoutTps = finiteOrNull(data?.withoutDrafter?.tokensPerSecond);
  if (withTps !== null && withoutTps !== null && withoutTps > 0) {
    return withTps / withoutTps;
  }
  return null;
}

function averageStepRtf(data) {
  const rows = data?.summary?.stepSweep;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return firstFinite(rows[0]?.meanRtf);
}

function statusText(row) {
  if (row.status === "not-applicable") return "N/A";
  return row.status.toUpperCase();
}

function escapeCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

function renderMarkdownReport(report) {
  const lines = [
    `# Eliza-1 ${report.tier} Release Gate Summary`,
    "",
    `Generated: ${report.generatedAt}`,
    `Collector: \`${report.collector}\``,
    `JSON report: \`${report.reportPath}\``,
    "",
    `Gate result counts: pass=${report.summary.pass}, fail=${report.summary.fail}, needs-data=${report.summary.needsData}, blocking=${report.summary.blocking}`,
    `Release matrix counts: pass=${report.releaseMatrixSummary.pass}, fail=${report.releaseMatrixSummary.fail}, needs-data=${report.releaseMatrixSummary.needsData}, n/a=${report.releaseMatrixSummary.notApplicable}, blocking=${report.releaseMatrixSummary.blocking}`,
    "",
    "| Area | Gate | Status | Blocking | Measurement | Threshold | Reason | Source |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of report.releaseGateMatrix) {
    lines.push(
      `| ${escapeCell(row.area)} | ${escapeCell(row.gate)} | ${escapeCell(statusText(row))} | ${row.blocking ? "yes" : "no"} | ${escapeCell(row.measured)} | ${escapeCell(row.threshold)} | ${escapeCell(row.reason)} | ${escapeCell(row.source)} |`,
    );
  }
  if (report.releaseMatrixSummary.blockerReasons.length > 0) {
    lines.push("", "## Blockers", "");
    for (const reason of report.releaseMatrixSummary.blockerReasons) {
      lines.push(`- ${reason}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/** Apply one gate. `measured` may be null (not measured). */
function applyGate(name, op, threshold, measured) {
  if (measured === null || measured === undefined) {
    return {
      name,
      op,
      threshold,
      measured: null,
      status: "needs-data",
      reason: "not measured",
    };
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
    reason:
      op === "bool"
        ? `${name}=${measured}; expected true`
        : `${name}=${measured} ${op} ${threshold}`,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const asrExternalMinUtterances = intEnv("ELIZA_ASR_MIN_EXTERNAL_UTTERANCES", 5);
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
  const evalAggregate = newestReportRecursiveWhere(
    path.join(REPORTS_ROOT, "local-e2e"),
    `${args.tier}-aggregate`,
    (data) => data?.tier === args.tier,
  );
  const textEval = newestReportRecursiveWhere(
    path.join(REPORTS_ROOT, "local-e2e"),
    `${args.tier}-text-eval`,
    (data) => data?.metric === "text_eval" || data?.score !== undefined,
  );
  const expressive = newestReportRecursiveWhere(
    path.join(REPORTS_ROOT, "local-e2e"),
    `${args.tier}-expressive`,
    (data) => data?.metric === "expressive",
  );
  const dflashBench = newestJsonReportWhere(
    [
      path.join(REPORTS_ROOT, "dflash-bench"),
      path.join(REPORTS_ROOT, "porting"),
      BENCH_RESULTS_ROOT,
      HARDWARE_RESULTS_ROOT,
    ],
    ({ name, data }) =>
      name.toLowerCase().includes("dflash") &&
      Boolean(data?.withDrafter) &&
      Boolean(data?.withoutDrafter) &&
      matchesTier(data, args.tier),
  );
  const asrExternal = newestJsonReportWhere(
    [BENCH_RESULTS_ROOT, path.join(REPORTS_ROOT, "local-e2e")],
    ({ name, data }) => {
      if (!name.toLowerCase().includes("asr")) return false;
      if (data?.aggregate?.wer === undefined || !matchesTier(data, args.tier)) return false;
      const source = String(data?.labelledSet?.source ?? "");
      const measurementClass = String(data?.labelledSet?.measurementClass ?? "");
      const count = firstFinite(data?.labelledSet?.count, data?.aggregate?.utterances);
      if (count === null || count < asrExternalMinUtterances) return false;
      if (source.includes("tts") || measurementClass.includes("self_labelled")) return false;
      return source.includes("external") || measurementClass.includes("external");
    },
  );
  const asrBench = newestJsonReportWhere(
    [BENCH_RESULTS_ROOT, path.join(REPORTS_ROOT, "local-e2e")],
    ({ name, data }) =>
      name.toLowerCase().includes("asr") &&
      data?.aggregate?.wer !== undefined &&
      String(data?.labelledSet?.source ?? "").includes("tts") &&
      matchesTier(data, args.tier),
  );
  const asrTtsLoopbackSmoke = newestJsonReportWhere(
    [path.join(REPORTS_ROOT, "local-e2e")],
    ({ name, data }) =>
      name.startsWith("asr-tts-loopback") &&
      data?.ok === true &&
      matchesTier(data, args.tier),
  );
  const voiceProfile = newestJsonReportWhere(
    [path.join(REPORTS_ROOT, "local-e2e")],
    ({ name, data }) =>
      name.startsWith("voice-profile-emotion-readiness") &&
      matchesTier(data, args.tier),
  );
  const ttsStreamSmoke = newestJsonReportWhere(
    [path.join(REPORTS_ROOT, "local-e2e")],
    ({ name, data }) =>
      name.startsWith("tts-stream-smoke") &&
      data?.ok === true &&
      matchesTier(data, args.tier),
  );
  const ttsSweep = newestJsonReportWhere(
    [path.join(REPORTS_ROOT, "local-e2e"), BENCH_RESULTS_ROOT],
    ({ name, data }) =>
      name.startsWith("tts-step-sweep") &&
      matchesTier(data, args.tier) &&
      averageStepRtf(data) !== null,
  );
  const vadQuality = newestJsonReportWhere(
    [
      path.join(REPORTS_ROOT, "vad"),
      path.join(REPORTS_ROOT, "local-e2e"),
      BENCH_RESULTS_ROOT,
    ],
    ({ name, data }) =>
      name.toLowerCase().includes("vad") &&
      data?.summary?.vadLatencyMs !== undefined &&
      matchesTier(data, args.tier),
  );
  const bargein = newestJsonReportWhere(
    [
      path.join(REPORTS_ROOT, "bargein"),
      path.join(REPORTS_ROOT, "local-e2e"),
      BENCH_RESULTS_ROOT,
    ],
    ({ name, data }) =>
      name.toLowerCase().includes("bargein") &&
      data?.summary?.bargeInCancelMs !== undefined &&
      matchesTier(data, args.tier),
  );
  const endurance = newestReport(
    path.join(REPORTS_ROOT, "endurance"),
    "thirty-turn-endurance-",
  );
  const mobileRss = newestReport(
    path.join(REPORTS_ROOT, "mobile-rss"),
    "mobile-peak-rss-",
  );
  const e2eLoop = newestReportRecursiveWhere(
    path.join(REPORTS_ROOT, "local-e2e"),
    "e2e-loop-",
    (data) => matchesTier(data, args.tier),
  );
  const e2eEnduranceLoop = newestReportRecursiveWhere(
    path.join(REPORTS_ROOT, "local-e2e"),
    "e2e-loop-",
    (data) => matchesTier(data, args.tier) && (data?.summary?.turns ?? data?.request?.turns ?? 0) >= 30,
  );
  const cpuSimd = newestJsonReportWhere(
    [BENCH_RESULTS_ROOT],
    ({ name, data }) =>
      name.toLowerCase().includes("cpu_simd") &&
      Array.isArray(data?.kernels) &&
      data?.qjl_active_simd,
  );
  const metalDispatch = newestJsonReportWhere(
    [VERIFY_ROOT],
    ({ name, data }) =>
      name === "metal-runtime-dispatch-evidence.json" && data?.backend === "metal",
    { recursive: false },
  );
  const vulkanDispatch = newestJsonReportWhere(
    [VERIFY_ROOT],
    ({ name, data }) =>
      name === "vulkan-runtime-dispatch-evidence.json" &&
      data?.backend === "vulkan",
    { recursive: false },
  );
  const visionSmoke = newestJsonReportWhere(
    [VERIFY_ROOT, BENCH_RESULTS_ROOT],
    ({ name, data }) =>
      name.toLowerCase().includes("vision") &&
      (data?.tier === args.tier || data?.request?.tier === args.tier),
  );
  const diarization = newestJsonReportWhere(
    [VERIFY_REPORTS_ROOT],
    ({ name, data }) =>
      name.toLowerCase().includes("diarization") && matchesTier(data, args.tier),
  );
  const iosSmoke = newestJsonReportWhere(
    [HARDWARE_RESULTS_ROOT, path.join(REPORTS_ROOT, "porting")],
    ({ name }) => name.toLowerCase().includes("ios") && name.toLowerCase().includes("smoke"),
  );

  const e2eDflashDrafted = e2eLoop?.data?.summary?.dflashDraftedTotal;
  const e2eDflashAccepted = e2eLoop?.data?.summary?.dflashAcceptedTotal;
  const e2eDflashAcceptance =
    Number.isFinite(e2eDflashDrafted) && Number.isFinite(e2eDflashAccepted)
      ? e2eDflashDrafted > 0
        ? e2eDflashAccepted / e2eDflashDrafted
        : 0
      : null;
  const dflashAcceptance =
    (dflashBench ? extractDflashAcceptance(dflashBench.data) : null) ??
    e2eLoop?.data?.summary?.dflashAcceptanceRateOverall ??
    e2eLoop?.data?.summary?.dflashAcceptanceRateMean ??
    e2eDflashAcceptance ??
    null;
  const dflashSpeedup = dflashBench ? extractDflashSpeedup(dflashBench.data) : null;
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
    e2eEnduranceLoop?.data?.thirtyTurnOk ??
    null;
  const e2eLoopOk =
    endurance?.data?.summary?.e2eLoopOk ??
    e2eLoop?.data?.e2eLoopOk ??
    null;
  const voiceRtf =
    averageStepRtf(ttsSweep?.data) ??
    ttsStreamSmoke?.data?.rtf ??
    e2eLoop?.data?.summary?.ttsRtfMedian ??
    e2eLoop?.data?.summary?.ttsRtfMean ??
    evalAggregate?.data?.results?.voice_rtf ??
    null;
  const asrWer =
    asrExternal?.data?.aggregate?.wer ??
    null;
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
  const textEvalScore =
    textEval?.data?.score ?? evalAggregate?.data?.results?.text_eval ?? null;
  const expressiveTagFaithfulness =
    expressive?.data?.tagFaithfulness ??
    evalAggregate?.data?.results?.expressive_tag_faithfulness ??
    null;
  const expressiveMos =
    expressive?.data?.mosExpressive ??
    evalAggregate?.data?.results?.expressive_mos ??
    null;
  const expressiveTagLeakage =
    expressive?.data?.tagLeakage ??
    evalAggregate?.data?.results?.expressive_tag_leakage ??
    null;

  // Map metric name → measured value. Missing values stay null: that means
  // not measured, not passed.
  const measured = {
    text_eval: textEvalScore,
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
    expressive_tag_faithfulness: expressiveTagFaithfulness,
    expressive_mos: expressiveMos,
    expressive_tag_leakage: expressiveTagLeakage,
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
  const gateByName = new Map(results.map((r) => [r.name, r]));
  const voiceRtfEval = voiceRtf !== null && {
    rtf: voiceRtf,
    passed: gateByName.get("voice_rtf")?.status === "pass",
  };
  const asrWerEval = asrWer !== null && {
    wer: asrWer,
    passed: gateByName.get("asr_wer")?.status === "pass",
  };
  const textEvalManifest = textEvalScore !== null && {
    score: textEvalScore,
    passed: gateByName.get("text_eval")?.status === "pass",
  };
  const expressiveMeasured = [
    expressiveTagFaithfulness,
    expressiveMos,
    expressiveTagLeakage,
  ].some((v) => v !== null);
  const expressiveManifest = expressiveMeasured && {
    tagFaithfulness: expressiveTagFaithfulness ?? -1,
    mosExpressive: expressiveMos ?? -1,
    tagLeakage: expressiveTagLeakage ?? -1,
    passed:
      gateByName.get("expressive_tag_faithfulness")?.status === "pass" &&
      gateByName.get("expressive_mos")?.status === "pass" &&
      gateByName.get("expressive_tag_leakage")?.status === "pass",
  };
  const manifestEvalsFragment = {
    // Only emit `thirtyTurnOk`/`e2eLoopOk` when actually measured (true or
    // false from a real run). `null` means "not measured" — the publish
    // side keeps whatever it had / treats it as not-ready.
    ...(textEvalManifest ? { textEval: textEvalManifest } : {}),
    ...(voiceRtfEval ? { voiceRtf: voiceRtfEval } : {}),
    ...(asrWerEval ? { asrWer: asrWerEval } : {}),
    ...(thirtyTurnOk !== null ? { thirtyTurnOk } : {}),
    ...(e2eLoopOk !== null ? { e2eLoopOk } : {}),
    ...(vadLatencyEval ? { vadLatencyMs: vadLatencyEval } : {}),
    ...(expressiveManifest ? { expressive: expressiveManifest } : {}),
    dflash: dflashEval,
  };

  function gateRow(name, area, source, reasonOverride = null, blockingOverride = null) {
    const gate = gateByName.get(name);
    const blocking =
      blockingOverride ??
      Boolean(gate?.required && gate?.status !== "pass" && !gate?.needsHardware);
    return {
      area,
      gate: name,
      status: gate?.status ?? "needs-data",
      blocking,
      measured: gate?.measured ?? null,
      threshold:
        gate?.op === "bool" ? "true" : `${gate?.op ?? ""} ${gate?.threshold ?? ""}`.trim(),
      reason: reasonOverride ?? gate?.reason ?? "not measured",
      source,
    };
  }

  function platformRow(area, gate, evidence, source, reasonPass, reasonMissing) {
    const ok = Boolean(evidence);
    return {
      area,
      gate,
      status: ok ? "pass" : "needs-data",
      blocking: !ok,
      measured: ok ? "runtime-ready evidence present" : null,
      threshold: "runtime-ready",
      reason: ok ? reasonPass : reasonMissing,
      source,
    };
  }

  const requiredKernelNames = ["turbo3", "turbo4", "qjl", "polar"];
  const metalKernelReady = requiredKernelNames.every(
    (name) => metalDispatch?.data?.kernels?.[name]?.runtimeReady === true,
  );
  const vulkanKernelReady = requiredKernelNames.every(
    (name) => vulkanDispatch?.data?.kernels?.[name]?.runtimeReady === true,
  );
  const cpuKernelReady = Boolean(cpuSimd?.data?.qjl_active_simd && cpuSimd?.data?.polarquant_active_simd);
  const dflashDrafted = firstFinite(
    dflashBench?.data?.withDrafter?.drafted,
    e2eLoop?.data?.summary?.dflashDraftedTotal,
  );
  const dflashAccepted = firstFinite(
    dflashBench?.data?.withDrafter?.accepted,
    e2eLoop?.data?.summary?.dflashAcceptedTotal,
  );
  const e2eOptimizations = e2eLoop?.data?.summary?.requiredOptimizations ?? e2eLoop?.data?.requiredOptimizations;
  const streamingTtsActive = boolOrNull(e2eOptimizations?.streamingTtsActive);
  const dflashDraftingActive = boolOrNull(e2eOptimizations?.dflashDraftingActive);
  const visionStatus =
    visionSmoke?.data?.status === "not-applicable"
      ? "not-applicable"
      : visionSmoke?.data?.passed === true
        ? "pass"
        : visionSmoke
          ? "fail"
          : "needs-data";
  const iosStatus = iosSmoke?.data?.status === "passed" ? "pass" : iosSmoke ? "fail" : "needs-data";
  const iosBlocker = iosSmoke?.data?.blocker;
  const localVoiceLoopbackPass =
    asrTtsLoopbackSmoke?.data?.ok === true ||
    voiceProfile?.data?.defaultStreamingTtsRoundTrip?.status === "pass";
  const localVoiceLoopbackRtf = firstFinite(
    ttsStreamSmoke?.data?.rtf,
    voiceProfile?.data?.defaultStreamingTtsRoundTrip?.tts?.rtf,
    averageStepRtf(ttsSweep?.data),
  );
  const localVoiceLoopbackWer = localVoiceLoopbackPass
      ? 0
      : firstFinite(
          ttsSweep?.data?.summary?.stepSweep?.[0]?.meanAsrWer,
          asrBench?.data?.aggregate?.wer,
      );
  const localVoiceLoopbackStatus =
    localVoiceLoopbackPass || (localVoiceLoopbackWer !== null && localVoiceLoopbackWer <= 0.1)
      ? "pass"
      : voiceProfile || ttsSweep || asrBench
        ? "fail"
        : "needs-data";
  const releaseGateMatrix = [
    gateRow("text_eval", "quality", sourcePath(textEval ?? evalAggregate)),
    gateRow("voice_rtf", "voice", sourcePath(ttsSweep ?? ttsStreamSmoke ?? e2eLoop)),
    gateRow(
      "asr_wer",
      "voice",
      sourcePath(asrExternal),
      asrWer === null
        ? `no >=${asrExternalMinUtterances}-utterance real recorded/external ASR WER report found; local generated-voice loopback is tracked separately`
        : null,
    ),
    {
      area: "voice",
      gate: "local_voice_loopback_smoke",
      status: localVoiceLoopbackStatus,
      blocking: localVoiceLoopbackStatus !== "pass",
      measured:
        localVoiceLoopbackStatus === "needs-data"
          ? null
          : `wer=${localVoiceLoopbackWer ?? "unknown"}, rtf=${localVoiceLoopbackRtf ?? "unknown"}`,
      threshold: "generated TTS->ASR smoke pass",
      reason:
        localVoiceLoopbackStatus === "pass"
          ? "default generated TTS audio round-tripped through local ASR"
          : "generated TTS->ASR smoke did not pass lexical validation",
      source: sourcePath(
        asrTtsLoopbackSmoke ?? voiceProfile ?? ttsSweep ?? asrBench,
      ),
    },
    gateRow("vad_latency_ms", "voice", sourcePath(vadQuality)),
    gateRow("vad_boundary_mae_ms", "voice", sourcePath(vadQuality)),
    gateRow("vad_endpoint_p95_ms", "voice", sourcePath(vadQuality)),
    gateRow("vad_false_bargein_per_hour", "voice", sourcePath(vadQuality)),
    gateRow("first_token_latency_ms", "latency", sourcePath(e2eLoop)),
    gateRow(
      "first_audio_latency_ms",
      "latency",
      sourcePath(e2eLoop),
      firstAudioLatencyMs !== null
        ? `first audio is ${firstAudioLatencyMs} ms; TTS best preset passes RTF but first-audio remains slow`
        : null,
      false,
    ),
    gateRow("barge_in_cancel_ms", "latency", sourcePath(bargein ?? e2eLoop)),
    gateRow("thirty_turn_ok", "endurance", sourcePath(endurance ?? e2eEnduranceLoop)),
    gateRow("e2e_loop_ok", "e2e", sourcePath(e2eLoop)),
    gateRow(
      "dflash_acceptance",
      "dflash",
      sourcePath(dflashBench ?? e2eLoop),
      dflashDrafted === 0 && dflashAccepted === 0
        ? "DFlash generated zero drafted and accepted tokens; acceptance is an honest 0"
        : null,
      true,
    ),
    gateRow(
      "dflash_speedup",
      "dflash",
      sourcePath(dflashBench),
      dflashSpeedup !== null
        ? `DFlash speedup ${dflashSpeedup.toFixed(3)}x is below target`
        : null,
      true,
    ),
    gateRow(
      "expressive_tag_faithfulness",
      "expressive",
      sourcePath(expressive ?? evalAggregate),
      expressive?.data?.reason ?? "expressive graders did not produce tag-faithfulness data",
      true,
    ),
    gateRow(
      "expressive_mos",
      "expressive",
      sourcePath(expressive ?? evalAggregate),
      expressive?.data?.reason ?? "expressive graders did not produce MOS data",
      true,
    ),
    gateRow(
      "expressive_tag_leakage",
      "expressive",
      sourcePath(expressive ?? evalAggregate),
      expressive?.data?.reason ?? "expressive graders did not produce tag-leakage data",
      true,
    ),
    {
      area: "platform",
      gate: "cpu_simd_kernels",
      status: cpuKernelReady ? "pass" : "needs-data",
      blocking: !cpuKernelReady,
      measured: cpuKernelReady
        ? `qjl=${cpuSimd.data.qjl_active_simd}, polar=${cpuSimd.data.polarquant_active_simd}`
        : null,
      threshold: "QJL + Polar SIMD active",
      reason: cpuKernelReady
        ? "CPU SIMD plugin evidence is present; model-backed tok/s is still not claimed"
        : "missing CPU SIMD evidence",
      source: sourcePath(cpuSimd),
    },
    platformRow(
      "platform",
      "metal_runtime_kernels",
      metalKernelReady,
      sourcePath(metalDispatch),
      "required Metal kernels are runtime-ready by graph dispatch evidence",
      "missing required Metal runtime dispatch evidence",
    ),
    platformRow(
      "platform",
      "vulkan_runtime_kernels",
      vulkanKernelReady,
      sourcePath(vulkanDispatch),
      "required Vulkan kernels are runtime-ready by native graph dispatch evidence",
      "missing required Vulkan runtime dispatch evidence",
    ),
    {
      area: "worker-output",
      gate: "streaming_tts_active",
      status: streamingTtsActive === true ? "pass" : streamingTtsActive === false ? "fail" : "needs-data",
      blocking: streamingTtsActive !== true,
      measured: streamingTtsActive,
      threshold: "true",
      reason:
        streamingTtsActive === true
          ? "e2e loop observed streaming TTS active; installed dylib rebuild is still tracked separately"
          : "streaming TTS was not active in the selected e2e loop",
      source: sourcePath(e2eLoop),
    },
    {
      area: "worker-output",
      gate: "dflash_drafting_active",
      status: dflashDraftingActive === true ? "pass" : dflashDraftingActive === false ? "fail" : "needs-data",
      blocking: dflashDraftingActive !== true,
      measured: dflashDraftingActive,
      threshold: "true",
      reason:
        dflashDraftingActive === true
          ? "e2e loop observed DFlash drafting"
          : "required optimization is inactive in the selected e2e loop",
      source: sourcePath(e2eLoop),
    },
    {
      area: "worker-output",
      gate: "vision_smoke",
      status: visionStatus,
      blocking: visionStatus === "fail",
      measured: visionSmoke?.data?.status ?? null,
      threshold: args.tier === "0_8b" || args.tier === "2b" ? "not-applicable" : "pass",
      reason:
        visionSmoke?.data?.reason ??
        (visionStatus === "needs-data" ? "no vision smoke evidence for this tier" : "vision smoke passed"),
      source: sourcePath(visionSmoke),
    },
    {
      area: "worker-output",
      gate: "diarization_der",
      status: diarization?.data?.diarization?.der !== null && diarization?.data?.diarization?.der !== undefined ? "pass" : "needs-data",
      blocking: false,
      measured: diarization?.data?.diarization?.der ?? null,
      threshold: "measured DER",
      reason:
        diarization?.data?.diarization?.reason ??
        "full DER was not measured",
      source: sourcePath(diarization),
    },
    {
      area: "worker-output",
      gate: "ios_physical_smoke",
      status: iosStatus,
      blocking: iosStatus !== "pass",
      measured: iosSmoke?.data?.status ?? null,
      threshold: "passed",
      reason:
        iosBlocker?.nextAction ??
        iosBlocker?.detail ??
        iosSmoke?.data?.reason ??
        (iosStatus === "pass" ? "iOS smoke passed" : "iOS smoke evidence missing"),
      source: sourcePath(iosSmoke),
    },
  ];

  const releaseMatrixSummary = {
    total: releaseGateMatrix.length,
    pass: releaseGateMatrix.filter((r) => r.status === "pass").length,
    fail: releaseGateMatrix.filter((r) => r.status === "fail").length,
    needsData: releaseGateMatrix.filter((r) => r.status === "needs-data").length,
    notApplicable: releaseGateMatrix.filter((r) => r.status === "not-applicable").length,
    blocking: releaseGateMatrix.some((r) => r.blocking && r.status !== "pass" && r.status !== "not-applicable"),
    blockerReasons: releaseGateMatrix
      .filter((r) => r.blocking && r.status !== "pass" && r.status !== "not-applicable")
      .map((r) => `${r.gate}: ${r.reason}`),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    collector: path.relative(process.cwd(), __filename),
    reportPath: path.relative(process.cwd(), args.report),
    tier: args.tier,
    gatesFile: path.relative(process.cwd(), args.gates),
    gatesVersion: gatesDoc?.version ?? null,
    sources: {
      evalAggregate: sourcePath(evalAggregate),
      textEval: sourcePath(textEval),
      expressive: sourcePath(expressive),
      dflashBench: sourcePath(dflashBench),
      asrExternal: sourcePath(asrExternal),
      asrBench: sourcePath(asrBench),
      asrTtsLoopbackSmoke: sourcePath(asrTtsLoopbackSmoke),
      voiceProfile: sourcePath(voiceProfile),
      ttsStreamSmoke: sourcePath(ttsStreamSmoke),
      ttsSweep: sourcePath(ttsSweep),
      vadQuality: sourcePath(vadQuality),
      bargein: sourcePath(bargein),
      endurance: sourcePath(endurance),
      e2eLoop: sourcePath(e2eLoop),
      e2eEnduranceLoop: sourcePath(e2eEnduranceLoop),
      mobileRss: sourcePath(mobileRss),
      cpuSimd: sourcePath(cpuSimd),
      metalDispatch: sourcePath(metalDispatch),
      vulkanDispatch: sourcePath(vulkanDispatch),
      visionSmoke: sourcePath(visionSmoke),
      diarization: sourcePath(diarization),
      iosSmoke: sourcePath(iosSmoke),
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
    releaseGateMatrix,
    releaseMatrixSummary,
  };

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  const markdownReport = args.report.replace(/\.json$/i, ".md");
  fs.writeFileSync(markdownReport, renderMarkdownReport(report));
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`wrote ${args.report}`);
    console.log(`wrote ${markdownReport}`);
    console.log(
      `eliza1-gates(${args.tier}): pass=${report.summary.pass} fail=${report.summary.fail} ` +
        `needs-data=${report.summary.needsData} blocking=${report.summary.blocking}`,
    );
    console.log(
      `release-matrix(${args.tier}): pass=${report.releaseMatrixSummary.pass} fail=${report.releaseMatrixSummary.fail} ` +
        `needs-data=${report.releaseMatrixSummary.needsData} n/a=${report.releaseMatrixSummary.notApplicable} ` +
        `blocking=${report.releaseMatrixSummary.blocking}`,
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
