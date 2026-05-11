#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function firstExisting(...candidates) {
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
  );
}

const MODELS_ROOT = path.join(
  os.homedir(),
  ".eliza",
  "local-inference",
  "models",
);
const DEFAULT_BUNDLE = path.join(MODELS_ROOT, "eliza-1-1_7b.bundle");
const DEFAULT_TARGET = firstExisting(
  path.join(DEFAULT_BUNDLE, "text", "eliza-1-1_7b-64k.gguf"),
  path.join(MODELS_ROOT, "qwen3.5-4b-dflash.gguf"),
);
const DEFAULT_DRAFTER = firstExisting(
  path.join(DEFAULT_BUNDLE, "dflash", "drafter-1_7b.gguf"),
  path.join(MODELS_ROOT, "qwen3.5-4b-dflash-drafter-q4.repaired.gguf"),
  path.join(MODELS_ROOT, "qwen3.5-4b-dflash-drafter-q4.gguf"),
);
const DEFAULT_BIN = path.join(
  process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza"),
  "local-inference",
  "bin",
  "dflash",
  "darwin-arm64-metal",
  "llama-speculative-simple",
);

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv) {
  const args = {
    targetModel: process.env.ELIZA_DFLASH_TARGET_MODEL || DEFAULT_TARGET,
    drafterModel: process.env.ELIZA_DFLASH_DRAFTER_MODEL || DEFAULT_DRAFTER,
    specBinary: process.env.ELIZA_DFLASH_SPEC_BINARY || DEFAULT_BIN,
    referenceBinary: process.env.ELIZA_DFLASH_REFERENCE_SPEC_BINARY || "",
    referenceLibraryPath: process.env.ELIZA_DFLASH_REFERENCE_LIBRARY_PATH || "",
    skipInstalled: process.env.ELIZA_DFLASH_SKIP_INSTALLED === "1",
    ngl: process.env.ELIZA_DFLASH_SMOKE_NGL || "0",
    ngld: process.env.ELIZA_DFLASH_SMOKE_NGLD || "0",
    deviceNone: process.env.ELIZA_DFLASH_SMOKE_DEVICE_NONE !== "0",
    specType: process.env.ELIZA_DFLASH_SMOKE_SPEC_TYPE || "",
    temperature: process.env.ELIZA_DFLASH_SMOKE_TEMP || "",
    treeBudget: process.env.ELIZA_DFLASH_SMOKE_TREE_BUDGET || "",
    report:
      process.env.ELIZA_DFLASH_DRAFTER_REPORT ||
      path.join(
        __dirname,
        "hardware-results",
        `dflash-drafter-runtime-${timestamp()}.json`,
      ),
    metadataOnly: false,
    // --bench: in addition to the loadability smoke, run a short generation
    // with and without the drafter (`-md`), record tok/s + DFlash acceptance
    // rate, and write a speedup report under packages/inference/reports/.
    bench: process.env.ELIZA_DFLASH_BENCH === "1",
    benchTokens: Number.parseInt(
      process.env.ELIZA_DFLASH_BENCH_TOKENS || "128",
      10,
    ),
    benchReport:
      process.env.ELIZA_DFLASH_BENCH_REPORT ||
      path.join(
        __dirname,
        "..",
        "reports",
        "dflash-bench",
        `dflash-bench-${timestamp()}.json`,
      ),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--target-model") args.targetModel = next();
    else if (arg === "--drafter-model") args.drafterModel = next();
    else if (arg === "--spec-binary") args.specBinary = next();
    else if (arg === "--reference-binary") args.referenceBinary = next();
    else if (arg === "--reference-library-path")
      args.referenceLibraryPath = next();
    else if (arg === "--skip-installed") args.skipInstalled = true;
    else if (arg === "--ngl") args.ngl = next();
    else if (arg === "--ngld") args.ngld = next();
    else if (arg === "--allow-devices") args.deviceNone = false;
    else if (arg === "--spec-type") args.specType = next();
    else if (arg === "--temp") args.temperature = next();
    else if (arg === "--tree-budget") args.treeBudget = next();
    else if (arg === "--report") args.report = next();
    else if (arg === "--metadata-only") args.metadataOnly = true;
    else if (arg === "--bench") args.bench = true;
    else if (arg === "--bench-tokens")
      args.benchTokens = Number.parseInt(next(), 10);
    else if (arg === "--bench-report") args.benchReport = next();
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node packages/inference/verify/dflash_drafter_runtime_smoke.mjs [options]",
          "",
          "Options:",
          "  --target-model <path>          Target GGUF (default: local qwen3.5 DFlash target)",
          "  --drafter-model <path>         DFlash drafter GGUF",
          "  --spec-binary <path>           llama-speculative-simple binary to test",
          "  --reference-binary <path>      Optional known-DFlash binary to compare loader errors",
          "  --reference-library-path <dir> Optional DYLD/LD library path for the reference binary",
          "  --skip-installed              Only run the reference binary",
          "  --ngl <N>                     Target GPU layers for runtime smoke (default: 0)",
          "  --ngld <N>                    Draft GPU layers for runtime smoke (default: 0)",
          "  --allow-devices               Do not pass --device none / --device-draft none",
          "  --spec-type <type>            Optional --spec-type value for the runtime smoke",
          "  --temp <N>                    Optional target sampler temperature",
          "  --tree-budget <N>             Optional DFlash tree budget",
          "  --report <path>                JSON report path",
          "  --metadata-only                Parse GGUF metadata only; skip runtime execution",
          "  --bench                        Also run a short generation with vs without -md and",
          "                                 record tok/s + DFlash acceptance rate to a speedup report",
          "  --bench-tokens <N>             Tokens to generate per bench run (default: 128)",
          "  --bench-report <path>          Speedup report JSON path (default: packages/inference/reports/dflash-bench/)",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function readU64(buf, off) {
  const value = buf.readBigUInt64LE(off.value);
  off.value += 8;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`GGUF value too large for verifier offset: ${value}`);
  }
  return Number(value);
}

function readString(buf, off) {
  const len = readU64(buf, off);
  const start = off.value;
  const end = start + len;
  off.value = end;
  return buf.toString("utf8", start, end);
}

function skipScalar(buf, off, type) {
  switch (type) {
    case 0:
    case 1:
    case 7:
      off.value += 1;
      return;
    case 2:
    case 3:
      off.value += 2;
      return;
    case 4:
    case 5:
    case 6:
      off.value += 4;
      return;
    case 8:
      readString(buf, off);
      return;
    case 10:
    case 11:
    case 12:
      off.value += 8;
      return;
    default:
      throw new Error(`unsupported GGUF scalar type ${type}`);
  }
}

function readScalar(buf, off, type) {
  switch (type) {
    case 0: {
      const value = buf.readUInt8(off.value);
      off.value += 1;
      return value;
    }
    case 1: {
      const value = buf.readInt8(off.value);
      off.value += 1;
      return value;
    }
    case 2: {
      const value = buf.readUInt16LE(off.value);
      off.value += 2;
      return value;
    }
    case 3: {
      const value = buf.readInt16LE(off.value);
      off.value += 2;
      return value;
    }
    case 4: {
      const value = buf.readUInt32LE(off.value);
      off.value += 4;
      return value;
    }
    case 5: {
      const value = buf.readInt32LE(off.value);
      off.value += 4;
      return value;
    }
    case 6: {
      const value = buf.readFloatLE(off.value);
      off.value += 4;
      return value;
    }
    case 7: {
      const value = buf.readUInt8(off.value) !== 0;
      off.value += 1;
      return value;
    }
    case 8:
      return readString(buf, off);
    case 10: {
      const value = readU64(buf, off);
      return value;
    }
    case 11: {
      const value = buf.readBigInt64LE(off.value);
      off.value += 8;
      return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
        value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value.toString();
    }
    case 12: {
      const value = buf.readDoubleLE(off.value);
      off.value += 8;
      return value;
    }
    default:
      throw new Error(`unsupported GGUF scalar type ${type}`);
  }
}

function readValue(buf, off, type, capture = true) {
  if (type !== 9) {
    if (!capture) {
      skipScalar(buf, off, type);
      return undefined;
    }
    return readScalar(buf, off, type);
  }

  const innerType = buf.readUInt32LE(off.value);
  off.value += 4;
  const len = readU64(buf, off);
  const maxCapture = 32;
  const values = [];
  for (let i = 0; i < len; i += 1) {
    const shouldCapture = capture && i < maxCapture;
    const value = readValue(buf, off, innerType, shouldCapture);
    if (shouldCapture) values.push(value);
  }
  return {
    type: "array",
    innerType,
    length: len,
    values,
    truncated: len > maxCapture,
  };
}

function parseGguf(file) {
  const buf = fs.readFileSync(file);
  const off = { value: 0 };
  const magic = buf.toString("utf8", 0, 4);
  off.value += 4;
  if (magic !== "GGUF") {
    throw new Error(`${file} is not a GGUF file`);
  }
  const version = buf.readUInt32LE(off.value);
  off.value += 4;
  const tensorCount = readU64(buf, off);
  const kvCount = readU64(buf, off);
  const metadata = {};
  const metadataTypes = {};

  for (let i = 0; i < kvCount; i += 1) {
    const key = readString(buf, off);
    const type = buf.readUInt32LE(off.value);
    off.value += 4;
    const capture =
      !key.startsWith("tokenizer.ggml.tokens") &&
      !key.startsWith("tokenizer.ggml.token_type") &&
      !key.startsWith("tokenizer.ggml.merges");
    metadataTypes[key] = type;
    metadata[key] = readValue(buf, off, type, capture);
  }

  const tensors = [];
  for (let i = 0; i < tensorCount; i += 1) {
    const name = readString(buf, off);
    const nDims = buf.readUInt32LE(off.value);
    off.value += 4;
    const dims = [];
    for (let d = 0; d < nDims; d += 1) {
      dims.push(readU64(buf, off));
    }
    const type = buf.readUInt32LE(off.value);
    off.value += 4;
    const tensorOffset = readU64(buf, off);
    tensors.push({ name, dims, type, offset: tensorOffset });
  }

  return {
    file,
    sizeBytes: fs.statSync(file).size,
    version,
    tensorCount,
    kvCount,
    metadata,
    metadataTypes,
    metadataKeys: Object.keys(metadata),
    tensorNames: tensors.map((tensor) => tensor.name),
    tensors,
  };
}

function buildRuntimeArgs(targetModel, drafterModel, options) {
  const args = [
    "-m",
    targetModel,
    "-md",
    drafterModel,
    "-p",
    "Hello",
    "-n",
    "1",
    "-c",
    "128",
    "-cd",
    "128",
    "-ngl",
    options.ngl,
    "-ngld",
    options.ngld,
  ];
  if (options.deviceNone) {
    args.push("--device", "none", "--device-draft", "none");
  }
  args.push("--draft", "1", "--draft-min", "1", "--draft-p-min", "0.1");
  if (options.specType) {
    args.push("--spec-type", options.specType);
  }
  if (options.temperature) {
    args.push("--temp", options.temperature);
  }
  if (options.treeBudget) {
    args.push("--tree-budget", options.treeBudget);
  }
  return args;
}

function classifyRuntimeOutput(text) {
  if (/unknown model architecture: 'dflash-draft'/.test(text)) {
    return "runtime_missing_dflash_draft_architecture";
  }
  if (/cannot find tokenizer merges in model file/.test(text)) {
    return "artifact_missing_tokenizer_merges";
  }
  if (/failed to load draft model/.test(text)) {
    return "draft_model_load_failed";
  }
  if (/n_drafted|drafted|accepted/i.test(text)) {
    return "generation_attempt_completed";
  }
  return "runtime_failed_unclassified";
}

function runRuntime(
  label,
  binary,
  libraryPath,
  targetModel,
  drafterModel,
  options,
) {
  if (!binary) return null;
  const args = buildRuntimeArgs(targetModel, drafterModel, options);
  if (!fs.existsSync(binary)) {
    return {
      label,
      binary,
      args,
      status: null,
      signal: null,
      classification: "binary_missing",
      outputTail: "",
    };
  }
  const env = { ...process.env };
  if (libraryPath) {
    env.DYLD_LIBRARY_PATH = `${libraryPath}${env.DYLD_LIBRARY_PATH ? `:${env.DYLD_LIBRARY_PATH}` : ""}`;
    env.LD_LIBRARY_PATH = `${libraryPath}${env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : ""}`;
  }
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const lines = output.trim().split(/\r?\n/);
  return {
    label,
    binary,
    args,
    status: result.status,
    signal: result.signal,
    classification:
      result.status === 0
        ? "generation_attempt_completed"
        : classifyRuntimeOutput(output),
    outputTail: lines.slice(-120).join("\n"),
  };
}

/**
 * Parse DFlash drafted/accepted counters and a tokens/sec figure out of a
 * llama.cpp speculative run's stdout/stderr. llama.cpp prints
 * `n_drafted = N`, `n_accept = N` (or `n_drafted_accepted`), and timing lines
 * like `eval time = ... ms / N tokens ( ... ms per token, X tokens per
 * second)`. Returns the best-effort numbers; null fields when not found.
 */
function parseBenchOutput(text) {
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  const drafted = num(/n_drafted\s*[:=]\s*(\d+)/i);
  const accepted =
    num(/n_drafted_accepted\s*[:=]\s*(\d+)/i) ??
    num(/n_accept(?:ed)?\s*[:=]\s*(\d+)/i);
  // Prefer the generation ("eval"/"decode") tokens-per-second line.
  const tokPerSec =
    num(/eval time\s*=.*?,\s*([\d.]+)\s*tokens per second/i) ??
    num(/decode:.*?,\s*([\d.]+)\s*t\/s/i) ??
    num(/([\d.]+)\s*tokens? per second/i);
  return {
    drafted,
    accepted,
    acceptanceRate:
      drafted && drafted > 0 && accepted != null ? accepted / drafted : null,
    tokensPerSecond: tokPerSec,
  };
}

/**
 * Run one bench pass of the spec binary. `withDrafter` toggles whether the
 * drafter actually drafts (`--draft-max 6` vs `--draft-max 0` — the latter
 * makes every step an autoregressive target step, i.e. the no-speculation
 * baseline, while still exercising the same binary so the comparison is
 * apples-to-apples). Returns `{ available: false }` when the binary is
 * missing so callers record a "needs hardware" entry rather than fail.
 */
function runBenchPass(binary, targetModel, drafterModel, options, withDrafter) {
  if (!binary || !fs.existsSync(binary)) {
    return { available: false, binary, withDrafter };
  }
  if (!fs.existsSync(targetModel) || !fs.existsSync(drafterModel)) {
    return {
      available: false,
      binary,
      withDrafter,
      reason: "target or drafter model missing",
    };
  }
  const n = String(options.benchTokens > 0 ? options.benchTokens : 128);
  const args = [
    "-m",
    targetModel,
    "-md",
    drafterModel,
    "-p",
    "Write a short paragraph about speculative decoding.",
    "-n",
    n,
    "-c",
    "2048",
    "-cd",
    "2048",
    "-ngl",
    options.ngl,
    "-ngld",
    options.ngld,
    "--draft-min",
    withDrafter ? "2" : "0",
    "--draft-max",
    withDrafter ? "6" : "0",
  ];
  if (options.deviceNone) {
    args.push("--device", "none", "--device-draft", "none");
  }
  if (options.specType) args.push("--spec-type", options.specType);
  if (options.temperature) args.push("--temp", options.temperature);
  const started = Date.now();
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    env: { ...process.env },
    maxBuffer: 32 * 1024 * 1024,
  });
  const wallMs = Date.now() - started;
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const parsed = parseBenchOutput(output);
  return {
    available: true,
    binary,
    withDrafter,
    status: result.status,
    wallMs,
    tokensRequested: Number(n),
    ...parsed,
    outputTail: output.trim().split(/\r?\n/).slice(-40).join("\n"),
  };
}

/**
 * Bench DFlash speedup: run the spec binary with and without the drafter,
 * compute the tok/s ratio + acceptance rate, and write a report JSON.
 * Coordinates its shape with W11 (eliza1_gates.yaml + manifest evals).
 */
function runDflashBench(args) {
  const withDrafter = runBenchPass(
    args.specBinary,
    args.targetModel,
    args.drafterModel,
    args,
    true,
  );
  const withoutDrafter = runBenchPass(
    args.specBinary,
    args.targetModel,
    args.drafterModel,
    args,
    false,
  );
  const speedup =
    withDrafter.available &&
    withoutDrafter.available &&
    withDrafter.tokensPerSecond &&
    withoutDrafter.tokensPerSecond
      ? withDrafter.tokensPerSecond / withoutDrafter.tokensPerSecond
      : null;
  const report = {
    generatedAt: new Date().toISOString(),
    verifier: path.relative(process.cwd(), __filename),
    targetModel: args.targetModel,
    drafterModel: args.drafterModel,
    specBinary: args.specBinary,
    benchTokens: args.benchTokens,
    available: withDrafter.available && withoutDrafter.available,
    withDrafter,
    withoutDrafter,
    acceptanceRate: withDrafter.acceptanceRate ?? null,
    speedup,
    // A neutral schema W11 can re-key into eliza1_gates.yaml. Null fields mean
    // "needs hardware" — recorded, not faked (AGENTS.md §3 / §7).
    summary: {
      tokensPerSecondWithDrafter: withDrafter.tokensPerSecond ?? null,
      tokensPerSecondBaseline: withoutDrafter.tokensPerSecond ?? null,
      dflashAcceptanceRate: withDrafter.acceptanceRate ?? null,
      dflashSpeedup: speedup,
    },
  };
  fs.mkdirSync(path.dirname(args.benchReport), { recursive: true });
  fs.writeFileSync(args.benchReport, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${args.benchReport}`);
  // Also write/overwrite a stable `dflash-bench-latest.json` next to the
  // timestamped report so `eliza1_gates_collect.mjs` and the manifest evals
  // writer have a fixed path to read (the collector also picks the newest
  // timestamped file — this is the convenience alias). Null fields are kept
  // as-is: a needs-hardware bench produces a latest entry that says so.
  try {
    const latest = path.join(
      path.dirname(args.benchReport),
      "dflash-bench-latest.json",
    );
    fs.writeFileSync(latest, `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    // Non-fatal — the timestamped report is the source of truth.
  }
  if (report.available) {
    console.log(
      `dflash-bench: tok/s with-drafter=${withDrafter.tokensPerSecond} ` +
        `baseline=${withoutDrafter.tokensPerSecond} speedup=${speedup?.toFixed?.(2) ?? "n/a"} ` +
        `acceptance=${withDrafter.acceptanceRate?.toFixed?.(3) ?? "n/a"}`,
    );
  } else {
    console.log(
      "dflash-bench: spec binary or models unavailable — recorded a needs-hardware entry",
    );
  }
  return report;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = {
    generatedAt: new Date().toISOString(),
    verifier: path.relative(process.cwd(), __filename),
    targetModel: args.targetModel,
    drafterModel: args.drafterModel,
    checks: {},
    metadata: null,
    runtime: [],
  };

  const parsed = parseGguf(args.drafterModel);
  const metadata = parsed.metadata;
  const tensorNames = new Set(parsed.tensorNames);
  const hasTokenizerMerges = Object.hasOwn(metadata, "tokenizer.ggml.merges");
  const tokenizerModel = metadata["tokenizer.ggml.model"];
  const architecture = metadata["general.architecture"];

  // Two valid drafter shapes:
  //  (a) Eliza-1 production drafter — a plain autoregressive GGUF
  //      (qwen3/qwen35/…) that shares the target's vocabulary. This is
  //      what `distill_dflash_drafter.py` produces and what the fork's
  //      `--spec-type dflash` path actually consumes (it treats `dflash`
  //      as `draft`; see common/speculative.cpp). It must record
  //      `dflash-draft.target_checkpoint_sha256` so the publish gate /
  //      runtime doctor can verify it was distilled against the shipped
  //      text checkpoint.
  //  (b) Upstream DFlash drafter — `general.architecture == dflash-draft`
  //      with the `dflash_fc.weight` MLP-head tensors and the
  //      `dflash-draft.dflash.*` block-config metadata. Not what Eliza-1
  //      ships, but the smoke still accepts it for fork-compat tests.
  const isUpstreamDflashArch = architecture === "dflash-draft";
  const upstreamRequiredTensors = [
    "dflash_fc.weight",
    "dflash_hidden_norm.weight",
    "output_norm.weight",
  ];
  const upstreamRequiredMetadata = [
    "dflash-draft.dflash.block_size",
    "dflash-draft.dflash.mask_token_id",
    "dflash-draft.dflash.target_layer_ids",
    "dflash-draft.dflash.n_target_features",
  ];
  // Plain-AR drafter sanity: a token-embedding tensor and an attention
  // block (we don't pin the exact arch — only that it's not a head-only
  // file). Either token_embd.weight or output.weight plus blk.0.* is
  // enough to confirm a usable AR drafter.
  const plainArMarkers = [
    "token_embd.weight",
    "blk.0.attn_q.weight",
    "blk.0.attn_k.weight",
  ];
  const targetCheckpointSha256 =
    metadata["dflash-draft.target_checkpoint_sha256"] ?? null;

  report.metadata = {
    version: parsed.version,
    tensorCount: parsed.tensorCount,
    kvCount: parsed.kvCount,
    architecture,
    drafterShape: isUpstreamDflashArch ? "upstream-dflash-draft" : "plain-ar",
    tokenizerModel,
    tokenizerPre: metadata["tokenizer.ggml.pre"],
    hasTokenizerMerges,
    targetCheckpointSha256,
    dflash: {
      blockSize: metadata["dflash-draft.dflash.block_size"],
      maskTokenId: metadata["dflash-draft.dflash.mask_token_id"],
      targetLayerIds: metadata["dflash-draft.dflash.target_layer_ids"],
      nTargetFeatures: metadata["dflash-draft.dflash.n_target_features"],
    },
    upstreamRequiredTensors: Object.fromEntries(
      upstreamRequiredTensors.map((name) => [name, tensorNames.has(name)]),
    ),
    plainArMarkers: Object.fromEntries(
      plainArMarkers.map((name) => [name, tensorNames.has(name)]),
    ),
  };

  const upstreamShapeOk =
    isUpstreamDflashArch &&
    upstreamRequiredTensors.every((name) => tensorNames.has(name)) &&
    upstreamRequiredMetadata.every((key) => Object.hasOwn(metadata, key));
  const plainArShapeOk =
    !isUpstreamDflashArch &&
    typeof architecture === "string" &&
    architecture.length > 0 &&
    tensorNames.has("token_embd.weight");

  report.checks = {
    drafterShape: report.metadata.drafterShape,
    upstreamDflashShapeOk: upstreamShapeOk,
    plainArShapeOk,
    hasTargetCheckpointSha256: targetCheckpointSha256 !== null,
    gpt2TokenizerHasMerges: tokenizerModel !== "gpt2" || hasTokenizerMerges,
  };

  const failedMetadata = [];
  if (!upstreamShapeOk && !plainArShapeOk) {
    failedMetadata.push(
      isUpstreamDflashArch
        ? "architecture is dflash-draft but the MLP-head tensors / dflash-draft.dflash.* metadata are incomplete"
        : `not a recognised drafter: architecture=${architecture ?? "<unset>"} and no token_embd.weight tensor`,
    );
  }
  // The target-checkpoint hash is only *advisory* in the smoke (a freshly
  // converted base won't have it yet); the publish gate is where it is
  // mandatory. Record it without failing.
  if (!report.checks.gpt2TokenizerHasMerges) {
    failedMetadata.push(
      "tokenizer.ggml.model is gpt2 but tokenizer.ggml.merges is absent",
    );
  }
  report.metadataStatus =
    failedMetadata.length === 0 ? "metadata_loadable" : "metadata_invalid";
  report.metadataFailures = failedMetadata;

  if (!args.metadataOnly) {
    if (!args.skipInstalled) {
      report.runtime.push(
        runRuntime(
          "installed",
          args.specBinary,
          "",
          args.targetModel,
          args.drafterModel,
          args,
        ),
      );
    }
    if (args.referenceBinary) {
      report.runtime.push(
        runRuntime(
          "reference",
          args.referenceBinary,
          args.referenceLibraryPath,
          args.targetModel,
          args.drafterModel,
          args,
        ),
      );
    }
  }

  if (args.bench) {
    report.bench = runDflashBench(args);
  }

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${args.report}`);
  console.log(`metadataStatus=${report.metadataStatus}`);
  for (const run of report.runtime.filter(Boolean)) {
    console.log(
      `${run.label}: status=${run.status} classification=${run.classification}`,
    );
  }

  const runtimeFailed = report.runtime
    .filter(Boolean)
    .some((run) => run.status !== 0);
  if (failedMetadata.length > 0 || runtimeFailed) {
    process.exit(1);
  }
}

main();
