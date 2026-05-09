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

function defaultModelPath(name) {
  return path.join(stateDir(), "local-inference", "models", name);
}

function parseArgs(argv) {
  const backend = detectBackend();
  const args = {
    backend,
    binary: defaultBinary(backend),
    model: defaultModelPath("qwen3.5-4b-dflash.gguf"),
    drafter: defaultModelPath("qwen3.5-4b-dflash-drafter-q4.repaired.gguf"),
    runs: 3,
    warmupTokens: 32,
    maxTokens: 256,
    contextSize: 6048,
    draftContextSize: 256,
    draftMin: 1,
    draftMax: 16,
    batchSize: 256,
    ubatchSize: 64,
    gpuLayers: 99,
    draftGpuLayers: 99,
    timeoutMs: 180_000,
    startTimeoutMs: 120_000,
    prompt: DEFAULT_PROMPT,
    variants: null,
    outDir: path.join(process.cwd(), "artifacts", "local-inference-ablation"),
    config: null,
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
  return variants.filter(
    (variant) => !variant.needsDrafter || fs.existsSync(args.drafter),
  );
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
    if (row.ok) {
      console.log(
        `${row.name.padEnd(24)} ${row.avgTokPerSec.toFixed(2).padStart(8)} tok/s  (${row.label})`,
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
  if (!fs.existsSync(args.binary))
    throw new Error(`missing llama-server: ${args.binary}`);
  if (!fs.existsSync(args.model))
    throw new Error(`missing target model: ${args.model}`);
  const variants = loadVariants(args);
  if (variants.length === 0) throw new Error("no variants selected");
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
  };

  for (const variant of variants) {
    console.log(`\n[ablation] ${variant.name}: ${variant.label}`);
    report.variants.push(await runVariant(args, variant));
  }

  printSummary(report.variants);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(args.outDir, `${stamp}-${args.backend}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
