#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const LIVE_RUNS_DIR = path.join(REPO_ROOT, "reports", "live-test-runs");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function listJsonFiles(root) {
  if (!root || !existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(full);
    }
  }
  return files.sort();
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

function truncate(value, limit = 12000) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unitMs(value, unit) {
  const parsed = number(value);
  if (parsed === null) return null;
  const normalized = String(unit || "ms").toLowerCase();
  if (normalized === "s") return parsed * 1000;
  if (normalized === "us") return parsed / 1000;
  return parsed;
}

function modelTelemetry(report) {
  const events = Array.isArray(report.events) ? report.events : [];
  const structuredSummary = report.structuredLlmSummary || {};
  const text = [report.stdout || "", report.stderr || "", ...events.map((event) => event.text || JSON.stringify(event))]
    .join("\n");
  const providerMatch = text.match(/\bLLM Mode:\s*real\s*\(([^)]+)\)/i);
  const modelTotalMs = [...text.matchAll(/\bmodel_total=([0-9.]+)(ms|s|us)\b/gi)]
    .map((match) => unitMs(match[1], match[2]))
    .filter((value) => value !== null);
  const pipelineModelMs = [...text.matchAll(/\bPipeline:.*?\bmodel=([0-9.]+)(ms|s|us)\b/gi)]
    .map((match) => unitMs(match[1], match[2]))
    .filter((value) => value !== null);
  const tokenLikeLines = text
    .split(/\r?\n/)
    .filter((line) => /\b(token|cache|usage|prompt|completion)\b/i.test(line))
    .slice(0, 20);
  return {
    realLlmMode: /\bLLM Mode:\s*real\b/i.test(text) || /\breal LLM\b/i.test(text),
    provider: providerMatch ? providerMatch[1].trim() : "",
    tokenLikeText: /\b(token|cache|usage|prompt|completion)\b/i.test(text),
    tokenLikeLineCount: tokenLikeLines.length,
    tokenLikeLines: tokenLikeLines.map((line) => truncate(line, 500)),
    modelTotalMs,
    pipelineModelMs,
    modelTotalMsSum: modelTotalMs.reduce((total, value) => total + value, 0),
    pipelineModelMsAvg:
      pipelineModelMs.length > 0
        ? pipelineModelMs.reduce((total, value) => total + value, 0) / pipelineModelMs.length
        : null,
    structuredLlmCallCount: Number(structuredSummary.callCount || 0),
    structuredPromptTokens: Number(structuredSummary.promptTokens || 0),
    structuredCompletionTokens: Number(structuredSummary.completionTokens || 0),
    structuredTotalTokens: Number(structuredSummary.totalTokens || 0),
    structuredCacheReadInputTokens: Number(structuredSummary.cacheReadInputTokens || 0),
  };
}

function usageFromMetrics(metrics = {}) {
  return {
    promptTokens: Number(metrics.totalPromptTokens || 0),
    completionTokens: Number(metrics.totalCompletionTokens || 0),
    totalTokens:
      Number(metrics.totalPromptTokens || 0) + Number(metrics.totalCompletionTokens || 0),
    cacheReadInputTokens: Number(metrics.totalCacheReadTokens || 0),
    cacheCreationInputTokens: Number(metrics.totalCacheCreationTokens || 0),
  };
}

function scenarioRunDirs(report) {
  const dirs = new Set();
  const text = [report.stdout || "", report.stderr || ""].join("\n");
  for (const match of text.matchAll(/wrote report bundle\s*[→>-]\s*(.+)$/gim)) {
    dirs.add(match[1].trim());
  }
  for (const match of text.matchAll(/run-dir:\s*([^\n(]+)/gim)) {
    dirs.add(match[1].trim());
  }
  const commandText = Array.isArray(report.command)
    ? report.command.join(" ")
    : String(report.command || "");
  for (const match of commandText.matchAll(/(?:--run-dir|RUN_DIR=)(?:\s+|)([^\s"']+)/g)) {
    const candidate = match[1].trim();
    if (candidate) dirs.add(candidate);
  }
  return [...dirs]
    .map((dir) => (path.isAbsolute(dir) ? dir : path.resolve(REPO_ROOT, dir)))
    .filter((dir) => {
      const relative = path.relative(REPO_ROOT, dir);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });
}

function callsFromScenarioTrajectories(report) {
  const calls = [];
  for (const scenarioDir of scenarioRunDirs(report)) {
    const trajectoryRoot = path.join(scenarioDir, "trajectories");
    for (const filePath of listJsonFiles(trajectoryRoot)) {
      let trajectory;
      try {
        trajectory = readJson(filePath);
      } catch {
        continue;
      }
      for (const [stageIndex, stage] of (trajectory.stages || []).entries()) {
        if (!stage?.model || typeof stage.model !== "object") continue;
        const model = stage.model;
        const usage = usageFromMetrics(trajectory.metrics || {});
        calls.push({
          type: "llm_call",
          timestamp: new Date(Number(stage.startedAt || trajectory.startedAt || Date.now())).toISOString(),
          callId: `${trajectory.trajectoryId || path.basename(filePath, ".json")}:${stage.stageId || stageIndex}`,
          provider: model.provider || "",
          model: model.modelType || "",
          purpose: `scenario:${trajectory.scenarioId || ""}:${stage.kind || "stage"}`,
          systemPrompt: "",
          userPrompt: "",
          messages: Array.isArray(model.messages) ? model.messages : [],
          response: model.response || "",
          finishReason: "",
          latencyMs: Number(stage.latencyMs || 0),
          usage,
          source: "scenario-trajectory-backfill",
          sourceFile: path.relative(REPO_ROOT, filePath).replaceAll(path.sep, "/"),
          raw: {
            trajectoryId: trajectory.trajectoryId,
            runId: trajectory.runId,
            scenarioId: trajectory.scenarioId,
            stageId: stage.stageId,
            kind: stage.kind,
            model,
          },
        });
      }
    }
  }
  return calls;
}

function structuredLlmSummary(records) {
  return records
    .filter((record) => record.type === "llm_call")
    .reduce(
      (summary, record) => {
        summary.callCount += 1;
        summary.promptTokens += Number(record.usage?.promptTokens || 0);
        summary.completionTokens += Number(record.usage?.completionTokens || 0);
        summary.totalTokens += Number(record.usage?.totalTokens || 0);
        summary.cacheReadInputTokens += Number(record.usage?.cacheReadInputTokens || 0);
        summary.cacheCreationInputTokens += Number(record.usage?.cacheCreationInputTokens || 0);
        return summary;
      },
      {
        callCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    );
}

function enrichStructuredCalls(report, runDir, reportPath) {
  if (Number(report.structuredLlmSummary?.callCount || 0) > 0) return report;
  const calls = callsFromScenarioTrajectories(report);
  if (calls.length === 0) return report;
  const processEvents = Array.isArray(report.processEvents)
    ? report.processEvents
    : (report.events || []).filter((event) => event.type !== "llm_call");
  const enriched = {
    ...report,
    processEvents,
    structuredLlmCalls: calls,
    structuredLlmSummary: structuredLlmSummary(calls),
    events: [...processEvents, ...calls],
    artifactPaths: {
      ...(report.artifactPaths || {}),
      llmCallsJsonl: path.join(runDir, "llm-calls.jsonl"),
      trajectoryJsonl: path.join(runDir, "trajectory.jsonl"),
    },
  };
  writeFileSync(
    path.join(runDir, "llm-calls.jsonl"),
    calls.map((call) => JSON.stringify(call)).join("\n") + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(runDir, "trajectory.jsonl"),
    enriched.events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  writeFileSync(reportPath, JSON.stringify(enriched, null, 2) + "\n", "utf8");
  writeFileSync(
    path.join(runDir, "data.js"),
    `window.LIVE_TEST_RUN = ${JSON.stringify(enriched)};\n`,
    "utf8",
  );
  return enriched;
}

function eventRecords(report) {
  const events = Array.isArray(report.events) ? report.events : [];
  return events.map((event, index) => ({
    index,
    type: String(event.type || "event"),
    timestamp: String(event.timestamp || ""),
    text: truncate(event.text || event.error || ""),
    code: event.code ?? null,
    signal: event.signal ?? null,
    command: event.command || null,
    raw: truncate(JSON.stringify(event, null, 2)),
  }));
}

function repoRelative(value) {
  if (!value) return "";
  const resolved = path.resolve(String(value));
  const relative = path.relative(REPO_ROOT, resolved).replaceAll(path.sep, "/");
  return relative.startsWith("..") || path.isAbsolute(relative) ? "" : relative;
}

function artifactLinks(report, fromDir = REPO_ROOT) {
  const artifactPaths = report.artifactPaths || {};
  if (!artifactPaths || typeof artifactPaths !== "object") return [];
  return Object.entries(artifactPaths)
    .map(([label, value]) => {
      const repoHref = repoRelative(value);
      const localHref = repoHref
        ? path.relative(fromDir, path.join(REPO_ROOT, repoHref)).replaceAll(path.sep, "/")
        : "";
      return {
        label,
        href: repoHref,
        localHref,
      };
    })
    .filter((entry) => entry.href);
}

function eventTypeCounts(records) {
  return records.reduce((acc, record) => {
    acc[record.type] = (acc[record.type] || 0) + 1;
    return acc;
  }, {});
}

function html(report, records, runDir) {
  const artifacts = artifactLinks(report, runDir);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(report.label)} Live Test Playback</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:14px 18px; }
    main { display:grid; grid-template-columns:290px 1fr; min-height:calc(100vh - 76px); }
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
    .ok { color:#17633a; font-weight:700; }
    .bad { color:#a12222; font-weight:700; }
    @media (max-width:820px) { main { grid-template-columns:1fr; } aside { max-height:220px; border-right:0; border-bottom:1px solid #d7ded1; } }
  </style>
</head>
<body>
  <header>
    <strong>${escapeHtml(report.label)}</strong>
    <span class="muted"> · <code>${escapeHtml(path.basename(report.runDir || ""))}</code></span>
  </header>
  <main>
    <aside id="nav"></aside>
    <section class="content">
      <div id="cards" class="cards"></div>
      <section class="panel"><h2>Model Telemetry</h2><pre id="telemetry"></pre></section>
      <section class="panel"><h2>Artifacts</h2><div id="artifacts"></div></section>
      <section class="panel"><h2>Event Text</h2><pre id="text"></pre></section>
      <section class="panel"><h2>Raw Event</h2><pre id="raw"></pre></section>
      <section class="panel"><h2>Command</h2><pre id="command">${escapeHtml(JSON.stringify(report.command || [], null, 2))}</pre></section>
    </section>
  </main>
  <script type="application/json" id="records">${JSON.stringify(records).replaceAll("</script", "<\\/script")}</script>
  <script type="application/json" id="telemetry-data">${JSON.stringify(report.modelTelemetry || {}).replaceAll("</script", "<\\/script")}</script>
  <script type="application/json" id="artifact-data">${JSON.stringify(artifacts).replaceAll("</script", "<\\/script")}</script>
  <script>
    const records = JSON.parse(document.getElementById("records").textContent || "[]");
    const telemetry = JSON.parse(document.getElementById("telemetry-data").textContent || "{}");
    const artifacts = JSON.parse(document.getElementById("artifact-data").textContent || "[]");
    const nav = document.getElementById("nav");
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function render(i) {
      const r = records[i] || {};
      for (const button of nav.querySelectorAll("button")) button.classList.toggle("active", Number(button.dataset.index) === i);
      document.getElementById("cards").innerHTML = [
        ["Event", (i + 1) + " / " + records.length],
        ["Type", r.type],
        ["Timestamp", r.timestamp],
        ["Exit code", r.code ?? ""],
        ["Signal", r.signal ?? ""],
        ["Real LLM", telemetry.realLlmMode ? "yes" : "no"],
        ["Provider", telemetry.provider || ""],
        ["Structured LLM calls", telemetry.structuredLlmCallCount || ""],
        ["Structured tokens", telemetry.structuredTotalTokens || ""],
        ["Structured cache read", telemetry.structuredCacheReadInputTokens || ""],
        ["Model total ms", telemetry.modelTotalMsSum || ""],
        ["Pipeline model avg ms", telemetry.pipelineModelMsAvg || ""],
      ].map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + esc(v ?? "") + '</b></div>').join("");
      document.getElementById("telemetry").textContent = JSON.stringify(telemetry, null, 2);
      document.getElementById("artifacts").innerHTML = artifacts.length
        ? '<table><tbody>' + artifacts.map(a => '<tr><td><code>' + esc(a.label) + '</code></td><td><a href="' + esc(a.localHref || a.href) + '">' + esc(a.href) + '</a></td></tr>').join("") + '</tbody></table>'
        : '<div class="muted" style="padding:10px">No artifact paths recorded.</div>';
      document.getElementById("text").textContent = r.text || "";
      document.getElementById("raw").textContent = r.raw || "";
    }
    nav.innerHTML = records.map((r, i) => '<button data-index="' + i + '"><strong>' + esc(i + 1) + '. ' + esc(r.type) + '</strong><br><span class="muted">' + esc(r.timestamp) + '</span></button>').join("");
    nav.addEventListener("click", event => {
      const button = event.target.closest("button[data-index]");
      if (button) render(Number(button.dataset.index));
    });
    render(0);
  </script>
</body>
</html>`;
}

function main() {
  if (!existsSync(LIVE_RUNS_DIR)) {
    process.stdout.write("live test playback 0 runs; reports/live-test-runs missing\n");
    return;
  }
  const manifest = [];
  for (const entry of readdirSync(LIVE_RUNS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(LIVE_RUNS_DIR, entry.name);
    const reportPath = path.join(runDir, "report.json");
    if (!existsSync(reportPath)) continue;
    let report = readJson(reportPath);
    report = enrichStructuredCalls(report, runDir, reportPath);
    report.modelTelemetry = modelTelemetry(report);
    const records = eventRecords(report);
    const artifacts = artifactLinks(report);
    const eventCounts = eventTypeCounts(records);
    const playbackPath = path.join(runDir, "playback.html");
    writeFileSync(playbackPath, html(report, records, runDir), "utf8");
    manifest.push({
      label: String(report.label || entry.name),
      runDir: path.relative(REPO_ROOT, runDir).replaceAll(path.sep, "/"),
      exitCode: Number(report.exitCode ?? -1),
      durationMs: Number(report.durationMs ?? 0),
      eventCount: records.length,
      eventTypeCounts: eventCounts,
      artifactLinks: artifacts,
      commandText: Array.isArray(report.command) ? report.command.join(" ") : String(report.command || ""),
      modelTelemetry: report.modelTelemetry,
      structuredLlmCallCount: report.modelTelemetry.structuredLlmCallCount || 0,
      structuredTotalTokens: report.modelTelemetry.structuredTotalTokens || 0,
      structuredCacheReadInputTokens: report.modelTelemetry.structuredCacheReadInputTokens || 0,
      playbackIndex: path.relative(REPO_ROOT, playbackPath).replaceAll(path.sep, "/"),
      viewerIndex: path.relative(REPO_ROOT, path.join(runDir, "index.html")).replaceAll(path.sep, "/"),
      reportJson: path.relative(REPO_ROOT, reportPath).replaceAll(path.sep, "/"),
    });
  }
  manifest.sort((a, b) => a.runDir.localeCompare(b.runDir));
  const exitCodeCounts = manifest.reduce((acc, row) => {
    acc[String(row.exitCode)] = (acc[String(row.exitCode)] || 0) + 1;
    return acc;
  }, {});
  const eventTypeTotals = manifest.reduce((acc, row) => {
    for (const [type, count] of Object.entries(row.eventTypeCounts || {})) {
      acc[type] = (acc[type] || 0) + count;
    }
    return acc;
  }, {});
  mkdirSync(LIVE_RUNS_DIR, { recursive: true });
  writeFileSync(
    path.join(LIVE_RUNS_DIR, "playback-manifest.json"),
    JSON.stringify({
      schema: "eliza_live_test_run_playback_manifest_v1",
      generatedAt: new Date().toISOString(),
      runCount: manifest.length,
      playbackCount: manifest.filter((row) => row.playbackIndex).length,
      exitCodeCounts,
      eventTypeTotals,
      artifactLinkRuns: manifest.filter((row) => (row.artifactLinks || []).length > 0).length,
      artifactLinkCount: manifest.reduce((total, row) => total + (row.artifactLinks || []).length, 0),
      structuredLlmRuns: manifest.filter((row) => row.structuredLlmCallCount > 0).length,
      structuredLlmCallCount: manifest.reduce((total, row) => total + (row.structuredLlmCallCount || 0), 0),
      structuredTotalTokens: manifest.reduce((total, row) => total + (row.structuredTotalTokens || 0), 0),
      structuredCacheReadInputTokens: manifest.reduce((total, row) => total + (row.structuredCacheReadInputTokens || 0), 0),
      modelTelemetryRuns: manifest.filter((row) => row.modelTelemetry?.realLlmMode).length,
      tokenLikeTextRuns: manifest.filter((row) => row.modelTelemetry?.tokenLikeText).length,
      modelTotalMsSum: manifest.reduce((total, row) => total + (row.modelTelemetry?.modelTotalMsSum || 0), 0),
      manifest,
    }, null, 2) + "\n",
    "utf8",
  );
  process.stdout.write(`live test playback ${manifest.length} runs\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
