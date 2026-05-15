#!/usr/bin/env node
/**
 * Inventory local Eliza-1 bundle disk footprint and available speed metrics.
 *
 * This is intentionally read-only for bundles. It records file sizes by runtime
 * component, hardlink-aware disk totals, a rough one-active-context mmap
 * footprint, and joins metrics already measured by local eval/bench reports.
 *
 * Usage:
 *   node packages/inference/verify/eliza1_memory_inventory.mjs \
 *     ~/.eliza/local-inference/models/eliza-1-*.bundle
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const REPORT_DIR = path.join(REPO_ROOT, "packages", "inference", "reports", "porting", "2026-05-12");
const BENCH_DIR = path.join(__dirname, "bench_results");

const DEFAULTS = {
  reportJson: path.join(REPORT_DIR, "eliza1-local-bundle-memory-inventory.json"),
  reportMd: path.join(REPORT_DIR, "eliza1-local-bundle-memory-inventory.md"),
  benchJson: path.join(BENCH_DIR, "eliza1_memory_inventory_2026-05-12.json"),
  bundleRoot: path.join(os.homedir(), ".eliza", "local-inference", "models"),
};

const COMPONENT_ORDER = [
  "text",
  "drafter",
  "asr",
  "asrMmproj",
  "ttsBase",
  "ttsTokenizer",
  "vad",
  "vision",
  "quantSidecars",
  "caches",
  "dflashSidecars",
  "manifest",
  "licenses",
  "evals",
  "evidence",
  "source",
  "lineage",
  "other",
];

function parseArgs(argv) {
  const args = {
    bundles: [],
    reportJson: DEFAULTS.reportJson,
    reportMd: DEFAULTS.reportMd,
    benchJson: DEFAULTS.benchJson,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--report-json") args.reportJson = argv[++i];
    else if (a === "--report-md") args.reportMd = argv[++i];
    else if (a === "--bench-json") args.benchJson = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "Usage: node eliza1_memory_inventory.mjs [bundle ...]",
          "  --report-json PATH  default packages/inference/reports/porting/2026-05-12/eliza1-local-bundle-memory-inventory.json",
          "  --report-md PATH    default packages/inference/reports/porting/2026-05-12/eliza1-local-bundle-memory-inventory.md",
          "  --bench-json PATH   default packages/inference/verify/bench_results/eliza1_memory_inventory_2026-05-12.json",
          "  --json              print the JSON report to stdout",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      args.bundles.push(expandHome(a));
    }
  }
  return args;
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultBundles() {
  if (!fs.existsSync(DEFAULTS.bundleRoot)) return [];
  return fs
    .readdirSync(DEFAULTS.bundleRoot)
    .filter((name) => /^eliza-1-.+\.bundle$/.test(name))
    .map((name) => path.join(DEFAULTS.bundleRoot, name))
    .filter((p) => fs.statSync(p).isDirectory())
    .sort((a, b) => tierSortKey(tierFromBundlePath(a)).localeCompare(tierSortKey(tierFromBundlePath(b))));
}

function tierFromBundlePath(bundleDir) {
  const base = path.basename(bundleDir).replace(/\.bundle$/, "");
  return base.replace(/^eliza-1-/, "");
}

function tierSortKey(tier) {
  const order = { "0_8b": "00", "2b": "01", "4b": "02", "9b": "03", "27b": "04", "27b-256k": "05" };
  return `${order[tier] ?? "99"}-${tier}`;
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { parseError: String(err?.message ?? err) };
  }
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) stack.push(abs);
      else if (st.isFile()) out.push({ abs, stat: st, rel: path.relative(root, abs).replaceAll(path.sep, "/") });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function componentFor(rel) {
  const lower = rel.toLowerCase();
  if (lower === ".cache" || lower.startsWith(".cache/") || lower.includes("/.cache/")) return "caches";
  if (lower === "eliza-1.manifest.json") return "manifest";
  if (lower === "lineage.json") return "lineage";
  if (lower.startsWith("text/") && lower.endsWith(".gguf")) return "text";
  if (lower.startsWith("dflash/") && lower.endsWith(".gguf")) return "drafter";
  if (lower.startsWith("dflash/")) return "dflashSidecars";
  if (lower.startsWith("asr/") && lower.includes("mmproj") && lower.endsWith(".gguf")) return "asrMmproj";
  if (lower.startsWith("asr/")) return "asr";
  if (lower.startsWith("tts/") && /(base|model|lm)/.test(lower) && lower.endsWith(".gguf")) return "ttsBase";
  if (lower.startsWith("tts/") && /(tokenizer|codec|dac)/.test(lower) && lower.endsWith(".gguf")) return "ttsTokenizer";
  if (lower.startsWith("tts/")) return "ttsBase";
  if (lower.startsWith("vad/")) return "vad";
  if (lower.startsWith("vision/")) return "vision";
  if (lower.startsWith("quantization/")) return "quantSidecars";
  if (lower.startsWith("cache/")) return "caches";
  if (lower.startsWith("licenses/")) return "licenses";
  if (lower.startsWith("evals/")) return "evals";
  if (lower.startsWith("evidence/")) return "evidence";
  if (lower.startsWith("source/")) return "source";
  return "other";
}

function sizeStats(files) {
  let apparentBytes = 0;
  let uniqueBytes = 0;
  const seen = new Set();
  for (const file of files) {
    apparentBytes += file.bytes;
    const key = `${file.dev}:${file.ino}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueBytes += file.bytes;
    }
  }
  return { apparentBytes, uniqueBytes, fileCount: files.length };
}

function byComponent(fileRows) {
  const grouped = {};
  for (const name of COMPONENT_ORDER) grouped[name] = [];
  for (const file of fileRows) {
    const component = componentFor(file.rel);
    grouped[component] ??= [];
    grouped[component].push(file);
  }
  return Object.fromEntries(
    Object.entries(grouped).map(([component, files]) => [
      component,
      {
        ...sizeStats(files),
        files,
      },
    ]),
  );
}

function manifestFileCtx(manifest, rel) {
  for (const entry of manifest?.files?.text ?? []) {
    if (entry?.path === rel && entry.ctx) return entry.ctx;
  }
  const m = rel.match(/-(\d+)k\.gguf$/i);
  return m ? Number(m[1]) * 1024 : null;
}

function annotateFiles(grouped, manifest) {
  for (const file of grouped.text.files) {
    file.ctx = manifestFileCtx(manifest, file.rel);
  }
}

function maxUniqueBytes(files) {
  if (!files?.length) return 0;
  return Math.max(...files.map((f) => f.bytes));
}

function sumComponentUnique(grouped, names) {
  let sum = 0;
  for (const name of names) sum += grouped[name]?.uniqueBytes ?? 0;
  return sum;
}

function runtimeFootprint(grouped, manifest) {
  const oneTextBytes = maxUniqueBytes(grouped.text.files);
  const textVariantsBytes = grouped.text.uniqueBytes;
  const sharedRuntimeBytes = sumComponentUnique(grouped, [
    "drafter",
    "asr",
    "asrMmproj",
    "ttsBase",
    "ttsTokenizer",
    "vad",
    "vision",
    "quantSidecars",
    "caches",
    "dflashSidecars",
  ]);
  const oneActiveContextBytes = oneTextBytes + sharedRuntimeBytes;
  const componentRuntimeBytes = textVariantsBytes + sharedRuntimeBytes;
  const recommendedBudgetMb = manifest?.ramBudgetMb?.recommended ?? null;
  return {
    componentRuntimeBytes,
    oneActiveContextBytes,
    oneActiveTextBytes: oneTextBytes,
    textVariantsBytes,
    sharedRuntimeBytes,
    mmapVirtualUpperBoundMb: mb(oneActiveContextBytes),
    fileBackedWarmRssUpperBoundMb: mb(oneActiveContextBytes),
    ramBudgetRecommendedMb: recommendedBudgetMb,
    ramBudgetDeltaMb:
      typeof recommendedBudgetMb === "number" ? round(recommendedBudgetMb - mb(oneActiveContextBytes), 1) : null,
    note:
      "Upper bound assumes one text/context variant plus shared voice, ASR, VAD, vision, drafter, sidecars, and cache files are mmaped and touched. Real RSS can be lower from lazy mmap, or reported as device/UMA memory when layers are offloaded.",
  };
}

function metric(value, source, extra = {}) {
  if (value === undefined || value === null || Number.isNaN(value)) return null;
  return { value, source, ...extra };
}

function bestEmbeddingThroughput(obj, source) {
  const through = obj?.throughput;
  if (!through || typeof through !== "object") return null;
  let best = null;
  for (const [batch, row] of Object.entries(through)) {
    const value = row?.texts_per_sec ?? row?.textsPerSec;
    if (typeof value !== "number") continue;
    if (!best || value > best.value) best = metric(value, source, { batch });
  }
  return best;
}

function metricFromTextModelBench(tier) {
  const file = path.join(BENCH_DIR, "text_model_2026-05-11.json");
  const j = readJsonIfExists(file);
  if (!j?.throughput) return null;
  const model = `eliza-1-${tier}`;
  const rows = [];
  for (const [backend, entries] of Object.entries(j.throughput)) {
    if (!Array.isArray(entries)) continue;
    for (const row of entries) {
      if (row?.model === model && /tg/i.test(String(row.test ?? "")) && typeof row.t_per_s === "number") {
        rows.push({ backend, value: row.t_per_s, test: row.test, source: relToRepo(file) });
      }
    }
  }
  rows.sort((a, b) => b.value - a.value);
  return rows[0] ? { value: rows[0].value, source: rows[0].source, backend: rows[0].backend, test: rows[0].test } : null;
}

function collectMetrics(bundleDir, tier, manifest) {
  const evals = path.join(bundleDir, "evals");
  const e2e = readJsonIfExists(path.join(evals, "e2e-loop.json"));
  const e2eBench = readJsonIfExists(path.join(evals, "e2e-loop-bench-30turn.json"));
  const voice = readJsonIfExists(path.join(evals, "voice-rtf.json"));
  const vad = readJsonIfExists(path.join(evals, "vad.json"));
  const dflash = readJsonIfExists(path.join(evals, "dflash-accept.json"));
  const dflashSmoke = readJsonIfExists(path.join(evals, "dflash-runtime-smoke.json"));
  const embeddingBench = readJsonIfExists(path.join(evals, "embedding-bench.json"));
  const embeddingSummary = readJsonIfExists(path.join(evals, "embedding.json"));
  const asrBench = firstExistingJson([
    path.join(evals, "asr-bench-standalone-inconsistent.json"),
    path.join(evals, "asr-bench.json"),
  ]);
  const textTps =
    metric(e2e?.decodeTokPerSecMedian, "evals/e2e-loop.json", { backend: e2e?.backend }) ??
    metric(e2eBench?.summary?.decodeTokPerSecMedian, "evals/e2e-loop-bench-30turn.json", {
      backend: e2eBench?.engine?.backend,
    }) ??
    metricFromTextModelBench(tier);

  const asrRtf =
    metric(asrBench?.json?.aggregate?.rtf, asrBench?.source, { backend: asrBench?.json?.backend }) ??
    metric(invertMsPerAudioSec(e2e?.asrLatencyMsMedian), "evals/e2e-loop.json", {
      caveat: "derived from ASR latency only; no utterance duration available",
    });
  const ttsRtf =
    metric(voice?.rtf, "evals/voice-rtf.json", { backend: voice?.backend }) ??
    metric(e2e?.ttsRtfMedian, "evals/e2e-loop.json", { backend: e2e?.backend });
  const vadLatency = metric(vad?.median, "evals/vad.json", { p95Ms: vad?.p95, boundaryMs: vad?.boundaryMs });
  const embeddingThroughput =
    bestEmbeddingThroughput(embeddingBench, "evals/embedding-bench.json") ??
    bestEmbeddingThroughput(embeddingSummary, "evals/embedding.json");
  const dflashAcceptance =
    metric(dflash?.acceptanceRate, "evals/dflash-accept.json", { speedup: dflash?.speedup }) ??
    metric(dflashSmoke?.summary?.dflashAcceptanceRate, "evals/dflash-runtime-smoke.json", {
      speedup: dflashSmoke?.summary?.dflashSpeedup,
    });

  return {
    textTps,
    asrRtf,
    ttsRtf,
    vadLatencyMs: vadLatency,
    embeddingThroughput,
    dflashAcceptance,
    notes: {
      manifestVoiceRtf: manifest?.evals?.voiceRtf ?? null,
      manifestDflash: manifest?.evals?.dflash ?? null,
      textTpsFallback: textTps?.source?.includes("text_model_2026-05-11") ? "supplemental bench result" : null,
    },
  };
}

function invertMsPerAudioSec(ms) {
  if (typeof ms !== "number" || ms <= 0) return null;
  return 1000 / ms;
}

function firstExistingJson(files) {
  for (const file of files) {
    const json = readJsonIfExists(file);
    if (json && !json.parseError) {
      return { json, source: file.startsWith(DEFAULTS.bundleRoot) ? bundleRelMetricSource(file) : relToRepo(file) };
    }
  }
  return null;
}

function bundleRelMetricSource(file) {
  const marker = "/evals/";
  const idx = file.indexOf(marker);
  return idx >= 0 ? `evals/${file.slice(idx + marker.length)}` : file;
}

function inventoryBundle(bundleDir) {
  const manifest = readJsonIfExists(path.join(bundleDir, "eliza-1.manifest.json"));
  const tier = manifest?.tier ?? tierFromBundlePath(bundleDir);
  const rows = walkFiles(bundleDir).map(({ abs, rel, stat }) => ({
    rel,
    component: componentFor(rel),
    bytes: stat.size,
    mib: mb(stat.size),
    dev: stat.dev,
    ino: stat.ino,
  }));
  const components = byComponent(rows);
  annotateFiles(components, manifest);
  const allFiles = sizeStats(rows);
  return {
    tier,
    id: manifest?.id ?? `eliza-1-${tier}`,
    bundleDir,
    manifestVersion: manifest?.version ?? null,
    publishedAt: manifest?.publishedAt ?? null,
    fileTotals: {
      ...allFiles,
      apparentMiB: mb(allFiles.apparentBytes),
      uniqueMiB: mb(allFiles.uniqueBytes),
    },
    components: Object.fromEntries(
      Object.entries(components).map(([name, group]) => [
        name,
        {
          apparentBytes: group.apparentBytes,
          uniqueBytes: group.uniqueBytes,
          apparentMiB: mb(group.apparentBytes),
          uniqueMiB: mb(group.uniqueBytes),
          fileCount: group.fileCount,
          files: group.files.map(stripStatIdentity),
        },
      ]),
    ),
    runtimeFootprint: runtimeFootprint(components, manifest),
    metrics: collectMetrics(bundleDir, tier, manifest),
  };
}

function stripStatIdentity(file) {
  const out = { path: file.rel, bytes: file.bytes, mib: file.mib };
  if (file.ctx) out.ctx = file.ctx;
  return out;
}

function relToRepo(file) {
  return path.relative(REPO_ROOT, file).replaceAll(path.sep, "/");
}

function mb(bytes) {
  return round(bytes / 1024 / 1024, 2);
}

function gb(bytes) {
  return round(bytes / 1024 / 1024 / 1024, 2);
}

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function fmtMiB(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  return n >= 1024 ? `${round(n / 1024, 2)} GiB` : `${round(n, 1)} MiB`;
}

function fmtMetric(m, suffix = "") {
  if (!m || m.value === null || m.value === undefined) return "n/a";
  const value = typeof m.value === "number" ? round(m.value, 3) : m.value;
  return `${value}${suffix}`;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Eliza-1 Local Bundle Memory and Performance Inventory");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("This report inventories local `~/.eliza/local-inference/models/eliza-1-*.bundle` directories. Size totals include both apparent bytes and hardlink-aware unique bytes; mmap/RSS is a rough one-active-context upper bound, not a live profiler result.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Tier | Unique disk | Runtime files | One active mmap upper bound | RAM budget delta | Text TPS | ASR RTF | TTS RTF | VAD ms | Embed texts/s | DFlash accept |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const b of report.bundles) {
    lines.push(
      [
        b.tier,
        fmtMiB(b.fileTotals.uniqueMiB),
        fmtMiB(mb(b.runtimeFootprint.componentRuntimeBytes)),
        fmtMiB(b.runtimeFootprint.mmapVirtualUpperBoundMb),
        fmtMiB(b.runtimeFootprint.ramBudgetDeltaMb),
        fmtMetric(b.metrics.textTps),
        fmtMetric(b.metrics.asrRtf),
        fmtMetric(b.metrics.ttsRtf),
        fmtMetric(b.metrics.vadLatencyMs),
        fmtMetric(b.metrics.embeddingThroughput),
        fmtMetric(b.metrics.dflashAcceptance),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }
  lines.push("");
  lines.push("## Component Sizes");
  for (const b of report.bundles) {
    lines.push("");
    lines.push(`### ${b.tier}`);
    lines.push("");
    lines.push("| Component | Unique | Apparent | Files |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const name of COMPONENT_ORDER) {
      const c = b.components[name];
      if (!c || c.fileCount === 0) continue;
      lines.push(`| ${name} | ${fmtMiB(c.uniqueMiB)} | ${fmtMiB(c.apparentMiB)} | ${c.fileCount} |`);
    }
    lines.push("");
    lines.push("| Runtime file | Component | Size | Context |");
    lines.push("| --- | --- | ---: | ---: |");
    for (const name of ["text", "drafter", "asr", "asrMmproj", "ttsBase", "ttsTokenizer", "vad", "vision", "quantSidecars", "caches"]) {
      for (const file of b.components[name]?.files ?? []) {
        lines.push(`| \`${file.path}\` | ${name} | ${fmtMiB(file.mib)} | ${file.ctx ?? ""} |`);
      }
    }
    lines.push("");
    lines.push(
      `Mmap/RSS note: one-active-context mmap upper bound is ${fmtMiB(
        b.runtimeFootprint.mmapVirtualUpperBoundMb,
      )}; if all mmaped pages are touched, file-backed RSS can approach that number before allocator, KV/cache, and backend compute buffers. ${b.runtimeFootprint.note}`,
    );
    lines.push("");
    lines.push("Metric sources:");
    for (const [key, value] of Object.entries(b.metrics)) {
      if (!value || key === "notes") continue;
      lines.push(`- ${key}: ${fmtMetric(value)} from \`${value.source}\``);
    }
  }
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  lines.push("- Text variants are counted separately in component totals; one-active-context mmap uses the largest text variant only.");
  lines.push("- Source, evidence, and eval files are included in unique disk totals but excluded from runtime mmap estimates.");
  lines.push("- Missing metrics are left as `n/a`; the tool does not fabricate speed or RSS measurements.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundles = (args.bundles.length ? args.bundles : defaultBundles())
    .filter((p) => fs.existsSync(p) && fs.statSync(p).isDirectory())
    .sort((a, b) => tierSortKey(tierFromBundlePath(a)).localeCompare(tierSortKey(tierFromBundlePath(b))));

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tool: relToRepo(__filename),
    host: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalRamMb: mb(os.totalmem()),
    },
    inputBundles: bundles,
    outputs: {
      reportJson: args.reportJson,
      reportMd: args.reportMd,
      benchJson: args.benchJson,
    },
    bundles: bundles.map(inventoryBundle),
  };

  fs.mkdirSync(path.dirname(args.reportJson), { recursive: true });
  fs.mkdirSync(path.dirname(args.reportMd), { recursive: true });
  fs.mkdirSync(path.dirname(args.benchJson), { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(args.reportJson, json);
  fs.writeFileSync(args.benchJson, json);
  fs.writeFileSync(args.reportMd, renderMarkdown(report));

  if (args.json) console.log(json);
  else {
    console.log(`wrote ${args.reportJson}`);
    console.log(`wrote ${args.reportMd}`);
    console.log(`wrote ${args.benchJson}`);
  }
}

main();
