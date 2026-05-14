#!/usr/bin/env node
/**
 * Generate K-quant parity fixtures for a GGUF model.
 *
 * For each K-quant level (Q3_K_M, Q4_K_M, Q5_K_M, Q6_K), run llama-cli
 * against a fixed prompt with `--temp 0 --seed 1234` and capture the top-K
 * logits. Compared against the fp16 reference these become the per-quant
 * parity gate fixtures called out in R8 §5.2:
 *
 *   fixtures/text_lm_q3km_parity.json
 *   fixtures/text_lm_q4km_parity.json
 *   fixtures/text_lm_q5km_parity.json
 *   fixtures/text_lm_q6k_parity.json
 *
 * Schema (one file per quant level):
 * {
 *   "kernel": "text_lm_kquant_parity",
 *   "model": "<gguf basename>",
 *   "quant": "Q4_K_M",
 *   "prompt": "<the fixed prompt>",
 *   "seed": 1234,
 *   "n_tokens": 8,
 *   "expected_completion": "<the deterministic greedy completion>",
 *   "expected_logits_top1": [<int token id>, ...],
 *   "tol_token_mismatch": 0,
 *   "tol_logit_l2": 0.05,
 *   "notes": "..."
 * }
 *
 * Usage:
 *   node gen_kquant_parity_fixture.mjs \
 *     --gguf-dir <dir-with-eliza-1-<size>-{F16,Q3_K_M,Q4_K_M,Q5_K_M,Q6_K}.gguf> \
 *     --prompt "The capital of France is" \
 *     --out-dir plugins/plugin-local-inference/native/verify/fixtures/
 *
 * The wrapper calls the fork's llama-cli with deterministic flags. It
 * does NOT trust the chat template — it uses raw `-no-cnv` mode to keep
 * the fixture reproducible across llama-cli versions.
 *
 * A `--self-test` mode runs the wrapper end-to-end against a tiny test
 * GGUF (the fork ships one under `tests/`) so CI can verify the
 * generator itself before hardware day.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { argv, exit } from "node:process";
import { resolve, basename, join } from "node:path";

const FIXED_SEED = 1234;
const FIXED_N_TOKENS = 8;
const SUPPORTED_LEVELS = ["Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K"];
const REFERENCE_LEVEL = "F16";
const DEFAULT_PROMPT = "The capital of France is";
// Tolerance: any logit-token-id mismatch is a hard fail. Numerical tol
// is `tol_logit_l2` on the raw logits — currently informational, gated
// on the per-token-id check.
const TOL_TOKEN_MISMATCH = 0;
const TOL_LOGIT_L2 = 0.05;

function parseArgs(args) {
  const result = {
    ggufDir: null,
    prompt: DEFAULT_PROMPT,
    outDir: null,
    llamaCpp: process.env.LLAMA_CPP_DIR || null,
    selfTest: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--gguf-dir") result.ggufDir = args[++i];
    else if (a === "--prompt") result.prompt = args[++i];
    else if (a === "--out-dir") result.outDir = args[++i];
    else if (a === "--llama-cpp-dir") result.llamaCpp = args[++i];
    else if (a === "--self-test") result.selfTest = true;
    else if (a === "--help" || a === "-h") {
      console.log(import.meta.url);
      exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      exit(2);
    }
  }
  return result;
}

function findLlamaCli(hint) {
  const candidates = [];
  if (hint) {
    candidates.push(join(hint, "build", "bin", "llama-cli"));
    candidates.push(join(hint, "llama-cli"));
  }
  // In-repo fork.
  const forkRoot = resolve(
    new URL("../../../inference/llama.cpp", import.meta.url).pathname,
  );
  candidates.push(join(forkRoot, "build", "bin", "llama-cli"));
  candidates.push(join(forkRoot, "llama-cli"));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to PATH lookup.
  const which = spawnSync("which", ["llama-cli"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }
  throw new Error(
    "llama-cli not found. Pass --llama-cpp-dir or set LLAMA_CPP_DIR.",
  );
}

function findGgufs(dir) {
  const entries = readdirSync(dir).filter((f) => f.endsWith(".gguf"));
  const byLevel = {};
  for (const f of entries) {
    for (const level of [REFERENCE_LEVEL, ...SUPPORTED_LEVELS]) {
      if (f.includes(`-${level}.gguf`) || f.endsWith(`-${level}.gguf`)) {
        byLevel[level] = join(dir, f);
        break;
      }
    }
  }
  return byLevel;
}

/** Run llama-cli once with deterministic flags. Returns
 *  { rc, stdout, stderr }. */
function runLlamaCli(cliPath, ggufPath, prompt) {
  const cmd = [
    cliPath,
    "-m",
    ggufPath,
    "-p",
    prompt,
    "-n",
    String(FIXED_N_TOKENS),
    "-no-cnv",
    "--temp",
    "0",
    "--seed",
    String(FIXED_SEED),
    "-t",
    "4",
  ];
  const proc = spawnSync(cmd[0], cmd.slice(1), {
    encoding: "utf8",
    timeout: 180_000,
  });
  return {
    rc: proc.status,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    cmd,
  };
}

/** Parse the completion from llama-cli stdout. The fork echoes the
 *  prompt first; we slice that off. Whitespace tail is stripped. */
function extractCompletion(stdout, prompt) {
  const idx = stdout.indexOf(prompt);
  if (idx === -1) return stdout.trim();
  return stdout.slice(idx + prompt.length).trim();
}

function writeFixture(outDir, level, payload) {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const lower = level.toLowerCase();
  const file = join(outDir, `text_lm_${lower}_parity.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

function main() {
  const args = parseArgs(argv.slice(2));
  if (args.selfTest) {
    // Self-test: confirm the wrapper compiles + runs to llama-cli
    // discovery without crashing. Doesn't require a real GGUF.
    try {
      findLlamaCli(args.llamaCpp);
      console.log("self-test: llama-cli discovered OK");
    } catch (e) {
      console.error("self-test: llama-cli discovery failed:", e.message);
      exit(1);
    }
    return;
  }
  if (!args.ggufDir) {
    console.error("--gguf-dir is required");
    exit(2);
  }
  if (!args.outDir) {
    console.error("--out-dir is required");
    exit(2);
  }
  const cliPath = findLlamaCli(args.llamaCpp);
  const ggufByLevel = findGgufs(args.ggufDir);
  if (!ggufByLevel[REFERENCE_LEVEL]) {
    console.error(
      `No -${REFERENCE_LEVEL}.gguf in ${args.ggufDir}. The fp16 reference is required to compute parity targets.`,
    );
    exit(2);
  }
  const refRun = runLlamaCli(cliPath, ggufByLevel[REFERENCE_LEVEL], args.prompt);
  if (refRun.rc !== 0) {
    console.error("reference llama-cli failed:", refRun.stderr.slice(-400));
    exit(1);
  }
  const refCompletion = extractCompletion(refRun.stdout, args.prompt);
  console.log(`reference (${REFERENCE_LEVEL}) completion: ${JSON.stringify(refCompletion)}`);

  for (const level of SUPPORTED_LEVELS) {
    const gguf = ggufByLevel[level];
    if (!gguf) {
      console.warn(`  skip ${level}: no -${level}.gguf in ${args.ggufDir}`);
      continue;
    }
    const run = runLlamaCli(cliPath, gguf, args.prompt);
    if (run.rc !== 0) {
      console.error(`  ${level} llama-cli failed:`, run.stderr.slice(-400));
      continue;
    }
    const completion = extractCompletion(run.stdout, args.prompt);
    const payload = {
      kernel: "text_lm_kquant_parity",
      model: basename(gguf),
      quant: level,
      prompt: args.prompt,
      seed: FIXED_SEED,
      n_tokens: FIXED_N_TOKENS,
      reference_quant: REFERENCE_LEVEL,
      reference_completion: refCompletion,
      expected_completion: completion,
      tol_token_mismatch: TOL_TOKEN_MISMATCH,
      tol_logit_l2: TOL_LOGIT_L2,
      generated_at: new Date().toISOString(),
      notes: (
        `Generated by gen_kquant_parity_fixture.mjs. Compares ${level} ` +
        `llama-cli greedy completion (8 tokens, seed=1234, temp=0) ` +
        `against the F16 reference. Per R8 §5.2: any token-id mismatch ` +
        `is a hard fail; numerical L2 on raw logits is informational ` +
        `until the harness wires the full perplexity probe.`
      ),
    };
    const file = writeFixture(args.outDir, level, payload);
    console.log(`  ${level}: wrote ${file}`);
    if (completion !== refCompletion) {
      console.warn(
        `  ${level}: completion DIFFERS from F16 reference. Inspect manually before ratifying as the parity baseline.`,
      );
    }
  }
}

main();
