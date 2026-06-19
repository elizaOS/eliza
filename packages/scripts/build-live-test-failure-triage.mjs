#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const LIVE_RUNS_DIR = path.join(REPO_ROOT, "reports", "live-test-runs");
const REPORT_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmark-analysis",
  "live-test-failure-triage",
);

function readJson(relativeOrAbsolutePath) {
  const filePath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(REPO_ROOT, relativeOrAbsolutePath);
  return JSON.parse(readFileSync(filePath, "utf8"));
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

function redact(value) {
  return String(value ?? "")
    .replace(/csk-[A-Za-z0-9_-]+/g, "csk-<redacted>")
    .replace(/\b(CEREBRAS_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|HL_PRIVATE_KEY)=\S+/g, "$1=<redacted>");
}

function excerpt(value, lineLimit = 24, charLimit = 5000) {
  const lines = redact(value)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const selected = lines.slice(-lineLimit).join("\n");
  return selected.length > charLimit ? selected.slice(-charLimit) : selected;
}

function rel(target, from = REPORT_DIR) {
  return path.relative(from, path.join(REPO_ROOT, target)).replaceAll(path.sep, "/");
}

function listReports() {
  if (!existsSync(LIVE_RUNS_DIR)) return [];
  return readdirSync(LIVE_RUNS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(LIVE_RUNS_DIR, entry.name, "report.json"))
    .filter((filePath) => existsSync(filePath))
    .sort();
}

function scriptId(row) {
  return `${row.packageJson}:${row.script}`;
}

function classify(report, finding) {
  const text = `${report.stderr || ""}\n${report.stdout || ""}`;
  if (Number(report.exitCode) === 124 || report.timedOut) return "timeout";
  if (/No booted Android emulator/i.test(text)) return "missing-android-emulator";
  if (/DATABASE_URL is required/i.test(text)) return "missing-database-url";
  if (/No model provider configured|No agents available/i.test(text)) return "missing-model-provider";
  if (/unknown command 'test'|Usage: bun packages\/scripts\/validate-/i.test(text)) return "bad-command-or-missing-args";
  if (/preload not found/i.test(text)) return "missing-test-preload";
  if (/expect\(|\bfail\b|1 fail/i.test(text)) return "test-assertion-failure";
  if (/external-runtime-no-sidecar/.test((finding?.reasons || []).join(" "))) return "external-runtime";
  return "wrapper-failed-before-sidecar";
}

function commandFor(finding, report) {
  if (finding?.packageJson && finding?.script) {
    const packageDir = path.dirname(finding.packageJson);
    const cwd = packageDir === "." ? "" : `--cwd ${packageDir} `;
    return `node packages/scripts/run-live-test-with-artifacts.mjs --label ${slug(`${finding.packageName || packageDir}-${finding.script}`)} -- bun run ${cwd}${finding.script}`;
  }
  return `node packages/scripts/run-live-test-with-artifacts.mjs --label ${slug(report.label)} -- ${redact((report.command || []).join(" "))}`;
}

function slug(value) {
  return String(value || "live-test")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function buildPayload() {
  const inventory = readJson("reports/live-test-inventory/inventory.json");
  const findingsByPlayback = new Map();
  const findingsByViewer = new Map();
  for (const finding of inventory.scriptFindings || []) {
    if (finding.latestWrappedPlayback) {
      findingsByPlayback.set(
        path.normalize(finding.latestWrappedPlayback.replace(/^\.\.\//, "reports/")),
        finding,
      );
    }
    if (finding.latestWrappedViewer) {
      findingsByViewer.set(
        path.normalize(finding.latestWrappedViewer.replace(/^\.\.\//, "reports/")),
        finding,
      );
    }
  }

  const rows = [];
  for (const reportPath of listReports()) {
    const report = readJson(reportPath);
    if (Number(report.exitCode) === 0) continue;
    const runDir = path.dirname(reportPath);
    const runRel = path.relative(REPO_ROOT, runDir).replaceAll(path.sep, "/");
    const playbackRel = `${runRel}/playback.html`;
    const viewerRel = `${runRel}/index.html`;
    const finding = findingsByPlayback.get(path.normalize(playbackRel)) ||
      findingsByViewer.get(path.normalize(viewerRel));
    const classification = classify(report, finding);
    rows.push({
      id: finding ? scriptId(finding) : report.label,
      label: report.label,
      runDir: runRel,
      packageJson: finding?.packageJson || "",
      script: finding?.script || "",
      packageName: finding?.packageName || "",
      likelyLlm: Boolean(finding?.likelyLlm),
      disposition: finding?.disposition || "wrapped-run-failed",
      classification,
      exitCode: Number(report.exitCode),
      timedOut: Boolean(report.timedOut),
      durationMs: Number(report.durationMs || 0),
      stdoutBytes: Number(report.stdoutBytes || 0),
      stderrBytes: Number(report.stderrBytes || 0),
      eventCount: Array.isArray(report.events) ? report.events.length : 0,
      structuredLlmCallCount: Number(report.structuredLlmSummary?.callCount || 0),
      structuredReason: finding?.structuredLlmCoverageReason || "",
      reasons: finding?.reasons || [],
      command: commandFor(finding, report),
      playbackHref: rel(playbackRel),
      viewerHref: rel(viewerRel),
      reportHref: rel(`${runRel}/report.json`),
      stdoutExcerpt: excerpt(report.stdout),
      stderrExcerpt: excerpt(report.stderr),
    });
  }

  const byClassification = {};
  const byExitCode = {};
  for (const row of rows) {
    byClassification[row.classification] = (byClassification[row.classification] || 0) + 1;
    byExitCode[row.exitCode] = (byExitCode[row.exitCode] || 0) + 1;
  }

  return {
    schema: "eliza_live_test_failure_triage_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      failedRunCount: rows.length,
      likelyLlmFailedRuns: rows.filter((row) => row.likelyLlm).length,
      nonModelFailedRuns: rows.filter((row) => !row.likelyLlm).length,
      timeoutRuns: rows.filter((row) => row.classification === "timeout").length,
      rowsWithPlayback: rows.filter((row) => row.playbackHref).length,
      rowsWithRerunCommand: rows.filter((row) => row.command).length,
      byClassification,
      byExitCode,
    },
    rows: rows.sort(
      (a, b) =>
        Number(b.likelyLlm) - Number(a.likelyLlm) ||
        a.classification.localeCompare(b.classification) ||
        a.id.localeCompare(b.id),
    ),
  };
}

function html(payload) {
  const cards = [
    ["Failed runs", payload.summary.failedRunCount],
    ["Likely LLM", payload.summary.likelyLlmFailedRuns],
    ["Timeouts", payload.summary.timeoutRuns],
    ["Playback", `${payload.summary.rowsWithPlayback}/${payload.summary.failedRunCount}`],
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live/e2e Failure Triage</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .muted { color:#5f685d; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; overflow:hidden; }
    .card { padding:10px 12px; }
    .metric { font-size:22px; font-weight:700; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; min-width:1180px; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#fbfcfa; position:sticky; top:0; z-index:1; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    pre { margin:0; max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:#101510; color:#eef7ea; padding:8px; border-radius:6px; }
    .bad { color:#a12222; font-weight:700; }
  </style>
</head>
<body>
  <header><h1>Live/e2e Failure Triage</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">${cards
      .map(([label, value]) => `<div class="card"><div class="muted">${escapeHtml(label)}</div><div class="metric">${escapeHtml(value)}</div></div>`)
      .join("")}</section>
    <section class="panel"><h2>Failure Clusters</h2><div class="body"><pre>${escapeHtml(JSON.stringify(payload.summary.byClassification, null, 2))}</pre></div></section>
    <section class="panel"><h2>Failed Runs</h2><div class="body"><table><thead><tr><th>id</th><th>class</th><th>exit</th><th>links</th><th>rerun</th><th>stderr excerpt</th><th>stdout excerpt</th></tr></thead><tbody>${payload.rows
      .map((row) => `<tr><td><code>${escapeHtml(row.id)}</code><br><span class="muted">${escapeHtml(row.runDir)}</span></td><td class="bad">${escapeHtml(row.classification)}</td><td>${escapeHtml(row.exitCode)}${row.timedOut ? "<br>timed out" : ""}<br><span class="muted">${escapeHtml(row.durationMs)}ms</span></td><td><a href="${escapeHtml(row.playbackHref)}">playback</a><br><a href="${escapeHtml(row.viewerHref)}">viewer</a><br><a href="${escapeHtml(row.reportHref)}">report</a></td><td><code>${escapeHtml(row.command)}</code><br><span class="muted">then <code>bun run bench:analysis:build</code></span></td><td><pre>${escapeHtml(row.stderrExcerpt)}</pre></td><td><pre>${escapeHtml(row.stdoutExcerpt)}</pre></td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Live/e2e Failure Triage",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Failed runs: ${payload.summary.failedRunCount}`,
    `Likely LLM failed runs: ${payload.summary.likelyLlmFailedRuns}`,
    `Timeouts: ${payload.summary.timeoutRuns}`,
    "",
    "## Classification Counts",
    "",
    "```json",
    JSON.stringify(payload.summary.byClassification, null, 2),
    "```",
    "",
    "| id | class | exit | playback |",
    "| --- | --- | ---: | --- |",
    ...payload.rows.map(
      (row) => `| ${row.id} | ${row.classification} | ${row.exitCode} | ${row.playbackHref} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "failure-triage.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `live/e2e failure triage ${payload.summary.failedRunCount} failed runs at ${path.relative(REPO_ROOT, REPORT_DIR)}/index.html\n`,
  );
}

main();
