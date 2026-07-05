/**
 * JSON + stdout reporting for the scenario runner. The JSON shape is what
 * `scripts/run-scenario-benchmark.mjs` expects back (scenarios[], totalCount,
 * failedCount) plus the richer per-scenario fields we emit for humans.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";
import type { AggregateReport, ScenarioReport } from "./types.ts";

/**
 * Walk `<runDir>/trajectories/**\/*.json` and sum the real per-trajectory LLM
 * spend so the aggregate report's `totalCostUsd` reflects what the run actually
 * cost instead of a hardcoded `0`.
 *
 * Each persisted trajectory carries a top-level `metrics.totalCostUsd` (summed
 * by the recorder from every model stage); we prefer that and fall back to
 * summing `stages[].model.costUsd` directly when a trajectory predates the
 * rolled-up metric. Only finite, non-negative values are counted — a corrupt
 * or unreadable trajectory contributes `0` rather than poisoning the total with
 * `NaN`. Returns `0` when no run dir / no trajectories exist (honest absence,
 * not a fabricated spend of `0` on a real live run — callers pass a runDir only
 * when trajectories were actually recorded).
 */
export function sumTrajectoryCostUsd(runDir: string | undefined): number {
  if (!runDir) return 0;
  const trajectoriesDir = path.join(runDir, "trajectories");
  if (!existsSync(trajectoriesDir)) return 0;
  let total = 0;
  for (const file of collectFiles(trajectoriesDir)) {
    if (!file.endsWith(".json")) continue;
    const payload = asRecord(readJsonFile(file));
    const rolled = asNumber(asRecord(payload.metrics).totalCostUsd);
    if (rolled !== null && rolled >= 0) {
      total += rolled;
      continue;
    }
    // Fallback: sum stage-level costs for trajectories without a rolled metric.
    const stages = Array.isArray(payload.stages) ? payload.stages : [];
    for (const stage of stages) {
      const stageCost = asNumber(asRecord(asRecord(stage).model).costUsd);
      if (stageCost !== null && stageCost >= 0) total += stageCost;
    }
  }
  return total;
}

export function buildAggregate(
  scenarios: ScenarioReport[],
  providerName: string | null,
  startedAtIso: string,
  completedAtIso: string,
  runId: string,
  runDir?: string,
): AggregateReport {
  const totals = {
    passed: 0,
    failed: 0,
    skipped: 0,
    costUsd: 0,
    finalChecksSkipped: 0,
  };
  for (const s of scenarios) {
    if (s.status === "passed") totals.passed += 1;
    else if (s.status === "failed") totals.failed += 1;
    else totals.skipped += 1;
    for (const check of s.finalChecks) {
      if (check.status === "skipped") totals.finalChecksSkipped += 1;
    }
  }
  totals.costUsd = sumTrajectoryCostUsd(runDir);
  return {
    runId,
    startedAtIso,
    completedAtIso,
    providerName,
    scenarios,
    totals,
    totalCount: scenarios.length,
    passedCount: totals.passed,
    failedCount: totals.failed,
    skippedCount: totals.skipped,
    totalCostUsd: totals.costUsd,
  };
}

export function writeReport(report: AggregateReport, filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8");
  logger.info(`[scenario-runner] wrote report → ${filePath}`);
}

function scenarioReportFileName(id: string, index: number): string {
  const sanitizedId = id.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${String(index + 1).padStart(3, "0")}-${sanitizedId}.json`;
}

export function writeReportBundle(
  report: AggregateReport,
  reportDir: string,
): void {
  mkdirSync(reportDir, { recursive: true });

  const matrixPath = path.join(reportDir, "matrix.json");
  writeFileSync(matrixPath, JSON.stringify(report, null, 2), "utf-8");

  report.scenarios.forEach((scenarioReport, index) => {
    const scenarioPath = path.join(
      reportDir,
      scenarioReportFileName(scenarioReport.id, index),
    );
    writeFileSync(
      scenarioPath,
      JSON.stringify(scenarioReport, null, 2),
      "utf-8",
    );
  });

  logger.info(`[scenario-runner] wrote report bundle → ${reportDir}`);
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function readJsonlFile(filePath: string, maxRows = 5_000): unknown[] {
  try {
    const rows: unknown[] = [];
    for (const line of readFileSync(filePath, "utf-8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        rows.push({ _raw: trimmed });
      }
      if (rows.length >= maxRows) break;
    }
    return rows;
  } catch {
    return [];
  }
}

function collectFiles(rootDir: string, maxFiles = 500): string[] {
  if (!existsSync(rootDir)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (stat.isFile()) out.push(full);
      if (out.length >= maxFiles) return;
    }
  };
  walk(rootDir);
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function truncateText(value: unknown, maxLength = 420): string {
  const text =
    typeof value === "string"
      ? value
      : value == null
        ? ""
        : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function summarizeTrajectoryFile(
  filePath: string,
  payload: unknown,
): Record<string, unknown> {
  const root = asRecord(payload);
  const stages = Array.isArray(root.stages) ? root.stages : [];
  const stageSummaries = stages.map((stage, index) => {
    const item = asRecord(stage);
    const model = asRecord(item.model);
    const usage = asRecord(model.usage);
    const cache = asRecord(item.cache);
    const tool = asRecord(item.tool);
    const toolSearch = asRecord(item.toolSearch);
    const evaluation = asRecord(item.evaluation);
    const promptTokens = asNumber(usage.promptTokens);
    const completionTokens = asNumber(usage.completionTokens);
    const totalTokens = asNumber(usage.totalTokens);
    const cacheReadTokens = asNumber(usage.cacheReadInputTokens);
    const cachePercent =
      promptTokens && cacheReadTokens !== null
        ? (cacheReadTokens / promptTokens) * 100
        : null;
    return {
      index,
      stageId: item.stageId,
      kind: item.kind,
      iteration: item.iteration,
      latencyMs: item.latencyMs,
      modelType: model.modelType,
      modelName: model.modelName,
      provider: model.provider,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens,
      cachePercent,
      costUsd: asNumber(model.costUsd),
      cachePrefixHash: cache.prefixHash,
      cacheSegmentCount: Array.isArray(cache.segmentHashes)
        ? cache.segmentHashes.length
        : null,
      toolName: tool.name,
      toolSuccess: tool.success,
      toolError: tool.errorText,
      toolInputPreview: truncateText(tool.input),
      toolOutputPreview: truncateText(tool.output),
      toolSearchQuery: truncateText(asRecord(toolSearch.query).text),
      toolSearchTopResults: Array.isArray(toolSearch.results)
        ? toolSearch.results.slice(0, 5).map((result) => {
            const row = asRecord(result);
            return {
              name: row.name,
              score: row.score,
              rank: row.rank,
              matchedBy: row.matchedBy,
            };
          })
        : [],
      evaluationVerdict: evaluation.verdict,
      responsePreview: truncateText(model.response),
    };
  });
  return {
    path: filePath,
    trajectoryId: root.trajectoryId,
    scenarioId: root.scenarioId,
    status: root.status,
    metrics: root.metrics ?? null,
    stages: stageSummaries,
  };
}

function defaultNativeManifestPath(
  nativeJsonlPath?: string,
): string | undefined {
  if (!nativeJsonlPath) return undefined;
  return nativeJsonlPath.endsWith(".jsonl")
    ? `${nativeJsonlPath.slice(0, -".jsonl".length)}.manifest.json`
    : `${nativeJsonlPath}.manifest.json`;
}

function buildScenarioViewerPayload(
  report: AggregateReport,
  runDir: string,
  nativeJsonlPath?: string,
): Record<string, unknown> {
  const trajectoriesDir = path.join(runDir, "trajectories");
  const nativeManifestPath = defaultNativeManifestPath(nativeJsonlPath);
  const trajectoryFiles = collectFiles(trajectoriesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      path: path.relative(runDir, file),
      payload: readJsonFile(file),
    }));
  const trajectorySummaries = trajectoryFiles.map((file) =>
    summarizeTrajectoryFile(file.path, file.payload),
  );
  const nativeRows =
    nativeJsonlPath && existsSync(nativeJsonlPath)
      ? readJsonlFile(nativeJsonlPath)
      : [];
  return {
    schema: "eliza_scenario_run_viewer_v1",
    generatedAt: new Date().toISOString(),
    runDir,
    matrixPath: path.join(runDir, "matrix.json"),
    nativeJsonlPath: nativeJsonlPath ?? null,
    nativeManifestPath: nativeManifestPath ?? null,
    report,
    trajectories: {
      root: trajectoriesDir,
      files: trajectoryFiles,
      summaries: trajectorySummaries,
    },
    nativeExport: {
      manifest:
        nativeManifestPath && existsSync(nativeManifestPath)
          ? readJsonFile(nativeManifestPath)
          : null,
      rows: nativeRows,
    },
  };
}

function scenarioViewerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Eliza Scenario Run Viewer</title>
  <style>
    :root { --bg:#f7f8f5; --panel:#fff; --ink:#182018; --muted:#5d665c; --line:#d8ded2; --ok:#17633a; --bad:#a12222; --accent:#116b5b; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { position:sticky; top:0; z-index:2; background:#fff; border-bottom:1px solid var(--line); padding:16px 20px; }
    h1 { margin:0 0 6px; font-size:22px; letter-spacing:0; }
    .muted { color:var(--muted); }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; padding:14px 20px; }
    .card,.panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; margin-top:3px; font-size:20px; }
    main { display:grid; grid-template-columns:330px 1fr; gap:12px; padding:0 20px 20px; }
    .panel { overflow:hidden; margin-bottom:12px; }
    .panel h2 { margin:0; padding:10px 12px; font-size:14px; border-bottom:1px solid var(--line); background:#f2f5ef; }
    .controls { display:grid; gap:8px; padding:10px; }
    input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:7px 8px; background:#fff; color:var(--ink); }
    .scenario-list { max-height:62vh; overflow:auto; }
    .scenario-item { width:100%; border:0; border-bottom:1px solid var(--line); background:#fff; padding:10px; text-align:left; cursor:pointer; }
    .scenario-item:hover,.scenario-item.active { background:#eef6f2; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:1px 6px; margin:2px 3px 0 0; font-size:11px; color:var(--muted); }
    .passed { color:var(--ok); font-weight:600; }
    .failed { color:var(--bad); font-weight:600; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid var(--line); padding:7px; text-align:left; vertical-align:top; }
    th { background:#f7faf4; position:sticky; top:65px; }
    details { border-top:1px solid var(--line); }
    summary { cursor:pointer; padding:9px 12px; background:#fff; }
    pre { margin:0; max-height:520px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:#101510; color:#eef7ea; padding:10px 12px; }
    .turn { border-top:1px solid var(--line); padding:10px 12px; }
    .audio-artifact { display:flex; flex-direction:column; gap:2px; margin-bottom:6px; }
    .audio-artifact audio { width:200px; height:30px; }
    @media (max-width:900px) { main { grid-template-columns:1fr; } th { top:0; } }
  </style>
</head>
<body>
  <header><h1>Eliza Scenario Run Viewer</h1><div id="meta" class="muted"></div></header>
  <div id="cards" class="cards"></div>
  <main>
    <aside class="panel">
      <h2>Scenarios</h2>
      <div class="controls">
        <input id="search" type="search" placeholder="Search scenario, status, tag..." />
        <select id="status"><option value="">all statuses</option></select>
      </div>
      <div id="scenario-list" class="scenario-list"></div>
    </aside>
    <section class="panel">
      <h2 id="detail-title">Scenario Detail</h2>
      <div id="detail"></div>
    </section>
  </main>
  <script src="./data.js"></script>
  <script>
    const data = window.SCENARIO_RUN_DATA || { report:{ scenarios:[], totals:{} }, trajectories:{ files:[], summaries:[] }, nativeExport:{ rows:[] } };
    let activeId = "";
    const text = v => v === null || v === undefined ? "" : String(v);
    const esc = v => text(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const json = v => esc(JSON.stringify(v, null, 2));
    function trajectoryMatches(id) {
      return (data.trajectories.files || []).filter(f => JSON.stringify(f.payload || {}).includes(id));
    }
    function trajectorySummaryMatches(id) {
      return (data.trajectories.summaries || []).filter(f => f.scenarioId === id || JSON.stringify(f).includes(id));
    }
    function nativeMatches(id) {
      return (data.nativeExport.rows || []).filter(r => r.scenarioId === id || r.metadata?.scenario_id === id);
    }
    function renderCards() {
      const r = data.report || {}, t = r.totals || {};
      document.getElementById("meta").textContent = \`\${data.runDir || ""} · provider=\${r.providerName || ""} · \${r.startedAtIso || ""} → \${r.completedAtIso || ""}\`;
      const items = [["Scenarios", r.totalCount || 0], ["Passed", t.passed || 0], ["Failed", t.failed || 0], ["Skipped", t.skipped || 0], ["Trajectory files", data.trajectories?.files?.length || 0], ["Native rows", data.nativeExport?.rows?.length || 0]];
      document.getElementById("cards").innerHTML = items.map(([k,v]) => \`<div class="card"><span class="muted">\${esc(k)}</span><b>\${esc(v)}</b></div>\`).join("");
    }
    function filtered() {
      const q = document.getElementById("search").value.toLowerCase();
      const st = document.getElementById("status").value;
      return (data.report.scenarios || []).filter(s => {
        const hay = [s.id, s.title, s.domain, s.status, ...(s.tags || [])].map(text).join(" ").toLowerCase();
        return (!q || hay.includes(q)) && (!st || s.status === st);
      });
    }
    function renderFilters() {
      const statuses = [...new Set((data.report.scenarios || []).map(s => s.status).filter(Boolean))].sort();
      document.getElementById("status").innerHTML = '<option value="">all statuses</option>' + statuses.map(s => \`<option>\${esc(s)}</option>\`).join("");
    }
    function renderList() {
      const rows = filtered();
      if (!activeId && rows.length) activeId = rows[0].id;
      if (!rows.some(r => r.id === activeId) && rows.length) activeId = rows[0].id;
      document.getElementById("scenario-list").innerHTML = rows.map(s => \`<button class="scenario-item \${s.id === activeId ? "active" : ""}" data-id="\${esc(s.id)}"><strong>\${esc(s.id)}</strong><br><span class="\${esc(s.status)}">\${esc(s.status)}</span> <span class="muted">\${esc(s.durationMs)}ms</span></button>\`).join("");
      renderDetail();
    }
    function audioArtifactsCell(t) {
      const artifacts = t.audioArtifacts || [];
      if (!artifacts.length) return "";
      // The viewer html lives in <runDir>/viewer/; artifact paths are run-dir
      // relative, so prefix "../" to resolve them from the viewer document.
      return artifacts.map(a => {
        const label = [a.kind, "turn " + a.turnIndex, a.speakerLabel].filter(Boolean).join(" · ");
        return \`<div class="audio-artifact"><span class="muted">\${esc(label)}</span><audio controls preload="none" src="../\${esc(a.path)}"></audio></div>\`;
      }).join("");
    }
    function turnsTable(s) {
      const turns = s.turns || [];
      if (!turns.length) return '<div class="turn muted">No turn reports.</div>';
      return '<table><thead><tr><th>turn</th><th>kind</th><th>status</th><th>input</th><th>response</th><th>actions</th><th>audio</th></tr></thead><tbody>' + turns.map(t => \`<tr><td>\${esc(t.name)}</td><td>\${esc(t.kind)}</td><td>\${esc((t.failedAssertions||[]).length ? "failed" : "ok")}</td><td>\${esc(t.text)}</td><td>\${esc(t.responseText)}</td><td>\${esc((t.actionsCalled||[]).map(a => a.name || a.actionName || "").join(", "))}</td><td>\${audioArtifactsCell(t)}</td></tr>\`).join("") + '</tbody></table>';
    }
    function fmtNum(v) {
      return typeof v === "number" && Number.isFinite(v) ? Math.round(v).toLocaleString() : "";
    }
    function fmtPct(v) {
      return typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) + "%" : "";
    }
    function stageLabel(stage) {
      const parts = [stage.kind || "", stage.iteration ? "iter " + stage.iteration : "", stage.modelName || stage.toolName || ""].filter(Boolean);
      return parts.join(" · ") || "stage " + stage.index;
    }
    function stageRows(summary) {
      const stages = summary.stages || [];
      if (!stages.length) return '<div class="turn muted">No stage summary.</div>';
      return '<table><thead><tr><th>#</th><th>stage</th><th>latency</th><th>tokens</th><th>cache</th><th>tool/result</th><th>preview</th></tr></thead><tbody>' + stages.map(stage => {
        const toolBits = [stage.toolName, stage.toolSuccess === true ? "ok" : stage.toolSuccess === false ? "failed" : "", stage.toolError].filter(Boolean).join(" · ");
        const preview = stage.responsePreview || stage.toolInputPreview || stage.toolSearchQuery || "";
        return \`<tr>
          <td>\${esc(stage.index)}</td>
          <td>\${esc(stageLabel(stage))}<br><span class="muted">\${esc(stage.stageId || "")}</span></td>
          <td>\${esc(stage.latencyMs || "")}ms</td>
          <td>prompt \${esc(fmtNum(stage.promptTokens))}<br>completion \${esc(fmtNum(stage.completionTokens))}<br>total \${esc(fmtNum(stage.totalTokens))}</td>
          <td>read \${esc(fmtNum(stage.cacheReadTokens))}<br>\${esc(fmtPct(stage.cachePercent))}<br><span class="muted">\${esc(stage.cacheSegmentCount ?? "")} segments</span></td>
          <td>\${esc(toolBits || stage.evaluationVerdict || "")}</td>
          <td>\${esc(preview)}</td>
        </tr>\`;
      }).join("") + '</tbody></table>';
    }
    function trajectorySummarySection(summaries) {
      if (!summaries.length) return '<div class="turn muted">No trajectory summaries for this scenario.</div>';
      return summaries.map(summary => \`<details open><summary>\${esc(summary.path)} · \${esc(summary.status || "")}</summary>
        <div class="turn"><strong>metrics</strong><pre>\${json(summary.metrics)}</pre></div>
        \${stageRows(summary)}
      </details>\`).join("");
    }
    function renderDetail() {
      const s = (data.report.scenarios || []).find(row => row.id === activeId);
      document.getElementById("detail-title").textContent = activeId || "Scenario Detail";
      if (!s) { document.getElementById("detail").innerHTML = '<div class="turn muted">No matching scenario.</div>'; return; }
      const traj = trajectoryMatches(s.id);
      const trajSummaries = trajectorySummaryMatches(s.id);
      const native = nativeMatches(s.id);
      document.getElementById("detail").innerHTML = \`
        <div class="turn"><strong class="\${esc(s.status)}">\${esc(s.status)}</strong> · \${esc(s.title)} · \${esc(s.domain)} · \${esc((s.tags||[]).join(", "))}</div>
        \${turnsTable(s)}
        <details open><summary>Call-by-call trajectory summary (\${trajSummaries.length})</summary>\${trajectorySummarySection(trajSummaries)}</details>
        <details open><summary>Native model-boundary rows (\${native.length})</summary>\${native.map((row,i) => \`<div class="turn"><strong>row \${i}</strong><pre>\${json(row)}</pre></div>\`).join("") || '<div class="turn muted">No native rows for this scenario.</div>'}</details>
        <details><summary>Recorded trajectory files (\${traj.length})</summary>\${traj.map(f => \`<details><summary>\${esc(f.path)}</summary><pre>\${json(f.payload)}</pre></details>\`).join("") || '<div class="turn muted">No recorded trajectory files for this scenario.</div>'}</details>
        <details><summary>Scenario report JSON</summary><pre>\${json(s)}</pre></details>\`;
    }
    document.addEventListener("click", e => { const b = e.target.closest(".scenario-item"); if (b) { activeId = b.dataset.id; renderList(); } });
    document.getElementById("search").addEventListener("input", renderList);
    document.getElementById("status").addEventListener("change", renderList);
    renderCards(); renderFilters(); renderList();
  </script>
</body>
</html>`;
}

export function writeScenarioRunViewer(
  report: AggregateReport,
  runDir: string,
  options: { nativeJsonlPath?: string } = {},
): { viewerIndex: string; viewerData: string; nativeManifest?: string } {
  const viewerDir = path.join(runDir, "viewer");
  mkdirSync(viewerDir, { recursive: true });
  const viewerIndex = path.join(viewerDir, "index.html");
  const viewerData = path.join(viewerDir, "data.js");
  const payload = buildScenarioViewerPayload(
    report,
    runDir,
    options.nativeJsonlPath,
  );
  writeFileSync(viewerIndex, scenarioViewerHtml(), "utf-8");
  writeFileSync(
    viewerData,
    `window.SCENARIO_RUN_DATA = ${JSON.stringify(payload)};\n`,
    "utf-8",
  );
  logger.info(`[scenario-runner] wrote run viewer → ${viewerIndex}`);
  return {
    viewerIndex,
    viewerData,
    nativeManifest: defaultNativeManifestPath(options.nativeJsonlPath),
  };
}

export function printStdoutSummary(report: AggregateReport): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `Scenario run ${report.runId} | provider=${report.providerName ?? "(none)"} | ${report.startedAtIso} → ${report.completedAtIso}`,
  );
  lines.push("| id | status | duration | failures |");
  lines.push("| --- | --- | --- | --- |");
  for (const s of report.scenarios) {
    const first =
      s.failedAssertions[0]?.detail ?? s.error ?? s.skipReason ?? "";
    const detail = first
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ")
      .slice(0, 140);
    lines.push(`| ${s.id} | ${s.status} | ${s.durationMs}ms | ${detail} |`);
  }
  lines.push("");
  lines.push(
    `Totals: ${report.totals.passed} passed, ${report.totals.failed} failed, ${report.totals.skipped} skipped of ${report.totalCount}`,
  );
  if (report.totals.finalChecksSkipped > 0) {
    lines.push(
      `WARNING: ${report.totals.finalChecksSkipped} finalCheck(s) skipped (dependency missing) — those checks proved nothing this run:`,
    );
    for (const s of report.scenarios) {
      for (const check of s.finalChecks) {
        if (check.status === "skipped") {
          lines.push(`  - ${s.id} :: ${check.label}: ${check.detail}`);
        }
      }
    }
  }
  const selfGraded = report.scenarios.filter((s) => s.judgeSelfGraded);
  if (selfGraded.length > 0) {
    lines.push(
      `WARNING: ${selfGraded.length} scenario(s) were JUDGED BY THE MODEL UNDER TEST (judgeSelfGraded) — no independent judge configured. ` +
        "Set CEREBRAS_API_KEY (or EVAL_CEREBRAS_API_KEY) so scores are independent; " +
        "SCENARIO_JUDGE_REQUIRE_INDEPENDENT=1 fails these scenarios instead (#9310):",
    );
    for (const s of selfGraded) {
      lines.push(`  - ${s.id}`);
    }
  }
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
}
