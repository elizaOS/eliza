#!/usr/bin/env node
/**
 * Barge-in cancellation latency harness.
 *
 * Measures the three timings the brief calls out:
 *   - `vad-voice-detected` — VAD reports ≥1 confirmed word while the agent
 *      is speaking ("hard-stop" trigger).
 *   - `tts-cancelled`      — the TTS backend acknowledges cancellation.
 *   - `llm-cancelled`      — the in-flight LLM/drafter generation aborts.
 *
 * How it runs:
 *   - Against the *real* assembled voice path (`engine.startVoice` →
 *     turn controller + scheduler + barge-in), once W9 lands and a real
 *     backend is present, the harness drives one turn, triggers a barge-in,
 *     and reads the cancel timings off the `EndToEndLatencyTracer` /
 *     `BargeInController`. Until then there is no assembled path to drive,
 *     so the harness records an `available: false` "needs-wiring" entry —
 *     it does NOT fabricate numbers (AGENTS.md §3 / §7).
 *
 * "Real backend present" check: a built dflash spec/server binary AND a
 * model bundle directory under ~/.eliza/local-inference/models. Without
 * those, there is nothing real to cancel.
 *
 * Output: a JSON report under `packages/inference/reports/bargein/`. The
 * `bargeInCancelMs` field (vad-voice-detected → max(tts-cancelled,
 * llm-cancelled)) feeds the `barge_in_cancel_ms` gate in
 * `packages/training/benchmarks/eliza1_gates.yaml` and the manifest evals
 * collector. Null = not measured.
 *
 * Usage:
 *   node packages/inference/verify/bargein_latency_harness.mjs [--report PATH] [--json]
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
    report: path.join(
      __dirname,
      "..",
      "reports",
      "bargein",
      `bargein-latency-${timestamp()}.json`,
    ),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--report") {
      i += 1;
      args.report = argv[i];
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node bargein_latency_harness.mjs [--report PATH] [--json]",
      );
      process.exit(0);
    }
  }
  return args;
}

const STATE_DIR =
  process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza");
const MODELS_ROOT = path.join(STATE_DIR, "local-inference", "models");
const SPEC_BIN_DIRS = [
  path.join(STATE_DIR, "local-inference", "bin", "dflash"),
  path.join(STATE_DIR, "local-inference", "bin"),
];

function realBackendPresent() {
  const hasModels =
    fs.existsSync(MODELS_ROOT) &&
    fs.readdirSync(MODELS_ROOT).some((e) => e.endsWith(".bundle"));
  const hasBin = SPEC_BIN_DIRS.some(
    (d) => fs.existsSync(d) && fs.readdirSync(d).length > 0,
  );
  return { hasModels, hasBin, ok: hasModels && hasBin };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const backend = realBackendPresent();

  // The assembled voice path (`engine.startVoice` + W9 turn controller) is
  // the only thing that can be barge-in-cancelled for real. It is not yet
  // wired up here, so there is nothing to drive — record a needs-wiring
  // entry rather than a synthetic number.
  const report = {
    generatedAt: new Date().toISOString(),
    harness: path.relative(process.cwd(), __filename),
    available: false,
    reason: backend.ok
      ? "assembled voice path (engine.startVoice + turn controller) not yet wired to this harness — pending W9"
      : "no real backend present (need a built dflash binary + a model bundle under ~/.eliza/local-inference/models)",
    backend,
    // Schema the gates collector + manifest evals writer key off. Null
    // fields mean "not measured" — recorded, not faked.
    summary: {
      vadVoiceDetectedToTtsCancelledMs: null,
      vadVoiceDetectedToLlmCancelledMs: null,
      bargeInCancelMs: null,
      samples: 0,
    },
  };

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`wrote ${args.report}`);
    console.log(
      `bargein-latency: available=${report.available} — ${report.reason}`,
    );
  }
  // Exit 0: "recorded a needs-wiring/needs-hardware entry" is success for
  // this harness, the same as the dflash bench. A non-zero exit is reserved
  // for a real run that fails its gate.
  process.exit(0);
}

main();
