#!/usr/bin/env node
/**
 * Local evidence reviewer for screenshots, videos, logs, trajectories, and
 * reports produced by the repo's existing verification lanes. It scans the
 * evidence silos, computes deterministic image heuristics, runs packaged OCR,
 * writes `evidence/manifest.json`, and generates a single browser dashboard for
 * the manual "capturing is not reviewing" pass.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeOcrEngines,
  ocrImage,
  resolveOcrEngine,
} from "../../packages/app/scripts/mvp-visual-verify/ocr.mjs";
import {
  analyzeImageFile,
  classifyArtifactPath,
  htmlEscape,
  inferSource,
  summarizeTextPreview,
  toPosixPath,
} from "./lib.mjs";

// sharp is not imported here: all pixel work runs inside
// @elizaos/evidence/visual-primitives (reached via lib.mjs and ocr.mjs), which
// owns the only `sharp` this repo resolves from a root-level script. Importing
// it here fails module resolution (sharp is nested under the evidence package),
// which is why analyzeImageFile no longer takes a sharp handle.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "evidence");
const MAX_TEXT_BYTES = 256 * 1024;
const DEFAULT_SCAN_DIRS = [
  "evidence",
  "e2e-recordings",
  "device-e2e-output",
  "packages/app/aesthetic-audit-output",
  "packages/app/device-e2e-output",
  "packages/app/ios/build/boot-capture",
  "packages/app/ios/build/device-logs",
  "packages/app/test-results",
  "packages/app/reports/walkthrough",
  "packages/scenario-runner/reports",
  "reports/live-test-runs",
  "reports/walkthrough",
];
const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".turbo",
  "dist",
  "build",
  ".codex-pr-worktrees",
]);

function parseArgs(argv) {
  const options = {
    outputDir: DEFAULT_OUTPUT_DIR,
    open: false,
    ocr: "on",
    maxArtifacts: 900,
    maxImages: 240,
    maxFilesPerDir: 6000,
    scanDirs: [],
    bundleDir: null,
  };
  for (const arg of argv) {
    if (arg === "--open") options.open = true;
    else if (arg === "--no-open") options.open = false;
    else if (arg.startsWith("--out=")) {
      options.outputDir = path.resolve(REPO_ROOT, arg.slice("--out=".length));
    } else if (arg.startsWith("--ocr=")) {
      options.ocr = arg.slice("--ocr=".length);
    } else if (arg.startsWith("--max-images=")) {
      options.maxImages = Number.parseInt(
        arg.slice("--max-images=".length),
        10,
      );
    } else if (arg.startsWith("--max-artifacts=")) {
      options.maxArtifacts = Number.parseInt(
        arg.slice("--max-artifacts=".length),
        10,
      );
    } else if (arg.startsWith("--max-files-per-dir=")) {
      options.maxFilesPerDir = Number.parseInt(
        arg.slice("--max-files-per-dir=".length),
        10,
      );
    } else if (arg.startsWith("--source=")) {
      options.scanDirs.push(arg.slice("--source=".length));
    } else if (arg.startsWith("--bundle=")) {
      options.bundleDir = path.resolve(
        REPO_ROOT,
        arg.slice("--bundle=".length),
      );
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.maxImages) || options.maxImages < 0) {
    throw new Error("--max-images must be a non-negative number");
  }
  if (!Number.isFinite(options.maxArtifacts) || options.maxArtifacts < 100) {
    throw new Error("--max-artifacts must be at least 100");
  }
  if (!["auto", "on", "off"].includes(options.ocr)) {
    throw new Error("--ocr must be auto, on, or off");
  }
  if (
    !Number.isFinite(options.maxFilesPerDir) ||
    options.maxFilesPerDir < 100
  ) {
    throw new Error("--max-files-per-dir must be at least 100");
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/evidence-review/generate.mjs [options]

Options:
  --open                  Open the generated dashboard in the browser.
  --no-open               Do not open the dashboard.
  --out=<dir>             Output directory. Default: evidence/
  --source=<dir>          Scan a specific directory. Repeatable.
  --bundle=<dir>          Read an evidence bundle's manifest.json (the @elizaos/evidence
                          BundleManifest inventory) and review its artifacts. Used alone
                          it reviews only that bundle; add --source to also scan silos.
  --ocr=on|auto|off       Run OCR with the packaged tesseract.js engine. Default: on.
  --max-artifacts=<n>     Limit total artifacts in the dashboard. Default: 900.
  --max-images=<n>        Limit image heuristic work. Default: 240.
  --max-files-per-dir=<n> Bound each scan root. Default: 6000.`);
}

function dirExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveScanDirs(options) {
  const dirs =
    options.scanDirs.length > 0 ? options.scanDirs : DEFAULT_SCAN_DIRS;
  return dirs
    .map((dir) => path.resolve(REPO_ROOT, dir))
    .filter((dir) => dirExists(dir));
}

async function runOcr(filePath, options) {
  if (options.ocr === "off") {
    return { status: "disabled", text: "" };
  }
  const result = await ocrImage(filePath);
  if (!result.available) {
    return {
      status: options.ocr === "on" ? "failed" : "unavailable",
      text: "",
      error: result.reason,
    };
  }
  return {
    status: "ok",
    engine: result.engine,
    text: summarizeTextPreview(result.text, 1800).trim(),
  };
}

function readTextPreview(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_TEXT_BYTES) {
      const fd = fs.openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(MAX_TEXT_BYTES);
        const bytesRead = fs.readSync(fd, buffer, 0, MAX_TEXT_BYTES, 0);
        return `${summarizeTextPreview(buffer.subarray(0, bytesRead).toString("utf8"))}\n...[truncated ${stat.size - bytesRead} bytes]`;
      } finally {
        fs.closeSync(fd);
      }
    }
    return summarizeTextPreview(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return `Could not read preview: ${error?.message || error}`;
  }
}

function walkFiles(scanRoot, maxFiles) {
  const files = [];
  const stack = [scanRoot];
  while (stack.length > 0 && files.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        const type = classifyArtifactPath(full);
        if (type) files.push({ full, type });
      }
    }
  }
  return files.sort((a, b) => a.full.localeCompare(b.full));
}

/**
 * Build one reviewer artifact record: stat plus the OCR/image heuristics for
 * screenshots and a text preview for logs/reports. Shared by the silo scan and
 * the `--bundle` manifest reader so both render through exactly the same
 * pipeline; `counters` carries the running id, image-analysis budget, and OCR
 * tallies across both sources.
 */
async function buildArtifactRecord(full, meta, options, counters) {
  const stat = fs.statSync(full);
  const artifact = {
    id: `${counters.nextId++}`,
    type: meta.type,
    source: meta.source,
    path: toPosixPath(path.relative(REPO_ROOT, full)),
    href: toPosixPath(path.relative(options.outputDir, full)),
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
  };
  if (meta.bundleRunId) artifact.bundleRunId = meta.bundleRunId;
  if (meta.type === "image") {
    if (options.ocr !== "off") {
      artifact.ocr = await runOcr(full, options);
      if (artifact.ocr.status === "ok") counters.ocrOk += 1;
      else if (options.ocr === "on") counters.ocrFail += 1;
    }
    if (counters.imageAnalysis < options.maxImages) {
      counters.imageAnalysis += 1;
      try {
        artifact.image = await analyzeImageFile(full);
      } catch (error) {
        artifact.imageError = error?.message || String(error);
      }
    } else {
      artifact.imageSkipped = "max image analysis limit reached";
    }
  } else if (
    meta.type === "log" ||
    meta.type === "report" ||
    meta.type === "trajectory" ||
    meta.type === "viewer"
  ) {
    artifact.preview = readTextPreview(full);
  }
  return artifact;
}

/**
 * The @elizaos/evidence BundleManifest artifact kinds mapped onto the reviewer's
 * coarser artifact types. `screenshot`/`keyframe` are pixels the image
 * heuristics and OCR run over; `analysis`/`qa`/`report` render as inspectable
 * text. An unlisted kind falls back to extension-based classification.
 */
const BUNDLE_KIND_TO_TYPE = {
  screenshot: "image",
  keyframe: "image",
  video: "video",
  log: "log",
  trajectory: "trajectory",
  report: "report",
  analysis: "report",
  qa: "report",
  "html-tree": "viewer",
};

/**
 * Read and structurally validate an evidence bundle's `manifest.json` — the
 * signed artifact inventory @elizaos/evidence writes (schema 1). This is
 * untrusted disk input (error-policy:J3): a missing or malformed manifest throws
 * an explicit error rather than silently reviewing a partial/forged inventory.
 */
function readBundleManifest(bundleDir) {
  const manifestPath = path.join(bundleDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `--bundle: no manifest.json in ${toPosixPath(path.relative(REPO_ROOT, bundleDir))} (expected an @elizaos/evidence bundle directory)`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `--bundle: ${manifestPath} is not valid JSON: ${error?.message || error}`,
    );
  }
  if (manifest?.schema !== 1 || !Array.isArray(manifest.artifacts)) {
    throw new Error(
      `--bundle: ${manifestPath} is not a schema-1 bundle manifest (need { schema: 1, artifacts: [] })`,
    );
  }
  return manifest;
}

/**
 * Append reviewer artifacts read from a bundle manifest. Each listed file's
 * absolute path is recorded in `seen` so the subsequent silo scan does not
 * re-add the same bytes when the bundle lives under a scan root. A manifest
 * entry whose path escapes the bundle, or names a file missing from disk, throws
 * — a bundle's signed inventory must match its contents.
 */
async function collectBundleArtifacts(bundleDir, options, counters, seen, out) {
  const manifest = readBundleManifest(bundleDir);
  const runId = typeof manifest.runId === "string" ? manifest.runId : null;
  for (const entry of manifest.artifacts) {
    if (out.length >= options.maxArtifacts) break;
    const rel = typeof entry?.path === "string" ? entry.path : "";
    const full = path.resolve(bundleDir, rel);
    if (full !== bundleDir && !full.startsWith(bundleDir + path.sep)) {
      throw new Error(
        `--bundle: artifact path ${JSON.stringify(rel)} escapes the bundle directory`,
      );
    }
    if (!fs.existsSync(full)) {
      throw new Error(
        `--bundle: manifest lists ${rel || "(empty path)"} but it is missing from the bundle`,
      );
    }
    seen.add(full);
    const type = BUNDLE_KIND_TO_TYPE[entry.kind] ?? classifyArtifactPath(full);
    if (!type) continue;
    const source =
      typeof entry.source === "string" && entry.source
        ? entry.source
        : inferSource(REPO_ROOT, full);
    out.push(
      await buildArtifactRecord(
        full,
        { type, source, bundleRunId: runId },
        options,
        counters,
      ),
    );
  }
}

async function collectArtifacts(options) {
  // A bare --bundle reviews just that bundle; the default silos are scanned only
  // when no bundle is given, or alongside a bundle when --source is explicit.
  const scanDirs =
    options.bundleDir && options.scanDirs.length === 0
      ? []
      : resolveScanDirs(options);
  const ocrEngine =
    options.ocr === "off"
      ? { available: false, kind: "disabled", label: null, reason: null }
      : await resolveOcrEngine();
  if (options.ocr === "on" && !ocrEngine.available) {
    throw new Error(
      `OCR is required but unavailable: ${ocrEngine.reason}. Run \`bun install\` so the packaged tesseract.js dependency is available, or set ELIZA_TESSERACT_BIN to a system tesseract binary.`,
    );
  }
  const counters = { nextId: 1, imageAnalysis: 0, ocrOk: 0, ocrFail: 0 };
  const artifacts = [];
  // Absolute paths already emitted, so a bundle under a scan root is not listed
  // twice: the bundle read wins, the silo scan skips those files.
  const seen = new Set();

  if (options.bundleDir) {
    await collectBundleArtifacts(
      options.bundleDir,
      options,
      counters,
      seen,
      artifacts,
    );
  }

  for (const scanRoot of scanDirs) {
    if (artifacts.length >= options.maxArtifacts) break;
    const files = walkFiles(scanRoot, options.maxFilesPerDir);
    for (const { full, type } of files) {
      if (artifacts.length >= options.maxArtifacts) break;
      if (seen.has(full)) continue;
      seen.add(full);
      artifacts.push(
        await buildArtifactRecord(
          full,
          { type, source: inferSource(REPO_ROOT, full) },
          options,
          counters,
        ),
      );
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    outputDir: options.outputDir,
    scanDirs: scanDirs.map((dir) => toPosixPath(path.relative(REPO_ROOT, dir))),
    bundleDir: options.bundleDir
      ? toPosixPath(path.relative(REPO_ROOT, options.bundleDir))
      : null,
    ocr: {
      mode: options.ocr,
      engine: ocrEngine.available ? ocrEngine.label : null,
      available: options.ocr === "off" ? false : Boolean(ocrEngine.available),
      ok: counters.ocrOk,
      failures: counters.ocrFail,
    },
    artifacts,
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function percent(value) {
  if (!Number.isFinite(value)) return "0.0%";
  return `${(value * 100).toFixed(1)}%`;
}

function artifactStatus(artifact) {
  if (artifact.imageError) return { label: "analysis error", cls: "bad" };
  if (artifact.image?.issues?.length) return { label: "review", cls: "warn" };
  if (artifact.type === "viewer") return { label: "viewer", cls: "info" };
  return { label: artifact.type, cls: "ok" };
}

function buildCard(artifact) {
  const status = artifactStatus(artifact);
  const dominant = artifact.image?.dominantColors ?? [];
  const textSnippet =
    artifact.ocr?.text ||
    (artifact.preview ? artifact.preview.slice(0, 900) : "") ||
    "";
  const issueText = [
    ...(artifact.image?.issues ?? []),
    artifact.imageError,
    artifact.ocr?.error,
  ]
    .filter(Boolean)
    .join("; ");

  let media = "";
  if (artifact.type === "image") {
    media = `<button class="thumb-button" data-img="${htmlEscape(artifact.href)}" data-caption="${htmlEscape(artifact.path)}"><img loading="lazy" src="${htmlEscape(artifact.href)}" alt="${htmlEscape(artifact.path)}"></button>`;
  } else if (artifact.type === "video") {
    media = `<video controls preload="metadata" src="${htmlEscape(artifact.href)}"></video>`;
  } else {
    media = `<pre>${htmlEscape(textSnippet || artifact.path)}</pre>`;
  }

  return `<article class="card" data-type="${htmlEscape(artifact.type)}" data-source="${htmlEscape(artifact.source)}" data-search="${htmlEscape(`${artifact.path} ${artifact.source} ${textSnippet} ${issueText}`.toLowerCase())}">
    <div class="media">${media}</div>
    <div class="body">
      <div class="row">
        <span class="pill ${status.cls}">${htmlEscape(status.label)}</span>
        <span class="source">${htmlEscape(artifact.source)}</span>
      </div>
      <h2>${htmlEscape(path.basename(artifact.path))}</h2>
      <p class="path">${htmlEscape(artifact.path)}</p>
      <p class="meta">${htmlEscape(formatBytes(artifact.bytes))} | ${htmlEscape(artifact.mtime)}</p>
      ${
        artifact.image
          ? `<dl class="metrics">
              <div><dt>Size</dt><dd>${artifact.image.width}x${artifact.image.height}</dd></div>
              <div><dt>Colors</dt><dd>${artifact.image.colorBuckets}</dd></div>
              <div><dt>Dominant</dt><dd>${percent(artifact.image.dominantRatio)}</dd></div>
              <div><dt>Blue</dt><dd>${percent(artifact.image.blueRatio)}</dd></div>
              <div><dt>Orange</dt><dd>${percent(artifact.image.orangeRatio)}</dd></div>
            </dl>`
          : ""
      }
      ${
        dominant.length
          ? `<div class="swatches">${dominant
              .map(
                (color) =>
                  `<span title="${htmlEscape(`${color.hex} ${percent(color.ratio)}`)}" style="background:${htmlEscape(color.hex)}"></span>`,
              )
              .join("")}</div>`
          : ""
      }
      ${
        issueText
          ? `<p class="issues"><strong>Heuristics:</strong> ${htmlEscape(issueText)}</p>`
          : ""
      }
      ${
        artifact.ocr
          ? `<p class="ocr"><strong>OCR:</strong> ${htmlEscape(artifact.ocr.status)}${artifact.ocr.text ? ` - ${htmlEscape(artifact.ocr.text)}` : ""}</p>`
          : ""
      }
      <a class="open-link" href="${htmlEscape(artifact.href)}">Open artifact</a>
    </div>
  </article>`;
}

function buildHtml(manifest) {
  const counts = manifest.artifacts.reduce(
    (acc, artifact) => {
      acc[artifact.type] = (acc[artifact.type] ?? 0) + 1;
      acc.total += 1;
      if (artifact.image?.issues?.length || artifact.imageError)
        acc.review += 1;
      return acc;
    },
    { total: 0, review: 0 },
  );
  const sources = [
    ...new Set(manifest.artifacts.map((artifact) => artifact.source)),
  ].sort();
  const types = [
    ...new Set(manifest.artifacts.map((artifact) => artifact.type)),
  ].sort();
  const ocrLabel =
    manifest.ocr.mode === "off"
      ? "off"
      : `${manifest.ocr.mode}${manifest.ocr.available ? ` available (${manifest.ocr.engine})` : " unavailable"}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidence Review</title>
<style>
  :root { color-scheme: dark; --bg:#101010; --panel:#171717; --panel2:#202020; --line:#313131; --txt:#eeeeee; --muted:#a1a1a1; --accent:#ff6a00; --warn:#f59e0b; --bad:#ef4444; --ok:#22c55e; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:13px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
  header { padding:24px 28px 14px; border-bottom:1px solid var(--line); background:#0d0d0d; position:sticky; top:0; z-index:10; }
  h1 { margin:0 0 6px; font-size:22px; letter-spacing:0; }
  .subtitle { color:var(--muted); margin:0 0 14px; }
  .stats { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
  .stat { border:1px solid var(--line); background:var(--panel); border-radius:6px; padding:6px 10px; }
  .toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  input, select { background:var(--panel2); color:var(--txt); border:1px solid var(--line); border-radius:6px; padding:8px 10px; min-height:36px; }
  input { min-width:260px; flex:1; }
  main { padding:20px 28px 48px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; min-width:0; }
  .media { background:#090909; min-height:150px; display:flex; align-items:center; justify-content:center; border-bottom:1px solid var(--line); }
  .media img { width:100%; height:230px; object-fit:contain; display:block; }
  .media video { width:100%; max-height:280px; display:block; }
  .media pre { width:100%; max-height:230px; overflow:auto; margin:0; padding:12px; white-space:pre-wrap; color:#d7d7d7; }
  .thumb-button { all:unset; display:block; width:100%; cursor:zoom-in; }
  .body { padding:12px; }
  .row { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .pill { border-radius:999px; padding:2px 8px; font-size:11px; font-weight:700; text-transform:uppercase; color:#111; }
  .pill.ok { background:var(--ok); }
  .pill.warn { background:var(--warn); }
  .pill.bad { background:var(--bad); color:#fff; }
  .pill.info { background:#b4b4b4; }
  .source { color:var(--muted); font-size:12px; }
  h2 { font-size:15px; line-height:1.25; margin:0 0 6px; overflow-wrap:anywhere; }
  .path, .meta { color:var(--muted); margin:0 0 8px; overflow-wrap:anywhere; }
  .metrics { display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:6px; margin:10px 0; }
  .metrics div { background:var(--panel2); border:1px solid var(--line); border-radius:6px; padding:6px; min-width:0; }
  dt { color:var(--muted); font-size:10px; text-transform:uppercase; }
  dd { margin:0; font-weight:700; }
  .swatches { display:flex; gap:5px; margin:8px 0; }
  .swatches span { width:22px; height:22px; border-radius:4px; border:1px solid rgba(255,255,255,.18); }
  .issues { color:#ffd08a; }
  .ocr { color:#d5d5d5; max-height:90px; overflow:auto; }
  .open-link { color:var(--accent); text-decoration:none; font-weight:700; }
  #lightbox { display:none; position:fixed; inset:0; background:rgba(0,0,0,.92); z-index:99; align-items:center; justify-content:center; padding:34px; }
  #lightbox.open { display:flex; }
  #lightbox img { max-width:94vw; max-height:86vh; border-radius:8px; box-shadow:0 14px 70px rgba(0,0,0,.75); }
  #lightbox button { position:fixed; top:18px; right:22px; background:var(--panel2); border:1px solid var(--line); color:var(--txt); border-radius:6px; padding:7px 11px; cursor:pointer; }
  #caption { position:fixed; bottom:18px; left:24px; right:24px; text-align:center; color:var(--muted); overflow-wrap:anywhere; }
  @media (max-width: 720px) { header, main { padding-left:14px; padding-right:14px; } .grid { grid-template-columns:1fr; } .metrics { grid-template-columns:repeat(2, minmax(0,1fr)); } }
</style>
</head>
<body>
<header>
  <h1>Evidence Review</h1>
  <p class="subtitle">Generated ${htmlEscape(manifest.generatedAt)} from ${htmlEscape([manifest.bundleDir ? `bundle ${manifest.bundleDir}` : null, ...manifest.scanDirs].filter(Boolean).join(", "))}. OCR: ${htmlEscape(ocrLabel)}.</p>
  <div class="stats">
    <span class="stat">${counts.total} artifacts</span>
    <span class="stat">${counts.image ?? 0} screenshots</span>
    <span class="stat">${counts.video ?? 0} videos</span>
    <span class="stat">${counts.log ?? 0} logs</span>
    <span class="stat">${counts.trajectory ?? 0} trajectories</span>
    <span class="stat">${counts.review} need review</span>
  </div>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Search path, source, OCR, preview text">
    <select id="type"><option value="">All types</option>${types.map((type) => `<option>${htmlEscape(type)}</option>`).join("")}</select>
    <select id="source"><option value="">All sources</option>${sources.map((source) => `<option>${htmlEscape(source)}</option>`).join("")}</select>
  </div>
</header>
<main><div id="grid" class="grid">${manifest.artifacts.map(buildCard).join("\n")}</div></main>
<div id="lightbox"><button id="close">Close</button><img id="large" alt=""><div id="caption"></div></div>
<script>
  const search = document.getElementById("search");
  const type = document.getElementById("type");
  const source = document.getElementById("source");
  const cards = [...document.querySelectorAll(".card")];
  function applyFilters() {
    const q = search.value.trim().toLowerCase();
    const t = type.value;
    const s = source.value;
    for (const card of cards) {
      const ok = (!q || card.dataset.search.includes(q)) && (!t || card.dataset.type === t) && (!s || card.dataset.source === s);
      card.style.display = ok ? "" : "none";
    }
  }
  search.addEventListener("input", applyFilters);
  type.addEventListener("change", applyFilters);
  source.addEventListener("change", applyFilters);
  const lb = document.getElementById("lightbox");
  const large = document.getElementById("large");
  const caption = document.getElementById("caption");
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-img]");
    if (!button) return;
    large.src = button.dataset.img;
    caption.textContent = button.dataset.caption || "";
    lb.classList.add("open");
  });
  document.getElementById("close").addEventListener("click", () => lb.classList.remove("open"));
  lb.addEventListener("click", (event) => { if (event.target === lb) lb.classList.remove("open"); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") lb.classList.remove("open"); });
</script>
</body>
</html>`;
}

function openFile(filePath) {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
  spawnSync(opener, args, { stdio: "ignore", detached: true });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(options.outputDir, { recursive: true });

  const manifest = await collectArtifacts(options);
  const manifestPath = path.join(options.outputDir, "manifest.json");
  const indexPath = path.join(options.outputDir, "index.html");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(indexPath, buildHtml(manifest), "utf8");

  const counts = manifest.artifacts.reduce(
    (acc, artifact) => {
      acc[artifact.type] = (acc[artifact.type] ?? 0) + 1;
      acc.total += 1;
      return acc;
    },
    { total: 0 },
  );

  console.log(`Evidence manifest: ${manifestPath}`);
  console.log(`Evidence dashboard: ${indexPath}`);
  console.log(
    `Artifacts: ${counts.total} total, ${counts.image ?? 0} screenshots, ${counts.video ?? 0} videos, ${counts.trajectory ?? 0} trajectories, ${counts.log ?? 0} logs.`,
  );
  if (!manifest.ocr.available && options.ocr !== "off") {
    console.log(
      "OCR: unavailable. Run `bun install` so packaged tesseract.js is installed, or set ELIZA_TESSERACT_BIN.",
    );
  }
  if (options.ocr === "on" && manifest.ocr.failures > 0) {
    console.error(`OCR: ${manifest.ocr.failures} screenshot(s) failed OCR.`);
    process.exitCode = 1;
  }
  if (options.open) openFile(indexPath);
}

main()
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeOcrEngines();
    if (process.exitCode) process.exit(process.exitCode);
  });
