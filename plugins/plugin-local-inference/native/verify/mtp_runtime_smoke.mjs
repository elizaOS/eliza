#!/usr/bin/env node
import { spawnSync } from "node:child_process";
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

const DEFAULT_BIN = path.join(
  process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza"),
  "local-inference",
  "bin",
  "dflash",
  process.platform === "darwin" ? "darwin-arm64-metal" : "linux-x64-cuda",
  "llama-cli",
);

function parseArgs(argv) {
  const args = {
    targetModel: process.env.ELIZA_MTP_TARGET_MODEL || "",
    specBinary: process.env.ELIZA_MTP_SPEC_BINARY || DEFAULT_BIN,
    tier: process.env.ELIZA_MTP_TIER || "",
    report:
      process.env.ELIZA_MTP_REPORT ||
      path.join(__dirname, "hardware-results", `mtp-runtime-${timestamp()}.json`),
    bench: process.env.ELIZA_MTP_BENCH === "1",
    metadataOnly: false,
    ngl: process.env.ELIZA_MTP_NGL || "0",
    benchTokens: Number.parseInt(process.env.ELIZA_MTP_BENCH_TOKENS || "128", 10),
    benchContext: Number.parseInt(process.env.ELIZA_MTP_BENCH_CONTEXT || "2048", 10),
    benchPrompt:
      process.env.ELIZA_MTP_BENCH_PROMPT ||
      "Write a short paragraph about speculative decoding.",
    benchDraftMax: process.env.ELIZA_MTP_BENCH_DRAFT_MAX || "2",
    benchTimeoutMs: Number.parseInt(
      process.env.ELIZA_MTP_BENCH_TIMEOUT_MS || "600000",
      10,
    ),
    benchReport:
      process.env.ELIZA_MTP_BENCH_REPORT ||
      timestampedSpeculativeReportPath(__dirname, "mtp"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--target-model") args.targetModel = next();
    else if (arg === "--spec-binary") args.specBinary = next();
    else if (arg === "--tier") args.tier = next();
    else if (arg === "--report") args.report = next();
    else if (arg === "--metadata-only") args.metadataOnly = true;
    else if (arg === "--bench") args.bench = true;
    else if (arg === "--ngl") args.ngl = next();
    else if (arg === "--bench-tokens") args.benchTokens = Number.parseInt(next(), 10);
    else if (arg === "--bench-context") args.benchContext = Number.parseInt(next(), 10);
    else if (arg === "--bench-prompt") args.benchPrompt = next();
    else if (arg === "--bench-draft-n-max") args.benchDraftMax = next();
    else if (arg === "--bench-timeout-ms")
      args.benchTimeoutMs = Number.parseInt(next(), 10);
    else if (arg === "--bench-report") args.benchReport = next();
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node plugins/plugin-local-inference/native/verify/mtp_runtime_smoke.mjs [options]",
          "",
          "Options:",
          "  --target-model <path>       Target GGUF with built-in MTP/NextN heads",
          "  --spec-binary <path>        llama-cli/llama-server binary with draft-mtp support",
          "  --tier <tier>               Eliza-1 tier label",
          "  --report <path>             Runtime metadata report path",
          "  --metadata-only             Validate GGUF metadata/tensor directory only",
          "  --bench                     Run baseline vs --spec-type draft-mtp bench",
          "  --ngl <N>                   GPU layers for llama.cpp bench",
          "  --bench-tokens <N>          Tokens to generate per run",
          "  --bench-context <N>         Context size",
          "  --bench-draft-n-max <N>     Max MTP draft tokens",
          "  --bench-report <path>       Speculative speedup report path",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!args.targetModel) {
    throw new Error("--target-model is required");
  }
  args.tier = args.tier || inferTier(args.targetModel) || "unknown";
  return args;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function inferTier(value) {
  const match = String(value ?? "").match(/eliza-1-(0_8b|2b|4b|9b|27b(?:-256k)?)/);
  return match?.[1] ?? "";
}

function readGgufMetadata(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.allocUnsafe(24);
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.toString("utf8", 0, 4) !== "GGUF") {
      throw new Error("not a GGUF file");
    }
    const kvCount = Number(head.readBigUInt64LE(16));
    let offset = 24;
    const fields = {};
    for (let i = 0; i < kvCount; i += 1) {
      const key = readStringAt(fd, offset);
      offset = key.next;
      const type = readU32At(fd, offset);
      offset += 4;
      const value = readValueAt(fd, offset, type.value);
      offset = value.next;
      fields[key.value] = value.value;
    }
    return fields;
  } finally {
    fs.closeSync(fd);
  }
}

function readBufferAt(fd, offset, size) {
  const out = Buffer.allocUnsafe(size);
  const read = fs.readSync(fd, out, 0, size, offset);
  if (read !== size) throw new Error("unexpected EOF while reading GGUF metadata");
  return out;
}

function readU32At(fd, offset) {
  return { value: readBufferAt(fd, offset, 4).readUInt32LE(0), next: offset + 4 };
}

function readU64At(fd, offset) {
  const raw = readBufferAt(fd, offset, 8).readBigUInt64LE(0);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("GGUF value too large");
  return { value: Number(raw), next: offset + 8 };
}

function readStringAt(fd, offset) {
  const len = readU64At(fd, offset);
  const start = len.next;
  const buf = readBufferAt(fd, start, len.value);
  return { value: buf.toString("utf8"), next: start + len.value };
}

function readValueAt(fd, offset, type) {
  if (type === 8) {
    return readStringAt(fd, offset);
  }
  if (type === 4) {
    return readU32At(fd, offset);
  }
  if (type === 7) {
    const raw = readBufferAt(fd, offset, 1);
    return { value: raw[0] !== 0, next: offset + 1 };
  }
  if (type === 9) {
    const elemType = readU32At(fd, offset);
    const len = readU64At(fd, elemType.next);
    let next = len.next;
    const values = [];
    for (let i = 0; i < len.value; i += 1) {
      const item = readValueAt(fd, next, elemType.value);
      next = item.next;
      values.push(item.value);
    }
    return { value: values, next };
  }
  const sizes = new Map([
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 2],
    [5, 4],
    [6, 4],
    [10, 8],
    [11, 8],
    [12, 8],
  ]);
  const size = sizes.get(type);
  if (!size) throw new Error(`unsupported GGUF metadata type ${type}`);
  return { value: null, next: offset + size };
}

function hasMtp(fields) {
  const mtpKeys = Object.keys(fields).filter((key) =>
    /nextn|mtp/i.test(key),
  );
  const nextnLayers = Object.entries(fields).find(([key]) =>
    key.endsWith(".nextn_predict_layers"),
  )?.[1];
  return {
    pass: Number(nextnLayers ?? 0) > 0,
    nextnPredictLayers: Number(nextnLayers ?? 0),
    keys: mtpKeys,
  };
}

function detectCliFeatures(binary) {
  if (!binary || !fs.existsSync(binary)) return { available: false, output: "" };
  const result = spawnSync(binary, ["--help"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  return {
    available: true,
    status: result.status,
    supportsDraftMtp: /draft-mtp|mtp/.test(output),
    outputTail: output.trim().split(/\r?\n/).slice(-20).join("\n"),
  };
}

function parseBenchOutput(output) {
  const tps =
    Number(output.match(/tok\/s:\s*([0-9.]+)/i)?.[1]) ||
    Number(output.match(/,\s*([0-9.]+)\s+tokens per second/i)?.[1]) ||
    null;
  const accepted = Number(output.match(/(\d+)\s+accepted/i)?.[1] ?? NaN);
  const drafted = Number(output.match(/(\d+)\s+(?:generated|drafted)/i)?.[1] ?? NaN);
  return {
    tokensPerSecond: Number.isFinite(tps) ? tps : null,
    accepted: Number.isFinite(accepted) ? accepted : null,
    drafted: Number.isFinite(drafted) ? drafted : null,
    acceptanceRate:
      Number.isFinite(accepted) && Number.isFinite(drafted) && drafted > 0
        ? accepted / drafted
        : null,
  };
}

function runBench(binary, args, withMtp) {
  if (!fs.existsSync(binary) || !fs.existsSync(args.targetModel)) {
    return { available: false, failure: "binary or target model missing" };
  }
  const cliArgs = [
    "-m",
    args.targetModel,
    "-p",
    args.benchPrompt,
    "-n",
    String(args.benchTokens),
    "-c",
    String(args.benchContext),
    "-ngl",
    String(args.ngl),
  ];
  if (withMtp) {
    cliArgs.push("--spec-type", "draft-mtp", "--spec-draft-n-max", String(args.benchDraftMax));
  }
  const started = Date.now();
  const result = spawnSync(binary, cliArgs, {
    encoding: "utf8",
    timeout: Math.max(1, args.benchTimeoutMs),
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const parsed = parseBenchOutput(output);
  const failure =
    result.error?.message ||
    (result.signal ? `terminated by ${result.signal}` : null) ||
    (result.status === 0 ? null : `exited ${result.status}`);
  return {
    available: true,
    withMtp,
    status: result.status,
    wallMs: Date.now() - started,
    failure,
    outputTail: output.trim().split(/\r?\n/).slice(-25).join("\n"),
    ...parsed,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const fields = readGgufMetadata(args.targetModel);
  const mtp = hasMtp(fields);
  const cli = detectCliFeatures(args.specBinary);
  const report = {
    reportSchema: "eliza.mtp-runtime-smoke.v1",
    generatedAt: new Date().toISOString(),
    verifier: "plugins/plugin-local-inference/native/verify/mtp_runtime_smoke.mjs",
    tier: args.tier,
    targetModel: args.targetModel,
    specBinary: args.specBinary,
    metadataStatus: mtp.pass ? "pass" : "fail",
    mtp,
    cli,
    runtime: [],
    bench: null,
  };

  if (args.bench && mtp.pass && cli.supportsDraftMtp && !args.metadataOnly) {
    const withoutMtp = runBench(args.specBinary, args, false);
    const withMtp = runBench(args.specBinary, args, true);
    report.runtime.push(withMtp);
    report.bench = buildSpeculativeBenchmarkReport({
      speculator: "mtp",
      verifier: report.verifier,
      tier: args.tier,
      targetModel: args.targetModel,
      specBinary: args.specBinary,
      benchTokens: args.benchTokens,
      withDrafter: {
        ...withMtp,
        drafted: withMtp.drafted,
        accepted: withMtp.accepted,
      },
      withoutDrafter: withoutMtp,
      failure: withMtp.failure,
    });
    writeSpeculativeBenchmarkReport(args.benchReport, report.bench, {
      verifyDir: __dirname,
    });
  }

  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${args.report}`);
  if (report.bench) {
    console.log(`wrote ${args.benchReport}`);
    console.log(`wrote ${latestSpeculativeReportPath(__dirname, "mtp")}`);
  }
  if (!mtp.pass) process.exitCode = 3;
}

main();
