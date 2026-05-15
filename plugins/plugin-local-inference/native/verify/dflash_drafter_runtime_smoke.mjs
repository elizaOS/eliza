#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSpeculativeBenchmarkReport,
  latestSpeculativeReportPath,
  timestampedSpeculativeReportPath,
  writeSpeculativeBenchmarkReport,
} from "./speculative_benchmark_report.mjs";

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
const DEFAULT_BUNDLE = path.join(MODELS_ROOT, "eliza-1-0_8b.bundle");
const DEFAULT_TARGET = firstExisting(
  path.join(DEFAULT_BUNDLE, "text", "eliza-1-0_8b-64k.gguf"),
  path.join(DEFAULT_BUNDLE, "text", "eliza-1-0_8b-32k.gguf"),
);
const DEFAULT_DRAFTER = firstExisting(
  path.join(DEFAULT_BUNDLE, "dflash", "drafter-0_8b.gguf"),
);
const DFLASH_TIERS = new Set(["2b", "4b", "9b", "27b", "27b-256k"]);
const TOKENIZER_COMPATIBILITY_KEYS = [
  "tokenizer.ggml.model",
  "tokenizer.ggml.pre",
  "tokenizer.ggml.tokens",
  "tokenizer.ggml.token_type",
  "tokenizer.ggml.merges",
  "tokenizer.ggml.eos_token_id",
  "tokenizer.ggml.bos_token_id",
  "tokenizer.ggml.padding_token_id",
  "tokenizer.ggml.add_bos_token",
  "tokenizer.ggml.add_eos_token",
];
const REQUIRED_TOKENIZER_COMPATIBILITY_KEYS = new Set([
  "tokenizer.ggml.model",
  "tokenizer.ggml.pre",
  "tokenizer.ggml.tokens",
  "tokenizer.ggml.token_type",
  "tokenizer.ggml.merges",
  "tokenizer.ggml.eos_token_id",
  "tokenizer.ggml.padding_token_id",
]);
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

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1 << 20);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function inferTier(...values) {
  for (const value of values) {
    const match = String(value ?? "").match(
      /eliza-1-(0_8b|2b|4b|9b|27b(?:-256k)?)/,
    );
    if (match) return match[1];
    const drafterMatch = String(value ?? "").match(
      /drafter-(0_8b|2b|4b|9b|27b(?:-256k)?)/,
    );
    if (drafterMatch) return drafterMatch[1];
  }
  return "";
}

function parseArgs(argv) {
  const args = {
    targetModel: process.env.ELIZA_DFLASH_TARGET_MODEL || DEFAULT_TARGET,
    drafterModel: process.env.ELIZA_DFLASH_DRAFTER_MODEL || DEFAULT_DRAFTER,
    specBinary: process.env.ELIZA_DFLASH_SPEC_BINARY || DEFAULT_BIN,
    tier: process.env.ELIZA_DFLASH_TIER || "",
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
    selfTest: false,
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
      timestampedSpeculativeReportPath(__dirname, "dflash"),
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
    else if (arg === "--tier") args.tier = next();
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
    else if (arg === "--self-test") args.selfTest = true;
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
          "  --target-model <path>          Target GGUF (default: local eliza-1-0_8b bundle)",
          "  --drafter-model <path>         DFlash drafter GGUF",
          "  --tier <tier>                  Eliza-1 tier; non-DFlash tiers are recorded as not-applicable",
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
          "  --self-test                    Run tokenizer-compatibility unit checks",
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

  args.tier = args.tier || inferTier(args.targetModel, args.drafterModel) || "0_8b";
  return args;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectCliFeatures(binary, libraryPath = "") {
  const flags = new Set();
  if (!binary || !fs.existsSync(binary)) {
    return {
      available: false,
      binary,
      flags,
      skippedReason: "binary_missing",
      helpStatus: null,
    };
  }
  const env = { ...process.env };
  if (libraryPath) {
    env.DYLD_LIBRARY_PATH = `${libraryPath}${env.DYLD_LIBRARY_PATH ? `:${env.DYLD_LIBRARY_PATH}` : ""}`;
    env.LD_LIBRARY_PATH = `${libraryPath}${env.LD_LIBRARY_PATH ? `:${env.LD_LIBRARY_PATH}` : ""}`;
  }
  const result = spawnSync(binary, ["--help"], {
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  const help = `${result.stdout || ""}${result.stderr || ""}`;
  const allFlags = help.match(/-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? [];
  for (const flag of allFlags) flags.add(flag);
  return {
    available: true,
    binary,
    flags,
    skippedReason: null,
    helpStatus: result.status,
    helpSignal: result.signal,
    helpOutputTail: help.trim().split(/\r?\n/).slice(-30).join("\n"),
  };
}

function supportsCliFlag(features, flag) {
  if (!features?.available) return false;
  if (features.flags?.has(flag)) return true;
  if (!features.helpOutputTail) return false;
  return new RegExp(`(^|[\\s,])${escapeRegExp(flag)}([\\s,]|$)`).test(
    features.helpOutputTail,
  );
}

function pushOptionalFlag(args, skippedCliFlags, features, flag, ...values) {
  if (supportsCliFlag(features, flag)) {
    args.push(flag, ...values);
    return;
  }
  skippedCliFlags.push({
    flag,
    values,
    reason: "not advertised by binary --help",
  });
}

function pushFirstSupportedFlag(args, skippedCliFlags, features, flags, ...values) {
  const supported = flags.find((flag) => supportsCliFlag(features, flag));
  if (supported) {
    args.push(supported, ...values);
    return supported;
  }
  skippedCliFlags.push({
    flag: flags[0],
    alternatives: flags.slice(1),
    values,
    reason: "not advertised by binary --help",
  });
  return null;
}

function pushDraftContextFlag(args, skippedCliFlags, features, value) {
  return pushFirstSupportedFlag(
    args,
    skippedCliFlags,
    features,
    ["--ctx-size-draft", "--spec-draft-ctx-size", "-cd"],
    value,
  );
}

function pushDraftMinFlag(args, skippedCliFlags, features, value) {
  return pushFirstSupportedFlag(
    args,
    skippedCliFlags,
    features,
    ["--spec-draft-n-min", "--draft-min", "--draft-n-min"],
    value,
  );
}

function pushDraftMaxFlag(args, skippedCliFlags, features, value) {
  return pushFirstSupportedFlag(
    args,
    skippedCliFlags,
    features,
    ["--spec-draft-n-max", "--draft-max", "--draft-n"],
    value,
  );
}

function pushDraftProbabilityFlag(args, skippedCliFlags, features, value) {
  return pushFirstSupportedFlag(
    args,
    skippedCliFlags,
    features,
    ["--spec-draft-p-min", "--draft-p-min"],
    value,
  );
}

const GGUF_READ_LIMIT_BYTES = 512 * 1024 * 1024;

function readGgufPrefix(file) {
  const stat = fs.statSync(file);
  const size = Math.min(stat.size, GGUF_READ_LIMIT_BYTES);
  const fd = fs.openSync(file, "r");
  try {
    const out = Buffer.allocUnsafe(size);
    const read = fs.readSync(fd, out, 0, size, 0);
    return {
      buffer: read === size ? out : out.subarray(0, read),
      sizeBytes: stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function assertAvailable(buf, offset, bytes, file) {
  if (offset + bytes <= buf.length) return;
  throw new Error(
    `${file} GGUF metadata/tensor directory exceeds ${Math.floor(
      GGUF_READ_LIMIT_BYTES / 1024 / 1024,
    )} MiB verifier read window`,
  );
}

function serializeCliFeatures(features) {
  if (!features) return null;
  return {
    available: features.available,
    binary: features.binary,
    supportedOptionalFlags: [
      "--device",
      "--device-draft",
      "--ctx-size-draft",
      "--spec-draft-ctx-size",
      "-cd",
      "--draft",
      "--spec-draft-n-min",
      "--draft-min",
      "--spec-draft-n-max",
      "--draft-max",
      "--spec-draft-p-min",
      "--draft-p-min",
      "--spec-type",
      "--temp",
      "--tree-budget",
    ].filter((flag) => supportsCliFlag(features, flag)),
    helpStatus: features.helpStatus,
    helpSignal: features.helpSignal,
    skippedReason: features.skippedReason,
  };
}

function readU64(buf, off) {
  assertAvailable(buf, off.value, 8, "GGUF");
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
  assertAvailable(buf, start, len, "GGUF");
  off.value = end;
  return buf.toString("utf8", start, end);
}

function skipScalar(buf, off, type) {
  switch (type) {
    case 0:
    case 1:
    case 7:
      assertAvailable(buf, off.value, 1, "GGUF");
      off.value += 1;
      return;
    case 2:
    case 3:
      assertAvailable(buf, off.value, 2, "GGUF");
      off.value += 2;
      return;
    case 4:
    case 5:
    case 6:
      assertAvailable(buf, off.value, 4, "GGUF");
      off.value += 4;
      return;
    case 8:
      readString(buf, off);
      return;
    case 10:
    case 11:
    case 12:
      assertAvailable(buf, off.value, 8, "GGUF");
      off.value += 8;
      return;
    default:
      throw new Error(`unsupported GGUF scalar type ${type}`);
  }
}

function readScalar(buf, off, type) {
  switch (type) {
    case 0: {
      assertAvailable(buf, off.value, 1, "GGUF");
      const value = buf.readUInt8(off.value);
      off.value += 1;
      return value;
    }
    case 1: {
      assertAvailable(buf, off.value, 1, "GGUF");
      const value = buf.readInt8(off.value);
      off.value += 1;
      return value;
    }
    case 2: {
      assertAvailable(buf, off.value, 2, "GGUF");
      const value = buf.readUInt16LE(off.value);
      off.value += 2;
      return value;
    }
    case 3: {
      assertAvailable(buf, off.value, 2, "GGUF");
      const value = buf.readInt16LE(off.value);
      off.value += 2;
      return value;
    }
    case 4: {
      assertAvailable(buf, off.value, 4, "GGUF");
      const value = buf.readUInt32LE(off.value);
      off.value += 4;
      return value;
    }
    case 5: {
      assertAvailable(buf, off.value, 4, "GGUF");
      const value = buf.readInt32LE(off.value);
      off.value += 4;
      return value;
    }
    case 6: {
      assertAvailable(buf, off.value, 4, "GGUF");
      const value = buf.readFloatLE(off.value);
      off.value += 4;
      return value;
    }
    case 7: {
      assertAvailable(buf, off.value, 1, "GGUF");
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
      assertAvailable(buf, off.value, 8, "GGUF");
      const value = buf.readBigInt64LE(off.value);
      off.value += 8;
      return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
        value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : value.toString();
    }
    case 12: {
      assertAvailable(buf, off.value, 8, "GGUF");
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

  assertAvailable(buf, off.value, 4, "GGUF");
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
  const { buffer: buf, sizeBytes } = readGgufPrefix(file);
  const off = { value: 0 };
  assertAvailable(buf, 0, 16, file);
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
  const metadataHashes = {};
  const metadataTypes = {};

  for (let i = 0; i < kvCount; i += 1) {
    const key = readString(buf, off);
    assertAvailable(buf, off.value, 4, file);
    const type = buf.readUInt32LE(off.value);
    off.value += 4;
    const valueStart = off.value;
    const capture =
      !key.startsWith("tokenizer.ggml.tokens") &&
      !key.startsWith("tokenizer.ggml.token_type") &&
      !key.startsWith("tokenizer.ggml.merges");
    metadataTypes[key] = type;
    metadata[key] = readValue(buf, off, type, capture);
    const valueEnd = off.value;
    metadataHashes[key] = crypto
      .createHash("sha256")
      .update(buf.subarray(valueStart, valueEnd))
      .digest("hex");
  }

  const tensors = [];
  for (let i = 0; i < tensorCount; i += 1) {
    const name = readString(buf, off);
    assertAvailable(buf, off.value, 4, file);
    const nDims = buf.readUInt32LE(off.value);
    off.value += 4;
    const dims = [];
    for (let d = 0; d < nDims; d += 1) {
      dims.push(readU64(buf, off));
    }
    assertAvailable(buf, off.value, 4, file);
    const type = buf.readUInt32LE(off.value);
    off.value += 4;
    const tensorOffset = readU64(buf, off);
    tensors.push({ name, dims, type, offset: tensorOffset });
  }

  return {
    file,
    sizeBytes,
    version,
    tensorCount,
    kvCount,
    metadata,
    metadataHashes,
    metadataTypes,
    metadataKeys: Object.keys(metadata),
    tensorNames: tensors.map((tensor) => tensor.name),
    tensors,
  };
}

function metadataArrayLength(value) {
  return value?.type === "array" ? value.length : null;
}

function tokenizerSummary(parsed) {
  const metadata = parsed.metadata;
  const hashes = parsed.metadataHashes;
  const hashByKey = Object.fromEntries(
    TOKENIZER_COMPATIBILITY_KEYS.map((key) => [key, hashes[key] ?? null]),
  );
  const valueByKey = {
    "tokenizer.ggml.model": metadata["tokenizer.ggml.model"] ?? null,
    "tokenizer.ggml.pre": metadata["tokenizer.ggml.pre"] ?? null,
    "tokenizer.ggml.eos_token_id":
      metadata["tokenizer.ggml.eos_token_id"] ?? null,
    "tokenizer.ggml.bos_token_id":
      metadata["tokenizer.ggml.bos_token_id"] ?? null,
    "tokenizer.ggml.padding_token_id":
      metadata["tokenizer.ggml.padding_token_id"] ?? null,
    "tokenizer.ggml.add_bos_token":
      metadata["tokenizer.ggml.add_bos_token"] ?? null,
    "tokenizer.ggml.add_eos_token":
      metadata["tokenizer.ggml.add_eos_token"] ?? null,
  };
  const lengthByKey = {
    "tokenizer.ggml.tokens": metadataArrayLength(
      metadata["tokenizer.ggml.tokens"],
    ),
    "tokenizer.ggml.token_type": metadataArrayLength(
      metadata["tokenizer.ggml.token_type"],
    ),
    "tokenizer.ggml.merges": metadataArrayLength(
      metadata["tokenizer.ggml.merges"],
    ),
  };
  return {
    architecture: metadata["general.architecture"] ?? null,
    name: metadata["general.name"] ?? null,
    tokenizerModel: metadata["tokenizer.ggml.model"] ?? null,
    tokenizerPre: metadata["tokenizer.ggml.pre"] ?? null,
    tokensLength: metadataArrayLength(metadata["tokenizer.ggml.tokens"]),
    tokenTypeLength: metadataArrayLength(metadata["tokenizer.ggml.token_type"]),
    mergesLength: metadataArrayLength(metadata["tokenizer.ggml.merges"]),
    eosTokenId: metadata["tokenizer.ggml.eos_token_id"] ?? null,
    bosTokenId: metadata["tokenizer.ggml.bos_token_id"] ?? null,
    paddingTokenId: metadata["tokenizer.ggml.padding_token_id"] ?? null,
    addBosToken: metadata["tokenizer.ggml.add_bos_token"] ?? null,
    addEosToken: metadata["tokenizer.ggml.add_eos_token"] ?? null,
    hashes: {
      model: hashes["tokenizer.ggml.model"] ?? null,
      pre: hashes["tokenizer.ggml.pre"] ?? null,
      tokens: hashes["tokenizer.ggml.tokens"] ?? null,
      tokenType: hashes["tokenizer.ggml.token_type"] ?? null,
      merges: hashes["tokenizer.ggml.merges"] ?? null,
      eosTokenId: hashes["tokenizer.ggml.eos_token_id"] ?? null,
      bosTokenId: hashes["tokenizer.ggml.bos_token_id"] ?? null,
      paddingTokenId: hashes["tokenizer.ggml.padding_token_id"] ?? null,
      addBosToken: hashes["tokenizer.ggml.add_bos_token"] ?? null,
      addEosToken: hashes["tokenizer.ggml.add_eos_token"] ?? null,
    },
    hashByKey,
    valueByKey,
    lengthByKey,
  };
}

function tokenizerBlockingReason(mismatch) {
  const missingSides = [];
  if (mismatch.targetHash === null) missingSides.push("target");
  if (mismatch.drafterHash === null) missingSides.push("drafter");
  if (missingSides.length > 0) {
    return mismatch.required
      ? `${mismatch.key} missing from ${missingSides.join(" and ")}`
      : `${mismatch.key} present on only one side`;
  }
  if (mismatch.targetLength !== null || mismatch.drafterLength !== null) {
    if (mismatch.targetLength !== mismatch.drafterLength) {
      return (
        `${mismatch.key} array length mismatch: ` +
        `target=${mismatch.targetLength}, drafter=${mismatch.drafterLength}`
      );
    }
    return `${mismatch.key} payload hash mismatch (length=${mismatch.targetLength})`;
  }
  if (
    Object.hasOwn(mismatch, "targetValue") ||
    Object.hasOwn(mismatch, "drafterValue")
  ) {
    return (
      `${mismatch.key} value mismatch: ` +
      `target=${JSON.stringify(mismatch.targetValue)}, ` +
      `drafter=${JSON.stringify(mismatch.drafterValue)}`
    );
  }
  return `${mismatch.key} payload hash mismatch`;
}

function tokenizerCompatibilityFailure(compatibility) {
  if (!compatibility || compatibility.compatible) return null;
  const reasons = compatibility.blockingReasons?.length
    ? compatibility.blockingReasons
    : compatibility.mismatches?.map((mismatch) => mismatch.key) ?? [];
  return (
    "target/drafter tokenizer metadata mismatch: " +
    reasons.join("; ") +
    "; speculative drafting must fail closed until a drafter distilled against this exact target tokenizer is provided"
  );
}

function normalizeSha256(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
}

function compareTargetCheckpointSha256(recorded, actual) {
  const recordedSha256 = normalizeSha256(recorded);
  const actualSha256 = normalizeSha256(actual);
  if (!recordedSha256) {
    return {
      compatible: false,
      recordedSha256: recorded ?? null,
      actualSha256: actualSha256 ?? actual ?? null,
      blockingReason:
        "drafter GGUF is missing dflash-draft.target_checkpoint_sha256; release validation cannot prove it was distilled against this text checkpoint",
    };
  }
  if (!actualSha256) {
    return {
      compatible: false,
      recordedSha256,
      actualSha256: actual ?? null,
      blockingReason:
        "target GGUF sha256 is unavailable; release validation cannot prove the drafter matches this text checkpoint",
    };
  }
  if (recordedSha256 !== actualSha256) {
    return {
      compatible: false,
      recordedSha256,
      actualSha256,
      blockingReason:
        "drafter GGUF target checkpoint sha256 mismatch: " +
        `recorded=${recordedSha256}, target=${actualSha256}; ` +
        "release validation must fail closed until a drafter distilled against this exact text checkpoint is provided",
    };
  }
  return {
    compatible: true,
    recordedSha256,
    actualSha256,
    blockingReason: null,
    reason: `target checkpoint sha256 ok (${actualSha256})`,
  };
}

function releaseCompatibilityFailure(...failures) {
  const reasons = failures.filter(Boolean);
  return reasons.length > 0 ? reasons.join("; ") : null;
}

function compareTokenizers(target, drafter) {
  const mismatches = [];
  for (const key of TOKENIZER_COMPATIBILITY_KEYS) {
    const targetHash = target.hashByKey?.[key] ?? null;
    const drafterHash = drafter.hashByKey?.[key] ?? null;
    const required = REQUIRED_TOKENIZER_COMPATIBILITY_KEYS.has(key);
    const requiredMissing =
      required && (targetHash === null || drafterHash === null);
    if (targetHash === drafterHash && !requiredMissing) continue;
    const mismatch = {
      key,
      targetHash,
      drafterHash,
      targetLength: target.lengthByKey?.[key] ?? null,
      drafterLength: drafter.lengthByKey?.[key] ?? null,
      targetValue: target.valueByKey?.[key] ?? null,
      drafterValue: drafter.valueByKey?.[key] ?? null,
      required,
    };
    mismatch.blockingReason = tokenizerBlockingReason(mismatch);
    mismatches.push(mismatch);
  }
  const requiredMissing = mismatches.filter(
    (mismatch) =>
      mismatch.required &&
      (mismatch.targetHash === null || mismatch.drafterHash === null),
  );
  const blockingReasons = mismatches.map(
    (mismatch) => mismatch.blockingReason,
  );
  return {
    compatible: mismatches.length === 0,
    reason:
      mismatches.length === 0
        ? "target and drafter tokenizer metadata are byte-compatible"
        : tokenizerCompatibilityFailure({
            compatible: false,
            mismatches,
            blockingReasons,
          }),
    mismatches,
    requiredMissing,
    blockingReasons,
  };
}

function readTargetMeta(targetModel, drafterModel) {
  const candidates = [
    path.join(path.dirname(drafterModel), "target-meta.json"),
    path.join(
      path.dirname(path.dirname(targetModel)),
      "dflash",
      "target-meta.json",
    ),
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) return { file: null, status: "missing", data: null };
  try {
    return {
      file,
      status: "loaded",
      data: JSON.parse(fs.readFileSync(file, "utf8")),
    };
  } catch (error) {
    return {
      file,
      status: "invalid_json",
      error: error.message,
      data: null,
    };
  }
}

function buildRuntimeArgs(targetModel, drafterModel, options) {
  const skippedCliFlags = [];
  const features = options.cliFeatures;
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
    "-ngl",
    options.ngl,
    "-ngld",
    options.ngld,
  ];
  pushDraftContextFlag(args, skippedCliFlags, features, "128");
  if (options.deviceNone) {
    pushOptionalFlag(args, skippedCliFlags, features, "--device", "none");
    pushOptionalFlag(
      args,
      skippedCliFlags,
      features,
      "--device-draft",
      "none",
    );
  }
  pushDraftMinFlag(args, skippedCliFlags, features, "1");
  pushDraftMaxFlag(args, skippedCliFlags, features, "1");
  pushDraftProbabilityFlag(args, skippedCliFlags, features, "0.1");
  if (options.specType) {
    pushOptionalFlag(
      args,
      skippedCliFlags,
      features,
      "--spec-type",
      options.specType,
    );
  }
  if (options.temperature) {
    pushOptionalFlag(
      args,
      skippedCliFlags,
      features,
      "--temp",
      options.temperature,
    );
  }
  if (options.treeBudget) {
    pushOptionalFlag(
      args,
      skippedCliFlags,
      features,
      "--tree-budget",
      options.treeBudget,
    );
  }
  return { args, skippedCliFlags };
}

function classifyRuntimeOutput(text) {
  if (/draft model vocab type must match target model/i.test(text)) {
    return "target_draft_vocab_type_mismatch";
  }
  if (/draft model bos tokens must match target model/i.test(text)) {
    return "target_draft_bos_mismatch";
  }
  if (/draft model eos tokens must match target model/i.test(text)) {
    return "target_draft_eos_mismatch";
  }
  if (/target vocab size .* does not match draft vocab size/i.test(text)) {
    return "target_draft_vocab_size_mismatch";
  }
  if (/token \d+ content differs/i.test(text)) {
    return "target_draft_token_content_mismatch";
  }
  if (/target and draft vocabs are not compatible/i.test(text)) {
    return "target_draft_vocab_incompatible";
  }
  if (/requires (?:DFlash )?hidden-state capture/i.test(text)) {
    return "dflash_hidden_capture_required";
  }
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
  const { args, skippedCliFlags } = buildRuntimeArgs(
    targetModel,
    drafterModel,
    options,
  );
  if (!fs.existsSync(binary)) {
    return {
      label,
      binary,
      args,
      skippedCliFlags,
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
  const dflash = parseBenchOutput(output);
  const requiresTrueDrafting = Boolean(options.requiresTrueDflashDrafting);
  const hasDflashCounters = dflash.drafted !== null || dflash.accepted !== null;
  const vocabIncompatible =
    dflash.vocabIncompatibleWarning ||
    options.tokenizerCompatibility?.compatible === false;
  let classification =
    result.status === 0
      ? "generation_attempt_completed"
      : classifyRuntimeOutput(output);
  let dflashFailure = null;
  if (
    result.status !== 0 &&
    classification.startsWith("target_draft_")
  ) {
    dflashFailure =
      tokenizerCompatibilityFailure(options.tokenizerCompatibility) ??
      `runtime rejected target/draft tokenizer compatibility (${classification})`;
  }
  if (result.status === 0 && requiresTrueDrafting) {
    if (vocabIncompatible && (dflash.drafted ?? 0) === 0) {
      classification = "dflash_vocab_incompatible_no_drafts";
      dflashFailure =
        tokenizerCompatibilityFailure(options.tokenizerCompatibility) ??
        "target and DFlash drafter tokenizers are incompatible; runtime translated tokens but produced zero drafted tokens";
    } else if (!hasDflashCounters) {
      classification = "dflash_counters_missing";
      dflashFailure =
        "true DFlash runtime exited 0 but did not print n_drafted/n_accept counters";
    } else if ((dflash.drafted ?? 0) === 0 && (dflash.accepted ?? 0) === 0) {
      classification = "dflash_no_drafts";
      dflashFailure =
        "true DFlash runtime exited 0 but generated zero drafted and accepted tokens";
    }
  }
  return {
    label,
    binary,
    args,
    skippedCliFlags,
    status: result.status,
    signal: result.signal,
    classification,
    dflash: {
      ...dflash,
      requiresTrueDrafting,
      tokenizerCompatible: options.tokenizerCompatibility?.compatible ?? null,
      draftingActive: (dflash.drafted ?? 0) > 0,
    },
    dflashFailure,
    outputTail: lines.slice(-120).join("\n"),
  };
}

function blockedRuntime(
  label,
  binary,
  targetModel,
  drafterModel,
  options,
  reason,
) {
  const { args, skippedCliFlags } = buildRuntimeArgs(
    targetModel,
    drafterModel,
    options,
  );
  return {
    label,
    binary,
    args,
    skippedCliFlags,
    status: null,
    signal: null,
    classification: "blocked_by_tokenizer_metadata_mismatch",
    dflash: {
      drafted: null,
      accepted: null,
      acceptanceRate: null,
      requiresTrueDrafting: Boolean(options.requiresTrueDflashDrafting),
      tokenizerCompatible: false,
      draftingActive: false,
    },
    dflashFailure: reason,
    outputTail: "",
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
  const tokenLine = (re) => {
    const m = text.match(re);
    return m
      ? {
          tokens: Number(m[1]),
          seconds: Number(m[2]),
          tokensPerSecond: Number(m[3]),
        }
      : null;
  };
  const timingLine = (prefix, label) => {
    const re = new RegExp(
      `${prefix}:\\s+${label} time =\\s*([\\d.]+) ms /\\s*(\\d+) (?:tokens|runs).*?([\\d.]+|inf) tokens per second`,
      "i",
    );
    const m = text.match(re);
    if (!m) return null;
    return {
      milliseconds: Number(m[1]),
      tokens: Number(m[2]),
      tokensPerSecond: m[3] === "inf" ? Infinity : Number(m[3]),
    };
  };
  const drafted = num(/n_drafted\s*[:=]\s*(\d+)/i);
  const accepted =
    num(/n_drafted_accepted\s*[:=]\s*(\d+)/i) ??
    num(/n_accept(?:ed)?\s*[:=]\s*(\d+)/i);
  const encoded = tokenLine(
    /encoded\s+(\d+)\s+tokens\s+in\s+([\d.]+)\s+seconds,\s+speed:\s+([\d.]+)\s+t\/s/i,
  );
  const decoded = tokenLine(
    /decoded\s+(\d+)\s+tokens\s+in\s+([\d.]+)\s+seconds,\s+speed:\s+([\d.]+)\s+t\/s/i,
  );
  const commonPromptEval = timingLine("common_perf_print", "prompt eval");
  const commonEval = timingLine("common_perf_print", "eval");
  const draftPromptEval = timingLine("llama_perf_context_print", "prompt eval");
  const draftEval = timingLine("llama_perf_context_print", "eval");
  // Prefer the wall-clock decoded line for generation speed. llama.cpp's
  // per-context eval timing excludes speculative overhead and can otherwise
  // overstate end-to-end tok/s when DFlash is not actually drafting.
  const tokPerSec =
    decoded?.tokensPerSecond ??
    num(/eval time\s*=.*?,\s*([\d.]+)\s*tokens per second/i) ??
    num(/decode:.*?,\s*([\d.]+)\s*t\/s/i) ??
    num(/([\d.]+)\s*tokens? per second/i);
  return {
    drafted,
    accepted,
    acceptanceRate:
      drafted && drafted > 0 && accepted != null ? accepted / drafted : null,
    tokensPerSecond: tokPerSec,
    generation: {
      encoded,
      decoded,
      tokensPerSecond: decoded?.tokensPerSecond ?? null,
    },
    timings: {
      targetPromptEval: commonPromptEval,
      targetEval: commonEval,
      draftPromptEval,
      draftEval,
    },
    vocabIncompatibleWarning:
      /target and draft vocabs are not compatible/i.test(text),
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
  const skippedCliFlags = [];
  if (!binary || !fs.existsSync(binary)) {
    return { available: false, binary, withDrafter };
  }
  if (!fs.existsSync(targetModel) || !fs.existsSync(drafterModel)) {
    return {
      available: false,
      binary,
      withDrafter,
      skippedCliFlags,
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
    "-ngl",
    options.ngl,
    "-ngld",
    options.ngld,
  ];
  pushDraftContextFlag(args, skippedCliFlags, options.cliFeatures, "2048");
  pushDraftMinFlag(
    args,
    skippedCliFlags,
    options.cliFeatures,
    withDrafter ? "2" : "0",
  );
  pushDraftMaxFlag(
    args,
    skippedCliFlags,
    options.cliFeatures,
    withDrafter ? "6" : "0",
  );
  if (options.deviceNone) {
    pushOptionalFlag(
      args,
      skippedCliFlags,
      options.cliFeatures,
      "--device",
      "none",
    );
    pushOptionalFlag(
      args,
      skippedCliFlags,
      options.cliFeatures,
      "--device-draft",
      "none",
    );
  }
  if (options.specType) {
    pushOptionalFlag(
      args,
      skippedCliFlags,
      options.cliFeatures,
      "--spec-type",
      options.specType,
    );
  }
  if (options.temperature) {
    pushOptionalFlag(
      args,
      skippedCliFlags,
      options.cliFeatures,
      "--temp",
      options.temperature,
    );
  }
  const started = Date.now();
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    env: { ...process.env },
    maxBuffer: 32 * 1024 * 1024,
  });
  const wallMs = Date.now() - started;
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const parsed = parseBenchOutput(output);
  const draftingActive = (parsed.drafted ?? 0) > 0;
  const dflashFailure =
    withDrafter &&
    !draftingActive &&
    (parsed.vocabIncompatibleWarning ||
      options.tokenizerCompatibility?.compatible === false)
      ? tokenizerCompatibilityFailure(options.tokenizerCompatibility) ??
        "target and DFlash drafter tokenizers are incompatible; runtime produced zero drafted tokens"
      : withDrafter && !draftingActive
        ? "runtime produced zero drafted tokens"
        : null;
  return {
    available: true,
    binary,
    withDrafter,
    args,
    skippedCliFlags,
    status: result.status,
    wallMs,
    tokensRequested: Number(n),
    ...parsed,
    draftingActive,
    dflashFailure,
    tokenizerCompatible: options.tokenizerCompatibility?.compatible ?? null,
    outputTail: output.trim().split(/\r?\n/).slice(-40).join("\n"),
  };
}

function blockedBenchPass(binary, options, withDrafter, reason) {
  return {
    available: true,
    binary,
    withDrafter,
    skippedReason: reason,
    status: null,
    wallMs: 0,
    tokensRequested: options.benchTokens > 0 ? options.benchTokens : 128,
    drafted: null,
    accepted: null,
    acceptanceRate: null,
    tokensPerSecond: null,
    generation: {
      encoded: null,
      decoded: null,
      tokensPerSecond: null,
    },
    timings: {
      targetPromptEval: null,
      targetEval: null,
      draftPromptEval: null,
      draftEval: null,
    },
    vocabIncompatibleWarning: false,
    draftingActive: false,
    dflashFailure: withDrafter ? reason : null,
    tokenizerCompatible: false,
    outputTail: "",
  };
}

/**
 * Bench DFlash speedup: run the spec binary with and without the drafter,
 * compute the tok/s ratio + acceptance rate, and write a report JSON.
 * Coordinates its shape with W11 (eliza1_gates.yaml + manifest evals).
 */
function runDflashBench(args) {
  const compatibilityFailure =
    args.releaseCompatibilityFailure ??
    tokenizerCompatibilityFailure(args.tokenizerCompatibility);
  if (compatibilityFailure) {
    const withDrafter = blockedBenchPass(
      args.specBinary,
      args,
      true,
      compatibilityFailure,
    );
    const withoutDrafter = blockedBenchPass(
      args.specBinary,
      args,
      false,
      "baseline not run because DFlash drafter metadata failed release compatibility",
    );
    const report = buildSpeculativeBenchmarkReport({
      speculator: "dflash",
      verifier: path.relative(process.cwd(), __filename),
      tier: args.tier,
      targetModel: args.targetModel,
      drafterModel: args.drafterModel,
      specBinary: args.specBinary,
      benchTokens: args.benchTokens,
      withDrafter,
      withoutDrafter,
      speedup: null,
      acceptanceRate: null,
      status: "fail",
      failure: compatibilityFailure,
      extra: {
        draftingActive: false,
        dflashFailure: compatibilityFailure,
        summary: {
          speculator: "dflash",
          tier: args.tier,
          backend: undefined,
          binarySha256: undefined,
          drafted: null,
          accepted: null,
          acceptanceRate: null,
          speedup: null,
          status: "fail",
          failure: compatibilityFailure,
          tokenizerCompatible: false,
        },
      },
    });
    report.summary.backend = report.backend;
    report.summary.binarySha256 = report.binary.sha256;
    writeSpeculativeBenchmarkReport(args.benchReport, report, {
      verifyDir: __dirname,
    });
    console.log(`wrote ${args.benchReport}`);
    console.log(`wrote ${latestSpeculativeReportPath(__dirname, "dflash")}`);
    console.log(`dflash-bench: ${compatibilityFailure}`);
    return report;
  }

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
  const legacySummary = {
    tokensPerSecondWithDrafter: withDrafter.tokensPerSecond ?? null,
    tokensPerSecondBaseline: withoutDrafter.tokensPerSecond ?? null,
    generationTokensPerSecondWithDrafter:
      withDrafter.generation?.tokensPerSecond ?? null,
    generationTokensPerSecondBaseline:
      withoutDrafter.generation?.tokensPerSecond ?? null,
    targetEvalTokensPerSecondWithDrafter:
      withDrafter.timings?.targetEval?.tokensPerSecond ?? null,
    draftEvalTokensPerSecondWithDrafter:
      withDrafter.timings?.draftEval?.tokensPerSecond ?? null,
    dflashDraftedTokens: withDrafter.drafted ?? null,
    dflashAcceptedTokens: withDrafter.accepted ?? null,
    dflashAcceptanceRate: withDrafter.acceptanceRate ?? null,
    dflashSpeedup: speedup,
    dflashDraftingActive: withDrafter.draftingActive ?? false,
    dflashFailure: withDrafter.dflashFailure ?? null,
    tokenizerCompatible: withDrafter.tokenizerCompatible ?? null,
  };
  const report = buildSpeculativeBenchmarkReport({
    speculator: "dflash",
    verifier: path.relative(process.cwd(), __filename),
    tier: args.tier,
    targetModel: args.targetModel,
    drafterModel: args.drafterModel,
    specBinary: args.specBinary,
    benchTokens: args.benchTokens,
    withDrafter,
    withoutDrafter,
    speedup,
    acceptanceRate: withDrafter.acceptanceRate ?? null,
    status:
      withDrafter.available && withoutDrafter.available
        ? withDrafter.dflashFailure
          ? "fail"
          : "pass"
        : "needs-data",
    failure: withDrafter.dflashFailure ?? null,
    extra: {
      draftingActive: withDrafter.draftingActive ?? false,
      dflashFailure: withDrafter.dflashFailure ?? null,
      summary: {
        ...legacySummary,
        speculator: "dflash",
        tier: args.tier,
        backend: undefined,
        binarySha256: undefined,
        drafted: withDrafter.drafted ?? null,
        accepted: withDrafter.accepted ?? null,
        acceptanceRate: withDrafter.acceptanceRate ?? null,
        speedup,
        status:
          withDrafter.available && withoutDrafter.available
            ? withDrafter.dflashFailure
              ? "fail"
              : "pass"
            : "needs-data",
        failure: withDrafter.dflashFailure ?? null,
      },
    },
  });
  report.summary.backend = report.backend;
  report.summary.binarySha256 = report.binary.sha256;
  writeSpeculativeBenchmarkReport(args.benchReport, report, {
    verifyDir: __dirname,
  });
  console.log(`wrote ${args.benchReport}`);
  // Also write/overwrite the stable per-speculator latest report so
  // `eliza1_gates_collect.mjs` and the manifest evals writer have a fixed
  // path to read. Null fields are kept as-is: a needs-hardware bench produces
  // a latest entry that says so.
  console.log(`wrote ${latestSpeculativeReportPath(__dirname, "dflash")}`);
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

function makeTokenizerSelfTestSummary(overrides = {}) {
  const hashByKey = Object.fromEntries(
    TOKENIZER_COMPATIBILITY_KEYS.map((key) => [key, `hash:${key}`]),
  );
  const valueByKey = {
    "tokenizer.ggml.model": "gpt2",
    "tokenizer.ggml.pre": "qwen35",
    "tokenizer.ggml.eos_token_id": 248046,
    "tokenizer.ggml.bos_token_id": null,
    "tokenizer.ggml.padding_token_id": 248044,
    "tokenizer.ggml.add_bos_token": false,
    "tokenizer.ggml.add_eos_token": null,
  };
  const lengthByKey = {
    "tokenizer.ggml.tokens": 248320,
    "tokenizer.ggml.token_type": 248320,
    "tokenizer.ggml.merges": 247587,
  };
  return {
    hashByKey: { ...hashByKey, ...(overrides.hashByKey ?? {}) },
    valueByKey: { ...valueByKey, ...(overrides.valueByKey ?? {}) },
    lengthByKey: { ...lengthByKey, ...(overrides.lengthByKey ?? {}) },
  };
}

function runSelfTest() {
  assert.equal(DFLASH_TIERS.has("0_8b"), false);
  for (const tier of ["2b", "4b", "9b", "27b", "27b-256k"]) {
    assert.equal(DFLASH_TIERS.has(tier), true);
  }

  assert.equal(
    compareTokenizers(
      makeTokenizerSelfTestSummary(),
      makeTokenizerSelfTestSummary(),
    ).compatible,
    true,
  );

  const tokenTypeMismatch = compareTokenizers(
    makeTokenizerSelfTestSummary({
      hashByKey: { "tokenizer.ggml.token_type": "target-token-type" },
    }),
    makeTokenizerSelfTestSummary({
      hashByKey: { "tokenizer.ggml.token_type": "draft-token-type" },
    }),
  );
  assert.equal(tokenTypeMismatch.compatible, false);
  assert.deepEqual(
    tokenTypeMismatch.mismatches.map((mismatch) => mismatch.key),
    ["tokenizer.ggml.token_type"],
  );
  assert.match(
    tokenTypeMismatch.blockingReasons[0],
    /tokenizer\.ggml\.token_type payload hash mismatch/,
  );

  const specialIdMismatch = compareTokenizers(
    makeTokenizerSelfTestSummary({
      hashByKey: { "tokenizer.ggml.padding_token_id": "target-padding" },
      valueByKey: { "tokenizer.ggml.padding_token_id": 248055 },
    }),
    makeTokenizerSelfTestSummary({
      hashByKey: { "tokenizer.ggml.padding_token_id": "draft-padding" },
      valueByKey: { "tokenizer.ggml.padding_token_id": 248044 },
    }),
  );
  assert.equal(specialIdMismatch.compatible, false);
  assert.equal(
    specialIdMismatch.blockingReasons[0],
    "tokenizer.ggml.padding_token_id value mismatch: target=248055, drafter=248044",
  );

  const missingRequired = compareTokenizers(
    makeTokenizerSelfTestSummary({
      hashByKey: { "tokenizer.ggml.merges": null },
    }),
    makeTokenizerSelfTestSummary({
      hashByKey: { "tokenizer.ggml.merges": null },
    }),
  );
  assert.equal(missingRequired.compatible, false);
  assert.equal(missingRequired.requiredMissing.length, 1);
  assert.match(
    tokenizerCompatibilityFailure(missingRequired),
    /tokenizer\.ggml\.merges missing from target and drafter/,
  );

  const targetSha = "a".repeat(64);
  assert.equal(
    compareTargetCheckpointSha256(targetSha, targetSha).compatible,
    true,
  );
  const checkpointMismatch = compareTargetCheckpointSha256(
    "b".repeat(64),
    targetSha,
  );
  assert.equal(checkpointMismatch.compatible, false);
  assert.match(
    checkpointMismatch.blockingReason,
    /drafter GGUF target checkpoint sha256 mismatch/,
  );
  assert.match(checkpointMismatch.blockingReason, /recorded=bbbb/);
  const missingCheckpoint = compareTargetCheckpointSha256(null, targetSha);
  assert.equal(missingCheckpoint.compatible, false);
  assert.match(
    missingCheckpoint.blockingReason,
    /missing dflash-draft\.target_checkpoint_sha256/,
  );
  assert.match(
    releaseCompatibilityFailure(
      tokenizerCompatibilityFailure(missingRequired),
      checkpointMismatch.blockingReason,
    ),
    /target\/drafter tokenizer metadata mismatch: .*sha256 mismatch/,
  );

  assert.equal(
    classifyRuntimeOutput(
      "draft model bos tokens must match target model to use speculation",
    ),
    "target_draft_bos_mismatch",
  );
  assert.equal(
    classifyRuntimeOutput("token 248044 content differs - target '<pad>'"),
    "target_draft_token_content_mismatch",
  );

  console.log("dflash_drafter_runtime_smoke self-test: pass");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    runSelfTest();
    return;
  }
  const installedCliFeatures = detectCliFeatures(args.specBinary);
  const referenceCliFeatures = args.referenceBinary
    ? detectCliFeatures(args.referenceBinary, args.referenceLibraryPath)
    : null;
  const report = {
    generatedAt: new Date().toISOString(),
    verifier: path.relative(process.cwd(), __filename),
    targetModel: args.targetModel,
    drafterModel: args.drafterModel,
    cliFeatures: {
      installed: serializeCliFeatures(installedCliFeatures),
      reference: serializeCliFeatures(referenceCliFeatures),
    },
    checks: {},
    metadata: null,
    runtime: [],
  };

  if (!DFLASH_TIERS.has(args.tier)) {
    report.status = "not-applicable";
    report.reason = `tier ${args.tier} does not ship a DFlash drafter`;
    report.checks = {
      tierShipsDflash: false,
      drafterRequired: false,
    };
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${args.report}`);
    console.log(`metadataStatus=not-applicable (${report.reason})`);
    return;
  }

  if (!fs.existsSync(args.drafterModel)) {
    report.status = "needs-data";
    report.reason = `tier ${args.tier} requires DFlash but drafter model is missing: ${args.drafterModel}`;
    report.checks = {
      tierShipsDflash: true,
      drafterPresent: false,
    };
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${args.report}`);
    console.log(`metadataStatus=needs-data (${report.reason})`);
    process.exit(1);
  }

  const parsedTarget = parseGguf(args.targetModel);
  const parsed = parseGguf(args.drafterModel);
  const metadata = parsed.metadata;
  const targetMetadata = parsedTarget.metadata;
  const targetModelSha256 = sha256File(args.targetModel);
  const tensorNames = new Set(parsed.tensorNames);
  const hasTokenizerMerges = Object.hasOwn(metadata, "tokenizer.ggml.merges");
  const tokenizerModel = metadata["tokenizer.ggml.model"];
  const architecture = metadata["general.architecture"];
  const targetMeta = readTargetMeta(args.targetModel, args.drafterModel);
  const targetTokenizer = tokenizerSummary(parsedTarget);
  const drafterTokenizer = tokenizerSummary(parsed);
  const tokenizerCompatibility = compareTokenizers(
    targetTokenizer,
    drafterTokenizer,
  );
  const tokenizerFailure = tokenizerCompatibilityFailure(
    tokenizerCompatibility,
  );

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
  const targetCheckpointCompatibility = compareTargetCheckpointSha256(
    targetCheckpointSha256,
    targetModelSha256,
  );
  const targetCheckpointFailure = targetCheckpointCompatibility.compatible
    ? null
    : targetCheckpointCompatibility.blockingReason;
  const metadataCompatibilityFailure = releaseCompatibilityFailure(
    tokenizerFailure,
    targetCheckpointFailure,
  );

  report.metadata = {
    target: {
      version: parsedTarget.version,
      tensorCount: parsedTarget.tensorCount,
      kvCount: parsedTarget.kvCount,
      architecture: targetMetadata["general.architecture"],
      name: targetMetadata["general.name"],
      sha256: targetModelSha256,
    },
    version: parsed.version,
    tensorCount: parsed.tensorCount,
    kvCount: parsed.kvCount,
    architecture,
    drafterShape: isUpstreamDflashArch ? "upstream-dflash-draft" : "plain-ar",
    tokenizerModel,
    tokenizerPre: metadata["tokenizer.ggml.pre"],
    hasTokenizerMerges,
    targetCheckpointSha256,
    targetCheckpointCompatibility,
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
    tokenizerCompatibility,
    tokenizers: {
      target: targetTokenizer,
      drafter: drafterTokenizer,
    },
    targetMeta,
  };

  const upstreamShapeOk =
    isUpstreamDflashArch &&
    upstreamRequiredTensors.every((name) => tensorNames.has(name)) &&
    upstreamRequiredMetadata.every((key) => Object.hasOwn(metadata, key));
  const plainArShapeOk =
    !isUpstreamDflashArch &&
    typeof architecture === "string" &&
    architecture.length > 0 &&
    (tensorNames.has("token_embd.weight") ||
      (tensorNames.has("blk.0.attn_q.weight") &&
        tensorNames.has("blk.0.attn_k.weight")));
  const requiresTrueDflashDrafting = upstreamShapeOk;
  report.runtimePolicy = {
    requiresTrueDflashDrafting,
    reason: requiresTrueDflashDrafting
      ? "upstream dflash-draft drafter"
      : "plain autoregressive drafter smoke",
  };

  report.checks = {
    drafterShape: report.metadata.drafterShape,
    upstreamDflashShapeOk: upstreamShapeOk,
    plainArShapeOk,
    drafterSmallerThanTarget: parsed.sizeBytes < parsedTarget.sizeBytes,
    hasTargetCheckpointSha256: targetCheckpointSha256 !== null,
    targetCheckpointMatchesTarget: targetCheckpointCompatibility.compatible,
    targetCheckpointFailure,
    targetDrafterTokenizerCompatible: tokenizerCompatibility.compatible,
    targetDrafterTokenizerFailure: tokenizerFailure,
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
  if (!report.checks.drafterSmallerThanTarget) {
    failedMetadata.push(
      `DFlash drafter is not smaller than the target (drafter=${parsed.sizeBytes} bytes, target=${parsedTarget.sizeBytes} bytes)`,
    );
  }
  if (!targetCheckpointCompatibility.compatible) {
    failedMetadata.push(targetCheckpointCompatibility.blockingReason);
  }
  if (targetMeta.status === "loaded") {
    const matchesTarget =
      targetMeta.data?.drafter?.matchesTargetCheckpoint === true;
    if (!matchesTarget) {
      failedMetadata.push(
        "dflash/target-meta.json does not prove drafter.matchesTargetCheckpoint=true",
      );
    }
  }
  if (!tokenizerCompatibility.compatible) {
    for (const reason of tokenizerCompatibility.blockingReasons) {
      failedMetadata.push(
        `target/drafter tokenizer metadata mismatch: ${reason}; speculative drafting must fail closed until a drafter distilled against this exact target tokenizer is provided`,
      );
    }
  }
  report.metadataStatus =
    failedMetadata.length === 0 ? "metadata_loadable" : "metadata_invalid";
  report.metadataFailures = failedMetadata;

  if (!args.metadataOnly) {
    if (!args.skipInstalled) {
      report.runtime.push(
        metadataCompatibilityFailure
          ? blockedRuntime(
              "installed",
              args.specBinary,
              args.targetModel,
              args.drafterModel,
              {
                ...args,
                cliFeatures: installedCliFeatures,
                requiresTrueDflashDrafting,
                tokenizerCompatibility,
              },
              metadataCompatibilityFailure,
            )
          : runRuntime(
              "installed",
              args.specBinary,
              "",
              args.targetModel,
              args.drafterModel,
              {
                ...args,
                cliFeatures: installedCliFeatures,
                requiresTrueDflashDrafting,
                tokenizerCompatibility,
              },
            ),
      );
    }
    if (args.referenceBinary) {
      report.runtime.push(
        metadataCompatibilityFailure
          ? blockedRuntime(
              "reference",
              args.referenceBinary,
              args.targetModel,
              args.drafterModel,
              {
                ...args,
                cliFeatures: referenceCliFeatures,
                requiresTrueDflashDrafting,
                tokenizerCompatibility,
              },
              metadataCompatibilityFailure,
            )
          : runRuntime(
              "reference",
              args.referenceBinary,
              args.referenceLibraryPath,
              args.targetModel,
              args.drafterModel,
              {
                ...args,
                cliFeatures: referenceCliFeatures,
                requiresTrueDflashDrafting,
                tokenizerCompatibility,
              },
            ),
      );
    }
  }

  if (args.bench) {
    report.bench = runDflashBench({
      ...args,
      cliFeatures: installedCliFeatures,
      tokenizerCompatibility,
      releaseCompatibilityFailure: metadataCompatibilityFailure,
    });
  }

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${args.report}`);
  console.log(`metadataStatus=${report.metadataStatus}`);
  for (const run of report.runtime.filter(Boolean)) {
    const drafted = run.dflash?.drafted ?? "n/a";
    const accepted = run.dflash?.accepted ?? "n/a";
    console.log(
      `${run.label}: status=${run.status} classification=${run.classification} drafted=${drafted} accepted=${accepted}`,
    );
    if (run.dflashFailure) {
      console.log(`${run.label}: dflashFailure=${run.dflashFailure}`);
    }
  }

  const runtimeFailed = report.runtime
    .filter(Boolean)
    .some((run) => run.status !== 0 || run.dflashFailure);
  if (failedMetadata.length > 0 || runtimeFailed) {
    process.exit(1);
  }
}

main();
