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
 * (AGENTS.md §3 / §7). A `required: true` gate exits non-zero when it is
 * missing or fails its threshold, except hardware-bound gates that are
 * explicitly skipped until the device matrix supplies evidence.
 *
 * Usage:
 *   node packages/inference/verify/eliza1_gates_collect.mjs \
 *     [--tier 0_8b|2b|4b|9b|27b|27b-256k] [--bundle PATH] \
 *     [--sync-bundle-manifest-evals] [--gates PATH] [--report PATH] [--json]
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoRoot(startDir) {
  let current = startDir;
  while (true) {
    const candidate = path.join(
      current,
      "packages",
      "training",
      "benchmarks",
      "eliza1_gates.yaml",
    );
    if (fs.existsSync(candidate)) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `could not locate repo root from ${startDir}; missing packages/training/benchmarks/eliza1_gates.yaml`,
      );
    }
    current = parent;
  }
}

const REPO_ROOT = findRepoRoot(__dirname);
const REPORTS_ROOT = path.join(__dirname, "..", "reports");
const VERIFY_ROOT = __dirname;
const BENCH_RESULTS_ROOT = path.join(VERIFY_ROOT, "bench_results");
const HARDWARE_RESULTS_ROOT = path.join(VERIFY_ROOT, "hardware-results");
const VERIFY_REPORTS_ROOT = path.join(VERIFY_ROOT, "reports");
const DEFAULT_GATES = path.join(
  REPO_ROOT,
  "packages",
  "training",
  "benchmarks",
  "eliza1_gates.yaml",
);
const ACTIVE_VISION_TIERS = new Set([
  "0_8b",
  "2b",
  "4b",
  "9b",
  "27b",
  "27b-256k",
]);
const ACTIVE_DFLASH_TIERS = new Set([
  "2b",
  "4b",
  "9b",
  "27b",
  "27b-256k",
]);

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv) {
  const args = {
    tier: "2b",
    bundle: null,
    syncBundleManifestEvals: false,
    gates: DEFAULT_GATES,
    report: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--tier") {
      i += 1;
      args.tier = argv[i];
    } else if (a === "--bundle" || a === "--bundle-dir") {
      i += 1;
      args.bundle = argv[i] ?? null;
    } else if (a === "--sync-bundle-manifest-evals") {
      args.syncBundleManifestEvals = true;
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
        "Usage: node eliza1_gates_collect.mjs [--tier <tier>] [--bundle PATH] [--sync-bundle-manifest-evals] [--gates PATH] [--report PATH] [--json]",
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

function stateDir() {
  return process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza");
}

function installedBundleDir(tier) {
  return path.join(
    stateDir(),
    "local-inference",
    "models",
    `eliza-1-${tier}.bundle`,
  );
}

function bundleEvalDirs(args) {
  const dirs = [];
  if (args.bundle) dirs.push(path.join(path.resolve(args.bundle), "evals"));
  const installed = path.join(installedBundleDir(args.tier), "evals");
  if (!dirs.includes(installed)) dirs.push(installed);
  return dirs.filter((dir) => fs.existsSync(dir));
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

function textOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
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

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function listChecksumInputs(root, dir = root) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === ".DS_Store" || entry.name === "__MACOSX") continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      out.push(...listChecksumInputs(root, full));
    } else if (entry.isFile() && rel !== "checksums/SHA256SUMS") {
      out.push(rel);
    }
  }
  return out;
}

function regenerateBundleChecksums(bundleDir) {
  const checksumPath = path.join(bundleDir, "checksums", "SHA256SUMS");
  fs.mkdirSync(path.dirname(checksumPath), { recursive: true });
  const lines = listChecksumInputs(bundleDir)
    .map((rel) => `${sha256File(path.join(bundleDir, rel))}  ${rel}`)
    .join("\n");
  fs.writeFileSync(checksumPath, `${lines}\n`);
  return checksumPath;
}

function isBlockingGateResult(result) {
  return Boolean(
    result?.required &&
      result?.status !== "pass" &&
      result?.status !== "not-applicable" &&
      !result?.provisional &&
      !result?.needsHardware,
  );
}

function syncBundleManifestEvals(
  bundleDir,
  manifestEvalsFragment,
  { generatedAt, measured, requiresDflash, results },
) {
  const manifestPath = path.join(bundleDir, "eliza-1.manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const before = JSON.stringify(manifest.evals ?? {});
  const evals = { ...(manifest.evals ?? {}) };
  const removed = [];
  const updated = [];
  const hasFiles = (slot) =>
    Array.isArray(manifest.files?.[slot]) && manifest.files[slot].length > 0;
  const voiceCapabilities = Array.isArray(manifest.voice?.capabilities)
    ? manifest.voice.capabilities
    : [];
  const needsExpressiveEval =
    voiceCapabilities.includes("emotion-tags") ||
    voiceCapabilities.includes("singing");

  for (const key of ["textEval", "voiceRtf"]) {
    if (Object.prototype.hasOwnProperty.call(manifestEvalsFragment, key)) {
      evals[key] = manifestEvalsFragment[key];
      updated.push(key);
    }
  }
  for (const key of ["e2eLoopOk", "thirtyTurnOk"]) {
    if (Object.prototype.hasOwnProperty.call(manifestEvalsFragment, key)) {
      evals[key] = manifestEvalsFragment[key];
      updated.push(key);
    } else if (typeof evals[key] !== "boolean") {
      evals[key] = false;
      updated.push(key);
    }
  }

  if (Object.prototype.hasOwnProperty.call(manifestEvalsFragment, "asrWer")) {
    evals.asrWer = manifestEvalsFragment.asrWer;
    updated.push("asrWer");
  } else if (hasFiles("asr")) {
    evals.asrWer = {
      wer: 1,
      passed: false,
      status: "not-run",
      reason: "no real recorded/external ASR WER report was measured",
    };
    updated.push("asrWer");
  } else if (Object.prototype.hasOwnProperty.call(evals, "asrWer")) {
    delete evals.asrWer;
    removed.push("asrWer");
  }

  if (Object.prototype.hasOwnProperty.call(manifestEvalsFragment, "vadLatencyMs")) {
    evals.vadLatencyMs = manifestEvalsFragment.vadLatencyMs;
    updated.push("vadLatencyMs");
  } else if (hasFiles("vad")) {
    evals.vadLatencyMs = {
      median: 999999,
      boundaryMs: 999999,
      endpointMs: 999999,
      falseBargeInRate: 1,
      passed: false,
      status: "not-run",
      reason: "native VAD metrics were not measured for this bundle",
    };
    updated.push("vadLatencyMs");
  } else if (Object.prototype.hasOwnProperty.call(evals, "vadLatencyMs")) {
    delete evals.vadLatencyMs;
    removed.push("vadLatencyMs");
  }

  if (Object.prototype.hasOwnProperty.call(manifestEvalsFragment, "expressive")) {
    evals.expressive = manifestEvalsFragment.expressive;
    updated.push("expressive");
  } else if (needsExpressiveEval) {
    evals.expressive = {
      tagFaithfulness: 0,
      mosExpressive: 0,
      tagLeakage: 1,
      passed: false,
      status: "not-run",
      reason: "expressive voice evals were not measured for this bundle",
    };
    updated.push("expressive");
  } else if (Object.prototype.hasOwnProperty.call(evals, "expressive")) {
    delete evals.expressive;
    removed.push("expressive");
  }
  if (requiresDflash && Object.prototype.hasOwnProperty.call(manifestEvalsFragment, "dflash")) {
    evals.dflash = manifestEvalsFragment.dflash;
    updated.push("dflash");
  } else if (requiresDflash) {
    evals.dflash = {
      acceptanceRate: null,
      speedup: null,
      passed: false,
      status: "not-run",
      reason: "DFlash benchmark was not measured for this bundle",
    };
    updated.push("dflash");
  } else if (Object.prototype.hasOwnProperty.call(evals, "dflash")) {
    delete evals.dflash;
    removed.push("dflash");
  }

  manifest.evals = evals;
  const after = JSON.stringify(evals);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const aggregatePath = path.join(bundleDir, "evals", "aggregate.json");
  const aggregate = fs.existsSync(aggregatePath)
    ? JSON.parse(fs.readFileSync(aggregatePath, "utf8"))
    : { schemaVersion: 1, tier: manifest.tier, mode: "collector-sync" };
  const gateRows = results.map((r) => ({
    name: r.name,
    passed: r.status === "pass",
    skipped: r.status === "needs-data" && !isBlockingGateResult(r),
    blocking: isBlockingGateResult(r),
    required: Boolean(r.required),
    provisional: Boolean(r.provisional),
    metric: r.name,
    observed: r.measured,
    op: r.op === "bool" ? "is_true" : r.op,
    threshold: r.threshold,
    reason: r.reason,
  }));
  const failures = gateRows
    .filter((g) => g.blocking && g.passed !== true && g.skipped !== true)
    .map((g) => `${g.name}: ${g.reason}`);
  aggregate.generatedAt = generatedAt;
  aggregate.tier = manifest.tier;
  aggregate.results = { ...(aggregate.results ?? {}), ...measured };
  aggregate.gateReport = {
    tier: manifest.tier,
    mode: aggregate.mode ?? "collector-sync",
    passed: failures.length === 0,
    gates: gateRows,
    failures,
  };
  aggregate.passed = failures.length === 0;
  fs.mkdirSync(path.dirname(aggregatePath), { recursive: true });
  fs.writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`);
  const checksumsPath = regenerateBundleChecksums(bundleDir);
  return {
    changed: before !== after,
    aggregatePath: path.relative(process.cwd(), aggregatePath),
    manifestPath: path.relative(process.cwd(), manifestPath),
    checksumsPath: path.relative(process.cwd(), checksumsPath),
    updated: [...new Set(updated)].sort(),
    removed: [...new Set(removed)].sort(),
  };
}

function extractDflashAcceptance(data) {
  const summaryRate = firstFinite(
    data?.summary?.dflashAcceptanceRate,
    data?.summary?.acceptanceRate,
    data?.acceptanceRate,
  );
  if (summaryRate !== null) return summaryRate;
  const directRate = finiteOrNull(data?.withDrafter?.acceptanceRate);
  if (directRate !== null) return directRate;

  const drafted = firstFinite(
    data?.withDrafter?.drafted,
    data?.summary?.dflashDraftedTotal,
    data?.summary?.dflashDraftedTokens,
    data?.summary?.drafted,
    data?.drafted,
  );
  const accepted = firstFinite(
    data?.withDrafter?.accepted,
    data?.summary?.dflashAcceptedTotal,
    data?.summary?.dflashAcceptedTokens,
    data?.summary?.accepted,
    data?.accepted,
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
    data?.summary?.dflashDraftedTokens,
    data?.summary?.drafted,
    data?.drafted,
  );
  const accepted = firstFinite(
    data?.withDrafter?.accepted,
    data?.summary?.dflashAcceptedTotal,
    data?.summary?.dflashAcceptedTokens,
    data?.summary?.accepted,
    data?.accepted,
  );
  const summarySpeedup = firstFinite(
    data?.summary?.dflashSpeedup,
    data?.summary?.speedup,
    data?.speedup,
  );
  if (summarySpeedup !== null) return summarySpeedup;
  const withTps = finiteOrNull(data?.withDrafter?.tokensPerSecond);
  const withoutTps = finiteOrNull(data?.withoutDrafter?.tokensPerSecond);
  if (withTps !== null && withoutTps !== null && withoutTps > 0) {
    return withTps / withoutTps;
  }
  const draftingActive =
    data?.draftingActive ??
    data?.summary?.dflashDraftingActive ??
    data?.summary?.draftingActive ??
    data?.withDrafter?.draftingActive ??
    (drafted !== null && drafted > 0 && accepted !== null);
  const tokenizerCompatible =
    data?.summary?.tokenizerCompatible ??
    data?.withDrafter?.tokenizerCompatible;
  if (draftingActive === false || tokenizerCompatible === false || drafted === 0) {
    return null;
  }
  return null;
}

function averageStepRtf(data) {
  const rows = data?.summary?.stepSweep;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return firstFinite(rows[0]?.meanRtf);
}

function kokoroE2eLoopbackOk(data) {
  return (
    data?.voiceLoop?.backend === "kokoro" &&
    data?.e2eLoopOk === true &&
    data?.summary?.flowCompletedOk === true &&
    firstFinite(data?.summary?.ttsRtfMedian, data?.summary?.ttsRtfMean) !== null
  );
}

function extractCpuSimd(data) {
  const qjl = firstNonNull(
    textOrNull(data?.qjl_active_simd),
    textOrNull(data?.shippedLib?.qjl_active_simd),
  );
  const polar = firstNonNull(
    textOrNull(data?.polarquant_active_simd),
    textOrNull(data?.shippedLib?.polarquant_active_simd),
  );
  const qjlReady =
    qjl !== null ||
    data?.kernels?.qjl?.runtimeReady === true ||
    data?.kernels?.fused_attn?.runtimeReady === true;
  const polarReady = polar !== null;
  return {
    qjl,
    polar,
    qjlReady,
    polarReady,
    mtVsStPass:
      typeof data?.mtVsStGate?.verdict === "string" &&
      data.mtVsStGate.verdict.toUpperCase().includes("PASS"),
  };
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
  const evalSearchDirs = [path.join(REPORTS_ROOT, "local-e2e"), ...bundleEvalDirs(args)];

  // ── Collect measured values from the latest reports ──────────────────
  const evalAggregate = newestJsonReportWhere(
    evalSearchDirs,
    ({ name, data }) =>
      (name === "aggregate.json" || name.startsWith(`${args.tier}-aggregate`)) &&
      data?.tier === args.tier,
  );
  const textEval = newestJsonReportWhere(
    evalSearchDirs,
    ({ name, data }) =>
      (name === "text-eval.json" || name.startsWith(`${args.tier}-text-eval`)) &&
      (data?.metric === "text_eval" || data?.score !== undefined),
  );
  const expressive = newestJsonReportWhere(
    evalSearchDirs,
    ({ name, data }) =>
      (name === "expressive.json" || name.startsWith(`${args.tier}-expressive`)) &&
      data?.metric === "expressive",
  );
  const dflashBench = newestJsonReportWhere(
    [
      path.join(REPORTS_ROOT, "dflash-bench"),
      path.join(REPORTS_ROOT, "porting"),
      BENCH_RESULTS_ROOT,
      HARDWARE_RESULTS_ROOT,
    ],
    ({ name, data }) =>
      (name.toLowerCase().includes("dflash") ||
        data?.speculator === "dflash") &&
      (Boolean(data?.withDrafter) ||
        data?.reportSchema === "eliza.speculative-benchmark.v1") &&
      matchesTier(data, args.tier),
  );
  const asrExternal = newestJsonReportWhere(
    [BENCH_RESULTS_ROOT, path.join(REPORTS_ROOT, "local-e2e")],
    ({ name, data }) => {
      if (!name.toLowerCase().includes("asr")) return false;
      if (data?.aggregate?.wer === undefined || !matchesTier(data, args.tier)) {
        return false;
      }
      const source = String(data?.labelledSet?.source ?? "");
      const measurementClass = String(data?.labelledSet?.measurementClass ?? "");
      const provenance = String(data?.labelledSet?.provenance ?? "");
      const count = firstFinite(
        data?.labelledSet?.count,
        data?.aggregate?.utterances,
      );
      if (count === null || count < asrExternalMinUtterances) return false;
      if (source.includes("tts") || measurementClass.includes("self_labelled")) {
        return false;
      }
      if (measurementClass.includes("generated") || provenance === "generated_tts") {
        return false;
      }
      return (
        data?.labelledSet?.publishGateEligible === true &&
        data?.labelledSet?.realRecordedWer === true &&
        provenance === "real_recorded" &&
        measurementClass.includes("real_recorded")
      );
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
    ({ name, data }) => {
      const lower = name.toLowerCase();
      return (
        (lower.startsWith("asr-tts-loopback") ||
          lower.startsWith("asr-tts-kokoro-loopback") ||
          lower.startsWith("asr-existing-tts-loopback")) &&
        data?.ok === true &&
        matchesTier(data, args.tier)
      );
    },
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
      (matchesTier(data, args.tier) || name.includes(args.tier)),
  );
  const endurance = newestJsonReportWhere(
    [path.join(REPORTS_ROOT, "endurance")],
    ({ name, data }) =>
      name.startsWith("thirty-turn-endurance-") &&
      (matchesTier(data, args.tier) || name.includes(args.tier)),
    { recursive: false },
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
    [BENCH_RESULTS_ROOT, VERIFY_ROOT],
    ({ name, data }) => {
      const lower = name.toLowerCase();
      if (!(lower.includes("cpu") || lower.includes("simd"))) return false;
      const simd = extractCpuSimd(data);
      return simd.qjlReady && simd.polarReady;
    },
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
    e2eLoop?.data?.e2eLoopOk ??
    e2eEnduranceLoop?.data?.e2eLoopOk ??
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

  const blockingGateFailures = results.filter(isBlockingGateResult);
  const hardFailures = results.filter((r) => r.status === "fail" && r.required);
  const softFailures = results.filter(
    (r) => r.status === "fail" && !isBlockingGateResult(r),
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
  const requiresDflash = ACTIVE_DFLASH_TIERS.has(args.tier);
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
    ...(requiresDflash ? { dflash: dflashEval } : {}),
  };

  function gateRow(name, area, source, reasonOverride = null, blockingOverride = null) {
    const gate = gateByName.get(name);
    const blocking = blockingOverride ?? isBlockingGateResult(gate);
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
  const runtimeKernelReady = (dispatch, name) => {
    if (dispatch?.data?.kernels?.[name]?.runtimeReady === true) return true;
    const targets = dispatch?.data?.targets;
    if (!targets || typeof targets !== "object") return false;
    return Object.values(targets).some(
      (target) => target?.kernels?.[name]?.runtimeReady === true,
    );
  };
  const metalKernelReady = requiredKernelNames.every(
    (name) => runtimeKernelReady(metalDispatch, name),
  );
  const vulkanKernelReady = requiredKernelNames.every(
    (name) => runtimeKernelReady(vulkanDispatch, name),
  );
  const cpuSimdEvidence = cpuSimd ? extractCpuSimd(cpuSimd.data) : null;
  const cpuKernelReady = Boolean(cpuSimdEvidence?.qjlReady && cpuSimdEvidence?.polarReady);
  const dflashDrafted = firstFinite(
    dflashBench?.data?.withDrafter?.drafted,
    dflashBench?.data?.summary?.dflashDraftedTokens,
    dflashBench?.data?.summary?.drafted,
    dflashBench?.data?.drafted,
    e2eLoop?.data?.summary?.dflashDraftedTotal,
  );
  const dflashAccepted = firstFinite(
    dflashBench?.data?.withDrafter?.accepted,
    dflashBench?.data?.summary?.dflashAcceptedTokens,
    dflashBench?.data?.summary?.accepted,
    dflashBench?.data?.accepted,
    e2eLoop?.data?.summary?.dflashAcceptedTotal,
  );
  const e2eOptimizations = e2eLoop?.data?.summary?.requiredOptimizations ?? e2eLoop?.data?.requiredOptimizations;
  const e2eStreamingTtsActive = boolOrNull(e2eOptimizations?.streamingTtsActive);
  const ttsStreamSmokeActive =
    ttsStreamSmoke?.data?.streamSupported === true &&
    firstFinite(ttsStreamSmoke?.data?.chunks) !== null &&
    firstFinite(ttsStreamSmoke?.data?.chunks) > 0;
  const streamingTtsActive =
    e2eStreamingTtsActive ?? ttsStreamSmokeActive;
  const streamingTtsSource = e2eStreamingTtsActive !== null ? e2eLoop : ttsStreamSmoke;
  const dflashDraftingActive = boolOrNull(e2eOptimizations?.dflashDraftingActive);
  const requiresVision = ACTIVE_VISION_TIERS.has(args.tier);
  const visionStatus = requiresVision
    ? visionSmoke?.data?.passed === true
      ? "pass"
      : visionSmoke
        ? "fail"
        : "needs-data"
    : "not-applicable";
  const visionReason =
    !requiresVision
      ? `tier ${args.tier} is text/voice-only; vision smoke is not required`
      : visionStatus === "pass"
      ? "vision smoke passed"
      : visionSmoke?.data?.status === "not-applicable" && requiresVision
        ? "active Eliza-1 tier requires vision; stale not-applicable vision evidence is invalid"
        : (visionSmoke?.data?.reason ??
          (requiresVision
            ? "configured vision tier has no vision smoke evidence"
            : "no vision smoke evidence for this tier"));
  const iosStatus = iosSmoke?.data?.status === "passed" ? "pass" : iosSmoke ? "fail" : "needs-data";
  const iosBlocker = iosSmoke?.data?.blocker;
  const kokoroLoopbackPass = kokoroE2eLoopbackOk(e2eLoop?.data);
  const localVoiceLoopbackPass =
    kokoroLoopbackPass ||
    asrTtsLoopbackSmoke?.data?.ok === true ||
    voiceProfile?.data?.defaultStreamingTtsRoundTrip?.status === "pass";
  const localVoiceLoopbackRtf = kokoroLoopbackPass
    ? firstFinite(
        e2eLoop?.data?.summary?.ttsRtfMedian,
        e2eLoop?.data?.summary?.ttsRtfMean,
      )
    : firstFinite(
        ttsStreamSmoke?.data?.rtf,
        voiceProfile?.data?.defaultStreamingTtsRoundTrip?.tts?.rtf,
        averageStepRtf(ttsSweep?.data),
      );
  const localVoiceLoopbackWer = firstFinite(
    e2eLoop?.data?.voiceLoop?.backend === "kokoro"
      ? e2eLoop?.data?.summary?.asrWerMean
      : null,
    ttsSweep?.data?.summary?.stepSweep?.[0]?.meanAsrWer,
    asrBench?.data?.aggregate?.wer,
  );
  const localVoiceLoopbackStatus =
    localVoiceLoopbackPass || (localVoiceLoopbackWer !== null && localVoiceLoopbackWer <= 0.1)
      ? "pass"
      : voiceProfile || ttsSweep || asrBench
        ? "fail"
        : "needs-data";
  const localVoiceLoopbackMeasured =
    localVoiceLoopbackStatus === "needs-data"
      ? null
      : kokoroLoopbackPass
        ? [
            "backend=kokoro",
            `asrWer=${localVoiceLoopbackWer ?? "unknown"}`,
            `rtf=${localVoiceLoopbackRtf ?? "unknown"}`,
            `embedding=${e2eLoop.data?.summary?.embedding?.status ?? "unknown"}`,
            `micSource=${e2eLoop.data?.voiceLoop?.micInputSource ?? "unknown"}`,
          ].join(", ")
      : asrTtsLoopbackSmoke
        ? [
            `lexical=${asrTtsLoopbackSmoke.data.ok === true}`,
            `rtf=${localVoiceLoopbackRtf ?? "unknown"}`,
            `transcript=${JSON.stringify(asrTtsLoopbackSmoke.data.transcript ?? "")}`,
            `expected=${JSON.stringify(asrTtsLoopbackSmoke.data.expectedContains ?? "")}`,
          ].join(", ")
        : `wer=${localVoiceLoopbackWer ?? "unknown"}, rtf=${localVoiceLoopbackRtf ?? "unknown"}`;
  const thirtyTurnMeasured =
    thirtyTurnOk !== null
      ? thirtyTurnOk
      : endurance
        ? [
            `turns=${endurance.data?.turns ?? "unknown"}`,
            `voiceLoopExercised=${endurance.data?.voiceLoopExercised ?? "unknown"}`,
            `noCrash=${endurance.data?.assertions?.noCrash ?? "unknown"}`,
            `rssLeakWithinCap=${endurance.data?.assertions?.rssLeakWithinCap ?? "unknown"}`,
          ].join(", ")
        : null;
  const thirtyTurnReason =
    thirtyTurnOk === null && endurance
      ? endurance.data?.reason ??
        "30-turn report exists, but it did not emit summary.thirtyTurnOk"
      : null;
  const vadQualityReason =
    vadQuality?.data?.reason ??
    vadQuality?.data?.error ??
    null;
  const bargeInReason =
    bargeInCancelMs === null && (bargein || e2eLoop)
      ? bargein?.data?.reason ??
        e2eLoop?.data?.reason ??
        "barge-in report exists, but it did not emit summary.bargeInCancelMs"
      : null;
  const e2eLoopReason =
    e2eLoopOk === null && e2eLoop
      ? e2eLoop.data?.reason ??
        "e2e report exists, but it did not emit e2eLoopOk"
      : null;
  const firstTokenReason =
    firstTokenLatencyMs === null && e2eLoop
      ? e2eLoop.data?.reason ??
        "e2e report exists, but it did not emit summary.firstTokenMsMedian"
      : null;
  const firstAudioReason =
    firstAudioLatencyMs === null && e2eLoop
      ? e2eLoop.data?.reason ??
        "e2e report exists, but it did not emit summary.firstAudioFromMicMsMedian"
      : null;
  const releaseGateMatrix = [
    gateRow("text_eval", "quality", sourcePath(textEval ?? evalAggregate)),
    gateRow("voice_rtf", "voice", sourcePath(ttsSweep ?? ttsStreamSmoke ?? e2eLoop)),
    gateRow(
      "asr_wer",
      "voice",
      sourcePath(asrExternal),
      asrWer === null
        ? `no >=${asrExternalMinUtterances}-utterance explicit real-recorded ASR WER report found; local generated-voice loopback is tracked separately`
        : null,
    ),
    {
      area: "voice",
      gate: "local_voice_loopback_smoke",
      status: localVoiceLoopbackStatus,
      blocking: localVoiceLoopbackStatus !== "pass",
      measured: localVoiceLoopbackMeasured,
      threshold: "generated TTS->ASR smoke pass",
      reason:
        localVoiceLoopbackStatus === "pass"
          ? kokoroLoopbackPass
            ? "Kokoro small-tier loop completed ASR -> text -> Kokoro TTS"
            : "default generated TTS audio round-tripped through local ASR"
          : "generated TTS->ASR smoke did not pass lexical validation",
      source: sourcePath(
        kokoroLoopbackPass
          ? e2eLoop
          : asrTtsLoopbackSmoke ?? voiceProfile ?? ttsSweep ?? asrBench,
      ),
    },
    gateRow("vad_latency_ms", "voice", sourcePath(vadQuality), vadQualityReason),
    gateRow("vad_boundary_mae_ms", "voice", sourcePath(vadQuality), vadQualityReason),
    gateRow("vad_endpoint_p95_ms", "voice", sourcePath(vadQuality), vadQualityReason),
    gateRow("vad_false_bargein_per_hour", "voice", sourcePath(vadQuality), vadQualityReason),
    gateRow("first_token_latency_ms", "latency", sourcePath(e2eLoop), firstTokenReason),
    gateRow(
      "first_audio_latency_ms",
      "latency",
      sourcePath(e2eLoop),
      firstAudioLatencyMs !== null
        ? `first audio is ${firstAudioLatencyMs} ms; TTS best preset passes RTF but first-audio remains slow`
        : firstAudioReason,
      false,
    ),
    gateRow("barge_in_cancel_ms", "latency", sourcePath(bargein ?? e2eLoop), bargeInReason),
    {
      ...gateRow(
        "thirty_turn_ok",
        "endurance",
        sourcePath(endurance ?? e2eEnduranceLoop),
        thirtyTurnReason,
      ),
      measured: thirtyTurnMeasured,
    },
    gateRow("e2e_loop_ok", "e2e", sourcePath(e2eLoop), e2eLoopReason),
    requiresDflash
      ? gateRow(
          "dflash_acceptance",
          "dflash",
          sourcePath(dflashBench ?? e2eLoop),
          dflashDrafted === 0 && dflashAccepted === 0
            ? "DFlash generated zero drafted and accepted tokens; acceptance is an honest 0"
            : null,
        )
      : {
          area: "dflash",
          gate: "dflash_acceptance",
          status: "not-applicable",
          blocking: false,
          measured: null,
          threshold: "tier ships DFlash",
          reason: `tier ${args.tier} does not ship a DFlash drafter`,
          source: null,
        },
    requiresDflash
      ? gateRow(
          "dflash_speedup",
          "dflash",
          sourcePath(dflashBench),
          dflashSpeedup !== null
            ? `DFlash speedup ${dflashSpeedup.toFixed(3)}x is below target`
            : null,
        )
      : {
          area: "dflash",
          gate: "dflash_speedup",
          status: "not-applicable",
          blocking: false,
          measured: null,
          threshold: "tier ships DFlash",
          reason: `tier ${args.tier} does not ship a DFlash drafter`,
          source: null,
        },
    gateRow(
      "expressive_tag_faithfulness",
      "expressive",
      sourcePath(expressive ?? evalAggregate),
      expressive?.data?.reason ?? "expressive graders did not produce tag-faithfulness data",
    ),
    gateRow(
      "expressive_mos",
      "expressive",
      sourcePath(expressive ?? evalAggregate),
      expressive?.data?.reason ?? "expressive graders did not produce MOS data",
    ),
    gateRow(
      "expressive_tag_leakage",
      "expressive",
      sourcePath(expressive ?? evalAggregate),
      expressive?.data?.reason ?? "expressive graders did not produce tag-leakage data",
    ),
    {
      area: "platform",
      gate: "cpu_simd_kernels",
      status: cpuKernelReady ? "pass" : "needs-data",
      blocking: !cpuKernelReady,
      measured: cpuKernelReady
        ? `qjl=${cpuSimdEvidence.qjl ?? "runtime-ready"}, polar=${cpuSimdEvidence.polar}`
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
          ? e2eStreamingTtsActive === true
            ? "e2e loop observed streaming TTS active; installed dylib rebuild is still tracked separately"
            : "standalone streaming TTS smoke emitted audio chunks from the installed runtime"
          : "streaming TTS was not active in the selected e2e loop",
      source: sourcePath(streamingTtsSource),
    },
    {
      area: "worker-output",
      gate: "dflash_drafting_active",
      status: requiresDflash
        ? dflashDraftingActive === true
          ? "pass"
          : dflashDraftingActive === false
            ? "fail"
            : "needs-data"
        : "not-applicable",
      blocking: requiresDflash && dflashDraftingActive !== true,
      measured: dflashDraftingActive,
      threshold: "true",
      reason:
        !requiresDflash
          ? `tier ${args.tier} does not ship a DFlash drafter`
          : dflashDraftingActive === true
          ? "e2e loop observed DFlash drafting"
          : "required optimization is inactive in the selected e2e loop",
      source: sourcePath(e2eLoop),
    },
    {
      area: "worker-output",
      gate: "vision_smoke",
      status: visionStatus,
      blocking: requiresVision ? visionStatus !== "pass" : visionStatus === "fail",
      measured: visionSmoke?.data?.status ?? null,
      threshold: requiresVision ? "pass" : "not-applicable",
      reason: visionReason,
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
  const generatedAt = new Date().toISOString();
  let bundleManifestEvalSync = null;
  if (args.syncBundleManifestEvals) {
    if (!args.bundle) {
      console.error(
        "[eliza1-gates-collect] --sync-bundle-manifest-evals requires --bundle",
      );
      process.exit(2);
    }
    bundleManifestEvalSync = syncBundleManifestEvals(
      path.resolve(args.bundle),
      manifestEvalsFragment,
      { generatedAt, measured, requiresDflash, results },
    );
  }

  const report = {
    generatedAt,
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
      blockingFailures: blockingGateFailures.map((r) => r.name),
      blockingReasons: blockingGateFailures.map((r) => `${r.name}: ${r.reason}`),
      blocking: blockingGateFailures.length > 0 || releaseMatrixSummary.blocking,
    },
    manifestEvalsFragment,
    bundleManifestEvalSync,
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
    if (blockingGateFailures.length > 0) {
      console.error(
        `[eliza1-gates-collect] BLOCKING gate failures: ${blockingGateFailures.map((r) => `${r.name}(${r.reason})`).join(", ")}`,
      );
    }
    if (releaseMatrixSummary.blockerReasons.length > 0) {
      console.error(
        `[eliza1-gates-collect] BLOCKING release matrix failures: ${releaseMatrixSummary.blockerReasons.join("; ")}`,
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
