#!/usr/bin/env node
/**
 * Eliza-1 local-embedding latency / throughput / cold-load / peak-RSS
 * harness.
 *
 * Per `packages/inference/AGENTS.md` §1 the embedding model is either the
 * text backbone with `--pooling last` (`0_6b`) or a dedicated
 * `embedding/eliza-1-embedding.gguf` (Qwen3-Embedding-0.6B) on the larger
 * tiers. This harness drives a `llama-server --embeddings --pooling last`
 * over a GGUF and measures:
 *   - cold-load time of the embedding region (spawn → /health),
 *   - single-text embed latency (median over N runs),
 *   - batch-embed throughput (texts/sec) at a few batch sizes,
 *   - peak RSS of the server process,
 *   - cosine-similarity preservation at each Matryoshka width
 *     {64,128,256,512,768} vs the full 1024-dim vector (the "quality"
 *     proxy when MTEB isn't available offline).
 *
 * It runs on whatever backend the resolved `llama-server` binary was
 * built for (CPU / Vulkan / CUDA); pass `--backend cpu|vulkan|cuda` to
 * select a specific build, or `--bin PATH` to point at one directly.
 *
 * Like the other verify harnesses, when no binary / model is available it
 * writes a structured `status: "skipped"` report and exits 0 — it does
 * NOT fabricate numbers (AGENTS.md §3).
 *
 * Usage:
 *   node packages/inference/verify/embedding_bench.mjs \
 *     [--bin PATH] [--backend cpu|vulkan|cuda] [--model PATH] \
 *     [--runs 30] [--threads 24] [--report PATH] [--json]
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const out = {
    bin: null,
    backend: null,
    model: null,
    runs: 30,
    threads: Math.max(1, os.cpus().length),
    report: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--bin") out.bin = argv[++i];
    else if (a === "--backend") out.backend = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--runs") out.runs = Number.parseInt(argv[++i], 10) || 30;
    else if (a === "--threads") out.threads = Number.parseInt(argv[++i], 10) || out.threads;
    else if (a === "--report") out.report = argv[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

function firstExisting(...candidates) {
  return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}

function resolveBinary(opts) {
  if (opts.bin) return fs.existsSync(opts.bin) ? opts.bin : null;
  const cacheRoots = [
    path.join(os.homedir(), ".cache", "eliza-dflash", "eliza-llama-cpp", "build"),
    path.join(os.homedir(), ".cache", "eliza-dflash", "buun-llama-cpp", "build"),
    path.join(os.homedir(), ".eliza", "local-inference", "bin", "dflash"),
  ];
  const platform = `${process.platform}-${process.arch}`.replace("darwin", "darwin").replace("linux", "linux");
  const backends = opts.backend ? [opts.backend] : ["cuda", "vulkan", "cpu"];
  const candidates = [];
  for (const root of cacheRoots) {
    for (const b of backends) {
      candidates.push(path.join(root, `${platform === "linux-x64" ? "linux-x64" : platform}-${b}`, "bin", "llama-server"));
      candidates.push(path.join(root, `linux-x64-${b}`, "bin", "llama-server"));
      candidates.push(path.join(root, `${b}`, "bin", "llama-server"));
      candidates.push(path.join(root, `linux-x64-${b}`, "llama-server"));
    }
  }
  return firstExisting(...candidates);
}

function resolveModel(opts) {
  if (opts.model) return fs.existsSync(opts.model) ? opts.model : null;
  const home = os.homedir();
  const modelsRoot = path.join(home, ".eliza", "local-inference", "models");
  const candidates = [];
  // A real dedicated embedding region, if any bundle ships it.
  for (const tier of ["1_7b", "9b", "27b"]) {
    const dir = path.join(modelsRoot, `eliza-1-${tier}.bundle`, "embedding");
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (/\.gguf$/i.test(f)) candidates.push(path.join(dir, f));
      }
    }
  }
  // Qwen3-Embedding-0.6B lineage stand-in (also the 0_6b text backbone base).
  candidates.push(path.join("/tmp", "eliza1-eval-models", "Qwen3-0.6B-Q8_0.gguf"));
  candidates.push(path.join(modelsRoot, "eliza-1-0_6b.bundle", "text", "eliza-1-0_6b-32k.gguf"));
  candidates.push(path.join(modelsRoot, "SmolLM2-360M-Instruct-Q4_K_M.gguf"));
  return firstExisting(...candidates);
}

function backendOfBinary(binPath) {
  const lc = (binPath || "").toLowerCase();
  if (lc.includes("metal")) return "metal";
  if (lc.includes("vulkan")) return "vulkan";
  if (lc.includes("cuda")) return "cuda";
  if (lc.includes("rocm") || lc.includes("hip")) return "rocm";
  return "cpu";
}

async function pickPort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      srv.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readRssKb(pid) {
  try {
    if (process.platform === "linux") {
      const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
      const pages = Number.parseInt(statm[1], 10); // resident pages
      return Math.round((pages * 4096) / 1024);
    }
  } catch {}
  return null;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function l2norm(v, dim) {
  const s = v.slice(0, dim);
  let ss = 0;
  for (const x of s) ss += x * x;
  if (ss === 0) return s;
  const inv = 1 / Math.sqrt(ss);
  return s.map((x) => x * inv);
}

const MATRYOSHKA_DIMS = [64, 128, 256, 512, 768, 1024];

// A small heterogeneous corpus — short factual sentences spanning a few
// topics so cosine-preservation at truncated dims isn't measured on
// near-identical inputs.
const CORPUS = [
  "The mitochondria is the powerhouse of the cell.",
  "Paris is the capital of France and sits on the Seine.",
  "TypeScript adds static types on top of JavaScript.",
  "A llama is a domesticated South American camelid.",
  "Quantum entanglement links the states of two particles.",
  "The Pacific Ocean is the largest and deepest ocean on Earth.",
  "Photosynthesis converts light energy into chemical energy in plants.",
  "The HTTP 404 status code means the resource was not found.",
  "Mount Everest is the highest mountain above sea level.",
  "Embeddings map text into a dense vector space for retrieval.",
  "The French Revolution began in 1789.",
  "A binary search runs in logarithmic time on a sorted array.",
  "Caffeine is a stimulant found in coffee and tea.",
  "The speed of light in vacuum is about 299,792 kilometres per second.",
  "Git is a distributed version control system.",
  "The Great Barrier Reef is off the coast of Queensland, Australia.",
];

async function embedBatch(baseUrl, texts) {
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: texts }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`/v1/embeddings HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  const json = await res.json();
  return (json.data || []).map((d) => d.embedding);
}

function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const reportPath =
    opts.report || path.join(__dirname, "bench_results", `embedding_${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const bin = resolveBinary(opts);
  const model = resolveModel(opts);
  const baseReport = {
    tool: "embedding_bench",
    date: new Date().toISOString(),
    host: os.cpus()[0]?.model ?? "unknown",
    cpus: os.cpus().length,
    totalRamMb: Math.round(os.totalmem() / 1024 / 1024),
  };

  if (!bin || !model) {
    const skipped = {
      ...baseReport,
      status: "skipped",
      reason: !bin
        ? "no llama-server binary found (build one: node packages/app-core/scripts/build-llama-cpp-dflash.mjs --target linux-x64-cpu)"
        : "no embedding GGUF found (point --model at an embedding/ GGUF or Qwen3-Embedding-0.6B / Qwen3-0.6B)",
      resolved: { bin, model },
    };
    fs.writeFileSync(reportPath, JSON.stringify(skipped, null, 2));
    if (opts.json) console.log(JSON.stringify(skipped, null, 2));
    else console.log(`[embedding-bench] SKIPPED: ${skipped.reason}\n[embedding-bench] report → ${reportPath}`);
    return;
  }

  const backend = backendOfBinary(bin);
  const host = "127.0.0.1";
  const port = await pickPort();
  const args = [
    "-m", model,
    "--host", host,
    "--port", String(port),
    "--ctx-size", "8192",
    // -ub == -b so a multi-input /v1/embeddings call is one ubatch, not
    // chunked at the 512-token default; --parallel 16 lets the inputs ride
    // one forward pass instead of being serialized under --pooling last.
    "--batch-size", "4096",
    "--ubatch-size", "4096",
    "--parallel", "16",
    "--threads", String(opts.threads),
    "--n-gpu-layers", "99",
    "--embeddings",
    "--pooling", "last",
  ];

  const tColdStart = Date.now();
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  child.stdout?.on("data", (c) => (serverLog += c.toString()));
  child.stderr?.on("data", (c) => (serverLog += c.toString()));

  let peakRssKb = 0;
  const rssTimer = setInterval(() => {
    const rss = readRssKb(child.pid);
    if (rss && rss > peakRssKb) peakRssKb = rss;
  }, 200);

  // Wait for health.
  let healthy = false;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`http://${host}:${port}/health`);
      if (r.ok) { healthy = true; break; }
    } catch {}
    await sleep(150);
  }
  const coldLoadMs = Date.now() - tColdStart;

  const cleanup = async () => {
    clearInterval(rssTimer);
    try { child.kill("SIGTERM"); } catch {}
    await sleep(300);
    try { if (child.exitCode === null) child.kill("SIGKILL"); } catch {}
  };

  if (!healthy) {
    await cleanup();
    const failed = {
      ...baseReport,
      status: "failed",
      reason: `llama-server (${bin}) did not become healthy within 90s`,
      backend,
      model,
      serverLogTail: serverLog.split("\n").slice(-25).join("\n"),
    };
    fs.writeFileSync(reportPath, JSON.stringify(failed, null, 2));
    if (opts.json) console.log(JSON.stringify(failed, null, 2));
    else console.error(`[embedding-bench] FAILED: ${failed.reason}\n[embedding-bench] report → ${reportPath}`);
    process.exitCode = 1;
    return;
  }

  const baseUrl = `http://${host}:${port}`;
  let result;
  try {
    // Determine the model's embedding dimension from one call.
    const probe = await embedBatch(baseUrl, [CORPUS[0]]);
    const modelDim = probe[0]?.length ?? 0;

    // Single-text latency (median of `runs`, after a warmup).
    await embedBatch(baseUrl, [CORPUS[0]]);
    const singleLatencies = [];
    for (let i = 0; i < opts.runs; i += 1) {
      const t0 = performance.now();
      await embedBatch(baseUrl, [CORPUS[i % CORPUS.length]]);
      singleLatencies.push(performance.now() - t0);
    }

    // Batch throughput at a few sizes (texts/sec = batch / wall).
    const batchSizes = [1, 4, 8, 16].filter((b) => b <= CORPUS.length);
    const throughput = {};
    for (const bsz of batchSizes) {
      const reps = Math.max(3, Math.ceil(opts.runs / bsz));
      const walls = [];
      for (let r = 0; r < reps; r += 1) {
        const batch = [];
        for (let k = 0; k < bsz; k += 1) batch.push(CORPUS[(r * bsz + k) % CORPUS.length]);
        const t0 = performance.now();
        await embedBatch(baseUrl, batch);
        walls.push(performance.now() - t0);
      }
      const medWall = median(walls);
      throughput[`batch_${bsz}`] = {
        median_wall_ms: Number(medWall.toFixed(2)),
        texts_per_sec: Number((bsz / (medWall / 1000)).toFixed(1)),
      };
    }

    // Matryoshka cosine-preservation: full corpus → full vectors; then for
    // each truncated width, average cos(truncate(v, dim), v_full[:dim]) ...
    // measured as cos(truncate_renorm(v, dim), truncate_renorm(v, 1024)[:dim])
    // which is just cos of the leading slices. The interesting number is how
    // well *pairwise rankings* survive — approximate that with the mean
    // pairwise-cosine correlation between full and truncated.
    const fullVecs = await embedBatch(baseUrl, CORPUS);
    const dims = MATRYOSHKA_DIMS.filter((d) => d <= modelDim);
    const matryoshka = {};
    // Pairwise cosine matrix at 1024 (or modelDim).
    const fullPairs = [];
    for (let i = 0; i < fullVecs.length; i += 1)
      for (let j = i + 1; j < fullVecs.length; j += 1)
        fullPairs.push(cosine(fullVecs[i], fullVecs[j]));
    for (const dim of dims) {
      const truncated = fullVecs.map((v) => l2norm(v, dim));
      const pairs = [];
      for (let i = 0; i < truncated.length; i += 1)
        for (let j = i + 1; j < truncated.length; j += 1)
          pairs.push(cosine(truncated[i], truncated[j]));
      // Spearman-ish: rank-correlation between fullPairs and pairs.
      const rho = pearson(fullPairs, pairs);
      // Mean self-cosine: how aligned the truncated slice is with the full
      // vector's leading slice (sanity — should be 1.0 by construction since
      // truncate is a prefix; kept for the table's "alignment" column).
      matryoshka[`dim_${dim}`] = {
        bytes_per_vec_fp32: dim * 4,
        bytes_per_vec_fp16: dim * 2,
        storage_fraction_vs_1024: Number((dim / modelDim).toFixed(3)),
        pairwise_ranking_pearson_vs_full: Number(rho.toFixed(4)),
      };
    }

    result = {
      ...baseReport,
      status: "ok",
      backend,
      binary: bin,
      model,
      modelDim,
      threads: opts.threads,
      runs: opts.runs,
      coldLoadMs,
      peakRssMb: Number((peakRssKb / 1024).toFixed(1)),
      singleTextEmbed: {
        median_ms: Number(median(singleLatencies).toFixed(2)),
        p10_ms: Number(percentile(singleLatencies, 10).toFixed(2)),
        p90_ms: Number(percentile(singleLatencies, 90).toFixed(2)),
      },
      throughput,
      matryoshka,
      note:
        "Server: llama-server --embeddings --pooling last over the GGUF. " +
        "`pairwise_ranking_pearson_vs_full` is the Pearson correlation between the corpus's pairwise-cosine matrix at the truncated width and at the full width — a cheap offline proxy for retrieval-ranking preservation when MTEB isn't available. " +
        "On 0_6b the GGUF IS the text backbone (pooled-text mode); on 1_7b+ it should be the dedicated embedding/eliza-1-embedding.gguf (Qwen3-Embedding-0.6B).",
    };
  } catch (err) {
    result = {
      ...baseReport,
      status: "failed",
      backend,
      model,
      reason: err instanceof Error ? err.message : String(err),
      serverLogTail: serverLog.split("\n").slice(-25).join("\n"),
    };
    process.exitCode = 1;
  } finally {
    await cleanup();
  }

  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2));
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`[embedding-bench] ${result.status} backend=${result.backend} model=${path.basename(model)}`);
    if (result.status === "ok") {
      console.log(`  cold-load=${result.coldLoadMs}ms  peakRSS=${result.peakRssMb}MB  single=${result.singleTextEmbed.median_ms}ms  modelDim=${result.modelDim}`);
      for (const [k, v] of Object.entries(result.throughput)) console.log(`  ${k}: ${v.texts_per_sec} texts/s (${v.median_wall_ms}ms)`);
      for (const [k, v] of Object.entries(result.matryoshka)) console.log(`  ${k}: storage=${(v.storage_fraction_vs_1024 * 100).toFixed(1)}%  rankPearson=${v.pairwise_ranking_pearson_vs_full}`);
    }
    console.log(`[embedding-bench] report → ${reportPath}`);
  }
}

function percentile(xs, p) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i += 1) { sa += a[i]; sb += b[i]; }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da === 0 || db === 0) return 1;
  return num / Math.sqrt(da * db);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
