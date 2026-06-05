#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SOURCE_DIR = path.join(REPO_ROOT, "packages", "benchmarks", "benchmark_results");
const LATEST_DIR = path.join(SOURCE_DIR, "latest");
const SQLITE_PATH = path.join(SOURCE_DIR, "orchestrator.sqlite");
const REPORT_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmarks",
  "benchmark-results-corpus-review",
);
const CANONICAL_DIR = path.join(REPORT_DIR, "canonical-trajectories");
const GAP_DIR = path.join(REPORT_DIR, "gap-pages");
const FAMILY_DIR = path.join(REPORT_DIR, "family-pages");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sqliteJson(sql) {
  if (!existsSync(SQLITE_PATH)) return [];
  const completed = spawnSync("sqlite3", ["-json", SQLITE_PATH, sql], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (completed.status !== 0) {
    throw new Error(
      `sqlite query failed: ${String(completed.stderr || completed.stdout).slice(0, 1000)}`,
    );
  }
  return JSON.parse(completed.stdout || "[]");
}

function splitLatestFile(fileName) {
  const stem = fileName.replace(/\.json$/, "");
  const marker = stem.lastIndexOf("__");
  if (marker === -1) return { benchmark_id: stem, agent: "" };
  return {
    benchmark_id: stem.slice(0, marker),
    agent: stem.slice(marker + 2),
  };
}

function redactPath(filePath) {
  return String(filePath || "").replaceAll(REPO_ROOT + path.sep, "");
}

function pathSegment(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "unknown";
}

function truncate(value, limit = 900) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
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

function canonicalPlaybackHtml(calls, entry) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(entry.benchmark_id)} / ${escapeHtml(entry.agent)} Playback</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:14px 18px; }
    main { display:grid; grid-template-columns:280px 1fr; min-height:calc(100vh - 74px); }
    aside { border-right:1px solid #d7ded1; background:#fff; overflow:auto; }
    button { width:100%; text-align:left; border:0; border-bottom:1px solid #d7ded1; background:#fff; padding:9px 10px; cursor:pointer; color:#172017; }
    button:hover, button.active { background:#edf4ea; }
    .content { padding:16px; overflow:auto; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; font-size:20px; }
    .panel { margin-bottom:12px; overflow:hidden; }
    .panel h2 { margin:0; font-size:14px; padding:8px 10px; background:#f2f5ef; border-bottom:1px solid #d7ded1; }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; padding:10px; max-height:55vh; overflow:auto; background:#fff; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .muted { color:#5f685d; }
    .ok { color:#17633a; font-weight:700; }
    @media (max-width:800px) { main { grid-template-columns:1fr; } aside { max-height:220px; border-right:0; border-bottom:1px solid #d7ded1; } }
  </style>
</head>
<body>
  <header>
    <strong>${escapeHtml(entry.benchmark_id)}</strong> / ${escapeHtml(entry.agent)}
    <span class="muted"> · <code>${escapeHtml(entry.run_id)}</code></span>
  </header>
  <main>
    <aside id="nav"></aside>
    <section class="content">
      <div id="cards" class="cards"></div>
      <section class="panel"><h2>Prompt / Input</h2><pre id="prompt"></pre></section>
      <section class="panel"><h2>Response / Output</h2><pre id="response"></pre></section>
      <section class="panel"><h2>Actions / Tool Calls</h2><pre id="actions"></pre></section>
      <section class="panel"><h2>Source</h2><pre id="source"></pre></section>
    </section>
  </main>
  <script type="application/json" id="calls">${JSON.stringify(calls).replaceAll("</script", "<\\/script")}</script>
  <script>
    const calls = JSON.parse(document.getElementById("calls").textContent || "[]");
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const n = v => typeof v === "number" ? v.toLocaleString() : esc(v ?? "");
    const nav = document.getElementById("nav");
    function usage(c) { return c.usage || {}; }
    function render(i) {
      const call = calls[i] || {};
      for (const button of nav.querySelectorAll("button")) button.classList.toggle("active", Number(button.dataset.index) === i);
      const u = usage(call);
      const cachePct = u.total_tokens ? ((Number(u.cached_tokens || 0) / Number(u.total_tokens || 0)) * 100).toFixed(1) + "%" : "n/a";
      document.getElementById("cards").innerHTML = [
        ["Call", (i + 1) + " / " + calls.length],
        ["Source", call.source],
        ["Kind", call.kind],
        ["Provider", call.provider || ""],
        ["Model", call.model || ""],
        ["Prompt tokens", u.prompt_tokens],
        ["Completion tokens", u.completion_tokens],
        ["Total tokens", u.total_tokens],
        ["Cached tokens", u.cached_tokens],
        ["Cache hit", cachePct],
        ["Latency ms", u.latency_ms],
      ].map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + n(v) + '</b></div>').join("");
      document.getElementById("prompt").textContent = call.prompt || "";
      document.getElementById("response").textContent = call.response || "";
      document.getElementById("actions").textContent = JSON.stringify(call.actions || [], null, 2);
      document.getElementById("source").textContent = JSON.stringify({ source_file: call.source_file, source_index: call.source_index, catalog_index: call.catalog_index, prompt_chars: call.prompt_chars }, null, 2);
    }
    nav.innerHTML = calls.map((call, i) => {
      const u = usage(call);
      return '<button data-index="' + i + '"><strong>Call ' + esc(i + 1) + '</strong><br><span class="muted">' + esc(call.source) + ' · ' + n(u.total_tokens) + ' tok · cache ' + n(u.cached_tokens) + '</span></button>';
    }).join("");
    nav.addEventListener("click", event => {
      const button = event.target.closest("button[data-index]");
      if (button) render(Number(button.dataset.index));
    });
    render(0);
  </script>
</body>
</html>`;
}

function noPlaybackGapHtml({ finding, family, rows, credentialGaps }) {
  const hyperliquid = credentialGaps?.hyperliquid;
  const credentialSection =
    finding.benchmark_id === "hyperliquid_bench" && hyperliquid
      ? `<section class="panel"><h2>Credential Readiness</h2><div class="body"><table><tbody>
      <tr><th>Required env keys</th><td>${escapeHtml((hyperliquid.requiredEnv || []).join(", "))}</td></tr>
      <tr><th>Configured keys</th><td>${escapeHtml(
        Object.entries(hyperliquid.present || {})
          .filter(([, present]) => present)
          .map(([key]) => key)
          .join(", ") || "none",
      )}</td></tr>
      <tr><th>Missing keys</th><td class="bad">${escapeHtml((hyperliquid.missing || []).join(", ") || "none")}</td></tr>
      <tr><th>Runnable</th><td class="${hyperliquid.runnable ? "ok" : "bad"}">${escapeHtml(hyperliquid.runnable ? "yes" : "no")}</td></tr>
    </tbody></table><p>Only key names and boolean readiness are recorded here. Secret values are not persisted in the report.</p></div></section>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(finding.benchmark_id)} Playback Gap</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; margin-bottom:12px; overflow:hidden; }
    .panel h2 { margin:0; font-size:14px; padding:8px 10px; background:#f2f5ef; border-bottom:1px solid #d7ded1; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .bad { color:#a12222; font-weight:700; }
    .ok { color:#17633a; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(finding.benchmark_id)} Playback Gap</h1><div class="muted">Focused explanation for why no canonical playback page exists.</div></header>
  <main>
    <section class="panel"><h2>Disposition</h2><div class="body"><strong class="${finding.disposition === "blocked" ? "bad" : "warn"}">${escapeHtml(finding.disposition)}</strong><p>${escapeHtml((finding.reasons || []).join("; "))}</p></div></section>
    <section class="panel"><h2>Family Summary</h2><div class="body"><table><tbody>
      <tr><th>latest rows</th><td>${escapeHtml(family?.latest_rows ?? 0)}</td></tr>
      <tr><th>succeeded rows</th><td>${escapeHtml(family?.succeeded_rows ?? 0)}</td></tr>
      <tr><th>normalized calls</th><td>${escapeHtml(family?.normalized_calls ?? 0)}</td></tr>
      <tr><th>trajectory-like files</th><td>${escapeHtml(family?.trajectory_like_files ?? 0)}</td></tr>
      <tr><th>output files</th><td>${escapeHtml(family?.output_files ?? 0)}</td></tr>
      <tr><th>matrix complete</th><td>${escapeHtml(family?.matrix_complete)}</td></tr>
      <tr><th>unsupported cells</th><td>${escapeHtml(family?.unsupported_cells ?? 0)}</td></tr>
      <tr><th>cache</th><td>${escapeHtml(family?.cache_percent == null ? "n/a" : family.cache_percent.toFixed(1) + "%")}</td></tr>
    </tbody></table></div></section>
    <section class="panel"><h2>Latest Rows</h2><div class="body"><table><thead><tr><th>agent</th><th>status</th><th>score</th><th>calls</th><th>tokens</th><th>outputs</th><th>warnings</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.agent)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.score)} ${escapeHtml(row.unit || "")}</td><td>${escapeHtml(row.llm_call_count)}</td><td>${escapeHtml(row.total_tokens)}</td><td>${escapeHtml((row.output_files || []).length)}</td><td>${escapeHtml((row.publication_warnings || []).join(", "))}</td></tr>`).join("") || `<tr><td colspan="7" class="bad">No latest published rows.</td></tr>`}</tbody></table></div></section>
    ${credentialSection}
    <section class="panel"><h2>Next Evidence Needed</h2><div class="body">Generate a benchmark run with exported model/action calls or trajectory-like files so a canonical JSONL and playback HTML page can be created.</div></section>
  </main>
</body>
</html>`;
}

function writeNoPlaybackGapPages(payload) {
  mkdirSync(GAP_DIR, { recursive: true });
  const canonicalBenchmarks = new Set(
    (payload.canonicalFiles || []).map((entry) => entry.benchmark_id),
  );
  const familyByBenchmark = new Map(
    (payload.benchmarkFamilies || []).map((family) => [family.benchmark_id, family]),
  );
  const rowsByBenchmark = new Map();
  for (const row of payload.latestRows || []) {
    if (!rowsByBenchmark.has(row.benchmark_id)) rowsByBenchmark.set(row.benchmark_id, []);
    rowsByBenchmark.get(row.benchmark_id).push(row);
  }
  const pages = [];
  for (const finding of payload.reviewFindings || []) {
    if (finding.disposition === "review-pass") continue;
    if (canonicalBenchmarks.has(finding.benchmark_id)) continue;
    const filePath = path.join(GAP_DIR, `${pathSegment(finding.benchmark_id)}.html`);
    const family = familyByBenchmark.get(finding.benchmark_id);
    const rows = rowsByBenchmark.get(finding.benchmark_id) || [];
    writeFileSync(
      filePath,
      noPlaybackGapHtml({
        finding,
        family,
        rows,
        credentialGaps: payload.credentialGaps,
      }),
      "utf8",
    );
    const gapPage = redactPath(filePath);
    finding.gap_page = gapPage;
    pages.push({
      benchmark_id: finding.benchmark_id,
      disposition: finding.disposition,
      gap_page: gapPage,
      reasons: finding.reasons || [],
    });
  }
  return pages;
}

function familyReviewHtml({ family, finding, rows, calls, canonicalFiles, history, gapPage }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(family.benchmark_id)} Family Review</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; font-size:20px; margin-top:3px; }
    .panel { margin-bottom:12px; overflow:hidden; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f8faf5; }
    pre { max-height:260px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:#101510; color:#eef7ea; padding:8px; border-radius:6px; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    .ok { color:#17633a; font-weight:700; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(family.benchmark_id)}</h1><div class="muted">Corpus benchmark-family review drilldown</div></header>
  <main>
    <div class="grid">
      <div class="card"><span class="muted">Disposition</span><b class="${finding.disposition === "review-pass" ? "ok" : finding.disposition === "blocked" ? "bad" : "warn"}">${escapeHtml(finding.disposition)}</b></div>
      <div class="card"><span class="muted">Latest rows</span><b>${escapeHtml(family.latest_rows)}</b><span>${escapeHtml(family.succeeded_rows)} succeeded</span></div>
      <div class="card"><span class="muted">Normalized calls</span><b>${escapeHtml(family.normalized_calls)}</b><span>${escapeHtml(calls.length)} shown below</span></div>
      <div class="card"><span class="muted">Tokens</span><b>${escapeHtml(family.token_total.toLocaleString?.() || family.token_total)}</b><span>${escapeHtml(family.cached_token_total)} cached</span></div>
      <div class="card"><span class="muted">Playback files</span><b>${escapeHtml(canonicalFiles.length)}</b><span>${gapPage ? "gap page available" : "canonical playback"}</span></div>
      <div class="card"><span class="muted">Previous pairs</span><b>${escapeHtml(finding.previous_pairs)}</b><span>${escapeHtml(finding.history_pairs)} history pairs</span></div>
    </div>
    <section class="panel"><h2>Reasons / Warnings</h2><div class="body"><p>${escapeHtml((finding.reasons || []).join("; ") || "No review caveats.")}</p><p class="muted">${escapeHtml((family.warnings || []).join(", ") || "No publication warnings.")}</p>${gapPage ? `<p><a href="../${escapeHtml(path.relative(REPORT_DIR, path.join(REPO_ROOT, gapPage)).replaceAll(path.sep, "/"))}">Open playback gap page</a></p>` : ""}</div></section>
    <section class="panel"><h2>Latest Rows</h2><div class="body"><table><thead><tr><th>agent</th><th>status</th><th>score</th><th>tasks</th><th>calls</th><th>tokens</th><th>trajectory/output files</th><th>warnings</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.agent)}</td><td class="${row.status === "succeeded" ? "ok" : "bad"}">${escapeHtml(row.status)}</td><td>${escapeHtml(row.score)} ${escapeHtml(row.unit || "")}</td><td>${escapeHtml(row.total_tasks)}</td><td>${escapeHtml(row.llm_call_count)}</td><td>${escapeHtml(row.total_tokens)}</td><td>${escapeHtml((row.discovered_trajectory_files || []).length)} trajectory<br>${escapeHtml((row.output_files || []).length)} output</td><td>${escapeHtml((row.publication_warnings || []).join(", "))}</td></tr>`).join("")}</tbody></table></div></section>
    <section class="panel"><h2>Canonical Playback</h2><div class="body"><table><thead><tr><th>agent</th><th>run</th><th>calls</th><th>tokens/cache</th><th>sources</th><th>playback</th></tr></thead><tbody>${canonicalFiles.map((entry) => `<tr><td>${escapeHtml(entry.agent)}</td><td><code>${escapeHtml(entry.run_id)}</code></td><td>${escapeHtml(entry.call_count)}</td><td>${escapeHtml(entry.token_total)}<br><span class="muted">${escapeHtml(entry.cached_token_total)} cached</span></td><td>${escapeHtml((entry.sources || []).join(", "))}</td><td><a href="../${escapeHtml(path.relative(REPORT_DIR, path.join(REPO_ROOT, entry.playback_file)).replaceAll(path.sep, "/"))}">playback</a><br><code>${escapeHtml(entry.file)}</code></td></tr>`).join("") || `<tr><td colspan="6" class="warn">No canonical playback file exists for this family.</td></tr>`}</tbody></table></div></section>
    <section class="panel"><h2>Normalized Call Samples</h2><div class="body"><table><thead><tr><th>#</th><th>agent/run</th><th>usage</th><th>prompt/response</th></tr></thead><tbody>${calls.slice(0, 20).map((call) => `<tr><td>${escapeHtml(call.catalog_index)}</td><td>${escapeHtml(call.agent)}<br><code>${escapeHtml(call.run_id)}</code><br><span class="muted">${escapeHtml(call.source)}</span></td><td>${escapeHtml(call.usage?.prompt_tokens)} / ${escapeHtml(call.usage?.completion_tokens)} / ${escapeHtml(call.usage?.total_tokens)}<br><span class="muted">cache ${escapeHtml(call.usage?.cached_tokens)}</span></td><td><details><summary>prompt</summary><pre>${escapeHtml(truncate(call.prompt, 3000))}</pre></details><details><summary>response</summary><pre>${escapeHtml(truncate(call.response, 3000))}</pre></details></td></tr>`).join("") || `<tr><td colspan="4" class="warn">No normalized calls.</td></tr>`}</tbody></table></div></section>
    <section class="panel"><h2>Run History</h2><div class="body"><table><thead><tr><th>agent</th><th>runs</th><th>current</th><th>previous</th><th>deltas</th></tr></thead><tbody>${history.map((entry) => `<tr><td>${escapeHtml(entry.agent)}</td><td>${escapeHtml(entry.run_count)}<br><span class="muted">${escapeHtml(entry.succeeded_run_count)} succeeded</span></td><td><code>${escapeHtml(entry.current?.run_id)}</code><br>${escapeHtml(entry.current?.status)} ${escapeHtml(entry.current?.score ?? "")}</td><td>${entry.previous ? `<code>${escapeHtml(entry.previous.run_id)}</code><br>${escapeHtml(entry.previous.status)} ${escapeHtml(entry.previous.score ?? "")}` : `<span class="muted">none</span>`}</td><td>score ${escapeHtml(entry.deltas?.score ?? "")}<br>calls ${escapeHtml(entry.deltas?.llm_call_count ?? "")}<br>tokens ${escapeHtml(entry.deltas?.total_tokens ?? "")}</td></tr>`).join("") || `<tr><td colspan="5" class="warn">No run history comparison.</td></tr>`}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function writeFamilyReviewPages(payload) {
  mkdirSync(FAMILY_DIR, { recursive: true });
  const findingByBenchmark = new Map(
    (payload.reviewFindings || []).map((finding) => [finding.benchmark_id, finding]),
  );
  const rowsByBenchmark = new Map();
  for (const row of payload.latestRows || []) {
    if (!rowsByBenchmark.has(row.benchmark_id)) rowsByBenchmark.set(row.benchmark_id, []);
    rowsByBenchmark.get(row.benchmark_id).push(row);
  }
  const callsByBenchmark = new Map();
  for (const call of payload.normalizedCalls || []) {
    if (!callsByBenchmark.has(call.benchmark_id)) callsByBenchmark.set(call.benchmark_id, []);
    callsByBenchmark.get(call.benchmark_id).push(call);
  }
  const canonicalByBenchmark = new Map();
  for (const entry of payload.canonicalFiles || []) {
    if (!canonicalByBenchmark.has(entry.benchmark_id)) canonicalByBenchmark.set(entry.benchmark_id, []);
    canonicalByBenchmark.get(entry.benchmark_id).push(entry);
  }
  const historyByBenchmark = new Map();
  for (const entry of payload.runHistory?.comparisons || []) {
    if (!historyByBenchmark.has(entry.benchmark_id)) historyByBenchmark.set(entry.benchmark_id, []);
    historyByBenchmark.get(entry.benchmark_id).push(entry);
  }
  const gapByBenchmark = new Map(
    (payload.noPlaybackGapPages || []).map((entry) => [entry.benchmark_id, entry.gap_page]),
  );
  const pages = [];
  for (const family of payload.benchmarkFamilies || []) {
    const filePath = path.join(FAMILY_DIR, `${pathSegment(family.benchmark_id)}.html`);
    const finding = findingByBenchmark.get(family.benchmark_id) || {
      benchmark_id: family.benchmark_id,
      disposition: "needs-review",
      reasons: [],
      previous_pairs: 0,
      history_pairs: 0,
    };
    writeFileSync(
      filePath,
      familyReviewHtml({
        family,
        finding,
        rows: rowsByBenchmark.get(family.benchmark_id) || [],
        calls: callsByBenchmark.get(family.benchmark_id) || [],
        canonicalFiles: canonicalByBenchmark.get(family.benchmark_id) || [],
        history: historyByBenchmark.get(family.benchmark_id) || [],
        gapPage: gapByBenchmark.get(family.benchmark_id) || "",
      }),
      "utf8",
    );
    const familyPage = redactPath(filePath);
    family.family_page = familyPage;
    finding.family_page = familyPage;
    pages.push({
      benchmark_id: family.benchmark_id,
      disposition: finding.disposition,
      family_page: familyPage,
      canonical_playback_files: (canonicalByBenchmark.get(family.benchmark_id) || []).length,
      latest_rows: family.latest_rows,
      normalized_calls: family.normalized_calls,
    });
  }
  return pages;
}

function usageFromRecord(record) {
  const usage = record?.usage || {};
  const promptDetails = usage.prompt_tokens_details || {};
  return {
    prompt_tokens:
      record?.prompt_tokens ??
      usage.prompt_tokens ??
      usage.promptTokens ??
      null,
    completion_tokens:
      record?.completion_tokens ??
      usage.completion_tokens ??
      usage.completionTokens ??
      null,
    total_tokens:
      record?.total_tokens ??
      usage.total_tokens ??
      usage.totalTokens ??
      null,
    cached_tokens:
      record?.cache_read_input_tokens ??
      record?.cached_tokens ??
      usage.cacheReadInputTokens ??
      usage.cachedTokens ??
      promptDetails.cached_tokens ??
      null,
    cache_creation_tokens:
      record?.cache_creation_input_tokens ??
      usage.cacheCreationInputTokens ??
      promptDetails.cache_write_tokens ??
      null,
    latency_ms:
      record?.latency_ms ??
      record?.latencyMs ??
      record?.prediction?.latencyMs ??
      record?.duration_ms ??
      null,
  };
}

function normalizedCallFromRecord(record, file, index, metadata = {}) {
  const prompt =
    record?.prompt_text ??
    record?.prompt ??
    record?.promptText ??
    record?.inputText ??
    record?.input ??
    record?.instruction ??
    (Array.isArray(record?.transcripts) ? record.transcripts.join("\n") : "") ??
    record?.sampleId ??
    record?.task_id ??
    record?.action ??
    record?.template ??
    record?.phase ??
    record?.benchmark ??
    record?.scenarioId ??
    record?.bucket ??
    (record?.DETECT ? "DETECT" : undefined) ??
    record?.expectedTranscript ??
    record?.inContext ??
    "";
  const response =
    record?.response_text ??
    record?.response ??
    record?.responseText ??
    record?.output ??
    record?.result ??
    record?.prediction?.text ??
    record?.agent_final_text ??
    record?.raw_response ??
    record?.outContext ??
    record?.responseSegmentation ??
    record?.reason ??
    (record?.metrics ? JSON.stringify(record.metrics) : undefined) ??
    (record?.totals ? JSON.stringify(record.totals) : undefined) ??
    (record?.DETECT ? JSON.stringify(record.DETECT) : undefined) ??
    (record?.success !== undefined
      ? JSON.stringify({
          success: record.success,
          reward: record.reward,
          total_reward: record.total_reward,
        })
      : undefined) ??
    (record?.info ? JSON.stringify(record.info) : undefined) ??
    "";
  if (!prompt && !response) return null;
  const usage = usageFromRecord(record);
  const firstLlmCall = Array.isArray(record?.trajectory?.llmCalls)
    ? record.trajectory.llmCalls[0]
    : null;
  const kind =
    record?.metrics || record?.totals || record?.DETECT
      ? "summary"
      : record?.action_type ||
          record?.action ||
          record?.step_num ||
          record?.step ||
          record?.task_id ||
          record?.sampleId
        ? "action"
        : "llm_call";
  return {
    ...metadata,
    file,
    index,
    kind,
    prompt: truncate(prompt),
    response: truncate(response),
    actions:
      record?.actions ||
      record?.tool_calls ||
      record?.tools ||
      record?.agent_tool_calls ||
      [],
    usage: {
      ...usage,
      latency_ms: usage.latency_ms ?? firstLlmCall?.latencyMs ?? null,
    },
  };
}

function previewFromRecord(record, file, index) {
  return normalizedCallFromRecord(record, file, index);
}

function jsonRecordsFromFile(filePath, maxRecords = 3) {
  const text = readFileSync(filePath, "utf8");
  if (filePath.endsWith(".jsonl") || filePath.endsWith(".ndjson")) {
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, maxRecords)
      .map((line) => JSON.parse(line));
  }
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed.slice(0, maxRecords);
  if (Array.isArray(parsed?.results)) return parsed.results.slice(0, maxRecords);
  if (Array.isArray(parsed?.messages)) return parsed.messages.slice(0, maxRecords);
  if (Array.isArray(parsed?.verdicts)) return parsed.verdicts.slice(0, maxRecords);
  if (Array.isArray(parsed?.samples)) return parsed.samples.slice(0, maxRecords);
  if (Array.isArray(parsed?.tasks)) return parsed.tasks.slice(0, maxRecords);
  if (Array.isArray(parsed?.steps)) return parsed.steps.slice(0, maxRecords);
  if (Array.isArray(parsed?.actions)) return parsed.actions.slice(0, maxRecords);
  return [parsed];
}

function callPreviews(files, maxPreviews = 3) {
  const previews = [];
  for (const relativeFile of files) {
    if (previews.length >= maxPreviews) break;
    const absoluteFile = path.join(REPO_ROOT, relativeFile);
    if (!existsSync(absoluteFile)) continue;
    try {
      const records = jsonRecordsFromFile(absoluteFile, maxPreviews);
      records.forEach((record, index) => {
        if (previews.length >= maxPreviews) return;
        const preview = previewFromRecord(record, relativeFile, index);
        if (preview) previews.push(preview);
        const steps = record?.trajectory_snapshot?.steps;
        if (Array.isArray(steps)) {
          for (const [stepIndex, step] of steps.entries()) {
            if (previews.length >= maxPreviews) break;
            const stepPreview = previewFromRecord(step, relativeFile, stepIndex);
            if (stepPreview) previews.push(stepPreview);
          }
        }
      });
    } catch {
      // Some output files are structured benchmark summaries rather than replayable calls.
    }
  }
  return previews;
}

function callsFromFile(relativeFile, metadata = {}) {
  const calls = [];
  const absoluteFile = path.join(REPO_ROOT, relativeFile);
  if (!existsSync(absoluteFile)) return calls;
  try {
    const records = jsonRecordsFromFile(absoluteFile, 10000);
    records.forEach((record, index) => {
      const call = normalizedCallFromRecord(record, relativeFile, index, metadata);
      if (call) calls.push(call);
      const steps = record?.trajectory_snapshot?.steps;
      if (Array.isArray(steps)) {
        for (const [stepIndex, step] of steps.entries()) {
          const stepCall = normalizedCallFromRecord(
            step,
            relativeFile,
            stepIndex,
            metadata,
          );
          if (stepCall) calls.push(stepCall);
        }
      }
    });
  } catch {
    // Some artifact files are structured summaries and not replayable call logs.
  }
  return calls;
}

function normalizedCallCatalog(rows) {
  const calls = [];
  for (const row of rows) {
    for (const file of row.discovered_trajectory_files || []) {
      calls.push(
        ...callsFromFile(file, {
          benchmark_id: row.benchmark_id,
          agent: row.agent,
          run_id: row.run_id,
          provider: row.provider,
          model: row.model,
        }),
      );
    }
  }
  return calls.map((call, index) => ({ ...call, catalog_index: index }));
}

function sqliteTrajectoryRows() {
  return sqliteJson(`
    select
      r.benchmark_id,
      r.agent,
      r.provider,
      r.model,
      r.status,
      r.score,
      r.unit,
      t.run_id,
      t.trajectory_file,
      t.turn_index,
      t.prompt_tokens,
      t.completion_tokens,
      t.total_tokens,
      t.cached_tokens,
      t.cache_creation_tokens,
      t.latency_ms,
      t.prompt_chars
    from benchmark_run_trajectories t
    left join benchmark_runs r on r.run_id = t.run_id
    order by r.benchmark_id, r.agent, t.run_id, t.turn_index
  `);
}

function writeCanonicalTrajectories(normalizedCalls, sqliteRows) {
  rmSync(CANONICAL_DIR, { recursive: true, force: true });
  const grouped = new Map();
  for (const call of normalizedCalls) {
    const key = [
      call.benchmark_id || "unknown",
      call.agent || "unknown",
      call.run_id || "unknown-run",
    ].join("\u0000");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      schema: "eliza_benchmark_canonical_call_v1",
      source: "normalized-artifact",
      benchmark_id: call.benchmark_id,
      agent: call.agent,
      run_id: call.run_id,
      provider: call.provider,
      model: call.model,
      source_file: call.file,
      source_index: call.index,
      catalog_index: call.catalog_index,
      kind: call.kind,
      prompt: call.prompt,
      response: call.response,
      actions: call.actions,
      usage: call.usage,
    });
  }
  for (const row of sqliteRows) {
    const key = [
      row.benchmark_id || "unknown",
      row.agent || "unknown",
      row.run_id || "unknown-run",
    ].join("\u0000");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      schema: "eliza_benchmark_canonical_call_v1",
      source: "sqlite-token-row",
      benchmark_id: row.benchmark_id,
      agent: row.agent,
      run_id: row.run_id,
      provider: row.provider,
      model: row.model,
      source_file: row.trajectory_file,
      source_index: row.turn_index,
      kind: "llm_call",
      prompt: "",
      response: "",
      actions: [],
      usage: {
        prompt_tokens: row.prompt_tokens,
        completion_tokens: row.completion_tokens,
        total_tokens: row.total_tokens,
        cached_tokens: row.cached_tokens,
        cache_creation_tokens: row.cache_creation_tokens,
        latency_ms: row.latency_ms,
      },
      prompt_chars: row.prompt_chars,
    });
  }

  const manifest = [];
  for (const [key, calls] of grouped) {
    const [benchmarkId, agent, runId] = key.split("\u0000");
    calls.sort(
      (a, b) =>
        Number(a.source_index ?? a.catalog_index ?? 0) -
        Number(b.source_index ?? b.catalog_index ?? 0),
    );
    const dir = path.join(
      CANONICAL_DIR,
      pathSegment(benchmarkId),
      pathSegment(agent),
    );
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${pathSegment(runId)}.trajectory.canonical.jsonl`);
    const playbackPath = filePath.replace(/\.jsonl$/, ".playback.html");
    writeFileSync(filePath, calls.map((call) => JSON.stringify(call)).join("\n") + "\n", "utf8");
    const entry = {
      benchmark_id: benchmarkId,
      agent,
      run_id: runId,
      call_count: calls.length,
      file: redactPath(filePath),
      playback_file: redactPath(playbackPath),
      token_total: calls.reduce((total, call) => total + Number(call.usage?.total_tokens || 0), 0),
      cached_token_total: calls.reduce((total, call) => total + Number(call.usage?.cached_tokens || 0), 0),
      sources: [...new Set(calls.map((call) => call.source))].sort(),
    };
    writeFileSync(playbackPath, canonicalPlaybackHtml(calls, entry), "utf8");
    manifest.push(entry);
  }
  manifest.sort((a, b) =>
    `${a.benchmark_id}\u0000${a.agent}\u0000${a.run_id}`.localeCompare(
      `${b.benchmark_id}\u0000${b.agent}\u0000${b.run_id}`,
    ),
  );
  mkdirSync(CANONICAL_DIR, { recursive: true });
  writeFileSync(
    path.join(CANONICAL_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  return manifest;
}

function runRootFromResultPath(resultPath) {
  if (!resultPath) return "";
  const marker = `${path.sep}output${path.sep}`;
  const index = String(resultPath).indexOf(marker);
  if (index === -1) return path.dirname(String(resultPath));
  return String(resultPath).slice(0, index);
}

function listRunFiles(runRoot) {
  if (!runRoot || !existsSync(runRoot)) {
    return { files: [], trajectoryFiles: [], outputFiles: [] };
  }
  const completed = spawnSync("find", [runRoot, "-type", "f"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const files = String(completed.stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .sort()
    .map(redactPath);
  const trajectoryFiles = files.filter((file) =>
    /(?:trajectory|trajectories|telemetry)\.(?:jsonl?|ndjson)$/i.test(file) ||
    /(?:^|\/)trajectory[^/]*\.(?:jsonl?|ndjson)$/i.test(file) ||
    /(?:^|\/)traj(?:ectory)?[^/]*\.(?:jsonl?|ndjson)$/i.test(file) ||
    /(?:^|\/)telemetry\.jsonl$/i.test(file) ||
    /(?:^|\/)voicebench[^/]*\.json$/i.test(file) ||
    /(?:^|\/)voiceagentbench[^/]*\.json$/i.test(file) ||
    /vision-language-results\.json$/i.test(file) ||
    /(?:^|\/)evm_[^/]*_metrics\.json$/i.test(file) ||
    /personality-bench.*\/output\/report\.json$/i.test(file) ||
    /eliza-replay-results\.json$/i.test(file) ||
    /benchmark_results_eliza-bridge\.json$/i.test(file),
  );
  const outputFiles = files.filter((file) => file.includes("/output/"));
  return { files, trajectoryFiles, outputFiles };
}

function credentialProbe() {
  const required = ["HL_PRIVATE_KEY", "CEREBRAS_API_KEY"];
  const present = Object.fromEntries(
    required.map((key) => [key, Boolean(process.env[key])]),
  );
  return {
    hyperliquid: {
      requiredEnv: required,
      present,
      runnable: required.every((key) => present[key]),
      missing: required.filter((key) => !present[key]),
    },
  };
}

function latestRows() {
  return readdirSync(LATEST_DIR)
    .filter((file) => file.endsWith(".json") && file !== "index.json")
    .sort()
    .map((file) => {
      const parsed = readJson(path.join(LATEST_DIR, file));
      const ids = splitLatestFile(file);
      const metrics = parsed.metrics || {};
      const runRoot = runRootFromResultPath(parsed.result_json_path || "");
      const runFiles = listRunFiles(runRoot);
      const previews = callPreviews(runFiles.trajectoryFiles);
      return {
        file,
        benchmark_id: parsed.benchmark_id || ids.benchmark_id,
        agent: parsed.agent || ids.agent,
        status: parsed.status || "",
        provider: parsed.provider || "",
        model: parsed.model || "",
        score: parsed.score,
        unit: parsed.unit || "",
        run_group_id: parsed.run_group_id || "",
        run_id: parsed.run_id || "",
        result_json_path: redactPath(parsed.result_json_path || ""),
        run_root: redactPath(runRoot),
        artifacts: (parsed.artifacts || []).map(redactPath),
        output_files: runFiles.outputFiles,
        discovered_trajectory_files: runFiles.trajectoryFiles,
        call_previews: previews,
        publication_warnings: parsed.publication_warnings || [],
        total_tasks:
          metrics.total_tasks ??
          metrics.total_instances ??
          metrics.total_samples ??
          metrics.n ??
          null,
        llm_call_count:
          parsed.token_metrics?.llm_call_count ??
          parsed.token_metrics?.call_count ??
          metrics.token_metrics?.llm_call_count ??
          metrics.token_metrics?.call_count ??
          null,
        total_tokens:
          parsed.token_metrics?.total_tokens ??
          metrics.token_metrics?.total_tokens ??
          null,
        cached_tokens:
          parsed.token_metrics?.cached_tokens ??
          parsed.cache_metrics?.cache_read_input_tokens ??
          metrics.token_metrics?.cached_tokens ??
          metrics.cache_metrics?.cache_read_input_tokens ??
          null,
        cache_hit_ratio:
          parsed.cache_metrics?.cache_hit_ratio ??
          metrics.cache_metrics?.cache_hit_ratio ??
          null,
        trajectory_files:
          parsed.trajectory_summary?.files ??
          metrics.trajectory_summary?.files ??
          null,
        trajectory_turns:
          parsed.trajectory_summary?.turns ??
          metrics.trajectory_summary?.turns ??
          null,
      };
    });
}

function summarize(rows, index, canonicalFiles) {
  const warningCounts = {};
  for (const row of rows) {
    for (const warning of row.publication_warnings || []) {
      warningCounts[warning] = (warningCounts[warning] || 0) + 1;
    }
  }
  const benchmarkIds = new Set(rows.map((row) => row.benchmark_id));
  const agents = [...new Set(rows.map((row) => row.agent).filter(Boolean))].sort();
  const insufficientRows = rows.filter((row) =>
    (row.publication_warnings || []).some((warning) =>
      String(warning).startsWith("insufficient_"),
    ),
  );
  const missingTrajectoryRows = rows.filter(
    (row) =>
      Number(row.llm_call_count || 0) === 0 ||
      Number(row.trajectory_turns || 0) === 0,
  );
  return {
    rowCount: rows.length,
    benchmarkCount: benchmarkIds.size,
    matrixBenchmarkCount:
      index.matrix_contract?.summary?.benchmarks ??
      Object.keys(index.benchmark_comparability || {}).length,
    agents,
    comparableBenchmarkCount: Object.values(
      index.benchmark_comparability || {},
    ).filter((item) => item?.comparable).length,
    incompleteBenchmarkCount:
      index.matrix_contract?.summary?.incomplete_benchmarks ??
      index.matrix_contract?.incomplete_benchmarks ??
      0,
    insufficientLatestRows: insufficientRows.length,
    missingTrajectoryLatestRows: missingTrajectoryRows.length,
    canonicalTrajectoryFiles: canonicalFiles.length,
    latestRowsWithTrajectoryFiles: rows.filter(
      (row) => (row.discovered_trajectory_files || []).length > 0,
    ).length,
    latestTrajectoryFileCount: rows.reduce(
      (total, row) => total + (row.discovered_trajectory_files || []).length,
      0,
    ),
    latestOutputFileCount: rows.reduce(
      (total, row) => total + (row.output_files || []).length,
      0,
    ),
    latestRowsWithCallPreviews: rows.filter(
      (row) => (row.call_previews || []).length > 0,
    ).length,
    latestCallPreviewCount: rows.reduce(
      (total, row) => total + (row.call_previews || []).length,
      0,
    ),
    warningCounts,
  };
}

function summarizeCallCatalog(calls) {
  const rowsWithCalls = new Set(calls.map((call) => `${call.benchmark_id}__${call.agent}`));
  const benchmarksWithCalls = new Set(calls.map((call) => call.benchmark_id));
  return {
    normalizedCallCount: calls.length,
    rowsWithNormalizedCalls: rowsWithCalls.size,
    benchmarksWithNormalizedCalls: benchmarksWithCalls.size,
    totalTokens: calls.reduce((total, call) => total + Number(call.usage?.total_tokens || 0), 0),
    cachedTokens: calls.reduce((total, call) => total + Number(call.usage?.cached_tokens || 0), 0),
    promptTokens: calls.reduce((total, call) => total + Number(call.usage?.prompt_tokens || 0), 0),
    completionTokens: calls.reduce((total, call) => total + Number(call.usage?.completion_tokens || 0), 0),
  };
}

function telemetryGapSummary(rows, families, findings) {
  const tokenlessFamilies = findings
    .filter((finding) => finding.disposition === "telemetry-gap")
    .map((finding) => ({
      benchmark_id: finding.benchmark_id,
      normalized_calls: finding.normalized_calls,
      trajectory_like_files: finding.trajectory_like_files,
      output_files: finding.output_files,
      reasons: finding.reasons || [],
    }));
  const zeroMetricRows = rows
    .filter(
      (row) =>
        Number(row.llm_call_count || 0) === 0 ||
        Number(row.trajectory_turns || 0) === 0,
    )
    .map((row) => ({
      benchmark_id: row.benchmark_id,
      agent: row.agent,
      run_id: row.run_id,
      llm_call_count: row.llm_call_count,
      trajectory_turns: row.trajectory_turns,
      discovered_trajectory_files: (row.discovered_trajectory_files || []).length,
      call_previews: (row.call_previews || []).length,
      output_files: (row.output_files || []).length,
    }));
  const evidenceAbsentRows = zeroMetricRows.filter(
    (row) => row.discovered_trajectory_files === 0 && row.call_previews === 0,
  );
  const reasonCounts = {};
  for (const finding of findings) {
    for (const reason of finding.reasons || []) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }
  return {
    tokenlessFamilyCount: tokenlessFamilies.length,
    tokenlessFamilies,
    zeroMetricLatestRows: zeroMetricRows.length,
    zeroMetricRows,
    evidenceAbsentLatestRows: evidenceAbsentRows.length,
    evidenceAbsentRows,
    replayableButTokenlessRows: zeroMetricRows.filter(
      (row) => row.discovered_trajectory_files > 0 || row.call_previews > 0,
    ).length,
    familiesWithCallsButNoTokens: families.filter(
      (family) => family.normalized_calls > 0 && family.token_total === 0,
    ).length,
    reasonCounts,
  };
}

function benchmarkFamilySummary(rows, calls, index) {
  const callBuckets = new Map();
  for (const call of calls) {
    if (!callBuckets.has(call.benchmark_id)) callBuckets.set(call.benchmark_id, []);
    callBuckets.get(call.benchmark_id).push(call);
  }
  const rowBuckets = new Map();
  for (const row of rows) {
    if (!rowBuckets.has(row.benchmark_id)) rowBuckets.set(row.benchmark_id, []);
    rowBuckets.get(row.benchmark_id).push(row);
  }
  const matrix = index.matrix_contract?.benchmarks || {};
  const names = [...new Set([...rowBuckets.keys(), ...Object.keys(matrix)])].sort();
  return names.map((name) => {
    const familyRows = rowBuckets.get(name) || [];
    const familyCalls = callBuckets.get(name) || [];
    const tokenTotal = familyCalls.reduce(
      (total, call) => total + Number(call.usage?.total_tokens || 0),
      0,
    );
    const cachedTotal = familyCalls.reduce(
      (total, call) => total + Number(call.usage?.cached_tokens || 0),
      0,
    );
    const warnings = [
      ...new Set(familyRows.flatMap((row) => row.publication_warnings || [])),
    ].sort();
    return {
      benchmark_id: name,
      latest_rows: familyRows.length,
      agents: [...new Set(familyRows.map((row) => row.agent).filter(Boolean))].sort(),
      succeeded_rows: familyRows.filter((row) => row.status === "succeeded").length,
      score_min:
        familyRows.length > 0
          ? Math.min(...familyRows.map((row) => Number(row.score)).filter(Number.isFinite))
          : null,
      score_max:
        familyRows.length > 0
          ? Math.max(...familyRows.map((row) => Number(row.score)).filter(Number.isFinite))
          : null,
      total_tasks: familyRows.reduce((total, row) => total + Number(row.total_tasks || 0), 0),
      normalized_calls: familyCalls.length,
      token_total: tokenTotal,
      cached_token_total: cachedTotal,
      cache_percent: tokenTotal > 0 ? (cachedTotal / tokenTotal) * 100 : null,
      trajectory_like_files: familyRows.reduce(
        (total, row) => total + (row.discovered_trajectory_files || []).length,
        0,
      ),
      output_files: familyRows.reduce(
        (total, row) => total + (row.output_files || []).length,
        0,
      ),
      warnings,
      matrix_complete: matrix[name]?.complete ?? null,
      unsupported_cells: Object.values(matrix[name]?.cells || {}).filter(
        (cell) => cell?.status === "unsupported" || cell?.state === "unsupported",
      ).length,
    };
  });
}

function trajectorySummary() {
  const summary = sqliteJson(`
    select
      count(*) as trajectory_rows,
      count(distinct run_id) as run_count,
      sum(prompt_tokens) as prompt_tokens,
      sum(completion_tokens) as completion_tokens,
      sum(total_tokens) as total_tokens,
      sum(cached_tokens) as cached_tokens,
      sum(cache_creation_tokens) as cache_creation_tokens,
      avg(latency_ms) as mean_latency_ms
    from benchmark_run_trajectories
  `)[0] || {};
  const byRun = sqliteJson(`
    select
      r.benchmark_id,
      r.agent,
      r.run_id,
      r.status,
      r.score,
      r.unit,
      r.provider,
      r.model,
      count(t.turn_index) as trajectory_rows,
      sum(t.total_tokens) as total_tokens,
      sum(t.cached_tokens) as cached_tokens,
      avg(t.latency_ms) as mean_latency_ms
    from benchmark_runs r
    left join benchmark_run_trajectories t on t.run_id = r.run_id
    group by r.run_id
    order by r.benchmark_id, r.agent, r.started_at desc
  `);
  return {
    ...summary,
    byRun,
  };
}

function runHistoryComparison() {
  const rows = sqliteJson(`
    select
      benchmark_id,
      agent,
      run_id,
      status,
      score,
      unit,
      provider,
      model,
      started_at,
      ended_at,
      duration_seconds,
      benchmarks_commit,
      high_score_label,
      high_score_value,
      llm_call_count,
      trajectory_count,
      total_prompt_tokens,
      total_completion_tokens,
      total_cache_read_input_tokens,
      total_cache_creation_input_tokens
    from benchmark_runs
    order by benchmark_id, agent, started_at
  `);
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.benchmark_id}__${row.agent}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const comparisons = [];
  for (const [key, history] of grouped) {
    const succeededHistory = history.filter((row) => row.status === "succeeded");
    const comparableHistory = succeededHistory.length > 0 ? succeededHistory : history;
    const current = comparableHistory.at(-1);
    const previous = comparableHistory.length > 1 ? comparableHistory.at(-2) : null;
    comparisons.push({
      key,
      benchmark_id: current.benchmark_id,
      agent: current.agent,
      run_count: history.length,
      succeeded_run_count: succeededHistory.length,
      has_previous: Boolean(previous),
      current,
      previous,
      deltas: previous
        ? {
            score: Number(current.score ?? 0) - Number(previous.score ?? 0),
            llm_call_count:
              Number(current.llm_call_count ?? 0) -
              Number(previous.llm_call_count ?? 0),
            trajectory_count:
              Number(current.trajectory_count ?? 0) -
              Number(previous.trajectory_count ?? 0),
            prompt_tokens:
              Number(current.total_prompt_tokens ?? 0) -
              Number(previous.total_prompt_tokens ?? 0),
            completion_tokens:
              Number(current.total_completion_tokens ?? 0) -
              Number(previous.total_completion_tokens ?? 0),
            cache_read_tokens:
              Number(current.total_cache_read_input_tokens ?? 0) -
              Number(previous.total_cache_read_input_tokens ?? 0),
            duration_seconds:
              Number(current.duration_seconds ?? 0) -
              Number(previous.duration_seconds ?? 0),
          }
        : {},
      history: comparableHistory.slice(-10),
      skipped_or_unsupported_count: history.filter(
        (row) => row.status !== "succeeded",
      ).length,
    });
  }
  comparisons.sort((a, b) => a.key.localeCompare(b.key));
  return {
    summary: {
      runCount: rows.length,
      benchmarkCount: new Set(rows.map((row) => row.benchmark_id)).size,
      benchmarkAgentPairs: comparisons.length,
      pairsWithPrevious: comparisons.filter((entry) => entry.has_previous).length,
      pairsWithoutPrevious: comparisons.filter((entry) => !entry.has_previous).length,
      pairsWithSuccessfulPrevious: comparisons.filter(
        (entry) => entry.has_previous && entry.succeeded_run_count >= 2,
      ).length,
      rowsWithBenchmarksCommit: rows.filter((row) => row.benchmarks_commit).length,
      rowsWithHighScore: rows.filter((row) => row.high_score_value !== null).length,
      skippedOrUnsupportedRuns: rows.filter((row) => row.status !== "succeeded").length,
    },
    comparisons,
  };
}

function reviewFindings(families, runHistory) {
  const historyByBenchmark = new Map();
  for (const entry of runHistory.comparisons || []) {
    if (!historyByBenchmark.has(entry.benchmark_id)) {
      historyByBenchmark.set(entry.benchmark_id, []);
    }
    historyByBenchmark.get(entry.benchmark_id).push(entry);
  }
  return families.map((family) => {
    const reasons = [];
    const history = historyByBenchmark.get(family.benchmark_id) || [];
    const previousPairs = history.filter((entry) => entry.has_previous).length;
    const regressionPairs = history.filter(
      (entry) => entry.has_previous && Number(entry.deltas?.score || 0) < 0,
    ).length;
    const improvementPairs = history.filter(
      (entry) => entry.has_previous && Number(entry.deltas?.score || 0) > 0,
    ).length;
    if (family.matrix_complete === false) {
      reasons.push(`matrix partial; unsupported cells=${family.unsupported_cells}`);
    }
    if (family.latest_rows === 0) {
      reasons.push("no latest published rows");
    }
    if (family.succeeded_rows < family.latest_rows) {
      reasons.push(`${family.latest_rows - family.succeeded_rows} latest row(s) not succeeded`);
    }
    if ((family.warnings || []).length > 0) {
      reasons.push(`publication warnings: ${(family.warnings || []).join(", ")}`);
    }
    if (family.normalized_calls === 0) {
      reasons.push("no normalized model/action calls recovered");
    }
    if (family.trajectory_like_files === 0) {
      reasons.push("no trajectory-like artifact files discovered");
    }
    if (family.token_total === 0 && family.normalized_calls > 0) {
      reasons.push("call records lack token totals");
    }
    if (regressionPairs > 0) {
      reasons.push(`${regressionPairs} comparable history pair(s) regressed by score`);
    }
    if (previousPairs === 0) {
      reasons.push("no previous comparable run for version comparison");
    }
    const cachePercent =
      typeof family.cache_percent === "number" ? family.cache_percent : null;
    let disposition = "review-pass";
    if (
      family.matrix_complete === false ||
      family.latest_rows === 0 ||
      family.succeeded_rows < family.latest_rows
    ) {
      disposition = "blocked";
    } else if (
      family.normalized_calls === 0 ||
      family.trajectory_like_files === 0 ||
      (family.warnings || []).length > 0 ||
      regressionPairs > 0
    ) {
      disposition = "needs-review";
    } else if (family.token_total === 0 && family.normalized_calls > 0) {
      disposition = "telemetry-gap";
    }
    return {
      benchmark_id: family.benchmark_id,
      disposition,
      reasons: reasons.length > 0 ? reasons : ["latest rows succeeded with trajectory/call evidence"],
      latest_rows: family.latest_rows,
      succeeded_rows: family.succeeded_rows,
      normalized_calls: family.normalized_calls,
      trajectory_like_files: family.trajectory_like_files,
      output_files: family.output_files,
      token_total: family.token_total,
      cached_token_total: family.cached_token_total,
      cache_percent: cachePercent,
      history_pairs: history.length,
      previous_pairs: previousPairs,
      regression_pairs: regressionPairs,
      improvement_pairs: improvementPairs,
    };
  });
}

function reviewFindingSummary(findings) {
  const byDisposition = {};
  for (const finding of findings) {
    byDisposition[finding.disposition] =
      (byDisposition[finding.disposition] || 0) + 1;
  }
  return {
    findingCount: findings.length,
    byDisposition,
    reviewPass: byDisposition["review-pass"] || 0,
    needsReview: byDisposition["needs-review"] || 0,
    telemetryGap: byDisposition["telemetry-gap"] || 0,
    blocked: byDisposition.blocked || 0,
    withRegression: findings.filter((finding) => finding.regression_pairs > 0).length,
    withoutVersionComparison: findings.filter((finding) => finding.previous_pairs === 0).length,
    withoutNormalizedCalls: findings.filter((finding) => finding.normalized_calls === 0).length,
  };
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Results Corpus Review</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; font-size:22px; margin-top:3px; }
    .panel { margin-bottom:12px; overflow:hidden; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f8faf5; position:sticky; top:0; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    .ok { color:#17633a; font-weight:700; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Benchmark Results Corpus Review</h1><div id="meta" class="muted"></div></header>
  <main>
    <div id="cards" class="grid"></div>
    <section class="panel"><h2>Coverage Gaps</h2><div id="gaps" class="body"></div></section>
    <section class="panel"><h2>Per-Benchmark Review Findings</h2><div id="findings" class="body"></div></section>
    <section class="panel"><h2>Benchmark Family Summary</h2><div id="families" class="body"></div></section>
    <section class="panel"><h2>Run History Comparison</h2><div id="history" class="body"></div></section>
    <section class="panel"><h2>Latest Rows</h2><div id="latest" class="body"></div></section>
    <section class="panel"><h2>Normalized Call Catalog</h2><div id="calls" class="body"></div></section>
    <section class="panel"><h2>Canonical Playback Files</h2><div id="canonical" class="body"></div></section>
    <section class="panel"><h2>SQLite Trajectory Rows</h2><div id="sqliteRows" class="body"></div></section>
    <section class="panel"><h2>Trajectory Runs</h2><div id="trajectories" class="body"></div></section>
  </main>
  <script src="./corpus-review-data.js"></script>
  <script>
    const data = window.BENCHMARK_RESULTS_CORPUS_REVIEW || {};
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const n = v => typeof v === "number" ? v.toLocaleString() : esc(v ?? "");
    document.getElementById("meta").textContent = (data.generatedAt || "") + " · source: " + (data.sourceDir || "");
    const cards = [
      ["Latest rows", data.summary?.rowCount],
      ["Benchmarks", data.summary?.benchmarkCount],
      ["Matrix benchmarks", data.summary?.matrixBenchmarkCount],
      ["Comparable", data.summary?.comparableBenchmarkCount],
      ["Partial matrix", data.summary?.incompleteBenchmarkCount],
      ["Insufficient latest rows", data.summary?.insufficientLatestRows],
      ["Missing trajectory rows", data.summary?.missingTrajectoryLatestRows],
      ["SQLite trajectory rows", data.trajectory?.trajectory_rows],
      ["Latest rows with files", data.summary?.latestRowsWithTrajectoryFiles],
      ["Latest trajectory files", data.summary?.latestTrajectoryFileCount],
      ["Rows with call previews", data.summary?.latestRowsWithCallPreviews],
      ["Call previews", data.summary?.latestCallPreviewCount],
      ["Normalized calls", data.callCatalogSummary?.normalizedCallCount],
      ["Rows with normalized calls", data.callCatalogSummary?.rowsWithNormalizedCalls],
      ["History pairs", data.runHistory?.summary?.benchmarkAgentPairs],
      ["Pairs with previous", data.runHistory?.summary?.pairsWithPrevious],
      ["Canonical files", data.summary?.canonicalTrajectoryFiles],
      ["SQLite playback rows", data.sqliteTrajectoryRows?.length],
      ["Review pass", data.reviewFindingSummary?.reviewPass],
      ["Needs review", data.reviewFindingSummary?.needsReview],
      ["Telemetry gaps", data.reviewFindingSummary?.telemetryGap],
      ["Blocked families", data.reviewFindingSummary?.blocked],
    ];
    document.getElementById("cards").innerHTML = cards.map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + n(v) + '</b></div>').join("");
    const warnings = Object.entries(data.summary?.warningCounts || {}).sort((a,b) => b[1]-a[1]);
    const gaps = [
      ["Publication warnings", warnings.map(([k,v]) => k + ": " + v).join("; ") || "none"],
      ["Partial matrix benchmarks", data.summary?.incompleteBenchmarkCount || 0],
      ["Canonical trajectory files", data.summary?.canonicalTrajectoryFiles || 0],
      ["Tokenless replay families", (data.telemetryGapSummary?.tokenlessFamilies || []).map(f => f.benchmark_id + " (" + f.normalized_calls + " records)").join("; ") || "none"],
      ["Zero-metric latest rows", (data.telemetryGapSummary?.zeroMetricLatestRows || 0) + " total; " + (data.telemetryGapSummary?.replayableButTokenlessRows || 0) + " have replayable previews/files; " + (data.telemetryGapSummary?.evidenceAbsentLatestRows || 0) + " lack previews/files"],
      ["Hyperliquid live prerequisites", data.credentialGaps?.hyperliquid?.runnable ? "ready" : "missing " + (data.credentialGaps?.hyperliquid?.missing || []).join(", ")],
    ];
    document.getElementById("gaps").innerHTML = '<table><thead><tr><th>gap/evidence</th><th>detail</th></tr></thead><tbody>' + gaps.map(([k,v]) => '<tr><td><strong>' + esc(k) + '</strong></td><td>' + esc(v) + '</td></tr>').join("") + '</tbody></table>';
    document.getElementById("findings").innerHTML = '<table><thead><tr><th>benchmark</th><th>disposition</th><th>evidence</th><th>cache</th><th>history</th><th>reasons</th></tr></thead><tbody>' + (data.reviewFindings || []).map(f => '<tr><td><code>' + esc(f.benchmark_id) + '</code></td><td class="' + (f.disposition === 'review-pass' ? 'ok' : f.disposition === 'blocked' ? 'bad' : 'warn') + '">' + esc(f.disposition) + '</td><td>' + esc(f.succeeded_rows) + '/' + esc(f.latest_rows) + ' succeeded<br>' + n(f.normalized_calls) + ' calls<br>' + esc(f.trajectory_like_files) + ' trajectory files<br>' + esc(f.output_files) + ' output files</td><td>' + n(f.token_total) + ' tokens<br><span class="muted">' + n(f.cached_token_total) + ' cached (' + esc(f.cache_percent == null ? "n/a" : f.cache_percent.toFixed(1) + "%") + ')</span></td><td>' + esc(f.previous_pairs) + '/' + esc(f.history_pairs) + ' with previous<br><span class="muted">' + esc(f.regression_pairs) + ' regressed, ' + esc(f.improvement_pairs) + ' improved</span></td><td>' + esc((f.reasons || []).join("; ")) + '</td></tr>').join("") + '</tbody></table>';
    document.getElementById("families").innerHTML = '<table><thead><tr><th>benchmark</th><th>rows</th><th>success</th><th>score range</th><th>tasks</th><th>calls</th><th>tokens/cache</th><th>files</th><th>matrix</th><th>warnings</th></tr></thead><tbody>' + (data.benchmarkFamilies || []).map(f => '<tr><td><code>' + esc(f.benchmark_id) + '</code><br>' + (f.family_page ? '<a href="' + esc(f.family_page.replace("reports/benchmarks/benchmark-results-corpus-review/", "")) + '">family review</a>' : '') + '</td><td>' + esc(f.latest_rows) + '<br><span class="muted">' + esc((f.agents || []).join(", ")) + '</span></td><td>' + esc(f.succeeded_rows) + '/' + esc(f.latest_rows) + '</td><td>' + esc(f.score_min) + ' - ' + esc(f.score_max) + '</td><td>' + esc(f.total_tasks) + '</td><td>' + n(f.normalized_calls) + '</td><td>' + n(f.token_total) + '<br><span class="muted">cache ' + n(f.cached_token_total) + ' (' + esc(f.cache_percent == null ? "n/a" : f.cache_percent.toFixed(1) + "%") + ')</span></td><td>' + esc(f.trajectory_like_files) + ' trajectory<br>' + esc(f.output_files) + ' output</td><td class="' + (f.matrix_complete === false ? 'bad' : 'ok') + '">' + esc(f.matrix_complete) + '<br><span class="muted">unsupported ' + esc(f.unsupported_cells) + '</span></td><td>' + esc((f.warnings || []).join(", ")) + '</td></tr>').join("") + '</tbody></table>';
    document.getElementById("history").innerHTML = '<table><thead><tr><th>benchmark</th><th>agent</th><th>runs</th><th>current</th><th>previous</th><th>deltas</th><th>recent comparable history</th></tr></thead><tbody>' + (data.runHistory?.comparisons || []).map(h => '<tr><td><code>' + esc(h.benchmark_id) + '</code></td><td>' + esc(h.agent) + '</td><td>' + esc(h.run_count) + '<br><span class="muted">' + esc(h.succeeded_run_count) + ' succeeded, ' + esc(h.skipped_or_unsupported_count) + ' skipped/unsupported</span></td><td><code>' + esc(h.current?.run_id) + '</code><br>' + esc(h.current?.status) + ' · ' + esc(h.current?.score) + ' ' + esc(h.current?.unit) + '<br><span class="muted">' + esc(h.current?.started_at) + '</span></td><td>' + (h.previous ? '<code>' + esc(h.previous.run_id) + '</code><br>' + esc(h.previous.status) + ' · ' + esc(h.previous.score) + ' ' + esc(h.previous.unit) + '<br><span class="muted">' + esc(h.previous.started_at) + '</span>' : '<span class="muted">none</span>') + '</td><td>score Δ ' + esc(h.deltas?.score ?? '') + '<br>calls Δ ' + esc(h.deltas?.llm_call_count ?? '') + '<br>traj Δ ' + esc(h.deltas?.trajectory_count ?? '') + '<br>prompt Δ ' + esc(h.deltas?.prompt_tokens ?? '') + '<br>cache Δ ' + esc(h.deltas?.cache_read_tokens ?? '') + '</td><td>' + (h.history || []).map(r => '<div><code>' + esc(r.run_id) + '</code> ' + esc(r.status) + ' ' + esc(r.score ?? '') + '</div>').join("") + '</td></tr>').join("") + '</tbody></table>';
    document.getElementById("latest").innerHTML = '<table><thead><tr><th>benchmark</th><th>agent</th><th>status</th><th>score</th><th>tasks</th><th>calls</th><th>tokens</th><th>cache</th><th>trajectory</th><th>call previews</th><th>artifact files</th><th>warnings</th></tr></thead><tbody>' + (data.latestRows || []).map(r => '<tr><td><code>' + esc(r.benchmark_id) + '</code></td><td>' + esc(r.agent) + '</td><td class="' + (r.status === 'succeeded' ? 'ok' : 'bad') + '">' + esc(r.status) + '</td><td>' + esc(r.score) + ' ' + esc(r.unit) + '</td><td>' + esc(r.total_tasks) + '</td><td>' + esc(r.llm_call_count) + '</td><td>' + n(r.total_tokens) + '</td><td>' + esc(r.cache_hit_ratio) + '</td><td>' + esc((r.discovered_trajectory_files || []).length) + ' files / ' + esc(r.trajectory_turns) + ' turns<br><span class="muted">' + esc((r.discovered_trajectory_files || []).slice(0,3).join("\\n")) + '</span></td><td>' + (r.call_previews || []).map((p, i) => '<details><summary>call ' + esc(i + 1) + ' · ' + esc(p.usage?.total_tokens ?? '') + ' tok · cache ' + esc(p.usage?.cached_tokens ?? '') + '</summary><strong>prompt</strong><pre>' + esc(p.prompt) + '</pre><strong>response</strong><pre>' + esc(p.response) + '</pre></details>').join("") + '</td><td>' + esc((r.output_files || []).length) + '<br><span class="muted">' + esc((r.output_files || []).slice(0,3).join("\\n")) + '</span></td><td>' + esc((r.publication_warnings || []).join(", ")) + '</td></tr>').join("") + '</tbody></table>';
    document.getElementById("calls").innerHTML = '<table><thead><tr><th>#</th><th>benchmark</th><th>agent</th><th>run</th><th>tokens</th><th>cache</th><th>latency</th><th>prompt/response</th></tr></thead><tbody>' + (data.normalizedCalls || []).map(c => '<tr><td>' + esc(c.catalog_index) + '</td><td><code>' + esc(c.benchmark_id) + '</code></td><td>' + esc(c.agent) + '</td><td><code>' + esc(c.run_id) + '</code><br><span class="muted">' + esc(c.file) + '</span></td><td>' + esc(c.usage?.prompt_tokens) + ' / ' + esc(c.usage?.completion_tokens) + ' / ' + esc(c.usage?.total_tokens) + '</td><td>' + esc(c.usage?.cached_tokens) + '</td><td>' + esc(c.usage?.latency_ms) + '</td><td><details><summary>prompt</summary><pre>' + esc(c.prompt) + '</pre></details><details><summary>response</summary><pre>' + esc(c.response) + '</pre></details></td></tr>').join("") + '</tbody></table><p class="muted">Showing all ' + n((data.normalizedCalls || []).length) + ' normalized calls. Canonical JSONL playback files are grouped by benchmark, agent, and run below.</p>';
    document.getElementById("canonical").innerHTML = '<table><thead><tr><th>benchmark</th><th>agent</th><th>run</th><th>calls</th><th>tokens/cache</th><th>sources</th><th>playback</th><th>jsonl</th></tr></thead><tbody>' + (data.canonicalFiles || []).map(f => '<tr><td><code>' + esc(f.benchmark_id) + '</code></td><td>' + esc(f.agent) + '</td><td><code>' + esc(f.run_id) + '</code></td><td>' + n(f.call_count) + '</td><td>' + n(f.token_total) + '<br><span class="muted">cache ' + n(f.cached_token_total) + '</span></td><td>' + esc((f.sources || []).join(", ")) + '</td><td><a href="' + esc((f.playback_file || "").replace("reports/benchmarks/benchmark-results-corpus-review/", "")) + '">open</a></td><td><code>' + esc(f.file) + '</code></td></tr>').join("") + '</tbody></table>';
    document.getElementById("sqliteRows").innerHTML = '<table><thead><tr><th>benchmark</th><th>agent</th><th>run</th><th>turn</th><th>tokens</th><th>cache</th><th>latency</th><th>file</th></tr></thead><tbody>' + (data.sqliteTrajectoryRows || []).map(r => '<tr><td><code>' + esc(r.benchmark_id) + '</code></td><td>' + esc(r.agent) + '</td><td><code>' + esc(r.run_id) + '</code></td><td>' + esc(r.turn_index) + '</td><td>' + esc(r.prompt_tokens) + ' / ' + esc(r.completion_tokens) + ' / ' + esc(r.total_tokens) + '</td><td>' + esc(r.cached_tokens) + '<br><span class="muted">create ' + esc(r.cache_creation_tokens) + '</span></td><td>' + esc(r.latency_ms) + '</td><td><code>' + esc(r.trajectory_file) + '</code></td></tr>').join("") + '</tbody></table>';
    document.getElementById("trajectories").innerHTML = '<table><thead><tr><th>benchmark</th><th>agent</th><th>run</th><th>status</th><th>score</th><th>rows</th><th>tokens</th><th>cached</th><th>latency</th></tr></thead><tbody>' + (data.trajectory?.byRun || []).map(r => '<tr><td><code>' + esc(r.benchmark_id) + '</code></td><td>' + esc(r.agent) + '</td><td><code>' + esc(r.run_id) + '</code></td><td>' + esc(r.status) + '</td><td>' + esc(r.score) + ' ' + esc(r.unit) + '</td><td>' + n(r.trajectory_rows) + '</td><td>' + n(r.total_tokens) + '</td><td>' + n(r.cached_tokens) + '</td><td>' + esc(r.mean_latency_ms) + '</td></tr>').join("") + '</tbody></table>';
  </script>
</body>
</html>`;
}

function renderMarkdown(payload) {
  return [
    "# Benchmark Results Corpus Review",
    "",
    `Generated: ${payload.generatedAt}`,
    `Source: ${payload.sourceDir}`,
    "",
    "## Summary",
    "",
    `Latest rows: ${payload.summary.rowCount}`,
    `Benchmarks with latest rows: ${payload.summary.benchmarkCount}`,
    `Matrix benchmarks: ${payload.summary.matrixBenchmarkCount}`,
    `Agents: ${payload.summary.agents.join(", ")}`,
    `Comparable benchmarks: ${payload.summary.comparableBenchmarkCount}`,
    `Partial matrix benchmarks: ${payload.summary.incompleteBenchmarkCount}`,
    `Latest rows with insufficient-* warnings: ${payload.summary.insufficientLatestRows}`,
    `Latest rows with zero calls or zero trajectory turns: ${payload.summary.missingTrajectoryLatestRows}`,
    `Latest rows with discovered trajectory-like files: ${payload.summary.latestRowsWithTrajectoryFiles}`,
    `Latest trajectory-like files discovered: ${payload.summary.latestTrajectoryFileCount}`,
    `Latest output files discovered: ${payload.summary.latestOutputFileCount}`,
    `Latest rows with call previews: ${payload.summary.latestRowsWithCallPreviews}`,
    `Call previews extracted: ${payload.summary.latestCallPreviewCount}`,
    `Normalized call records: ${payload.callCatalogSummary.normalizedCallCount}`,
    `Latest rows with normalized calls: ${payload.callCatalogSummary.rowsWithNormalizedCalls}`,
    `Benchmarks with normalized calls: ${payload.callCatalogSummary.benchmarksWithNormalizedCalls}`,
    `Normalized call tokens: ${payload.callCatalogSummary.totalTokens}`,
    `Normalized call cached tokens: ${payload.callCatalogSummary.cachedTokens}`,
    `Run-history rows: ${payload.runHistory.summary.runCount}`,
    `Benchmark/agent history pairs: ${payload.runHistory.summary.benchmarkAgentPairs}`,
    `History pairs with previous runs: ${payload.runHistory.summary.pairsWithPrevious}`,
    `History pairs with previous successful runs: ${payload.runHistory.summary.pairsWithSuccessfulPrevious}`,
    `Rows with benchmark commit metadata: ${payload.runHistory.summary.rowsWithBenchmarksCommit}`,
    `Rows with high-score metadata: ${payload.runHistory.summary.rowsWithHighScore}`,
    `Skipped/unsupported history rows: ${payload.runHistory.summary.skippedOrUnsupportedRuns}`,
    `SQLite trajectory rows: ${payload.trajectory.trajectory_rows || 0}`,
    `Canonical trajectory files: ${payload.summary.canonicalTrajectoryFiles}`,
    `Canonical playback HTML files: ${payload.canonicalFiles.filter((entry) => entry.playback_file).length}`,
    `Canonical playback manifest rows: ${payload.canonicalFiles.length}`,
    `SQLite trajectory playback rows: ${payload.sqliteTrajectoryRows.length}`,
    `Review findings: ${payload.reviewFindingSummary.findingCount}`,
    `Review-pass families: ${payload.reviewFindingSummary.reviewPass}`,
    `Needs-review families: ${payload.reviewFindingSummary.needsReview}`,
    `Telemetry-gap families: ${payload.reviewFindingSummary.telemetryGap}`,
    `Blocked families: ${payload.reviewFindingSummary.blocked}`,
    `Tokenless replay families: ${payload.telemetryGapSummary.tokenlessFamilyCount}`,
    `Zero-metric latest rows: ${payload.telemetryGapSummary.zeroMetricLatestRows}`,
    `Zero-metric rows with replayable files/previews: ${payload.telemetryGapSummary.replayableButTokenlessRows}`,
    `Evidence-absent latest rows: ${payload.telemetryGapSummary.evidenceAbsentLatestRows}`,
    `Hyperliquid runnable: ${payload.credentialGaps.hyperliquid.runnable ? "yes" : "no"}`,
    `Hyperliquid missing env keys: ${payload.credentialGaps.hyperliquid.missing.join(", ") || "none"}`,
    "",
    "## Benchmark Family Summary",
    "",
    "| benchmark | latest rows | succeeded | tasks | normalized calls | tokens | cached tokens | matrix complete | warnings |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ...payload.benchmarkFamilies.map((family) =>
      `| \`${family.benchmark_id}\` | ${family.latest_rows} | ${family.succeeded_rows} | ${family.total_tasks} | ${family.normalized_calls} | ${family.token_total} | ${family.cached_token_total} | ${family.matrix_complete} | ${(family.warnings || []).join(", ")} |`,
    ),
    "",
    "## Per-Benchmark Review Findings",
    "",
    "| benchmark | disposition | rows | calls | cache % | history | reasons |",
    "|---|---|---:|---:|---:|---:|---|",
    ...payload.reviewFindings.map((finding) =>
      `| \`${finding.benchmark_id}\` | ${finding.disposition} | ${finding.succeeded_rows}/${finding.latest_rows} | ${finding.normalized_calls} | ${finding.cache_percent == null ? "" : finding.cache_percent.toFixed(1)} | ${finding.previous_pairs}/${finding.history_pairs} | ${(finding.reasons || []).join("; ").replaceAll("|", "\\|")} |`,
    ),
    "",
    "## Telemetry Gap Details",
    "",
    "| benchmark | normalized records | trajectory files | output files | reasons |",
    "|---|---:|---:|---:|---|",
    ...payload.telemetryGapSummary.tokenlessFamilies.map((family) =>
      `| \`${family.benchmark_id}\` | ${family.normalized_calls} | ${family.trajectory_like_files} | ${family.output_files} | ${(family.reasons || []).join("; ").replaceAll("|", "\\|")} |`,
    ),
    "",
    "| benchmark | agent | run | llm calls | turns | files | previews | output files |",
    "|---|---|---|---:|---:|---:|---:|---:|",
    ...payload.telemetryGapSummary.zeroMetricRows.map((row) =>
      `| \`${row.benchmark_id}\` | ${row.agent} | \`${row.run_id}\` | ${row.llm_call_count ?? ""} | ${row.trajectory_turns ?? ""} | ${row.discovered_trajectory_files} | ${row.call_previews} | ${row.output_files} |`,
    ),
    "",
    "## Run History Comparison",
    "",
    "| benchmark | agent | runs | succeeded | current | previous | score delta | call delta | cache-read delta |",
    "|---|---|---:|---|---|---:|---:|---:|",
    ...payload.runHistory.comparisons.map((entry) =>
      `| \`${entry.benchmark_id}\` | ${entry.agent} | ${entry.run_count} | ${entry.succeeded_run_count} | \`${entry.current?.run_id || ""}\` | \`${entry.previous?.run_id || ""}\` | ${entry.deltas?.score ?? ""} | ${entry.deltas?.llm_call_count ?? ""} | ${entry.deltas?.cache_read_tokens ?? ""} |`,
    ),
    "",
    "## Warning Counts",
    "",
    "| warning | rows |",
    "|---|---:|",
    ...Object.entries(payload.summary.warningCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([warning, count]) => `| \`${warning}\` | ${count} |`),
    "",
    "## Canonical Playback Files",
    "",
    "| benchmark | agent | run | calls | tokens | cached tokens | playback | jsonl |",
    "|---|---|---|---:|---:|---:|---|---|",
    ...payload.canonicalFiles.map((entry) =>
      `| \`${entry.benchmark_id}\` | ${entry.agent} | \`${entry.run_id}\` | ${entry.call_count} | ${entry.token_total} | ${entry.cached_token_total} | \`${entry.playback_file}\` | \`${entry.file}\` |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const index = readJson(path.join(LATEST_DIR, "index.json"));
  const rows = latestRows();
  const normalizedCalls = normalizedCallCatalog(rows);
  const sqliteRows = sqliteTrajectoryRows();
  const canonicalFiles = writeCanonicalTrajectories(normalizedCalls, sqliteRows);
  const families = benchmarkFamilySummary(rows, normalizedCalls, index);
  const runHistory = runHistoryComparison();
  const findings = reviewFindings(families, runHistory);
  const telemetryGaps = telemetryGapSummary(rows, families, findings);
  const payload = {
    schema: "eliza_benchmark_results_corpus_review_v1",
    generatedAt: new Date().toISOString(),
    sourceDir: SOURCE_DIR,
    latestDir: LATEST_DIR,
    sqlitePath: SQLITE_PATH,
    summary: summarize(rows, index, canonicalFiles),
    callCatalogSummary: summarizeCallCatalog(normalizedCalls),
    credentialGaps: credentialProbe(),
    benchmarkFamilies: families,
    reviewFindings: findings,
    reviewFindingSummary: reviewFindingSummary(findings),
    telemetryGapSummary: telemetryGaps,
    runHistory,
    latestRows: rows,
    normalizedCalls,
    canonicalFiles,
    sqliteTrajectoryRows: sqliteRows,
    trajectory: trajectorySummary(),
  };
  payload.noPlaybackGapPages = writeNoPlaybackGapPages(payload);
  payload.summary.noPlaybackGapPages = payload.noPlaybackGapPages.length;
  payload.familyReviewPages = writeFamilyReviewPages(payload);
  payload.summary.familyReviewPages = payload.familyReviewPages.length;
  writeFileSync(
    path.join(REPORT_DIR, "corpus-review.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(REPORT_DIR, "corpus-review-data.js"),
    `window.BENCHMARK_RESULTS_CORPUS_REVIEW = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "README.md"), renderMarkdown(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(), "utf8");
  process.stdout.write(
    `benchmark results corpus review ${payload.summary.rowCount} rows, ${payload.summary.benchmarkCount} benchmarks, ${payload.trajectory.trajectory_rows || 0} trajectory rows\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
