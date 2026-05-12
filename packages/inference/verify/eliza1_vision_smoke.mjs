#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODELS_ROOT = path.join(
  os.homedir(),
  ".eliza",
  "local-inference",
  "models",
);

const VISION_TIERS = new Set(["9b", "27b", "27b-256k"]);
const TEXT_VOICE_ONLY_TIERS = new Set(["0_6b", "1_7b"]);

function usage() {
  return [
    "Usage: node packages/inference/verify/eliza1_vision_smoke.mjs --bundle-dir <path> [options]",
    "",
    "Options:",
    "  --bundle-dir <path>       Eliza-1 bundle directory to inspect",
    "  --tier <tier>             Optional tier override; defaults to manifest.tier",
    "  --image <path>            Image to pass to llama-mtmd-cli when vision exists",
    "  --mtmd-cli <path>         llama-mtmd-cli binary; defaults to ELIZA_LLAMA_MTMD_CLI or build/bin candidates",
    "  --ctx-size <n>            Smoke context size; default 2048 to avoid full long-context KV allocation",
    "  --n-predict <n>           Tokens to generate; default 64",
    "  --gpu-layers <n|auto|all> Optional -ngl value; default auto",
    "  --timeout-ms <n>          Smoke subprocess timeout; default 600000",
    "  --out <path>              JSON report path; repeat to write the same report to multiple paths",
    "  --help, -h                Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    bundleDir: "",
    tier: "",
    image: "",
    mtmdCli: process.env.ELIZA_LLAMA_MTMD_CLI?.trim() || "",
    ctxSize: 2048,
    nPredict: 64,
    gpuLayers: "",
    timeoutMs: 600_000,
    outs: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--bundle-dir") args.bundleDir = next();
    else if (arg === "--tier") args.tier = next();
    else if (arg === "--image") args.image = next();
    else if (arg === "--mtmd-cli") args.mtmdCli = next();
    else if (arg === "--ctx-size") args.ctxSize = Number.parseInt(next(), 10);
    else if (arg === "--n-predict") args.nPredict = Number.parseInt(next(), 10);
    else if (arg === "--gpu-layers") args.gpuLayers = next();
    else if (arg === "--timeout-ms") args.timeoutMs = Number.parseInt(next(), 10);
    else if (arg === "--out") args.outs.push(next());
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.bundleDir) throw new Error("--bundle-dir is required");
  for (const [name, value] of [
    ["--ctx-size", args.ctxSize],
    ["--n-predict", args.nPredict],
    ["--timeout-ms", args.timeoutMs],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function relativeFiles(bundleDir, dir) {
  return listFiles(path.join(bundleDir, dir)).map((file) =>
    path.relative(bundleDir, file),
  );
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function firstExisting(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function walkFiles(root, predicate) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && predicate(file)) out.push(file);
    }
  }
  return out.sort();
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandOnPath(name) {
  const proc = spawnSync("command", ["-v", name], {
    shell: true,
    encoding: "utf8",
  });
  return proc.status === 0 ? proc.stdout.trim().split("\n")[0] : "";
}

function mtmdBuildCommands() {
  const src = "packages/inference/llama.cpp";
  const build = "packages/inference/llama.cpp/build/darwin-arm64-metal-fused";
  return [
    `cmake -S ${src} -B ${build} -DGGML_METAL=ON -DLLAMA_BUILD_TOOLS=ON -DLLAMA_BUILD_EXAMPLES=ON`,
    `cmake --build ${build} --target llama-mtmd-cli -j "$(sysctl -n hw.logicalcpu)"`,
  ];
}

function visionAssetCommands(tier, bundleDir) {
  return {
    stageSource: `python packages/training/scripts/manifest/stage_eliza1_source_weights.py --tier ${tier} --bundle-dir ${bundleDir} --link-mode hardlink`,
    consolidateLocalBundle: `python packages/training/scripts/manifest/stage_local_eliza1_bundle.py --tier ${tier} --bundle-dir ${bundleDir} --force`,
  };
}

function inspectMtmdCandidate(file) {
  const help = spawnSync(file, ["--help"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env },
  });
  const output = `${help.stdout || ""}\n${help.stderr || ""}`;
  return {
    path: file,
    exists: fs.existsSync(file),
    executable: fs.existsSync(file) && isExecutable(file),
    helpExitCode: help.status,
    compatible:
      help.status === 0 && /--mmproj\b/.test(output) && /--image\b/.test(output),
    helpSignals: {
      mmproj: /--mmproj\b/.test(output),
      image: /--image\b/.test(output),
      mtmd: /\bmtmd\b/i.test(output),
      metal: /\bmetal\b/i.test(output),
    },
    stderrTail: (help.stderr || "").slice(-2000),
  };
}

function resolveMtmdCli(explicit) {
  const stateDir =
    process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza");
  const cwd = process.cwd();
  const fixed = [
    explicit,
    process.env.ELIZA_LLAMA_MTMD_CLI?.trim() || "",
    path.join(
      stateDir,
      "local-inference",
      "bin",
      "dflash",
      "darwin-arm64-metal-fused",
      "llama-mtmd-cli",
    ),
    path.join(
      stateDir,
      "local-inference",
      "bin",
      "dflash",
      "darwin-arm64-metal",
      "llama-mtmd-cli",
    ),
    path.join(
      cwd,
      "packages/inference/llama.cpp/build/darwin-arm64-metal-fused/bin/llama-mtmd-cli",
    ),
    path.join(
      cwd,
      "packages/inference/llama.cpp/build/darwin-arm64-metal/bin/llama-mtmd-cli",
    ),
    path.join(
      cwd,
      "packages/inference/llama.cpp/build/bin/llama-mtmd-cli",
    ),
    path.join(cwd, "packages/inference/llama.cpp/build/bin/mtmd-cli"),
    commandOnPath("llama-mtmd-cli"),
    commandOnPath("mtmd-cli"),
  ].filter(Boolean);
  const discovered = walkFiles(
    path.join(cwd, "packages/inference/llama.cpp/build"),
    (file) => /(^|\/)(llama-mtmd-cli|mtmd-cli)$/.test(file),
  );
  const seen = new Set();
  const candidates = [...fixed, ...discovered]
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    });
  const inspections = candidates
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => inspectMtmdCandidate(candidate));
  return {
    selected: inspections.find((candidate) => candidate.compatible)?.path || "",
    candidates: inspections,
    buildCommands: mtmdBuildCommands(),
  };
}

function parseVisionTimings(text) {
  const matchNumber = (re) => {
    const match = text.match(re);
    return match ? Number(match[1]) : null;
  };
  const loadMs = matchNumber(/load time\s*=\s*([\d.]+)\s*ms/i);
  const promptEvalMs = matchNumber(/prompt eval time\s*=\s*([\d.]+)\s*ms/i);
  const promptTokens = matchNumber(/prompt eval time\s*=.*?\/\s*(\d+)\s*tokens/i);
  const promptTokPerSec = matchNumber(/prompt eval time\s*=.*?,\s*([\d.]+)\s*tokens per second/i);
  const evalMs = matchNumber(/(?:^|\n|:)\s*eval time\s*=\s*([\d.]+)\s*ms/i);
  const evalRuns = matchNumber(/(?:^|\n|:)\s*eval time\s*=.*?\/\s*(\d+)\s*runs/i);
  const evalTokPerSec = matchNumber(/(?:^|\n|:)\s*eval time\s*=.*?,\s*([\d.]+)\s*tokens per second/i);
  const totalMs = matchNumber(/total time\s*=\s*([\d.]+)\s*ms/i);
  const imageEncodeMs = matchNumber(/image slice encoded in\s*([\d.]+)\s*ms/i);
  const imageDecodeMs = matchNumber(/image decoded .*? in\s*([\d.]+)\s*ms/i);
  return {
    loadMs,
    promptEvalMs,
    promptTokens,
    promptTokPerSec,
    evalMs,
    evalRuns,
    evalTokPerSec,
    totalMs,
    imageEncodeMs,
    imageDecodeMs,
  };
}

function findTextModel(bundleDir, manifest) {
  const textFiles = manifest?.files?.text;
  if (Array.isArray(textFiles) && textFiles.length > 0) {
    const rel = textFiles[0]?.path;
    if (typeof rel === "string") return path.join(bundleDir, rel);
  }
  return firstExisting(listFiles(path.join(bundleDir, "text")));
}

function runVisionSmoke({
  mtmdCli,
  textModel,
  mmproj,
  image,
  ctxSize,
  nPredict,
  gpuLayers,
  timeoutMs,
}) {
  if (!mtmdCli.selected) {
    return {
      attempted: false,
      status: "not-run",
      reason:
        "No compatible llama-mtmd-cli was found; artifact audit completed only",
      detection: mtmdCli,
    };
  }
  if (!image) {
    return {
      attempted: false,
      status: "not-run",
      reason: "--image was not provided; artifact audit completed only",
    };
  }
  if (!fs.existsSync(image)) {
    return {
      attempted: false,
      status: "not-run",
      reason: `image file is missing: ${image}`,
    };
  }
  const args = [
    "-m",
    textModel,
    "--mmproj",
    mmproj,
    "--image",
    image,
    "-c",
    String(ctxSize),
    "-p",
    "Describe this image in one short sentence.",
    "-n",
    String(nPredict),
  ];
  if (gpuLayers) args.push("-ngl", String(gpuLayers));
  const startedAt = new Date().toISOString();
  const proc = spawnSync(mtmdCli.selected, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env },
  });
  const output = `${proc.stdout || ""}\n${proc.stderr || ""}`;
  return {
    attempted: true,
    status: proc.status === 0 ? "pass" : "fail",
    startedAt,
    command: [mtmdCli.selected, ...args],
    timeoutMs,
    exitCode: proc.status,
    signal: proc.signal,
    detection: mtmdCli,
    timings: parseVisionTimings(output),
    stdoutTail: (proc.stdout || "").slice(-4000),
    stderrTail: (proc.stderr || "").slice(-4000),
  };
}

function fileEntryWithSize(bundleDir, entry) {
  const file = path.join(bundleDir, entry.path);
  const sizeBytes = fs.existsSync(file) ? fs.statSync(file).size : null;
  return {
    ...entry,
    sizeBytes,
    sizeGiB:
      sizeBytes === null
        ? null
        : Number((sizeBytes / 1024 ** 3).toFixed(3)),
  };
}

function sizeFiles(bundleDir, entries) {
  return Array.isArray(entries)
    ? entries.map((entry) => fileEntryWithSize(bundleDir, entry))
    : [];
}

function maxSize(files) {
  return Math.max(0, ...files.map((file) => file.sizeBytes || 0));
}

function buildReport(args) {
  const bundleDir = path.resolve(args.bundleDir);
  const manifestPath = path.join(bundleDir, "eliza-1.manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}`);
  }
  const manifest = readJson(manifestPath);
  const tier = args.tier || manifest.tier;
  if (!tier) throw new Error("tier is required when manifest.tier is absent");

  const manifestVisionFiles = Array.isArray(manifest?.files?.vision)
    ? manifest.files.vision
    : [];
  const visionFiles = relativeFiles(bundleDir, "vision");
  const sourceVisionFiles = relativeFiles(bundleDir, "source/vision");
  const asrMmprojFiles = relativeFiles(bundleDir, "asr").filter((file) =>
    /mmproj/i.test(file),
  );
  const expectedVisionTier = VISION_TIERS.has(tier);
  const textVoiceOnlyTier = TEXT_VOICE_ONLY_TIERS.has(tier);
  const mmprojRel = manifestVisionFiles[0]?.path;
  const mmprojPath =
    typeof mmprojRel === "string" ? path.join(bundleDir, mmprojRel) : "";
  const textModel = findTextModel(bundleDir, manifest);
  const mtmdCli = resolveMtmdCli(args.mtmdCli);
  const textFilesSized = sizeFiles(bundleDir, manifest?.files?.text);
  const visionFilesSized = sizeFiles(bundleDir, manifestVisionFiles);
  const largestTextBytes = maxSize(textFilesSized);
  const largestVisionBytes = maxSize(visionFilesSized);

  const report = {
    schemaVersion: 1,
    metric: "vision_smoke",
    generatedAt: new Date().toISOString(),
    bundleDir,
    tier,
    expectedVisionTier,
    textVoiceOnlyTier,
    supported: manifestVisionFiles.length > 0,
    passed: false,
    status: "not-run",
    action: "undecided",
    smokeConfig: {
      image: args.image ? path.resolve(args.image) : "",
      ctxSize: args.ctxSize,
      nPredict: args.nPredict,
      gpuLayers: args.gpuLayers || "auto",
      timeoutMs: args.timeoutMs,
    },
    manifest: {
      path: manifestPath,
      filesText: textFilesSized,
      filesVision: visionFilesSized,
      lineageVisionPresent: Boolean(manifest?.lineage?.vision),
    },
    mtmdCli,
    visionAssetCommands: visionAssetCommands(tier, bundleDir),
    inventory: {
      visionFiles,
      sourceVisionFiles,
      asrMmprojFiles,
      borrowedVisionArtifactsSeen: [
        path.join(
          MODELS_ROOT,
          "eliza-1-9b.bundle",
          "vision",
          "mmproj-9b.gguf",
        ),
        path.join(
          MODELS_ROOT,
          "eliza-1-27b.bundle",
          "vision",
          "mmproj-27b.gguf",
        ),
        path.join(
          MODELS_ROOT,
          "eliza-1-27b-256k.bundle",
          "vision",
          "mmproj-27b-256k.gguf",
        ),
      ].filter((file) => fs.existsSync(file)),
    },
    appCorePath: {
      spawnArg: "--mmproj",
      envOverride: "ELIZA_LOCAL_MMPROJ",
      optimizationField: "runtime.optimizations.mmproj",
      note: "packages/app-core/src/services/local-inference/dflash-server.ts only enables image inputs when a tier-compatible mmproj path is provided.",
    },
    memoryImplications: {
      largestTextBytes,
      largestVisionBytes,
      largestTextGiB: Number((largestTextBytes / 1024 ** 3).toFixed(3)),
      largestVisionGiB: Number((largestVisionBytes / 1024 ** 3).toFixed(3)),
      minimumMappedWeightsGiB: Number(
        ((largestTextBytes + largestVisionBytes) / 1024 ** 3).toFixed(3),
      ),
      note:
        "Smoke uses a small --ctx-size, so KV cache allocation is much smaller than the tier's long-context runtime budget. Operational RAM still needs text weights + mmproj + KV cache + Metal/CPU working buffers.",
    },
    imageAnalysis: {
      attempted: false,
      status: "skipped",
      reason: "no tier-compatible vision/mmproj artifact selected",
    },
  };

  if (textVoiceOnlyTier && manifestVisionFiles.length === 0) {
    report.status = "not-applicable";
    report.action = "mark-text-voice-only";
    report.reason =
      `${tier} is text/voice-only by the Eliza-1 tier contract: packages/inference/AGENTS.md marks Vision=no for ${tier}, ` +
      "packages/shared/src/local-inference/catalog.ts has no sourceModel.components.vision for this tier, " +
      "packages/training/scripts/manifest/stage_eliza1_source_weights.py has no vision source for this tier, " +
      "and manifest.files.vision is empty. The ASR mmproj is audio-only and cannot be reused for image analysis; " +
      "the local 9B/27B mmproj files are tied to different text backbones and are not compatible substitutes.";
    report.imageAnalysis.reason = "skipped because manifest.files.vision is empty";
    return report;
  }

  if (!expectedVisionTier && manifestVisionFiles.length > 0) {
    report.status = "fail";
    report.action = "remove-unexpected-vision-artifact";
    report.reason = `${tier} is not a configured vision tier but manifest.files.vision is non-empty`;
    return report;
  }

  if (expectedVisionTier && manifestVisionFiles.length === 0) {
    report.status = "fail";
    report.action = "stage-compatible-mmproj";
    report.reason = `${tier} is a configured vision tier but manifest.files.vision is empty`;
    return report;
  }

  if (!mmprojPath || !fs.existsSync(mmprojPath)) {
    report.status = "fail";
    report.action = "fix-manifest-or-stage-mmproj";
    report.reason = `manifest.files.vision points at a missing mmproj: ${mmprojRel}`;
    return report;
  }

  report.supported = true;
  report.mmproj = {
    path: mmprojPath,
    sha256: sha256(mmprojPath),
    sizeBytes: fs.statSync(mmprojPath).size,
  };
  report.textModel = textModel;
  report.imageAnalysis = runVisionSmoke({
    mtmdCli,
    textModel,
    mmproj: mmprojPath,
    image: args.image,
    ctxSize: args.ctxSize,
    nPredict: args.nPredict,
    gpuLayers: args.gpuLayers,
    timeoutMs: args.timeoutMs,
  });
  report.status = report.imageAnalysis.status;
  report.passed = report.imageAnalysis.status === "pass";
  report.action = report.passed ? "vision-smoke-passed" : "needs-vision-smoke";
  report.reason = report.passed
    ? "tier-compatible mmproj loaded and image analysis command completed"
    : report.imageAnalysis.reason || "image analysis command did not pass";
  return report;
}

function writeReport(report, outs) {
  const targets =
    outs.length > 0
      ? outs
      : [path.join(report.bundleDir, "evals", "vision.json")];
  for (const out of targets) {
    const target = path.resolve(out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  return targets.map((out) => path.resolve(out));
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = buildReport(args);
  const written = writeReport(report, args.outs);
  console.log(
    JSON.stringify(
      {
        status: report.status,
        passed: report.passed,
        tier: report.tier,
        action: report.action,
        reason: report.reason,
        written,
      },
      null,
      2,
    ),
  );
  process.exit(report.status === "fail" ? 1 : 0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
