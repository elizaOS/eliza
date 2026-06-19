#!/usr/bin/env node

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORTS_DIR = path.join(REPO_ROOT, "reports");
const OUT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "artifact-manifest");

function walk(dir, rows = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(filePath, rows);
    } else if (entry.isFile()) {
      const stat = statSync(filePath);
      const relative = path.relative(REPO_ROOT, filePath).replaceAll(path.sep, "/");
      const extension = path.extname(entry.name).slice(1).toLowerCase() || "none";
      rows.push({
        path: relative,
        href: path.relative(OUT_DIR, filePath).replaceAll(path.sep, "/"),
        extension,
        bytes: stat.size,
        area: areaFor(relative),
        role: roleFor(relative),
      });
    }
  }
  return rows;
}

function areaFor(relative) {
  if (relative.startsWith("reports/benchmark-analysis/")) return "benchmark-analysis";
  if (relative.startsWith("reports/benchmarks/")) return "benchmarks";
  if (relative.startsWith("reports/scenarios/")) return "scenarios";
  if (relative.startsWith("reports/live-test-inventory/")) return "live-test-inventory";
  if (relative.startsWith("reports/live-test-runs/")) return "live-test-runs";
  return relative.split("/").slice(0, 2).join("/");
}

function roleFor(relative) {
  if (/playback.*\.html$|\/playback\/.*\.html$|\/playback\.html$/.test(relative)) {
    return "playback-html";
  }
  if (/\/viewer\/index\.html$|\/index\.html$/.test(relative)) return "viewer";
  if (/\.canonical\.jsonl$|trajectory.*\.jsonl$|\/trajectory\.jsonl$/.test(relative)) {
    return "trajectory-data";
  }
  if (/\.json$|\.js$/.test(relative)) return "data";
  if (/\.md$/.test(relative)) return "markdown";
  if (/\.log$/.test(relative)) return "log";
  return "artifact";
}

function countBy(rows, key) {
  return rows.reduce((acc, row) => {
    const value = row[key] || "unknown";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
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

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Artifact Manifest</title>
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
    .controls { display:grid; grid-template-columns:2fr repeat(3,minmax(140px,1fr)); gap:8px; padding:10px; border-bottom:1px solid #d7ded1; }
    input,select { width:100%; border:1px solid #d7ded1; border-radius:6px; padding:7px 8px; background:#fff; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { position:sticky; top:61px; background:#f7faf4; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    @media (max-width:900px) { .controls { grid-template-columns:1fr; } th { top:0; } }
  </style>
</head>
<body>
  <header><h1>Benchmark Artifact Manifest</h1><div id="meta" class="muted"></div></header>
  <main>
    <div id="cards" class="cards"></div>
    <section class="panel">
      <div class="controls">
        <input id="q" type="search" placeholder="Search path..." />
        <select id="area"><option value="">all areas</option></select>
        <select id="role"><option value="">all roles</option></select>
        <select id="extension"><option value="">all extensions</option></select>
      </div>
      <div id="table"></div>
    </section>
  </main>
  <script src="./manifest-data.js"></script>
  <script>
    const data = window.BENCHMARK_ARTIFACT_MANIFEST || { files: [], summary: {} };
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    document.getElementById("meta").textContent = (data.generatedAt || "") + " · " + (data.summary.totalFiles || 0) + " files";
    document.getElementById("cards").innerHTML = [["files",data.summary.totalFiles],["HTML",data.summary.htmlFiles],["playback HTML",data.summary.playbackHtmlFiles],["trajectory data",data.summary.trajectoryDataFiles],["JSON",data.summary.jsonFiles],["bytes",data.summary.totalBytes]].map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + esc(v ?? 0) + '</b></div>').join("");
    for (const id of ["area","role","extension"]) {
      const values = [...new Set(data.files.map(f => f[id]).filter(Boolean))].sort();
      document.getElementById(id).innerHTML += values.map(v => '<option>' + esc(v) + '</option>').join("");
    }
    function filtered() {
      const q = document.getElementById("q").value.toLowerCase();
      const area = document.getElementById("area").value;
      const role = document.getElementById("role").value;
      const extension = document.getElementById("extension").value;
      return data.files.filter(f => (!q || f.path.toLowerCase().includes(q)) && (!area || f.area === area) && (!role || f.role === role) && (!extension || f.extension === extension));
    }
    function render() {
      const rows = filtered();
      document.getElementById("table").innerHTML = '<table><thead><tr><th>path</th><th>area</th><th>role</th><th>extension</th><th>bytes</th></tr></thead><tbody>' + rows.map(f => '<tr><td><a href="' + esc(f.href) + '"><code>' + esc(f.path) + '</code></a></td><td>' + esc(f.area) + '</td><td>' + esc(f.role) + '</td><td>' + esc(f.extension) + '</td><td>' + esc(f.bytes) + '</td></tr>').join("") + '</tbody></table>';
    }
    for (const id of ["q","area","role","extension"]) document.getElementById(id).addEventListener("input", render);
    for (const id of ["area","role","extension"]) document.getElementById(id).addEventListener("change", render);
    render();
  </script>
</body>
</html>`;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = walk(REPORTS_DIR).sort((a, b) => a.path.localeCompare(b.path));
  const summary = {
    totalFiles: files.length,
    totalBytes: files.reduce((sum, row) => sum + row.bytes, 0),
    htmlFiles: files.filter((row) => row.extension === "html").length,
    playbackHtmlFiles: files.filter((row) => row.role === "playback-html").length,
    trajectoryDataFiles: files.filter((row) => row.role === "trajectory-data").length,
    jsonFiles: files.filter((row) => row.extension === "json").length,
    byArea: countBy(files, "area"),
    byRole: countBy(files, "role"),
    byExtension: countBy(files, "extension"),
  };
  const payload = {
    schema: "eliza_benchmark_artifact_manifest_v1",
    generatedAt: new Date().toISOString(),
    summary,
    files,
  };
  writeFileSync(
    path.join(OUT_DIR, "manifest.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(OUT_DIR, "manifest-data.js"),
    `window.BENCHMARK_ARTIFACT_MANIFEST = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  writeFileSync(path.join(OUT_DIR, "index.html"), html(), "utf8");
  writeFileSync(
    path.join(OUT_DIR, "README.md"),
    [
      "# Benchmark Artifact Manifest",
      "",
      `Generated: ${payload.generatedAt}`,
      `Files: ${summary.totalFiles}`,
      `HTML files: ${summary.htmlFiles}`,
      `Playback HTML files: ${summary.playbackHtmlFiles}`,
      `Trajectory data files: ${summary.trajectoryDataFiles}`,
      "",
      `HTML viewer: index.html`,
      "",
    ].join("\n"),
    "utf8",
  );
  process.stdout.write(`benchmark artifact manifest ${summary.totalFiles} files\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
