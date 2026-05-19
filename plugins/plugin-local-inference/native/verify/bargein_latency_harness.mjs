#!/usr/bin/env node
/**
 * Barge-in cancellation latency readiness harness.
 *
 * This wrapper drives the assembled local voice path through
 * `e2e_loop_bench.mjs` and records `summary.bargeInCancelMs` only when the
 * native path measured both streaming TTS cancellation and LLM/DFlash abort.
 * Missing bundles, missing fused builds, or missing native cancel features are
 * hard failures with precise JSON evidence, not skipped passes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPORTS_ROOT = path.join(__dirname, "..", "reports");
const E2E_BENCH = path.join(__dirname, "e2e_loop_bench.mjs");
const KOKORO_E2E_BENCH = path.join(__dirname, "kokoro_e2e_loop_bench.mjs");
const KOKORO_TIERS = new Set(["0_8b", "2b", "4b"]);
const NO_DRAFTER_TIERS = new Set(["0_8b"]);

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv) {
  const args = {
    tier: process.env.ELIZA_E2E_TIER || "",
    bundle: process.env.ELIZA_E2E_BUNDLE || "",
    backend: process.env.ELIZA_E2E_BACKEND || "cpu",
    binDir: process.env.ELIZA_E2E_BIN_DIR || "",
    e2eReport: process.env.ELIZA_BARGEIN_E2E_REPORT || "",
    maxCancelMs: Number(process.env.ELIZA_BARGEIN_MAX_CANCEL_MS || "250"),
    nPredict: Number.parseInt(process.env.ELIZA_E2E_N_PREDICT || "80", 10),
    ttsSteps: Number.parseInt(process.env.ELIZA_E2E_TTS_STEPS || "32", 10),
    ctx: Number.parseInt(process.env.ELIZA_E2E_CTX || "2048", 10),
    ngl: process.env.ELIZA_E2E_NGL || "0",
    startTimeoutS: Number.parseInt(
      process.env.ELIZA_E2E_START_TIMEOUT || "180",
      10,
    ),
    turnTimeoutS: Number.parseInt(
      process.env.ELIZA_E2E_TURN_TIMEOUT || "240",
      10,
    ),
    report: path.join(
      REPORTS_ROOT,
      "bargein",
      `bargein-latency-${timestamp()}.json`,
    ),
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === "--tier") args.tier = next();
    else if (a === "--bundle" || a === "--bundle-dir") args.bundle = next();
    else if (a === "--backend") args.backend = next();
    else if (a === "--bin-dir") args.binDir = next();
    else if (a === "--e2e-report") args.e2eReport = next();
    else if (a === "--max-cancel-ms") args.maxCancelMs = Number(next());
    else if (a === "--n-predict") args.nPredict = Number.parseInt(next(), 10);
    else if (a === "--tts-steps") args.ttsSteps = Number.parseInt(next(), 10);
    else if (a === "--ctx") args.ctx = Number.parseInt(next(), 10);
    else if (a === "--ngl") args.ngl = next();
    else if (a === "--start-timeout") {
      args.startTimeoutS = Number.parseInt(next(), 10);
    } else if (a === "--turn-timeout") {
      args.turnTimeoutS = Number.parseInt(next(), 10);
    } else if (a === "--report") args.report = next();
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node bargein_latency_harness.mjs [--bundle DIR] [--tier TIER] [--backend cpu|metal|vulkan|cuda] [--bin-dir DIR] [--e2e-report PATH] [--report PATH] [--json]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }

  return args;
}

function stateDir() {
  return process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza");
}

function modelsRoot() {
  return path.join(stateDir(), "local-inference", "models");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readManifestTier(bundleDir) {
  const manifestPath = path.join(bundleDir, "eliza-1.manifest.json");
  if (!fs.existsSync(manifestPath)) return "";
  try {
    return String(readJson(manifestPath)?.tier || "");
  } catch {
    return "";
  }
}

function inferTierFromBundle(bundleDir) {
  return (
    readManifestTier(bundleDir) ||
    path.basename(bundleDir).replace(/^eliza-1-/, "").replace(/\.bundle$/, "")
  );
}

function resolveBundle(args) {
  if (args.bundle) {
    const bundleDir = path.resolve(args.bundle);
    if (!fs.existsSync(bundleDir)) {
      return {
        ok: false,
        status: "needs-bundle",
        reason: `bundle directory not found: ${bundleDir}`,
      };
    }
    return {
      ok: true,
      bundleDir,
      tier: args.tier || inferTierFromBundle(bundleDir),
    };
  }

  const root = modelsRoot();
  if (!fs.existsSync(root)) {
    return {
      ok: false,
      status: "needs-bundle",
      reason: `no local model bundle root found at ${root}; pass --bundle`,
    };
  }

  if (args.tier) {
    const bundleDir = path.join(root, `eliza-1-${args.tier}.bundle`);
    if (!fs.existsSync(bundleDir)) {
      return {
        ok: false,
        status: "needs-bundle",
        reason: `installed bundle for tier ${args.tier} not found at ${bundleDir}; pass --bundle`,
      };
    }
    return { ok: true, bundleDir, tier: args.tier };
  }

  const bundles = fs
    .readdirSync(root)
    .filter((name) => name.endsWith(".bundle"))
    .map((name) => path.join(root, name))
    .filter((full) => fs.statSync(full).isDirectory())
    .sort();

  if (bundles.length === 0) {
    return {
      ok: false,
      status: "needs-bundle",
      reason: `no *.bundle directories found under ${root}; pass --bundle`,
    };
  }
  if (bundles.length > 1) {
    return {
      ok: false,
      status: "needs-bundle",
      reason: `multiple installed bundles found under ${root}; pass --tier or --bundle (${bundles
        .map((b) => path.basename(b))
        .join(", ")})`,
    };
  }

  return {
    ok: true,
    bundleDir: bundles[0],
    tier: inferTierFromBundle(bundles[0]),
  };
}

function latestLocalE2eReportPath(tier) {
  const safeTier = tier || "unknown";
  return path.join(
    REPORTS_ROOT,
    "local-e2e",
    safeTier,
    `e2e-loop-bargein-${safeTier}-${timestamp()}.json`,
  );
}

function runE2eBench(args, bundle) {
  const report = latestLocalE2eReportPath(bundle.tier);
  const bun = process.env.BUN_BIN || "bun";
  const useKokoro = KOKORO_TIERS.has(bundle.tier);
  const childArgs = useKokoro
    ? [
        KOKORO_E2E_BENCH,
        "--bundle",
        bundle.bundleDir,
        "--tier",
        bundle.tier,
        "--backend",
        args.backend,
        "--turns",
        "1",
        "--n-predict",
        String(args.nPredict),
        "--ctx",
        String(args.ctx),
        "--ngl",
        String(args.ngl),
        "--start-timeout",
        String(args.startTimeoutS),
        "--turn-timeout",
        String(args.turnTimeoutS),
        "--report",
        report,
        "--skip-embedding",
        "--no-save-audio",
        "--quiet",
      ]
    : [
        E2E_BENCH,
        "--bundle",
        bundle.bundleDir,
        "--tier",
        bundle.tier,
        "--backend",
        args.backend,
        "--turns",
        "1",
        "--n-predict",
        String(args.nPredict),
        "--tts-steps",
        String(args.ttsSteps),
        "--ctx",
        String(args.ctx),
        "--ngl",
        String(args.ngl),
        "--start-timeout",
        String(args.startTimeoutS),
        "--turn-timeout",
        String(args.turnTimeoutS),
        "--report",
        report,
        "--quiet",
      ];
  if (args.binDir) childArgs.splice(7, 0, "--bin-dir", args.binDir);

  const res = spawnSync(bun, childArgs, {
    cwd: path.resolve(__dirname, "..", "..", ".."),
    encoding: "utf8",
    stdio: args.json ? "pipe" : "inherit",
  });

  if (res.error) {
    return {
      ok: false,
      status: "needs-runtime",
      reason: `${bun} executable could not run ${path.basename(childArgs[0])}: ${res.error.message}`,
      e2eReportPath: report,
    };
  }
  if (res.status !== 0) {
    const stderr = typeof res.stderr === "string" ? res.stderr.trim() : "";
    return {
      ok: false,
      status: "failed",
      reason: `${path.basename(childArgs[0])} exited ${res.status}${stderr ? `: ${stderr}` : ""}`,
      e2eReportPath: report,
    };
  }
  if (!fs.existsSync(report)) {
    return {
      ok: false,
      status: "failed",
      reason: `${path.basename(childArgs[0])} completed without writing ${report}`,
      e2eReportPath: report,
    };
  }
  return { ok: true, e2eReportPath: report, e2eReport: readJson(report) };
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round1(value) {
  return value == null ? null : Math.round(value * 10) / 10;
}

function selectE2eRun(report, tier) {
  const runs = Array.isArray(report?.runs) ? report.runs : [report];
  return (
    runs.find((run) => !tier || run?.request?.tier === tier || run?.bundle?.tier === tier) ??
    runs[0] ??
    null
  );
}

function dflashRequiredForRun(run, fallbackTier = null) {
  const tier = run?.request?.tier ?? run?.bundle?.tier ?? fallbackTier;
  const requiredOptimizations =
    run?.summary?.requiredOptimizations ?? run?.requiredOptimizations ?? {};
  if (
    requiredOptimizations.dflashRequired === false ||
    run?.summary?.dflashPolicy?.requiresDrafter === false ||
    run?.dflashPolicy?.requiresDrafter === false ||
    NO_DRAFTER_TIERS.has(tier)
  ) {
    return false;
  }
  return true;
}

function buildBlockedReport(args, block, bundle = null) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    harness: path.relative(process.cwd(), __filename),
    status: block.status || "failed",
    available: false,
    reason: block.reason,
    request: {
      tier: bundle?.tier ?? args.tier ?? null,
      backend: args.backend,
      bundle: (bundle?.bundleDir ?? args.bundle) || null,
      maxCancelMs: args.maxCancelMs,
    },
    backend: {
      e2eReport: (block.e2eReportPath ?? args.e2eReport) || null,
    },
    evidence: {
      passRecordable: false,
      blockers: [{ key: block.status || "failed", reason: block.reason }],
    },
    summary: {
      vadVoiceDetectedToTtsCancelledMs: null,
      vadVoiceDetectedToLlmCancelledMs: null,
      audioDrainMs: null,
      bargeInCancelMs: null,
      samples: 0,
    },
  };
}

function buildBargeInReportFromE2e({
  args,
  e2eReport,
  e2eReportPath = null,
  bundle = null,
}) {
  const run = selectE2eRun(e2eReport, bundle?.tier ?? args.tier);
  if (!run) {
    return buildBlockedReport(
      args,
      {
        status: "failed",
        reason: "e2e report did not contain a run object",
        e2eReportPath,
      },
      bundle,
    );
  }

  const barge = run.bargeIn ?? {};
  const rawBargeInCancelMs = finite(
    run.summary?.bargeInCancelMs ?? barge.bargeInCancelMs,
  );
  const ttsCancelMs = finite(
    barge.ttsCancelMs ??
      barge.nativeTtsStreamCancelMs ??
      barge.nativeStreamCancelMs,
  );
  const llmCancelMs = finite(barge.llmCancelMs ?? barge.llmAbortMs);
  const audioDrainMs = finite(barge.audioDrainMs ?? barge.httpAbortMs);
  const streamingTtsActive =
    barge.ttsStreamSupported === true ||
    run.summary?.requiredOptimizations?.streamingTtsActive === true ||
    run.requiredOptimizations?.streamingTtsActive === true;
  const dflashRequired = dflashRequiredForRun(run, bundle?.tier ?? args.tier);
  const dflashActive =
    run.summary?.requiredOptimizations?.dflashDraftingActive === true ||
    run.requiredOptimizations?.dflashDraftingActive === true;

  const blockers = [];
  if (run.e2eLoopOk !== true) {
    blockers.push({
      key: "e2e-loop-not-ok",
      reason: run.reason || `e2e loop status is ${run.status ?? "unknown"}`,
    });
  }
  if (!streamingTtsActive) {
    blockers.push({
      key: "missing-native-streaming-tts",
      reason:
        barge.note ||
        "streaming TTS cancel support was not active in the assembled voice loop",
    });
  }
  if (dflashRequired && !dflashActive) {
    blockers.push({
      key: "missing-dflash",
      reason: "DFlash drafting was not active in the assembled voice loop",
    });
  }
  if (rawBargeInCancelMs === null) {
    blockers.push({
      key: "missing-barge-in-cancel-ms",
      reason: "e2e loop did not emit summary.bargeInCancelMs",
    });
  }
  if (ttsCancelMs === null) {
    blockers.push({
      key: "missing-tts-cancel-ms",
      reason: "e2e loop did not emit streaming TTS cancel latency",
    });
  }
  if (llmCancelMs === null) {
    blockers.push({
      key: "missing-llm-cancel-ms",
      reason: dflashRequired
        ? "e2e loop did not emit LLM/DFlash abort latency"
        : "e2e loop did not emit LLM stream abort latency",
    });
  }

  const passRecordable = blockers.length === 0;
  const overBudget =
    passRecordable &&
    Number.isFinite(args.maxCancelMs) &&
    args.maxCancelMs > 0 &&
    rawBargeInCancelMs > args.maxCancelMs;
  const status = passRecordable && !overBudget ? "ok" : "failed";
  const reason = !passRecordable
    ? blockers.map((b) => `${b.key}: ${b.reason}`).join("; ")
    : overBudget
      ? `bargeInCancelMs ${rawBargeInCancelMs}ms exceeds ${args.maxCancelMs}ms`
      : null;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    harness: path.relative(process.cwd(), __filename),
    status,
    available: passRecordable && !overBudget,
    reason,
    request: {
      tier: run.request?.tier ?? bundle?.tier ?? args.tier ?? null,
      backend: run.request?.backend ?? args.backend,
      bundle: (run.bundle?.dir ?? bundle?.bundleDir ?? args.bundle) || null,
      maxCancelMs: args.maxCancelMs,
    },
    backend: {
      e2eReport: e2eReportPath,
      e2eStatus: run.status ?? null,
      e2eLoopOk: run.e2eLoopOk ?? null,
      requiredOptimizations:
        run.summary?.requiredOptimizations ?? run.requiredOptimizations ?? null,
    },
    evidence: {
      passRecordable,
      rawBargeInCancelMs: round1(rawBargeInCancelMs),
      blockers,
      source:
        run.voiceLoop?.backend === "kokoro"
          ? "assembled-local-kokoro-voice-e2e-loop"
          : "assembled-local-voice-e2e-loop",
      dflashRequired,
    },
    summary: {
      vadVoiceDetectedToTtsCancelledMs: round1(ttsCancelMs),
      vadVoiceDetectedToLlmCancelledMs: round1(llmCancelMs),
      audioDrainMs: round1(audioDrainMs),
      bargeInCancelMs: passRecordable ? round1(rawBargeInCancelMs) : null,
      samples: passRecordable ? 1 : 0,
    },
  };
}

function writeReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const bundle = args.e2eReport ? null : resolveBundle(args);
  let report;

  if (bundle && !bundle.ok) {
    report = buildBlockedReport(args, bundle);
  } else {
    const e2e = args.e2eReport
      ? {
          ok: true,
          e2eReportPath: path.resolve(args.e2eReport),
          e2eReport: readJson(args.e2eReport),
        }
      : runE2eBench(args, bundle);
    report = e2e.ok
      ? buildBargeInReportFromE2e({
          args,
          e2eReport: e2e.e2eReport,
          e2eReportPath: e2e.e2eReportPath,
          bundle,
        })
      : buildBlockedReport(args, e2e, bundle);
  }

  writeReport(args.report, report);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`wrote ${args.report}`);
    console.log(
      `bargein-latency: status=${report.status} bargeInCancelMs=${report.summary.bargeInCancelMs} reason=${report.reason ?? "ok"}`,
    );
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().then(
    (report) => process.exit(report.status === "ok" ? 0 : 1),
    (err) => {
      console.error(err?.stack || String(err));
      process.exit(1);
    },
  );
}

export {
  buildBargeInReportFromE2e,
  buildBlockedReport,
  parseArgs,
  resolveBundle,
  runCli,
  selectE2eRun,
};
