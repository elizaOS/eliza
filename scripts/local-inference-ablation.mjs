#!/usr/bin/env node
/**
 * Portable llama-server ablation runner for local inference backends.
 *
 * Measures target-only, DFlash, TurboQuant KV, TCQ/QJL KV, and combined paths
 * with the same OpenAI-compatible request shape across Metal, CUDA, ROCm, and
 * CPU builds. Results are written as JSON for cross-machine comparison.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

const HOST = "127.0.0.1";
const DEFAULT_PROMPT =
  "Write a dense technical paragraph about local language model inference, GPU kernels, KV cache compression, speculative decoding, and benchmarking. Keep going until the token budget is exhausted. Do not use bullets.";

const DEFAULT_VARIANTS = [
  {
    name: "baseline_f16_kv",
    label: "target only, f16 KV",
    args: [],
  },
  {
    name: "turbo4_polar_kv",
    label: "target only, Turbo/Polar KV turbo4",
    args: ["--cache-type-k", "turbo4", "--cache-type-v", "turbo4"],
  },
  {
    name: "turbo3_polar_kv",
    label: "target only, Turbo/Polar KV turbo3",
    args: ["--cache-type-k", "turbo3", "--cache-type-v", "turbo3"],
  },
  {
    name: "qjl_tcq_forced",
    label: "target only, forced QJL/TCQ turbo3_tcq",
    args: ["--cache-type-k", "turbo3_tcq", "--cache-type-v", "turbo3_tcq"],
  },
  {
    name: "dflash_only",
    label: "DFlash, f16 KV",
    needsDrafter: true,
    args: ["--spec-type", "dflash"],
  },
  {
    name: "dflash_turbo4_polar",
    label: "DFlash + Turbo/Polar KV turbo4",
    needsDrafter: true,
    args: [
      "--spec-type",
      "dflash",
      "--cache-type-k",
      "turbo4",
      "--cache-type-v",
      "turbo4",
      "--cache-type-k-draft",
      "turbo4",
      "--cache-type-v-draft",
      "turbo4",
    ],
  },
  {
    name: "all_dflash_qjl_tcq",
    label: "DFlash + forced QJL/TCQ turbo3_tcq",
    needsDrafter: true,
    args: [
      "--spec-type",
      "dflash",
      "--cache-type-k",
      "turbo3_tcq",
      "--cache-type-v",
      "turbo3_tcq",
      "--cache-type-k-draft",
      "turbo3_tcq",
      "--cache-type-v-draft",
      "turbo3_tcq",
    ],
  },
];

function stateDir() {
  return (
    process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza")
  );
}

function detectBackend() {
  const forced = process.env.ELIZA_DFLASH_BACKEND?.trim().toLowerCase();
  if (forced) return forced;
  if (process.platform === "darwin") return "metal";
  if (process.env.HIP_VISIBLE_DEVICES || process.env.ROCR_VISIBLE_DEVICES)
    return "rocm";
  if (
    process.env.CUDA_VISIBLE_DEVICES &&
    process.env.CUDA_VISIBLE_DEVICES !== "-1"
  )
    return "cuda";
  return "cpu";
}

function platformKey(backend) {
  return `${process.platform}-${process.arch}-${backend}`;
}

function defaultBinary(backend) {
  return path.join(
    stateDir(),
    "local-inference",
    "bin",
    "dflash",
    platformKey(backend),
    "llama-server",
  );
}

const KERNEL_BY_CACHE_TYPE = new Map([
  ["turbo3", "turbo3"],
  ["tbq3_0", "turbo3"],
  ["turbo4", "turbo4"],
  ["tbq4_0", "turbo4"],
  ["turbo3_tcq", "turbo3_tcq"],
  ["tbq3_tcq", "turbo3_tcq"],
  ["qjl", "qjl_full"],
  ["qjl_full", "qjl_full"],
  ["qjl1_256", "qjl_full"],
  ["polar", "polarquant"],
  ["polarquant", "polarquant"],
  ["q4_polar", "polarquant"],
]);

function normalizeKernelArg(value) {
  return String(value).trim().toLowerCase().replaceAll("-", "_");
}

function kernelForCacheType(value) {
  return KERNEL_BY_CACHE_TYPE.get(normalizeKernelArg(value)) ?? null;
}

function optionValue(argv, index) {
  const arg = argv[index];
  const eq = arg.indexOf("=");
  if (eq !== -1) return { value: arg.slice(eq + 1), consumed: 0 };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return { value: null, consumed: 0 };
  return { value, consumed: 1 };
}

function variantRequiredKernels(variant) {
  const required = new Set();
  const argv = variant.args ?? [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--spec-type" || arg.startsWith("--spec-type=")) {
      const parsed = optionValue(argv, i);
      if (parsed.value && normalizeKernelArg(parsed.value) === "dflash") {
        required.add("dflash");
      }
      i += parsed.consumed;
      continue;
    }
    if (arg.startsWith("--cache-type")) {
      const parsed = optionValue(argv, i);
      if (parsed.value) {
        const kernel = kernelForCacheType(parsed.value);
        if (kernel) required.add(kernel);
      }
      i += parsed.consumed;
    }
  }
  return [...required];
}

function loadCapabilities(binary) {
  const filePath = path.join(path.dirname(binary), "CAPABILITIES.json");
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const kernels = parsed?.kernels;
  if (!kernels || typeof kernels !== "object" || Array.isArray(kernels)) {
    throw new Error(`invalid CAPABILITIES.json kernels map: ${filePath}`);
  }
  return { path: filePath, kernels };
}

function missingVariantKernels(variant, capabilities) {
  const required = variantRequiredKernels(variant);
  return required.filter((kernel) => capabilities.kernels[kernel] !== true);
}

function defaultModelPath(name) {
  return path.join(stateDir(), "local-inference", "models", name);
}

function parseArgs(argv) {
  const backend = detectBackend();
  const defaultGpuLayers = backend === "cpu" ? 0 : 99;
  const args = {
    backend,
    binary: defaultBinary(backend),
    model: defaultModelPath("eliza-1-mobile-1_7b.gguf"),
    drafter: defaultModelPath("eliza-1-mobile-1_7b-drafter-q4.repaired.gguf"),
    runs: 3,
    warmupTokens: 32,
    maxTokens: 256,
    contextSize: 6048,
    draftContextSize: 256,
    draftMin: 1,
    draftMax: 16,
    batchSize: 256,
    ubatchSize: 64,
    gpuLayers: defaultGpuLayers,
    draftGpuLayers: defaultGpuLayers,
    timeoutMs: 180_000,
    startTimeoutMs: 120_000,
    prompt: DEFAULT_PROMPT,
    variants: null,
    outDir: path.join(process.cwd(), "artifacts", "local-inference-ablation"),
    config: null,
    gate: null,
    requireAll: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === "--backend") args.backend = next();
    else if (arg === "--binary") args.binary = path.resolve(next());
    else if (arg === "--model") args.model = path.resolve(next());
    else if (arg === "--drafter") args.drafter = path.resolve(next());
    else if (arg === "--runs") args.runs = Number.parseInt(next(), 10);
    else if (arg === "--max-tokens")
      args.maxTokens = Number.parseInt(next(), 10);
    else if (arg === "--warmup-tokens")
      args.warmupTokens = Number.parseInt(next(), 10);
    else if (arg === "--ctx-size")
      args.contextSize = Number.parseInt(next(), 10);
    else if (arg === "--ctx-size-draft")
      args.draftContextSize = Number.parseInt(next(), 10);
    else if (arg === "--draft-min") args.draftMin = Number.parseInt(next(), 10);
    else if (arg === "--draft-max") args.draftMax = Number.parseInt(next(), 10);
    else if (arg === "--batch-size" || arg === "-b")
      args.batchSize = Number.parseInt(next(), 10);
    else if (arg === "--ubatch-size" || arg === "-ub")
      args.ubatchSize = Number.parseInt(next(), 10);
    else if (arg === "--gpu-layers")
      args.gpuLayers = Number.parseInt(next(), 10);
    else if (arg === "--draft-gpu-layers")
      args.draftGpuLayers = Number.parseInt(next(), 10);
    else if (arg === "--timeout-ms")
      args.timeoutMs = Number.parseInt(next(), 10);
    else if (arg === "--start-timeout-ms")
      args.startTimeoutMs = Number.parseInt(next(), 10);
    else if (arg === "--prompt") args.prompt = next();
    else if (arg === "--variants")
      args.variants = next()
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    else if (arg === "--out-dir") args.outDir = path.resolve(next());
    else if (arg === "--config") args.config = path.resolve(next());
    else if (arg === "--gate") args.gate = path.resolve(next());
    else if (arg === "--require-all") args.requireAll = true;
    else if (arg === "--quick") {
      args.runs = 1;
      args.maxTokens = 96;
      args.warmupTokens = 16;
      args.variants = [
        "baseline_f16_kv",
        "turbo4_polar_kv",
        "qjl_tcq_forced",
        "dflash_only",
      ];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  args.binary = args.binary || defaultBinary(args.backend);
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/local-inference-ablation.mjs [options]

Options:
  --backend metal|cuda|rocm|cpu
  --binary /path/to/llama-server
  --model /path/to/target.gguf
  --drafter /path/to/drafter.gguf
  --variants baseline_f16_kv,turbo4_polar_kv,qjl_tcq_forced,dflash_only
  --runs 3 --max-tokens 256 --quick
  --out-dir artifacts/local-inference-ablation
  --config scripts/local-inference-ablation.config.json
  --gate scripts/local-inference-thresholds.json
  --require-all   fail (exit 1) if any variant is skipped due to a missing model

Exit codes:
  0  all selected variants ran (or were cleanly skipped) and met thresholds (if --gate is set)
  1  startup error, a variant failed to run, gate thresholds were violated, or a model was missing while --require-all is set
`);
}

function loadVariants(args) {
  let variants = DEFAULT_VARIANTS;
  if (args.config) {
    const parsed = JSON.parse(fs.readFileSync(args.config, "utf8"));
    if (Array.isArray(parsed.variants)) variants = parsed.variants;
  }
  if (args.variants) {
    const wanted = new Set(args.variants);
    variants = variants.filter((variant) => wanted.has(variant.name));
  }
  const targetExists = fs.existsSync(args.model);
  const drafterExists = fs.existsSync(args.drafter);
  const capabilities = loadCapabilities(args.binary);
  return variants.map((variant) => {
    if (!targetExists) {
      return { ...variant, skipReason: `model missing: ${args.model}` };
    }
    if (variant.needsDrafter && !drafterExists) {
      return { ...variant, skipReason: `drafter missing: ${args.drafter}` };
    }
    if (capabilities) {
      const missing = missingVariantKernels(variant, capabilities);
      if (missing.length > 0) {
        return {
          ...variant,
          skipReason: `kernel(s) not advertised by ${capabilities.path}: ${missing.join(", ")}`,
        };
      }
    }
    return variant;
  });
}

function loadThresholds(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid threshold file: ${filePath}`);
  }
  return parsed;
}

function thresholdFor(thresholds, backend, variantName) {
  if (!thresholds) return null;
  const byBackend = thresholds[backend];
  if (!byBackend || typeof byBackend !== "object") return null;
  const direct = byBackend[variantName];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const fallback = byBackend.default;
  if (typeof fallback === "number" && Number.isFinite(fallback))
    return fallback;
  return null;
}

function evaluateGate(report, thresholds) {
  const violations = [];
  for (const variant of report.variants) {
    if (variant.skipped || !variant.ok) continue;
    const min = thresholdFor(thresholds, report.hardware.backend, variant.name);
    if (min === null) continue;
    variant.thresholdTokPerSec = min;
    if (variant.avgTokPerSec < min) {
      violations.push({
        name: variant.name,
        backend: report.hardware.backend,
        avgTokPerSec: variant.avgTokPerSec,
        thresholdTokPerSec: min,
      });
    }
  }
  return violations;
}

function runCapture(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function hardwareInfo(args) {
  const info = {
    platform: process.platform,
    arch: process.arch,
    backend: args.backend,
    platformKey: platformKey(args.backend),
    hostname: os.hostname(),
    cpus: os.cpus().map((cpu) => cpu.model)[0],
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  };
  if (process.platform === "darwin") {
    const chip = runCapture("sysctl", ["-n", "machdep.cpu.brand_string"]);
    const gpu = runCapture("system_profiler", ["SPDisplaysDataType"]);
    info.cpuBrand = chip.stdout || null;
    info.gpu = (gpu.stdout.match(/Chipset Model: (.+)/) || [])[1] || null;
  } else {
    const nvidia = runCapture("nvidia-smi", [
      "--query-gpu=name,memory.total,driver_version",
      "--format=csv,noheader",
    ]);
    const rocm = runCapture("rocminfo", []);
    info.nvidiaSmi = nvidia.ok ? nvidia.stdout : null;
    info.rocminfo = rocm.ok ? rocm.stdout.slice(0, 2000) : null;
  }
  return info;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("failed to allocate port"));
      });
    });
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${await response.text().catch(() => "")}`,
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitReady(baseUrl, state, logs, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (state.exited) {
      throw new Error(
        `server exited ${state.exited.code ?? state.exited.signal}: ${logs.slice(-80).join("\n")}`,
      );
    }
    try {
      await fetchJson(`${baseUrl}/health`, { method: "GET" }, 1500);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(
    `server not ready after ${timeoutMs}ms:\n${logs.slice(-120).join("\n")}`,
  );
}

async function stopServer(child, state) {
  if (state.exited) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(5000),
  ]);
  if (!state.exited) child.kill("SIGKILL");
}

function serverArgs(args, variant, port) {
  const out = [
    "--model",
    args.model,
    "--host",
    HOST,
    "--port",
    String(port),
    "--n-gpu-layers",
    String(args.gpuLayers),
    "--ctx-size",
    String(args.contextSize),
    "--parallel",
    "1",
    "--metrics",
    "--jinja",
    "--reasoning",
    "off",
    "--chat-template-kwargs",
    '{"enable_thinking":false}',
    "-fa",
    "on",
    "-b",
    String(args.batchSize),
    "-ub",
    String(args.ubatchSize),
  ];
  if (variant.needsDrafter || variant.args?.includes("--spec-type")) {
    out.push(
      "-md",
      args.drafter,
      "--ctx-size-draft",
      String(args.draftContextSize),
      "--draft-min",
      String(args.draftMin),
      "--draft-max",
      String(args.draftMax),
      "--n-gpu-layers-draft",
      String(args.draftGpuLayers),
    );
  }
  out.push(...(variant.args || []));
  return out;
}

async function completion(baseUrl, args, maxTokens) {
  const started = performance.now();
  const json = await fetchJson(
    `${baseUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local",
        messages: [{ role: "user", content: args.prompt }],
        max_tokens: maxTokens,
        temperature: 0.7,
        top_p: 0.95,
        stream: false,
      }),
    },
    args.timeoutMs,
  );
  const elapsedSec = (performance.now() - started) / 1000;
  const content = json?.choices?.[0]?.message?.content ?? "";
  const usageTokens = Number(json?.usage?.completion_tokens);
  const tokens =
    Number.isFinite(usageTokens) && usageTokens > 0
      ? usageTokens
      : Math.max(1, Math.round(String(content).length / 4));
  return {
    tokens,
    elapsedSec,
    tokPerSec: tokens / elapsedSec,
    preview: String(content).slice(0, 96).replace(/\s+/g, " "),
  };
}

async function runVariant(args, variant) {
  const port = await freePort();
  const baseUrl = `http://${HOST}:${port}`;
  const logs = [];
  const state = { exited: null };
  const cmdArgs = serverArgs(args, variant, port);
  const child = spawn(args.binary, cmdArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    state.exited = { code, signal };
  });
  const capture = (buf) => {
    for (const raw of buf.toString().split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      logs.push(line);
      while (logs.length > 300) logs.shift();
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  const row = {
    name: variant.name,
    label: variant.label,
    ok: false,
    args: cmdArgs,
    runs: [],
  };

  try {
    await waitReady(baseUrl, state, logs, args.startTimeoutMs);
    await completion(baseUrl, args, args.warmupTokens);
    for (let i = 0; i < args.runs; i += 1) {
      const run = await completion(baseUrl, args, args.maxTokens);
      row.runs.push(run);
      console.log(
        `${variant.name} run ${i + 1}/${args.runs}: ${run.tokPerSec.toFixed(2)} tok/s (${run.tokens} tok, ${run.elapsedSec.toFixed(3)}s)`,
      );
    }
    row.ok = true;
    row.avgTokPerSec =
      row.runs.reduce((sum, run) => sum + run.tokPerSec, 0) / row.runs.length;
    row.minTokPerSec = Math.min(...row.runs.map((run) => run.tokPerSec));
    row.maxTokPerSec = Math.max(...row.runs.map((run) => run.tokPerSec));
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
    row.logs = logs.slice(-120);
    console.log(`${variant.name} FAILED: ${row.error.split("\n")[0]}`);
  } finally {
    await stopServer(child, state);
  }
  return row;
}

function printSummary(results) {
  console.log("\nAblation summary");
  for (const row of results) {
    if (row.skipped) {
      console.log(
        `${row.name.padEnd(24)} SKIPPED  ${row.skipReason ?? "unknown"}`,
      );
    } else if (row.ok) {
      const gate =
        typeof row.thresholdTokPerSec === "number"
          ? `  >=${row.thresholdTokPerSec.toFixed(2)} tok/s gate`
          : "";
      console.log(
        `${row.name.padEnd(24)} ${row.avgTokPerSec.toFixed(2).padStart(8)} tok/s  (${row.label})${gate}`,
      );
    } else {
      console.log(
        `${row.name.padEnd(24)} FAILED   ${row.error?.split("\n")[0] ?? "unknown"}`,
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const variants = loadVariants(args);
  if (variants.length === 0) throw new Error("no variants selected");

  const binaryMissing = !fs.existsSync(args.binary);
  const _modelMissing = !fs.existsSync(args.model);
  const thresholds = args.gate ? loadThresholds(args.gate) : null;

  fs.mkdirSync(args.outDir, { recursive: true });

  const report = {
    createdAt: new Date().toISOString(),
    binary: args.binary,
    model: args.model,
    drafter: fs.existsSync(args.drafter) ? args.drafter : null,
    maxTokens: args.maxTokens,
    runs: args.runs,
    hardware: hardwareInfo(args),
    variants: [],
    gate: thresholds ? args.gate : null,
  };

  if (binaryMissing) {
    const reason = `binary missing: ${args.binary}`;
    console.log(`[ablation] skip all variants: ${reason}`);
    for (const variant of variants) {
      report.variants.push({
        name: variant.name,
        label: variant.label,
        skipped: true,
        skipReason: reason,
      });
    }
  } else {
    for (const variant of variants) {
      if (variant.skipReason) {
        console.log(`[ablation] skip ${variant.name}: ${variant.skipReason}`);
        report.variants.push({
          name: variant.name,
          label: variant.label,
          skipped: true,
          skipReason: variant.skipReason,
        });
        continue;
      }
      console.log(`\n[ablation] ${variant.name}: ${variant.label}`);
      report.variants.push(await runVariant(args, variant));
    }
  }

  const violations = thresholds ? evaluateGate(report, thresholds) : [];
  report.thresholdViolations = violations;

  printSummary(report.variants);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(args.outDir, `${stamp}-${args.backend}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);

  const skipped = report.variants.filter((row) => row.skipped);
  const failed = report.variants.filter((row) => !row.skipped && !row.ok);
  let exitCode = 0;
  if (failed.length > 0) {
    console.error(
      `[ablation] ${failed.length} variant(s) failed: ${failed.map((row) => row.name).join(", ")}`,
    );
    exitCode = 1;
  }
  if (args.requireAll && skipped.length > 0) {
    console.error(
      `[ablation] --require-all set but ${skipped.length} variant(s) skipped: ${skipped.map((row) => row.name).join(", ")}`,
    );
    exitCode = 1;
  }
  if (violations.length > 0) {
    console.error("[ablation] threshold gate violations:");
    for (const v of violations) {
      console.error(
        `  ${v.backend}/${v.name}: ${v.avgTokPerSec.toFixed(2)} tok/s < ${v.thresholdTokPerSec.toFixed(2)} tok/s`,
      );
    }
    exitCode = 1;
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
