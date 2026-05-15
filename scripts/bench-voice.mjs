#!/usr/bin/env node
/**
 * bench-voice.mjs — top-level voice benchmark orchestrator.
 *
 * Runs all four voice benchmarks and emits a combined summary at
 * `artifacts/voice-bench-summary.json`. Each bench writes its own
 * artifacts under `artifacts/<bench-name>/<run-id>/`.
 *
 * Usage:
 *   bun run bench:voice                       # full run (all benches)
 *   bun run bench:voice --smoke               # 30-second CI smoke variants
 *   bun run bench:voice --skip-ts             # skip TypeScript voicebench
 *   bun run bench:voice --skip-quality        # skip voicebench-quality
 *   bun run bench:voice --skip-agent          # skip voiceagentbench
 *   bun run bench:voice --skip-emotion        # skip voice-emotion
 *
 * Environment variables forwarded to each bench:
 *   ELIZA_API_BASE        Eliza runtime base URL (default http://localhost:31337)
 *   GROQ_API_KEY          Required for Groq Whisper STT + TTS
 *   ELEVENLABS_API_KEY    Required when --profile=elevenlabs for voicebench TS
 *   VOICEBENCH_PROFILE    groq | elevenlabs (default: groq)
 *   CEREBRAS_API_KEY      Optional for coherence judging in voiceagentbench
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const ARTIFACTS_ROOT = resolve(REPO_ROOT, "artifacts");
const BENCH_DIR = resolve(REPO_ROOT, "packages", "benchmarks");

// Parse CLI flags
const args = process.argv.slice(2);
const SMOKE = args.includes("--smoke");
const SKIP_TS = args.includes("--skip-ts");
const SKIP_QUALITY = args.includes("--skip-quality");
const SKIP_AGENT = args.includes("--skip-agent");
const SKIP_EMOTION = args.includes("--skip-emotion");

const RUN_ID = `${Date.now()}`;
const TIMESTAMP_ISO = new Date().toISOString();

// Resolve python interpreter
function resolvePython() {
  for (const candidate of ["python3", "python"]) {
    try {
      const result = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
      if (result.status === 0) return candidate;
    } catch {
      // continue
    }
  }
  throw new Error("Python 3 not found. Install python3 to run voice benchmarks.");
}

// Resolve bun
function resolveBun() {
  try {
    const result = spawnSync("bun", ["--version"], { encoding: "utf-8" });
    if (result.status === 0) return "bun";
  } catch {
    // continue
  }
  const localBun = resolve(REPO_ROOT, "node_modules", ".bin", "bun");
  if (existsSync(localBun)) return localBun;
  throw new Error("bun not found.");
}

function run(cmd, opts = {}) {
  console.log(`\n[bench:voice] $ ${cmd}`);
  const result = spawnSync(cmd, {
    shell: true,
    stdio: "inherit",
    cwd: opts.cwd || REPO_ROOT,
    env: { ...process.env, ...opts.env },
  });
  return result.status ?? 1;
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function readJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

async function main() {
  const PYTHON = resolvePython();
  const BUN = resolveBun();

  const results = {
    runId: RUN_ID,
    timestamp: TIMESTAMP_ISO,
    smoke: SMOKE,
    benches: {},
  };

  // -------------------------------------------------------------------------
  // 1. voicebench (TypeScript) — real Eliza AgentRuntime + Groq/ElevenLabs
  // -------------------------------------------------------------------------
  if (!SKIP_TS) {
    const label = "voicebench-ts";
    const outDir = resolve(ARTIFACTS_ROOT, "voicebench", RUN_ID);
    ensureDir(outDir);
    const profile = process.env.VOICEBENCH_PROFILE || "groq";
    const audioPath = resolve(BENCH_DIR, "voicebench", "shared", "audio", "default.wav");
    const outFile = resolve(outDir, `voicebench-typescript-${profile}-${RUN_ID}.json`);
    const iterations = SMOKE ? "1" : undefined;

    let cmd = `${BUN} run "${resolve(BENCH_DIR, "voicebench", "typescript", "src", "bench.ts")}"`;
    cmd += ` --profile=${profile}`;
    if (existsSync(audioPath)) {
      cmd += ` --audio="${audioPath}"`;
    } else {
      // Try dataset
      const datasetPath = resolve(BENCH_DIR, "voicebench", "shared", "manifest-groq.json");
      if (existsSync(datasetPath)) {
        cmd += ` --dataset="${datasetPath}"`;
      } else {
        console.warn(`[bench:voice] WARNING: No audio file or dataset found for voicebench-ts. Skipping.`);
        results.benches[label] = { status: "skipped", reason: "no-audio" };
        goto_quality();
        return;
      }
    }
    cmd += ` --output="${outFile}"`;
    if (iterations) cmd += ` --iterations=${iterations}`;

    const started = Date.now();
    const code = run(cmd);
    const elapsed = (Date.now() - started) / 1000;

    let score = null;
    const out = readJsonSafe(outFile);
    if (out?.summary) {
      const modes = Object.values(out.summary);
      if (modes.length > 0) {
        score = modes.reduce((s, m) => s + (m.transcriptionNormalizedAccuracy || 0), 0) / modes.length;
      }
    }

    results.benches[label] = {
      status: code === 0 ? "pass" : "fail",
      exitCode: code,
      elapsedSeconds: Math.round(elapsed * 10) / 10,
      score,
      artifactDir: outDir,
      artifactFile: outFile,
    };
    console.log(`[bench:voice] ${label}: ${code === 0 ? "PASS" : "FAIL"} (${elapsed.toFixed(1)}s)`);
  }

  function goto_quality() {}

  // -------------------------------------------------------------------------
  // 2. voicebench-quality (Python) — real Eliza HTTP + Groq STT
  // -------------------------------------------------------------------------
  if (!SKIP_QUALITY) {
    const label = "voicebench-quality";
    const outDir = resolve(ARTIFACTS_ROOT, "voicebench-quality", RUN_ID);
    ensureDir(outDir);

    const sttProvider = process.env.ELIZA_API_BASE ? "eliza-runtime" : "groq";
    const agent = "eliza";
    const suite = SMOKE ? "openbookqa" : "all";
    const limit = SMOKE ? "2" : "";

    let cmd = `${PYTHON} -m elizaos_voicebench`;
    cmd += ` --agent ${agent}`;
    cmd += ` --stt-provider ${sttProvider}`;
    cmd += ` --suite ${suite}`;
    if (limit) cmd += ` --limit ${limit}`;
    cmd += ` --output "${outDir}"`;

    const started = Date.now();
    const code = run(cmd, {
      cwd: resolve(BENCH_DIR, "voicebench-quality"),
    });
    const elapsed = (Date.now() - started) / 1000;

    const resultFile = resolve(outDir, "voicebench-quality-results.json");
    const out = readJsonSafe(resultFile);
    results.benches[label] = {
      status: code === 0 ? "pass" : "fail",
      exitCode: code,
      elapsedSeconds: Math.round(elapsed * 10) / 10,
      score: out?.score ?? null,
      perSuite: out?.per_suite ?? null,
      artifactDir: outDir,
      artifactFile: resultFile,
    };
    console.log(`[bench:voice] ${label}: ${code === 0 ? "PASS" : "FAIL"} (${elapsed.toFixed(1)}s, score=${out?.score ?? "n/a"})`);
  }

  // -------------------------------------------------------------------------
  // 3. voiceagentbench (Python) — real Eliza HTTP agent + Groq STT
  // -------------------------------------------------------------------------
  if (!SKIP_AGENT) {
    const label = "voiceagentbench";
    const outDir = resolve(ARTIFACTS_ROOT, "voiceagentbench", RUN_ID);
    ensureDir(outDir);

    const fixtureData = resolve(BENCH_DIR, "voiceagentbench", "fixtures", "test_tasks.jsonl");
    const suite = SMOKE ? "single" : "all";
    const limit = SMOKE ? "2" : "0";

    let cmd = `${PYTHON} -m elizaos_voiceagentbench`;
    cmd += ` --agent eliza`;
    cmd += ` --suite ${suite}`;
    cmd += ` --limit ${limit}`;
    cmd += ` --data-path "${fixtureData}"`;
    cmd += ` --no-judge`;
    cmd += ` --output "${outDir}"`;

    const started = Date.now();
    const code = run(cmd, {
      cwd: resolve(BENCH_DIR, "voiceagentbench"),
    });
    const elapsed = (Date.now() - started) / 1000;

    // Find the output file (CLI stamps it with a timestamp)
    let resultFile = null;
    let out = null;
    try {
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
      if (files.length > 0) {
        resultFile = resolve(outDir, files[files.length - 1]);
        out = readJsonSafe(resultFile);
      }
    } catch {
      // continue
    }

    results.benches[label] = {
      status: code === 0 ? "pass" : "fail",
      exitCode: code,
      elapsedSeconds: Math.round(elapsed * 10) / 10,
      score: out?.pass_at_1 ?? null,
      passAt1: out?.pass_at_1 ?? null,
      artifactDir: outDir,
      artifactFile: resultFile,
    };
    console.log(`[bench:voice] ${label}: ${code === 0 ? "PASS" : "FAIL"} (${elapsed.toFixed(1)}s, pass@1=${out?.pass_at_1 ?? "n/a"})`);
  }

  // -------------------------------------------------------------------------
  // 4. voice-emotion (Python) — fixture smoke + real duet when available
  // -------------------------------------------------------------------------
  if (!SKIP_EMOTION) {
    const label = "voice-emotion";
    const outDir = resolve(ARTIFACTS_ROOT, "voice-emotion", RUN_ID);
    ensureDir(outDir);

    // Intrinsic fixture (always runs — no corpus or onnxruntime needed)
    const outFile = resolve(outDir, "intrinsic-fixture.json");
    let cmd = `${PYTHON} -m elizaos_voice_emotion intrinsic`;
    cmd += ` --suite fixture`;
    cmd += ` --model wav2small-msp-dim-int8`;
    cmd += ` --out "${outFile}"`;

    // Text-intrinsic fixture
    const textOutFile = resolve(outDir, "text-intrinsic-fixture.json");
    let textCmd = `${PYTHON} -m elizaos_voice_emotion text-intrinsic`;
    textCmd += ` --suite fixture`;
    textCmd += ` --model stage1-lm`;
    textCmd += ` --out "${textOutFile}"`;

    const started = Date.now();
    const code1 = run(cmd, { cwd: resolve(BENCH_DIR, "voice-emotion") });
    const code2 = run(textCmd, { cwd: resolve(BENCH_DIR, "voice-emotion") });

    // If the Eliza runtime is up, also try the fidelity bench.
    let fidelityCode = 0;
    let fidelityScore = null;
    const elizaBase = process.env.ELIZA_API_BASE || "http://localhost:31337";
    if (!SMOKE) {
      const fidelityOutFile = resolve(outDir, "fidelity.json");
      const emotions = "happy,sad,angry,nervous,calm";
      const fidelityCmd = [
        `${PYTHON} -m elizaos_voice_emotion fidelity`,
        `--duet-host "${elizaBase}"`,
        `--emotions "${emotions}"`,
        `--rounds 5`,
        `--out "${fidelityOutFile}"`,
      ].join(" ");
      fidelityCode = run(fidelityCmd, { cwd: resolve(BENCH_DIR, "voice-emotion") });
      const fidelityOut = readJsonSafe(fidelityOutFile);
      fidelityScore = fidelityOut?.macroF1 ?? null;
    }

    const elapsed = (Date.now() - started) / 1000;
    const intrinsicOut = readJsonSafe(outFile);

    results.benches[label] = {
      status: code1 === 0 && code2 === 0 ? "pass" : "fail",
      exitCode: Math.max(code1, code2),
      elapsedSeconds: Math.round(elapsed * 10) / 10,
      score: intrinsicOut?.macroF1 ?? null,
      macroF1Intrinsic: intrinsicOut?.macroF1 ?? null,
      macroF1Fidelity: fidelityScore,
      fidelityStatus: SMOKE ? "skipped-smoke" : fidelityCode === 0 ? "pass" : "bench-unavailable",
      artifactDir: outDir,
    };
    console.log(`[bench:voice] ${label}: ${results.benches[label].status.toUpperCase()} (${elapsed.toFixed(1)}s, macroF1=${intrinsicOut?.macroF1 ?? "n/a"})`);
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  ensureDir(ARTIFACTS_ROOT);
  const summaryPath = resolve(ARTIFACTS_ROOT, "voice-bench-summary.json");
  const totalBenches = Object.keys(results.benches).length;
  const passedBenches = Object.values(results.benches).filter((b) => b.status === "pass").length;
  results.summary = {
    total: totalBenches,
    passed: passedBenches,
    failed: totalBenches - passedBenches,
    overallPass: passedBenches === totalBenches,
  };
  writeFileSync(summaryPath, JSON.stringify(results, null, 2));

  console.log(`\n[bench:voice] ============================================================`);
  console.log(`[bench:voice] Summary written to ${summaryPath}`);
  console.log(`[bench:voice] Results: ${passedBenches}/${totalBenches} benches passed`);
  for (const [name, bench] of Object.entries(results.benches)) {
    const icon = bench.status === "pass" ? "✓" : bench.status === "skipped" ? "-" : "✗";
    const scoreStr = bench.score != null ? ` score=${bench.score.toFixed(3)}` : "";
    console.log(`[bench:voice]   ${icon} ${name}${scoreStr} (${bench.elapsedSeconds ?? "?"}s)`);
  }
  console.log(`[bench:voice] ============================================================\n`);

  const anyFailed = Object.values(results.benches).some(
    (b) => b.status === "fail",
  );
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error("[bench:voice] fatal:", err);
  process.exit(1);
});
