#!/usr/bin/env node
/**
 * convert-omnivoice-singing.mjs
 *
 * One-shot wrapper that converts the upstream `ModelsLab/omnivoice-singing`
 * Hugging Face checkpoint (safetensors) into the GGUF pair that
 * omnivoice.cpp consumes:
 *
 *   omnivoice-singing-base-<DTYPE>.gguf      (Qwen3 LM + audio_emb + audio_heads)
 *   omnivoice-singing-tokenizer-F32.gguf     (HuBERT + DAC + RVQ + fc/fc2)
 *
 * Pipeline (shells out to system binaries; no Python deps are bundled):
 *
 *   1. Probe `python3` >= 3.10 and `huggingface-cli` (or `hf`).
 *   2. `hf download ModelsLab/omnivoice-singing --local-dir <hf-cache>`.
 *   3. Run `packages/inference/omnivoice.cpp/convert.py` against the
 *      downloaded checkpoint (override CHECKPOINT_DIR / OUTPUT_DIR via env).
 *   4. Optionally run `packages/inference/omnivoice.cpp/build/quantize`
 *      to derive Q8_0 / Q4_K_M / BF16 from the F32 base.
 *   5. Emit a JSON manifest listing produced files + sha256 + bytes,
 *      so the runtime downloader can verify a Milady-hosted mirror copy.
 *
 * The script does NOT bundle Python dependencies. If `transformers`,
 * `numpy`, `gguf`, or `safetensors` are missing it prints an actionable
 * `python3 -m pip install ...` line and exits non-zero.
 *
 * Usage:
 *
 *   node scripts/inference/convert-omnivoice-singing.mjs \
 *     --out-dir ~/.milady/models/omnivoice/singing \
 *     --quantize Q8_0
 *
 *   node scripts/inference/convert-omnivoice-singing.mjs --dry-run
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const OMNIVOICE_CPP_DIR = path.join(
  REPO_ROOT,
  "packages",
  "inference",
  "omnivoice.cpp",
);
const CONVERT_PY = path.join(OMNIVOICE_CPP_DIR, "convert.py");
const QUANTIZE_BIN = path.join(OMNIVOICE_CPP_DIR, "build", "quantize");

const HF_MODEL_ID = "ModelsLab/omnivoice-singing";
const VALID_QUANT = new Set(["none", "F16", "BF16", "Q8_0", "Q4_K_M"]);

function log(level, msg) {
  const line = `[convert-omnivoice-singing][${level}] ${msg}\n`;
  process.stderr.write(line);
}

function parseArgs(argv) {
  const args = {
    outDir: path.join(homedir(), ".milady", "models", "omnivoice", "singing"),
    hfCache: null,
    quantize: "Q8_0",
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out-dir") {
      args.outDir = path.resolve(argv[++i]);
    } else if (a === "--hf-cache") {
      args.hfCache = path.resolve(argv[++i]);
    } else if (a === "--quantize") {
      args.quantize = argv[++i];
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "-h" || a === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!VALID_QUANT.has(args.quantize)) {
    throw new Error(
      `--quantize must be one of ${[...VALID_QUANT].join(", ")} (got "${args.quantize}")`,
    );
  }
  if (!args.hfCache) {
    args.hfCache = path.join(args.outDir, ".hf-cache");
  }
  return args;
}

function printHelp() {
  const help =
    "Usage: node scripts/inference/convert-omnivoice-singing.mjs [options]\n" +
    "\n" +
    "Options:\n" +
    "  --out-dir <path>     Directory to write GGUFs + manifest.json\n" +
    "                       (default: ~/.milady/models/omnivoice/singing)\n" +
    "  --hf-cache <path>    Where huggingface-cli stores the safetensors\n" +
    "                       (default: <out-dir>/.hf-cache)\n" +
    "  --quantize <type>    none | F16 | BF16 | Q8_0 | Q4_K_M  (default: Q8_0)\n" +
    "  --dry-run            Print the plan, do not execute\n" +
    "  -h, --help           Show this help\n";
  process.stderr.write(help);
}

function which(bin) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [
    bin,
  ]);
  if (result.status === 0) {
    return result.stdout.toString().trim().split(/\r?\n/)[0] || null;
  }
  return null;
}

function probePython() {
  const py = which("python3") || which("python");
  if (!py) {
    throw new Error(
      "python3 not found in PATH. Install Python >= 3.10 (e.g. `brew install python@3.11`).",
    );
  }
  const ver = spawnSync(py, ["--version"], { encoding: "utf8" });
  const match = (ver.stdout || ver.stderr || "").match(/(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Could not parse python version from "${ver.stdout}${ver.stderr}".`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 3 || (major === 3 && minor < 10)) {
    throw new Error(
      `Python >= 3.10 required (found ${major}.${minor}). Install via pyenv or homebrew.`,
    );
  }
  return py;
}

function probePythonDeps(py) {
  const required = ["numpy", "gguf", "safetensors"];
  const check = spawnSync(
    py,
    [
      "-c",
      `import importlib, sys\nmissing=[m for m in ${JSON.stringify(required)} if importlib.util.find_spec(m) is None]\nprint(",".join(missing))`,
    ],
    { encoding: "utf8" },
  );
  if (check.status !== 0) {
    throw new Error(`Python dep probe failed: ${check.stderr || check.stdout}`);
  }
  const missing = check.stdout.trim().split(",").filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Missing Python packages: ${missing.join(", ")}.\n` +
        `  Install with: ${py} -m pip install --user ${missing.join(" ")}`,
    );
  }
}

function probeHfCli() {
  const hf = which("hf") || which("huggingface-cli");
  if (!hf) {
    throw new Error(
      "huggingface-cli not found. Install via `python3 -m pip install --user --upgrade huggingface_hub`.",
    );
  }
  return hf;
}

function runStep(cmd, args, opts = {}) {
  log("info", `$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(
      `Step failed: ${cmd} ${args.join(" ")} (exit ${result.status})`,
    );
  }
}

async function sha256OfFile(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function buildManifest(outDir) {
  const entries = await readdir(outDir);
  const ggufs = entries.filter((f) => f.endsWith(".gguf"));
  const files = [];
  for (const name of ggufs.sort()) {
    const full = path.join(outDir, name);
    const st = await stat(full);
    const sha = await sha256OfFile(full);
    files.push({ name, bytes: st.size, sha256: sha });
  }
  return {
    schema: 1,
    model: HF_MODEL_ID,
    convertedAt: new Date().toISOString(),
    files,
  };
}

function planSteps(args) {
  return [
    {
      title: "Probe python3 (>=3.10) + transformers/gguf/safetensors/numpy",
    },
    {
      title: "Probe huggingface-cli (`hf` or `huggingface-cli`)",
    },
    {
      title: `Ensure output dirs exist: ${args.outDir}, ${args.hfCache}`,
    },
    {
      title: `huggingface-cli download ${HF_MODEL_ID} --local-dir ${args.hfCache}/OmniVoiceSinging`,
    },
    {
      title: `python3 ${CONVERT_PY} (CHECKPOINT_DIR=${args.hfCache}/OmniVoiceSinging, OUTPUT_DIR=${args.outDir})`,
      note:
        "convert.py writes omnivoice-base-F32.gguf + omnivoice-tokenizer-F32.gguf. " +
        "This wrapper renames them to omnivoice-singing-* to disambiguate.",
    },
    args.quantize === "none"
      ? {
          title: "Skip quantize (--quantize none); F32 base kept as-is",
        }
      : {
          title: `${QUANTIZE_BIN} omnivoice-singing-base-F32.gguf -> omnivoice-singing-base-${args.quantize}.gguf`,
          note:
            "Requires omnivoice.cpp to have been built first " +
            "(`packages/inference/omnivoice.cpp/buildcpu.sh` or similar).",
        },
    {
      title: `Write ${path.join(args.outDir, "manifest.json")} with sha256 + sizes`,
    },
  ];
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    log("error", err.message);
    printHelp();
    process.exit(2);
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  log("info", `Repo root: ${REPO_ROOT}`);
  log("info", `Out dir:   ${args.outDir}`);
  log("info", `HF cache:  ${args.hfCache}`);
  log("info", `Quantize:  ${args.quantize}`);

  const steps = planSteps(args);
  log("info", "Plan:");
  for (const [i, step] of steps.entries()) {
    process.stderr.write(`  ${i + 1}. ${step.title}\n`);
    if (step.note) process.stderr.write(`       (${step.note})\n`);
  }

  if (args.dryRun) {
    log("info", "Dry run — not executing. Re-run without --dry-run to perform the conversion.");
    return;
  }

  // Step 1+2: probe toolchain.
  const py = probePython();
  probePythonDeps(py);
  const hf = probeHfCli();
  log("info", `Using python: ${py}`);
  log("info", `Using hf cli: ${hf}`);

  // Step 3: ensure directories.
  await mkdir(args.outDir, { recursive: true });
  await mkdir(args.hfCache, { recursive: true });

  // Step 4: HF download.
  const checkpointDir = path.join(args.hfCache, "OmniVoiceSinging");
  await mkdir(checkpointDir, { recursive: true });
  runStep(hf, ["download", HF_MODEL_ID, "--local-dir", checkpointDir]);

  // Step 5: run convert.py. The vendored convert.py expects
  // CHECKPOINT_DIR/OmniVoice/ and writes models/omnivoice-*-F32.gguf;
  // we point it at our checkpoint via a temp staging dir + symlink so we
  // don't need to patch the script itself.
  const stagingCheckpointRoot = path.join(args.hfCache, "convert-staging");
  await mkdir(stagingCheckpointRoot, { recursive: true });
  // convert.py hardcodes CHECKPOINT_DIR = <script>/checkpoints/OmniVoice and
  // OUTPUT_DIR = <script>/models. We invoke it with a wrapping cwd whose
  // checkpoints/OmniVoice/ symlinks to the real download, and whose
  // models/ symlinks to the configured out-dir.
  const wrapDir = path.join(stagingCheckpointRoot, "wrap");
  await mkdir(path.join(wrapDir, "checkpoints"), { recursive: true });
  const linkTarget = path.join(wrapDir, "checkpoints", "OmniVoice");
  runStep("ln", ["-sfn", checkpointDir, linkTarget]);
  const modelsLink = path.join(wrapDir, "models");
  runStep("ln", ["-sfn", args.outDir, modelsLink]);

  // convert.py uses paths derived from __file__, so we must run it
  // from a copy whose location resolves to wrapDir. Symlink the script
  // into wrapDir so SCRIPT_DIR points at wrapDir.
  const wrapScript = path.join(wrapDir, "convert.py");
  runStep("ln", ["-sfn", CONVERT_PY, wrapScript]);
  runStep(py, [wrapScript], { cwd: wrapDir });

  // Step 6: rename base + tokenizer to disambiguate from the non-singing build.
  const renames = [
    ["omnivoice-base-F32.gguf", "omnivoice-singing-base-F32.gguf"],
    ["omnivoice-tokenizer-F32.gguf", "omnivoice-singing-tokenizer-F32.gguf"],
  ];
  for (const [from, to] of renames) {
    const src = path.join(args.outDir, from);
    const dst = path.join(args.outDir, to);
    try {
      await stat(src);
    } catch {
      throw new Error(`convert.py did not produce ${src}`);
    }
    runStep("mv", ["-f", src, dst]);
  }

  // Step 7: optional quantize.
  if (args.quantize !== "none" && args.quantize !== "F32") {
    try {
      await stat(QUANTIZE_BIN);
    } catch {
      throw new Error(
        `quantize binary not found at ${QUANTIZE_BIN}.\n` +
          "  Build omnivoice.cpp first: ./packages/inference/omnivoice.cpp/buildcpu.sh",
      );
    }
    const srcBase = path.join(args.outDir, "omnivoice-singing-base-F32.gguf");
    const dstBase = path.join(
      args.outDir,
      `omnivoice-singing-base-${args.quantize}.gguf`,
    );
    runStep(QUANTIZE_BIN, [srcBase, dstBase, args.quantize]);
    // Tokenizer is left at native dtype per omnivoice.cpp/quantize.sh policy.
  }

  // Step 8: manifest.
  const manifest = await buildManifest(args.outDir);
  const manifestPath = path.join(args.outDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log("info", `Wrote ${manifestPath}`);
  for (const f of manifest.files) {
    process.stderr.write(`  - ${f.name}  ${f.bytes} bytes  sha256=${f.sha256}\n`);
  }
  log("info", "Done.");
}

main().catch((err) => {
  log("error", err.message || String(err));
  process.exit(1);
});
