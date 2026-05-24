#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const INDEX_DATA_PATH = path.join(
  REPO_ROOT,
  "reports",
  "benchmarks",
  "code-agent-run-index",
  "index-data.js",
);
const DEFAULT_REPORT_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmarks",
  "code-agent-trajectory-catalog",
);
const PLAYBACK_DIR = path.join(DEFAULT_REPORT_DIR, "playback");
const MAX_RECORDS_PER_FILE = 200;
const PREVIEW_CHARS = 6000;

function readIndexData() {
  return JSON.parse(
    readFileSync(INDEX_DATA_PATH, "utf8")
      .replace(/^window\.BENCHMARK_RUN_INDEX = /, "")
      .replace(/;\n?$/, ""),
  );
}

function rel(target, from = DEFAULT_REPORT_DIR) {
  return path.relative(from, target).replaceAll(path.sep, "/");
}

function safeSegment(value) {
  return String(value || "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140) || "unknown";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function listFiles(root) {
  if (!root || !existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && /\.(jsonl|json)$/i.test(entry.name)) out.push(full);
    }
  }
  return out.sort();
}

function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_RECORDS_PER_FILE)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parse_error: true, raw: line.slice(0, PREVIEW_CHARS) };
      }
    });
}

function parseTrajectoryFile(filePath) {
  const text = readFileSync(filePath, "utf8");
  if (filePath.endsWith(".jsonl")) return parseJsonl(text);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.slice(0, MAX_RECORDS_PER_FILE);
    return [parsed];
  } catch {
    return [{ parse_error: true, raw: text.slice(0, PREVIEW_CHARS) }];
  }
}

function preview(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
}

function pick(record, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((acc, part) => acc?.[part], record);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function pickWithSource(record, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((acc, part) => acc?.[part], record);
    if (value !== undefined && value !== null && value !== "") {
      return { key, value };
    }
  }
  return { key: "", value: undefined };
}

function numeric(record, keys) {
  const value = pick(record, keys);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cachePercent(promptTokens, cacheReadTokens) {
  if (!promptTokens || !cacheReadTokens) return null;
  return (cacheReadTokens / promptTokens) * 100;
}

function normalizeRecord(record, index) {
  const input = pickWithSource(record, [
    "prompt_text",
    "input_text",
    "model_input",
    "request.messages",
    "messages",
    "input",
    "prompt",
    "request",
    "message.content",
    "transcript",
  ]);
  const output = pickWithSource(record, [
    "response_text",
    "output_text",
    "completion_text",
    "model_output",
    "response.text",
    "response.message.content",
    "output",
    "response",
    "completion",
    "text",
    "result",
    "message",
  ]);
  const promptTokens = numeric(record, [
    "prompt_tokens",
    "input_tokens",
    "usage.prompt_tokens",
    "usage.input_tokens",
    "token_metrics.input_tokens",
  ]);
  const completionTokens = numeric(record, [
    "completion_tokens",
    "output_tokens",
    "usage.completion_tokens",
    "usage.output_tokens",
    "token_metrics.output_tokens",
  ]);
  const totalTokens =
    numeric(record, ["total_tokens", "usage.total_tokens", "token_metrics.total_tokens"]) ??
    (promptTokens !== null || completionTokens !== null
      ? (promptTokens || 0) + (completionTokens || 0)
      : null);
  const cacheReadTokens = numeric(record, [
    "cache_read_input_tokens",
    "cached_tokens",
    "usage.cache_read_input_tokens",
    "usage.cached_tokens",
    "token_metrics.cached_tokens",
  ]);
  const explicitCachePercent = numeric(record, [
    "cached_token_percent",
    "cache_percent",
    "token_metrics.cached_token_percent",
  ]);
  const taskId = String(
    pick(record, ["task_id", "task", "metadata.task_id", "scenario", "id"]) || "",
  );
  return {
    index,
    taskId,
    step:
      pick(record, [
        "trajectory_step",
        "metadata.trajectory_step",
        "step",
        "turn",
        "message_index",
      ]) ?? index + 1,
    kind: String(pick(record, ["kind", "type", "event", "modelType"]) || "record"),
    model: String(pick(record, ["model", "model_name", "metadata.model_name"]) || ""),
    provider: String(pick(record, ["provider", "model_provider", "metadata.model_provider"]) || ""),
    latencyMs: numeric(record, ["latency_ms", "duration_ms", "durationMs"]),
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens: numeric(record, [
      "cache_creation_input_tokens",
      "cache_creation_tokens",
      "usage.cache_creation_input_tokens",
      "usage.cache_creation_tokens",
    ]),
    cachePercent:
      explicitCachePercent ?? cachePercent(promptTokens || totalTokens, cacheReadTokens),
    actions: Array.isArray(record.actions) ? record.actions.map(String) : [],
    inputSource: input.key,
    outputSource: output.key,
    inputPreview: preview(input.value),
    outputPreview: preview(output.value),
    rawPreview: preview(record),
  };
}

function summarizeRecords(records) {
  const normalized = records.map(normalizeRecord);
  const totals = {
    records: normalized.length,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    latencyMs: 0,
    llmLikeRecords: 0,
  };
  for (const item of normalized) {
    if (typeof item.promptTokens === "number") totals.promptTokens += item.promptTokens;
    if (typeof item.completionTokens === "number") totals.completionTokens += item.completionTokens;
    if (typeof item.totalTokens === "number") totals.totalTokens += item.totalTokens;
    if (typeof item.cacheReadTokens === "number") totals.cacheReadTokens += item.cacheReadTokens;
    if (typeof item.latencyMs === "number") totals.latencyMs += item.latencyMs;
    if (
      item.promptTokens !== null ||
      item.completionTokens !== null ||
      item.model ||
      item.provider
    ) {
      totals.llmLikeRecords += 1;
    }
  }
  totals.cachePercent = totals.totalTokens
    ? (totals.cacheReadTokens / totals.totalTokens) * 100
    : null;
  return { totals, records: normalized };
}

function inputOutputSummary(entries) {
  const summary = {
    records: 0,
    recordsWithInput: 0,
    recordsWithOutput: 0,
    promptTextRecords: 0,
    responseTextRecords: 0,
    byInputSource: {},
    byOutputSource: {},
  };
  for (const entry of entries) {
    for (const record of entry.records || []) {
      summary.records += 1;
      if (record.inputPreview) summary.recordsWithInput += 1;
      if (record.outputPreview) summary.recordsWithOutput += 1;
      if (record.inputSource === "prompt_text") summary.promptTextRecords += 1;
      if (record.outputSource === "response_text") summary.responseTextRecords += 1;
      const inputSource = record.inputSource || "none";
      const outputSource = record.outputSource || "none";
      summary.byInputSource[inputSource] = (summary.byInputSource[inputSource] || 0) + 1;
      summary.byOutputSource[outputSource] = (summary.byOutputSource[outputSource] || 0) + 1;
    }
  }
  return summary;
}

function playbackHtml(entry) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(entry.benchmark)} ${escapeHtml(entry.side)} Trajectory</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:14px 18px; }
    main { display:grid; grid-template-columns:280px 1fr; min-height:calc(100vh - 74px); }
    aside { border-right:1px solid #d7ded1; background:#fff; overflow:auto; }
    button { width:100%; text-align:left; border:0; border-bottom:1px solid #d7ded1; background:#fff; padding:9px 10px; cursor:pointer; color:#172017; }
    button:hover, button.active { background:#edf4ea; }
    .content { padding:16px; overflow:auto; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(145px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; font-size:19px; }
    .panel { margin-bottom:12px; overflow:hidden; }
    .panel h2 { margin:0; font-size:14px; padding:8px 10px; background:#f2f5ef; border-bottom:1px solid #d7ded1; }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; padding:10px; max-height:58vh; overflow:auto; background:#fff; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .muted { color:#5f685d; }
    @media (max-width:800px) { main { grid-template-columns:1fr; } aside { max-height:220px; border-right:0; border-bottom:1px solid #d7ded1; } }
  </style>
</head>
<body>
  <header>
    <strong>${escapeHtml(entry.benchmark)}</strong>
    <span class="muted"> · ${escapeHtml(entry.side)} / ${escapeHtml(entry.adapter)} · <code>${escapeHtml(entry.relativePath)}</code></span>
  </header>
  <main>
    <aside id="nav"></aside>
    <section class="content">
      <div id="cards" class="cards"></div>
      <section class="panel"><h2>Input / Prompt</h2><pre id="input"></pre></section>
      <section class="panel"><h2>Output / Response</h2><pre id="output"></pre></section>
      <section class="panel"><h2>Raw Record Preview</h2><pre id="raw"></pre></section>
    </section>
  </main>
  <script type="application/json" id="records">${JSON.stringify(entry.records || []).replaceAll("</script", "<\\/script")}</script>
  <script>
    const records = JSON.parse(document.getElementById("records").textContent || "[]");
    const nav = document.getElementById("nav");
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const n = v => typeof v === "number" ? Math.round(v * 100) / 100 : esc(v ?? "");
    function render(i) {
      const r = records[i] || {};
      for (const button of nav.querySelectorAll("button")) button.classList.toggle("active", Number(button.dataset.index) === i);
      document.getElementById("cards").innerHTML = [
        ["Record", (i + 1) + " / " + records.length],
        ["Task", r.taskId],
        ["Kind", r.kind],
        ["Step", r.step],
        ["Provider", r.provider],
        ["Model", r.model],
        ["Prompt tokens", r.promptTokens],
        ["Completion tokens", r.completionTokens],
        ["Total tokens", r.totalTokens],
        ["Cache read", r.cacheReadTokens],
        ["Cache hit", r.cachePercent == null ? "n/a" : n(r.cachePercent) + "%"],
        ["Latency ms", r.latencyMs],
        ["Input source", r.inputSource || "n/a"],
        ["Output source", r.outputSource || "n/a"],
      ].map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + esc(v ?? "") + '</b></div>').join("");
      document.getElementById("input").textContent = r.inputPreview || "";
      document.getElementById("output").textContent = r.outputPreview || "";
      document.getElementById("raw").textContent = r.rawPreview || "";
    }
    nav.innerHTML = records.map((r, i) => '<button data-index="' + i + '"><strong>Record ' + esc(i + 1) + '</strong><br><span class="muted">' + esc(r.kind) + ' · task ' + esc(r.taskId || "n/a") + ' · ' + esc(r.totalTokens ?? "") + ' tok · cache ' + esc(r.cacheReadTokens ?? "") + '</span></button>').join("");
    nav.addEventListener("click", event => {
      const button = event.target.closest("button[data-index]");
      if (button) render(Number(button.dataset.index));
    });
    render(0);
  </script>
</body>
</html>`;
}

function writePlayback(entry) {
  const fileName = `${safeSegment(entry.relativePath.replace(/\.(jsonl|json)$/i, ""))}.playback.html`;
  const filePath = path.join(
    PLAYBACK_DIR,
    safeSegment(entry.benchmark),
    safeSegment(entry.runId),
    safeSegment(entry.side),
    safeSegment(entry.adapter),
    fileName,
  );
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, playbackHtml(entry), "utf8");
  return {
    playbackPath: filePath,
    playbackHref: rel(filePath),
  };
}

function buildCatalog() {
  const indexData = readIndexData();
  const latestRows = Object.values(indexData.latest_by_benchmark || {}).sort((a, b) =>
    String(a.benchmark || "").localeCompare(String(b.benchmark || "")),
  );
  const latestKeys = new Set(
    latestRows.map((row) => `${row.benchmark}\0${row.run_id}\0${row.generated_at}`),
  );
  const sourceRows = (indexData.benchmark_rows || [])
    .filter((row) => row.benchmark && row.run_id)
    .sort((a, b) =>
      [
        String(a.benchmark || "").localeCompare(String(b.benchmark || "")),
        String(a.generated_at || "").localeCompare(String(b.generated_at || "")),
        String(a.run_id || "").localeCompare(String(b.run_id || "")),
      ].find((value) => value !== 0) || 0,
    );
  const seenSources = new Set();
  const entries = [];
  for (const row of sourceRows) {
    const rowKey = `${row.benchmark}\0${row.run_id}\0${row.generated_at}`;
    for (const side of ["target", "baseline"]) {
      const adapter = row[`${side}_adapter`] || side;
      const trajectoryDir = row[`${side}_trajectory_dir`];
      const sourceKey = `${row.benchmark}\0${row.run_id}\0${side}\0${adapter}\0${trajectoryDir || ""}`;
      if (seenSources.has(sourceKey)) continue;
      seenSources.add(sourceKey);
      let files = listFiles(trajectoryDir);
      if (files.length === 0 && row.run_root && row.benchmark && adapter) {
        const outputRoot = path.join(row.run_root, String(row.benchmark), String(adapter), "output");
        files = listFiles(outputRoot).filter((filePath) => {
          const name = path.basename(filePath).toLowerCase();
          return name === "traj.jsonl" || name.includes("trajectory") || name.includes("trajectories");
        });
      }
      for (const filePath of files) {
        const records = parseTrajectoryFile(filePath);
        const summary = summarizeRecords(records);
        const entry = {
          benchmark: row.benchmark,
          runId: row.run_id,
          runMode: row.run_mode,
          status: row.status,
          isLatest: latestKeys.has(rowKey),
          side,
          adapter,
          trajectoryDir,
          filePath,
          fileHref: rel(filePath),
          fileSize: statSync(filePath).size,
          relativePath: path.relative(trajectoryDir, filePath).replaceAll(path.sep, "/"),
          viewerHref: row.viewer_href,
          taskIds: [...new Set(summary.records.map((record) => record.taskId).filter(Boolean))],
          totals: summary.totals,
          records: summary.records,
        };
        Object.assign(entry, writePlayback(entry));
        entries.push(entry);
      }
    }
  }
  const byBenchmark = {};
  for (const entry of entries) {
    byBenchmark[entry.benchmark] ??= {
      files: 0,
      records: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      adapters: {},
    };
    const bucket = byBenchmark[entry.benchmark];
    bucket.files += 1;
    bucket.records += entry.totals.records;
    bucket.totalTokens += entry.totals.totalTokens || 0;
    bucket.cacheReadTokens += entry.totals.cacheReadTokens || 0;
    bucket.adapters[entry.adapter] ??= { files: 0, records: 0 };
    bucket.adapters[entry.adapter].files += 1;
    bucket.adapters[entry.adapter].records += entry.totals.records;
  }
  for (const bucket of Object.values(byBenchmark)) {
    bucket.cachePercent = bucket.totalTokens
      ? (bucket.cacheReadTokens / bucket.totalTokens) * 100
      : null;
  }
  const ioSummary = inputOutputSummary(entries);
  return {
    schema: "eliza_code_agent_trajectory_catalog_v1",
    generatedAt: new Date().toISOString(),
    sourceIndex: INDEX_DATA_PATH,
    summary: {
      benchmarkCount: Object.keys(byBenchmark).length,
      trajectoryFiles: entries.length,
      playbackFiles: entries.filter((entry) => entry.playbackHref).length,
      trajectoryRecords: entries.reduce((sum, entry) => sum + entry.totals.records, 0),
      llmLikeRecords: entries.reduce((sum, entry) => sum + entry.totals.llmLikeRecords, 0),
      totalTokens: entries.reduce((sum, entry) => sum + (entry.totals.totalTokens || 0), 0),
      cacheReadTokens: entries.reduce((sum, entry) => sum + (entry.totals.cacheReadTokens || 0), 0),
      inputOutput: ioSummary,
    },
    byBenchmark,
    entries,
  };
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Trajectory Catalog</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { position:sticky; top:0; z-index:3; background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:14px 20px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .muted { color:#5f685d; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; margin-top:3px; font-size:20px; }
    .controls { display:grid; grid-template-columns:2fr repeat(3,minmax(150px,1fr)); gap:8px; padding:10px; border-bottom:1px solid #d7ded1; }
    input,select { width:100%; border:1px solid #d7ded1; border-radius:6px; padding:7px 8px; background:#fff; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { position:sticky; top:61px; background:#f7faf4; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    details { margin-top:6px; }
    summary { cursor:pointer; color:#116b5b; }
    pre { max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:#101510; color:#eef7ea; padding:8px; border-radius:6px; }
    @media (max-width:900px) { .controls { grid-template-columns:1fr; } th { top:0; } }
  </style>
</head>
<body>
  <header><h1>Benchmark Trajectory Catalog</h1><div id="meta" class="muted"></div></header>
  <main>
    <div id="cards" class="cards"></div>
    <section class="panel">
      <div class="controls">
        <input id="q" type="search" placeholder="Search benchmark, task, adapter, preview..." />
        <select id="benchmark"><option value="">all benchmarks</option></select>
        <select id="adapter"><option value="">all adapters</option></select>
        <select id="side"><option value="">target + baseline</option><option value="target">target</option><option value="baseline">baseline</option></select>
      </div>
      <div id="table"></div>
    </section>
  </main>
  <script src="./trajectory-catalog-data.js"></script>
  <script>
    const data = window.BENCHMARK_TRAJECTORY_CATALOG || { entries: [], summary: {} };
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const num = v => typeof v === "number" ? Math.round(v * 100) / 100 : "";
    document.getElementById("meta").textContent = (data.generatedAt || "") + " · " + (data.sourceIndex || "");
    document.getElementById("cards").innerHTML = [["benchmarks",data.summary.benchmarkCount],["files",data.summary.trajectoryFiles],["playback pages",data.summary.playbackFiles],["records",data.summary.trajectoryRecords],["records with input",data.summary.inputOutput?.recordsWithInput],["records with output",data.summary.inputOutput?.recordsWithOutput],["LLM-like records",data.summary.llmLikeRecords],["total tokens",data.summary.totalTokens],["cache read",data.summary.cacheReadTokens]].map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + esc(v ?? 0) + '</b></div>').join("");
    for (const [id, values] of [["benchmark", [...new Set(data.entries.map(e => e.benchmark))].sort()], ["adapter", [...new Set(data.entries.map(e => e.adapter))].sort()]]) {
      document.getElementById(id).innerHTML += values.map(v => '<option>' + esc(v) + '</option>').join("");
    }
    function filtered() {
      const q = document.getElementById("q").value.toLowerCase();
      const benchmark = document.getElementById("benchmark").value;
      const adapter = document.getElementById("adapter").value;
      const side = document.getElementById("side").value;
      return data.entries.filter(e => {
        const recordText = (e.records || []).slice(0, 8).map(r => [r.taskId, r.inputPreview, r.outputPreview, r.rawPreview].join(" ")).join(" ");
        const hay = [e.benchmark, e.runId, e.adapter, e.relativePath, (e.taskIds || []).join(" "), recordText].join(" ").toLowerCase();
        return (!q || hay.includes(q)) && (!benchmark || e.benchmark === benchmark) && (!adapter || e.adapter === adapter) && (!side || e.side === side);
      });
    }
    function renderRecords(records) {
      return '<details><summary>' + esc(records.length) + ' record(s)</summary><table><thead><tr><th>#</th><th>task/step</th><th>model</th><th>tokens/cache</th><th>input/output preview</th></tr></thead><tbody>' + records.map(r => '<tr><td>' + esc(r.index + 1) + '</td><td><code>' + esc(r.taskId) + '</code><br>' + esc(r.kind) + ' · step ' + esc(r.step) + '</td><td>' + esc(r.provider) + '<br>' + esc(r.model) + '<br><span class="muted">' + esc(num(r.latencyMs)) + ' ms</span></td><td>prompt ' + esc(r.promptTokens ?? '') + '<br>out ' + esc(r.completionTokens ?? '') + '<br>total ' + esc(r.totalTokens ?? '') + '<br>cache ' + esc(r.cacheReadTokens ?? '') + ' (' + esc(num(r.cachePercent)) + '%)</td><td><strong>input</strong> <span class="muted">' + esc(r.inputSource || 'n/a') + '</span><br>' + esc(r.inputPreview) + '<br><strong>output</strong> <span class="muted">' + esc(r.outputSource || 'n/a') + '</span><br>' + esc(r.outputPreview || r.rawPreview) + '</td></tr>').join("") + '</tbody></table></details>';
    }
    function render() {
      const rows = filtered();
      document.getElementById("table").innerHTML = '<table><thead><tr><th>benchmark</th><th>file</th><th>summary</th><th>records</th></tr></thead><tbody>' + rows.map(e => '<tr><td><code>' + esc(e.benchmark) + '</code><br>' + esc(e.side) + ' · ' + esc(e.adapter) + '<br><span class="muted">' + esc(e.runMode) + ' · ' + esc(e.status) + '</span></td><td><a href="' + esc(e.fileHref) + '">' + esc(e.relativePath) + '</a><br><span class="muted">' + esc((e.taskIds || []).join(", ")) + '</span><br><a href="' + esc(e.playbackHref) + '">playback</a> · <a href="' + esc(e.viewerHref) + '">run viewer</a></td><td>records ' + esc(e.totals.records) + '<br>LLM-like ' + esc(e.totals.llmLikeRecords) + '<br>tokens ' + esc(e.totals.totalTokens) + '<br>cache ' + esc(e.totals.cacheReadTokens) + ' (' + esc(num(e.totals.cachePercent)) + '%)</td><td>' + renderRecords(e.records || []) + '</td></tr>').join("") + '</tbody></table>';
    }
    for (const id of ["q","benchmark","adapter","side"]) document.getElementById(id).addEventListener("input", render);
    for (const id of ["benchmark","adapter","side"]) document.getElementById(id).addEventListener("change", render);
    render();
  </script>
</body>
</html>`;
}

function renderMarkdown(payload) {
  const lines = [
    "# Benchmark Trajectory Catalog",
    "",
    `Generated: ${payload.generatedAt}`,
    `Benchmarks: ${payload.summary.benchmarkCount}`,
    `Trajectory files: ${payload.summary.trajectoryFiles}`,
    `Playback pages: ${payload.summary.playbackFiles}`,
    `Trajectory records: ${payload.summary.trajectoryRecords}`,
    `LLM-like records: ${payload.summary.llmLikeRecords}`,
    `Total tokens: ${payload.summary.totalTokens}`,
    `Cache-read tokens: ${payload.summary.cacheReadTokens}`,
    "",
    "| benchmark | files | records | total tokens | cache read | cache % |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const [benchmark, bucket] of Object.entries(payload.byBenchmark).sort()) {
    lines.push(
      `| \`${benchmark}\` | ${bucket.files} | ${bucket.records} | ${bucket.totalTokens} | ${bucket.cacheReadTokens} | ${bucket.cachePercent ?? ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  mkdirSync(DEFAULT_REPORT_DIR, { recursive: true });
  rmSync(PLAYBACK_DIR, { recursive: true, force: true });
  const payload = buildCatalog();
  writeFileSync(
    path.join(DEFAULT_REPORT_DIR, "trajectory-catalog-data.js"),
    `window.BENCHMARK_TRAJECTORY_CATALOG = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  writeFileSync(
    path.join(DEFAULT_REPORT_DIR, "trajectory-catalog.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(DEFAULT_REPORT_DIR, "README.md"), renderMarkdown(payload), "utf8");
  writeFileSync(path.join(DEFAULT_REPORT_DIR, "index.html"), html(), "utf8");
  process.stdout.write(
    `benchmark trajectory catalog ${payload.summary.trajectoryFiles} files, ${payload.summary.trajectoryRecords} records\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
