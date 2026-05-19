#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSpeculativeBenchmarkReport,
  timestampedSpeculativeReportPath,
  writeSpeculativeBenchmarkReport,
} from "./speculative_benchmark_report.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SPEC_TYPE = "draft-eagle3";

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
  path.join(DEFAULT_BUNDLE, "eagle3", "drafter-0_8b.gguf"),
  path.join(DEFAULT_BUNDLE, "eagle3", "drafter.gguf"),
);
const DEFAULT_BIN = path.join(
  process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza"),
  "local-inference",
  "bin",
  "dflash",
  "darwin-arm64-metal",
  "llama-speculative-simple",
);

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
    targetModel: process.env.ELIZA_EAGLE3_TARGET_MODEL || DEFAULT_TARGET,
    drafterModel: process.env.ELIZA_EAGLE3_DRAFTER_MODEL || DEFAULT_DRAFTER,
    specBinary: process.env.ELIZA_EAGLE3_SPEC_BINARY || DEFAULT_BIN,
    tier: process.env.ELIZA_EAGLE3_TIER || "",
    report:
      process.env.ELIZA_EAGLE3_BENCH_REPORT ||
      timestampedSpeculativeReportPath(__dirname, "eagle3"),
    ngl: process.env.ELIZA_EAGLE3_SMOKE_NGL || "0",
    ngld: process.env.ELIZA_EAGLE3_SMOKE_NGLD || "0",
    metadataOnly: false,
    dryRun: false,
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
    else if (arg === "--report") args.report = next();
    else if (arg === "--ngl") args.ngl = next();
    else if (arg === "--ngld") args.ngld = next();
    else if (arg === "--metadata-only") args.metadataOnly = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node eagle3_drafter_runtime_smoke.mjs [options]",
          "",
          "Options:",
          "  --target-model <path>   Target GGUF",
          "  --drafter-model <path>  EAGLE3 drafter GGUF",
          "  --spec-binary <path>    llama-speculative-simple binary to test",
          "  --tier <tier>           Eliza-1 tier",
          "  --report <path>         JSON report path",
          "  --ngl <N>               Target GPU layers for runtime smoke",
          "  --ngld <N>              Draft GPU layers for runtime smoke",
          "  --metadata-only         Record artifact metadata; skip runtime",
          "  --dry-run               Record intended invocation; skip runtime",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  args.tier =
    args.tier || inferTier(args.targetModel, args.drafterModel) || "0_8b";
  return args;
}

function parseRuntimeCounters(text) {
  const number = (re) => {
    const match = text.match(re);
    return match ? Number(match[1]) : null;
  };
  const drafted = number(/n_drafted\s*[:=]\s*(\d+)/i);
  const accepted =
    number(/n_drafted_accepted\s*[:=]\s*(\d+)/i) ??
    number(/n_accept(?:ed)?\s*[:=]\s*(\d+)/i);
  return {
    drafted,
    accepted,
    acceptanceRate:
      drafted && drafted > 0 && accepted !== null ? accepted / drafted : null,
  };
}

function classifyFailure(output) {
  if (
    /invalid value|unknown|unsupported/i.test(output) &&
    /spec-type/i.test(output)
  ) {
    return "native EAGLE3 speculative decoding is not supported by this binary";
  }
  if (/failed to load draft model/i.test(output)) {
    return "EAGLE3 draft model failed to load";
  }
  return "EAGLE3 runtime smoke did not complete successfully";
}

function buildRuntimeArgs(args) {
  return [
    "-m",
    args.targetModel,
    "-md",
    args.drafterModel,
    "-p",
    "Hello",
    "-n",
    "1",
    "-c",
    "128",
    "-ngl",
    args.ngl,
    "-ngld",
    args.ngld,
    "--spec-type",
    SPEC_TYPE,
  ];
}

function runRuntime(args, runtimeArgs) {
  if (!fs.existsSync(args.specBinary)) {
    return {
      available: false,
      binary: args.specBinary,
      withDrafter: true,
      args: runtimeArgs,
      status: null,
      failure: `speculative binary is missing: ${args.specBinary}`,
    };
  }
  if (!fs.existsSync(args.targetModel) || !fs.existsSync(args.drafterModel)) {
    return {
      available: false,
      binary: args.specBinary,
      withDrafter: true,
      args: runtimeArgs,
      status: null,
      failure: `target or EAGLE3 drafter model is missing: target=${args.targetModel}, drafter=${args.drafterModel}`,
    };
  }

  const result = spawnSync(args.specBinary, runtimeArgs, {
    encoding: "utf8",
    env: { ...process.env },
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const counters = parseRuntimeCounters(output);
  return {
    available: true,
    binary: args.specBinary,
    withDrafter: true,
    args: runtimeArgs,
    status: result.status,
    signal: result.signal,
    ...counters,
    failure: result.status === 0 ? null : classifyFailure(output),
    outputTail: output.trim().split(/\r?\n/).slice(-80).join("\n"),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeArgs = buildRuntimeArgs(args);
  const metadataMode = args.metadataOnly || args.dryRun;
  const runtime = metadataMode
    ? {
        available: fs.existsSync(args.specBinary),
        binary: args.specBinary,
        withDrafter: true,
        args: runtimeArgs,
        status: null,
        failure: null,
      }
    : runRuntime(args, runtimeArgs);
  const status = metadataMode
    ? "metadata-only"
    : runtime.status === 0
      ? "pass"
      : "blocked-native-support";
  const failure = metadataMode ? null : runtime.failure;
  const report = buildSpeculativeBenchmarkReport({
    speculator: "eagle3",
    verifier: path.relative(process.cwd(), __filename),
    tier: args.tier,
    targetModel: args.targetModel,
    drafterModel: args.drafterModel,
    specBinary: args.specBinary,
    withDrafter: runtime,
    status,
    failure,
    extra: {
      specType: SPEC_TYPE,
      metadataOnly: args.metadataOnly,
      dryRun: args.dryRun,
      invocation: {
        binary: args.specBinary,
        args: runtimeArgs,
      },
      runtime,
    },
  });

  writeSpeculativeBenchmarkReport(args.report, report, {
    verifyDir: __dirname,
  });
  console.log(`wrote ${args.report}`);
  console.log(
    `eagle3-runtime-smoke: status=${report.status} failure=${report.failure ?? "none"}`,
  );
  if (!metadataMode && runtime.status !== 0) {
    process.exit(1);
  }
}

main();
