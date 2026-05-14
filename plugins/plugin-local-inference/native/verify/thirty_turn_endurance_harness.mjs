#!/usr/bin/env node
/**
 * 30-turn voice-loop endurance harness.
 *
 * AGENTS.md §8: "A 30-turn end-to-end voice loop runs without crash,
 * without leak, without exceeding `manifest.ramBudgetMb.recommended`."
 * This harness loops a synthetic conversation 30 times and asserts:
 *   - no crash / unhandled rejection,
 *   - no resident-memory leak (RSS growth over the run stays under the
 *     `--rss-growth-mb` cap; default 64 MB — a real leak grows linearly),
 *   - peak RSS stays under `--rss-cap-mb` when given (the bundle's
 *     `ramBudgetMb.recommended`).
 *
 * How it runs:
 *   - Against the *real* assembled voice path (`engine.startVoice` +
 *     turn controller + ASR/LLM/TTS backends), once W9 lands and a real
 *     backend is present, the harness drives 30 real turns and reads RSS
 *     between turns. Until then there is no assembled path to drive — but
 *     the harness still does a real 30-iteration *process-level* leak/RSS
 *     check around a representative allocation/GC cycle so a regression in
 *     the harness host itself is caught, and records `voiceLoopExercised:
 *     false` so the result is not mistaken for a true e2e pass.
 *
 * Output: a JSON report under `packages/inference/reports/endurance/`.
 * `thirtyTurnOk` (and the peak-RSS figure) feed the `thirty_turn_ok` gate
 * in `eliza1_gates.yaml`, the manifest `evals.thirtyTurnOk` flag, and the
 * `peak_rss_mb` gate. `thirtyTurnOk` is only `true` when the real voice
 * loop was exercised AND every assertion held.
 *
 * Usage:
 *   node packages/inference/verify/thirty_turn_endurance_harness.mjs \
 *     [--turns N] [--rss-growth-mb M] [--rss-cap-mb M] [--report PATH] [--json]
 */

import fs from "node:fs";
import os from "node:os";
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
    turns: 30,
    rssGrowthMb: 64,
    rssCapMb: null,
    report: path.join(
      __dirname,
      "..",
      "reports",
      "endurance",
      `thirty-turn-endurance-${timestamp()}.json`,
    ),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--turns") {
      i += 1;
      args.turns = Math.max(1, Number.parseInt(argv[i], 10) || 30);
    } else if (a === "--rss-growth-mb") {
      i += 1;
      args.rssGrowthMb = Number(argv[i]);
    } else if (a === "--rss-cap-mb") {
      i += 1;
      args.rssCapMb = Number(argv[i]);
    } else if (a === "--report") {
      i += 1;
      args.report = argv[i];
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node thirty_turn_endurance_harness.mjs [--turns N] [--rss-growth-mb M] [--rss-cap-mb M] [--report PATH] [--json]",
      );
      process.exit(0);
    }
  }
  return args;
}

const STATE_DIR =
  process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza");
const MODELS_ROOT = path.join(STATE_DIR, "local-inference", "models");

function realBackendPresent() {
  return (
    fs.existsSync(MODELS_ROOT) &&
    fs.readdirSync(MODELS_ROOT).some((e) => e.endsWith(".bundle"))
  );
}

function rssMb() {
  return process.memoryUsage().rss / (1024 * 1024);
}

/**
 * One synthetic "turn": a small bounded allocate-then-release cycle so the
 * RSS sample between turns is meaningful even when the real voice loop is
 * not driven. NOT a stand-in for ASR/LLM/TTS — it is a host-level leak
 * sentinel only.
 */
function syntheticTurn() {
  // Allocate ~2 MB, touch it, drop it.
  const buf = Buffer.allocUnsafe(2 * 1024 * 1024);
  for (let i = 0; i < buf.length; i += 4096) buf[i] = i & 0xff;
  return buf.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const voiceLoopExercised = false; // flips true once W9's path is driven here
  const backendPresent = realBackendPresent();

  const rssSamples = [];
  let crashed = false;
  let crashError = null;
  const onUnhandled = (err) => {
    crashed = true;
    crashError = err instanceof Error ? err.message : String(err);
  };
  process.on("unhandledRejection", onUnhandled);
  process.on("uncaughtExceptionMonitor", onUnhandled);

  rssSamples.push(rssMb());
  try {
    for (let t = 0; t < args.turns; t += 1) {
      syntheticTurn();
      if (typeof globalThis.gc === "function" && t % 5 === 0) globalThis.gc();
      rssSamples.push(rssMb());
    }
  } catch (err) {
    crashed = true;
    crashError = err instanceof Error ? err.message : String(err);
  }
  process.off("unhandledRejection", onUnhandled);
  process.off("uncaughtExceptionMonitor", onUnhandled);

  const first = rssSamples[0];
  const last = rssSamples[rssSamples.length - 1];
  const peak = Math.max(...rssSamples);
  const growth = last - first;
  const leakOk =
    Number.isFinite(args.rssGrowthMb) && args.rssGrowthMb > 0
      ? growth <= args.rssGrowthMb
      : true;
  const capOk =
    args.rssCapMb && args.rssCapMb > 0 ? peak <= args.rssCapMb : true;

  // `thirtyTurnOk` / `e2eLoopOk` are the strongest claims: they require the
  // *real* voice loop to have been exercised. Until W9's path is wired here
  // they are `null` ("not measured" — recorded, not faked), NOT `false` —
  // `false` would mean "ran and failed", which is a different and stronger
  // statement than "didn't run". The host-level leak/RSS facts are still
  // reported in `assertions`.
  const thirtyTurnOk = voiceLoopExercised ? !crashed && leakOk && capOk : null;
  const e2eLoopOk = voiceLoopExercised ? !crashed : null;

  const report = {
    generatedAt: new Date().toISOString(),
    harness: path.relative(process.cwd(), __filename),
    turns: args.turns,
    voiceLoopExercised,
    backendPresent,
    reason: voiceLoopExercised
      ? null
      : "assembled voice path (engine.startVoice + turn controller) not yet wired to this harness — pending W9; host-level leak/RSS check still ran",
    assertions: {
      noCrash: !crashed,
      crashError,
      rssLeakWithinCap: leakOk,
      rssGrowthMb: Number.isFinite(growth) ? Number(growth.toFixed(2)) : null,
      rssGrowthCapMb: args.rssGrowthMb,
      peakRssWithinBundleCap: capOk,
      peakRssMb: Number.isFinite(peak) ? Number(peak.toFixed(2)) : null,
      bundleRssCapMb: args.rssCapMb,
    },
    // What the gates collector / manifest evals writer reads. Null = not
    // measured (the voice loop was not driven) — never a fabricated value.
    summary: {
      thirtyTurnOk,
      e2eLoopOk,
      peakRssMb: voiceLoopExercised ? Number(peak.toFixed(2)) : null,
    },
  };

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`wrote ${args.report}`);
    console.log(
      `thirty-turn-endurance: thirtyTurnOk=${thirtyTurnOk} voiceLoopExercised=${voiceLoopExercised} ` +
        `peakRss=${peak.toFixed(1)}MB growth=${growth.toFixed(1)}MB crashed=${crashed}`,
    );
  }
  // Exit non-zero only when an assertion *that was actually checked* failed:
  // a crash or a host-level RSS leak. "voice loop not yet wired" is exit 0.
  process.exit(crashed || !leakOk || !capOk ? 1 : 0);
}

main();
