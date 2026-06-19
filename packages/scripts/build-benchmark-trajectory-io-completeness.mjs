#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmark-analysis",
  "trajectory-io-completeness",
);
const TRAJECTORY_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmarks",
  "code-agent-trajectory-catalog",
);

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
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

function relTrajectory(href) {
  if (!href) return "";
  const text = String(href);
  if (text.startsWith("/") || text.startsWith("file://")) return "";
  const absolute = text.startsWith("reports/")
    ? path.join(REPO_ROOT, text)
    : path.resolve(TRAJECTORY_DIR, text);
  return path.relative(REPORT_DIR, absolute).replaceAll(path.sep, "/");
}

function slug(value) {
  return String(value || "gap")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "gap";
}

function hasInput(record) {
  const source = String(record.inputSource || "");
  return source && source !== "none";
}

function hasOutput(record) {
  const source = String(record.outputSource || "");
  return source && source !== "none";
}

function outputGapClass(record) {
  if (hasOutput(record)) return "output-present";
  if (!Number.isFinite(record.totalTokens) || Number(record.totalTokens) === 0) {
    return "environment-or-dry-run-no-token-output";
  }
  if ((record.actions || []).length === 0 && ["prompt_path", "prompt"].includes(record.inputSource)) {
    return "aggregate-usage-only-output";
  }
  if ((record.actions || []).length > 0) return "tool-call-or-action-only-output";
  if (
    Number(record.completionTokens || 0) > 0 &&
    Number(record.responseChars || 0) === 0 &&
    Number(record.toolCallCount || 0) === 0
  ) {
    return "provider-empty-response-with-completion-tokens";
  }
  return "empty-response-with-token-usage";
}

function isReviewRelevantOutputGap(record) {
  return [
    "empty-response-with-token-usage",
    "provider-empty-response-with-completion-tokens",
  ].includes(outputGapClass(record));
}

function buildPayload() {
  const trajectory = readJson(
    "reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json",
  );
  const rowsByBenchmark = new Map();
  const allRecords = [];

  for (const entry of trajectory.entries || []) {
    const row =
      rowsByBenchmark.get(entry.benchmark) ||
      {
        benchmark: entry.benchmark,
        files: 0,
        playbackFiles: 0,
        records: 0,
        llmLikeRecords: 0,
        withInput: 0,
        withOutput: 0,
        missingInput: 0,
        missingOutput: 0,
        missingOutputWithTokens: 0,
        missingOutputWithoutTokens: 0,
        reviewRelevantOutputGaps: 0,
        benignOutputGaps: 0,
        outputGapClasses: {},
        tokens: 0,
        cacheReadTokens: 0,
        sampleGaps: [],
        sampleReviewRelevantGaps: [],
        sampleMissingInputs: [],
      };
    row.files += 1;
    if (entry.playbackHref) row.playbackFiles += 1;
    row.llmLikeRecords += Number(entry.totals?.llmLikeRecords || 0);
    row.tokens += Number(entry.totals?.totalTokens || 0);
    row.cacheReadTokens += Number(entry.totals?.cacheReadTokens || 0);

    for (const record of entry.records || []) {
      const recordRow = {
        benchmark: entry.benchmark,
        runId: entry.runId,
        side: entry.side,
        adapter: entry.adapter,
        taskId: record.taskId || "",
        step: record.step,
        model: record.model || "",
        provider: record.provider || "",
        totalTokens: Number(record.totalTokens || 0),
        completionTokens: Number(record.completionTokens || 0),
        cacheReadTokens: Number(record.cacheReadTokens || 0),
        inputSource: record.inputSource || "",
        outputSource: record.outputSource || "",
        actions: record.actions || [],
        responseChars: record.responseChars,
        toolCallCount: record.toolCallCount,
        toolNames: record.toolNames || [],
        toolSchemaCount: record.toolSchemaCount,
        toolCallNames: record.toolCallNames || [],
        toolCallArgumentsPreview: record.toolCallArgumentsPreview || "",
        benchmarkCommand: record.benchmarkCommand || "",
        diagnosticsEndpoint: record.diagnosticsEndpoint || "",
        trajectoryEndpoint: record.trajectoryEndpoint || "",
        trajectorySnapshotStatus: record.trajectorySnapshotStatus || "",
        trajectorySnapshotError: record.trajectorySnapshotError || "",
        webshopPage: record.webshopPage || "",
        webshopGoal: record.webshopGoal || "",
        webshopBudget: record.webshopBudget ?? null,
        webshopAvailableActions: record.webshopAvailableActions || [],
        webshopRecentActions: record.webshopRecentActions || [],
        webshopObservationPreview: record.webshopObservationPreview || "",
        outputGapClass: outputGapClass(record),
        inputPreview: record.inputPreview || "",
        outputPreview: record.outputPreview || "",
        playbackHref: relTrajectory(entry.playbackHref),
      };
      allRecords.push(recordRow);
      row.records += 1;
      if (hasInput(record)) row.withInput += 1;
      else {
        row.missingInput += 1;
        if (row.sampleMissingInputs.length < 5) row.sampleMissingInputs.push(recordRow);
      }
      if (hasOutput(record)) row.withOutput += 1;
      else {
        row.missingOutput += 1;
        if (Number(record.totalTokens || 0) > 0) row.missingOutputWithTokens += 1;
        else row.missingOutputWithoutTokens += 1;
        if (isReviewRelevantOutputGap(record)) {
          row.reviewRelevantOutputGaps += 1;
          if (row.sampleReviewRelevantGaps.length < 5) {
            row.sampleReviewRelevantGaps.push(recordRow);
          }
        } else {
          row.benignOutputGaps += 1;
        }
        row.outputGapClasses[recordRow.outputGapClass] =
          (row.outputGapClasses[recordRow.outputGapClass] || 0) + 1;
        if (row.sampleGaps.length < 5) row.sampleGaps.push(recordRow);
      }
    }
    rowsByBenchmark.set(entry.benchmark, row);
  }

  const rows = [...rowsByBenchmark.values()].sort((a, b) =>
    a.benchmark.localeCompare(b.benchmark),
  );
  const recordsByTask = new Map();
  for (const record of allRecords) {
    const key = [record.benchmark, record.runId, record.side, record.adapter, record.taskId || "task"].join("\t");
    const bucket = recordsByTask.get(key) || [];
    bucket.push(record);
    recordsByTask.set(key, bucket);
  }
  for (const bucket of recordsByTask.values()) {
    bucket.sort((a, b) => Number(a.step || 0) - Number(b.step || 0));
  }

  const rawReviewRelevantGaps = allRecords
    .filter(isReviewRelevantOutputGap)
    .sort(
      (a, b) =>
        b.totalTokens - a.totalTokens ||
        a.benchmark.localeCompare(b.benchmark) ||
        a.runId.localeCompare(b.runId) ||
        a.step - b.step,
    );
  const playbackGapCounts = rawReviewRelevantGaps.reduce((counts, record) => {
    counts[record.playbackHref || "missing-playback"] =
      (counts[record.playbackHref || "missing-playback"] || 0) + 1;
    return counts;
  }, {});
  const taskGapCounts = rawReviewRelevantGaps.reduce((counts, record) => {
    counts[record.taskId || "missing-task"] = (counts[record.taskId || "missing-task"] || 0) + 1;
    return counts;
  }, {});
  const reviewRelevantGaps = rawReviewRelevantGaps.map((record, index) => {
    const fileName = `${String(index + 1).padStart(2, "0")}-${slug(record.benchmark)}-${slug(record.taskId || record.runId)}-step-${record.step}.html`;
    const taskKey = [record.benchmark, record.runId, record.side, record.adapter, record.taskId || "task"].join("\t");
    const taskRecords = recordsByTask.get(taskKey) || [];
    const sameTaskGapSteps = taskRecords
      .filter(isReviewRelevantOutputGap)
      .map((item) => item.step);
    const position = taskRecords.findIndex((item) => item.step === record.step);
    const previousRecords = position >= 0 ? taskRecords.slice(0, position).reverse() : [];
    const nextRecords = position >= 0 ? taskRecords.slice(position + 1) : [];
    const previousCommand = previousRecords.find((item) => item.benchmarkCommand)?.benchmarkCommand || "";
    const nextCommand = nextRecords.find((item) => item.benchmarkCommand)?.benchmarkCommand || "";
    const previousNonEmpty = previousRecords.find((item) => item.outputSource && item.outputSource !== "none");
    const nextNonEmpty = nextRecords.find((item) => item.outputSource && item.outputSource !== "none");
    return {
      id: `${record.benchmark}:${record.runId}:${record.side}:${record.adapter}:${record.taskId || "task"}:${record.step}`,
      rank: index + 1,
      fileName,
      href: `review-gaps/${fileName}`,
      benchmark: record.benchmark,
      runId: record.runId,
      side: record.side,
      adapter: record.adapter,
      taskId: record.taskId,
      step: record.step,
      model: record.model,
      provider: record.provider,
      totalTokens: record.totalTokens,
      completionTokens: Number(record.completionTokens || 0),
      cacheReadTokens: record.cacheReadTokens,
      cachePercent:
        record.totalTokens > 0
          ? Number(((record.cacheReadTokens / record.totalTokens) * 100).toFixed(1))
          : null,
      inputSource: record.inputSource,
      outputGapClass: record.outputGapClass,
      responseChars: Number(record.responseChars || 0),
      toolCallCount: Number(record.toolCallCount || 0),
      toolNames: record.toolNames || [],
      toolSchemaCount: record.toolSchemaCount,
      toolCallNames: record.toolCallNames || [],
      toolCallArgumentsPreview: record.toolCallArgumentsPreview,
      benchmarkCommand: record.benchmarkCommand,
      previousBenchmarkCommand: previousCommand,
      nextBenchmarkCommand: nextCommand,
      previousNonEmptyStep: previousNonEmpty?.step ?? null,
      nextNonEmptyStep: nextNonEmpty?.step ?? null,
      sameTaskGapSteps,
      consecutiveEmptyGapIndex: sameTaskGapSteps.indexOf(record.step) + 1,
      diagnosticsEndpoint: record.diagnosticsEndpoint,
      trajectoryEndpoint: record.trajectoryEndpoint,
      trajectorySnapshotStatus: record.trajectorySnapshotStatus,
      trajectorySnapshotError: record.trajectorySnapshotError,
      webshopPage: record.webshopPage,
      webshopGoal: record.webshopGoal,
      webshopBudget: record.webshopBudget,
      webshopAvailableActions: record.webshopAvailableActions || [],
      webshopRecentActions: record.webshopRecentActions || [],
      webshopObservationPreview: record.webshopObservationPreview,
      inputPreview: record.inputPreview,
      playbackHref: record.playbackHref,
      playbackGapCount: playbackGapCounts[record.playbackHref || "missing-playback"] || 0,
      taskGapCount: taskGapCounts[record.taskId || "missing-task"] || 0,
      reviewDisposition: "provider-empty-response-with-completion-tokens",
      reviewNote:
        "Provider reported completion tokens but trajectory captured no text, no tool call, and no benchmark action for this step.",
    };
  });
  const summary = {
    benchmarkCount: rows.length,
    files: rows.reduce((sum, row) => sum + row.files, 0),
    playbackFiles: rows.reduce((sum, row) => sum + row.playbackFiles, 0),
    records: rows.reduce((sum, row) => sum + row.records, 0),
    llmLikeRecords: rows.reduce((sum, row) => sum + row.llmLikeRecords, 0),
    withInput: rows.reduce((sum, row) => sum + row.withInput, 0),
    withOutput: rows.reduce((sum, row) => sum + row.withOutput, 0),
    missingInput: rows.reduce((sum, row) => sum + row.missingInput, 0),
    missingOutput: rows.reduce((sum, row) => sum + row.missingOutput, 0),
    missingOutputWithTokens: rows.reduce((sum, row) => sum + row.missingOutputWithTokens, 0),
    missingOutputWithoutTokens: rows.reduce(
      (sum, row) => sum + row.missingOutputWithoutTokens,
      0,
    ),
    reviewRelevantOutputGaps: rows.reduce((sum, row) => sum + row.reviewRelevantOutputGaps, 0),
    benignOutputGaps: rows.reduce((sum, row) => sum + row.benignOutputGaps, 0),
    tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    cacheReadTokens: rows.reduce((sum, row) => sum + row.cacheReadTokens, 0),
    outputGapClasses: allRecords.reduce((counts, record) => {
      if (record.outputGapClass !== "output-present") {
        counts[record.outputGapClass] = (counts[record.outputGapClass] || 0) + 1;
      }
      return counts;
    }, {}),
    reviewRelevantGapRows: reviewRelevantGaps.length,
    reviewRelevantGapReviewPages: reviewRelevantGaps.length,
    reviewRelevantGapPlaybacks: new Set(reviewRelevantGaps.map((record) => record.playbackHref).filter(Boolean)).size,
    reviewRelevantGapTasks: new Set(reviewRelevantGaps.map((record) => record.taskId).filter(Boolean)).size,
    benchmarksWithTokenOutputGaps: rows.filter((row) => row.missingOutputWithTokens > 0).length,
    benchmarksWithReviewRelevantOutputGaps: rows.filter((row) => row.reviewRelevantOutputGaps > 0).length,
    benchmarksWithMissingInputs: rows.filter((row) => row.missingInput > 0).length,
  };

  return {
    schema: "eliza_benchmark_trajectory_io_completeness_v1",
    generatedAt: new Date().toISOString(),
    summary,
    rows,
    reviewRelevantGaps,
  };
}

function pct(part, total) {
  if (!total) return "";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:14px 0; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; padding:10px; }
    .card b { display:block; font-size:20px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d7ded1; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f2f5ef; }
    code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    pre { max-height:520px; overflow:auto; white-space:pre-wrap; background:#f8faf6; border:1px solid #d7ded1; padding:10px; }
    a { color:#116b5b; text-decoration:none; margin-right:8px; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function gapPage(gap) {
  return pageShell(
    `Trajectory I/O gap ${gap.rank}`,
    `<header><h1>Trajectory I/O Gap ${gap.rank}</h1><div class="muted">${escapeHtml(gap.id)}</div></header>
  <main>
    <section class="cards">
      <div class="card"><span class="muted">benchmark</span><b>${escapeHtml(gap.benchmark)}</b></div>
      <div class="card"><span class="muted">task</span><b>${escapeHtml(gap.taskId || "n/a")}</b></div>
      <div class="card"><span class="muted">step</span><b>${escapeHtml(gap.step)}</b></div>
      <div class="card"><span class="muted">tokens</span><b>${escapeHtml(gap.totalTokens)}</b></div>
      <div class="card"><span class="muted">cache</span><b>${escapeHtml(gap.cachePercent ?? "n/a")}%</b></div>
      <div class="card"><span class="muted">same playback gaps</span><b>${escapeHtml(gap.playbackGapCount)}</b></div>
      <div class="card"><span class="muted">page</span><b>${escapeHtml(gap.webshopPage || "n/a")}</b></div>
      <div class="card"><span class="muted">same task gap</span><b>${escapeHtml(gap.consecutiveEmptyGapIndex)} / ${escapeHtml(gap.sameTaskGapSteps.length)}</b></div>
    </section>
    <section class="panel"><h2>Review Finding</h2>
      <p><b>${escapeHtml(gap.reviewDisposition)}</b></p>
      <p>${escapeHtml(gap.reviewNote)}</p>
      <p>${link(`../${gap.playbackHref}`, "open playback")} ${link("../index.html", "trajectory I/O matrix")}</p>
    </section>
    <section class="panel"><h2>WebShop Turn Context</h2>
      <table><tbody>
        <tr><th>goal</th><td>${escapeHtml(gap.webshopGoal)}</td></tr>
        <tr><th>budget</th><td>${escapeHtml(gap.webshopBudget ?? "n/a")}</td></tr>
        <tr><th>page</th><td>${escapeHtml(gap.webshopPage || "n/a")}</td></tr>
        <tr><th>available actions</th><td>${(gap.webshopAvailableActions || []).map((item) => `<code>${escapeHtml(item)}</code>`).join(" ")}</td></tr>
        <tr><th>recent actions</th><td>${(gap.webshopRecentActions || []).map((item) => `<code>${escapeHtml(item)}</code>`).join(" ")}</td></tr>
        <tr><th>previous/next command</th><td>previous <code>${escapeHtml(gap.previousBenchmarkCommand || "n/a")}</code><br>next <code>${escapeHtml(gap.nextBenchmarkCommand || "n/a")}</code></td></tr>
        <tr><th>same task gap steps</th><td>${(gap.sameTaskGapSteps || []).map((item) => `<code>${escapeHtml(item)}</code>`).join(" ")}</td></tr>
      </tbody></table>
    </section>
    <section class="panel"><h2>Call Metadata</h2>
      <table><tbody>
        <tr><th>run</th><td><code>${escapeHtml(gap.runId)}</code></td></tr>
        <tr><th>side/adapter</th><td>${escapeHtml(gap.side)} / ${escapeHtml(gap.adapter)}</td></tr>
        <tr><th>provider/model</th><td>${escapeHtml(gap.provider)} / ${escapeHtml(gap.model)}</td></tr>
        <tr><th>token split</th><td>total ${escapeHtml(gap.totalTokens)}; completion ${escapeHtml(gap.completionTokens)}; cache ${escapeHtml(gap.cacheReadTokens)} (${escapeHtml(gap.cachePercent ?? "n/a")}%)</td></tr>
        <tr><th>tool metadata</th><td>schema count ${escapeHtml(gap.toolSchemaCount ?? "n/a")}; names ${(gap.toolNames || []).map((item) => `<code>${escapeHtml(item)}</code>`).join(" ")}; call count ${escapeHtml(gap.toolCallCount)}</td></tr>
        <tr><th>input source</th><td><code>${escapeHtml(gap.inputSource)}</code></td></tr>
        <tr><th>output gap class</th><td><code>${escapeHtml(gap.outputGapClass)}</code></td></tr>
        <tr><th>trajectory endpoints</th><td><code>${escapeHtml(gap.diagnosticsEndpoint || "")}</code><br><code>${escapeHtml(gap.trajectoryEndpoint || "")}</code></td></tr>
        <tr><th>snapshot status</th><td><code>${escapeHtml(gap.trajectorySnapshotStatus || "n/a")}</code> ${escapeHtml(gap.trajectorySnapshotError || "")}</td></tr>
        <tr><th>same task gaps</th><td>${escapeHtml(gap.taskGapCount)}</td></tr>
      </tbody></table>
    </section>
    <section class="panel"><h2>Observation</h2><pre>${escapeHtml(gap.webshopObservationPreview)}</pre></section>
    <section class="panel"><h2>Captured Input</h2><pre>${escapeHtml(gap.inputPreview)}</pre></section>
  </main>`,
  );
}

function html(payload) {
  const rows = payload.rows
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.benchmark)}</code><br><span class="muted">${row.files} files / ${row.playbackFiles} playback</span></td>
        <td>${row.withInput}/${row.records}<br><span class="muted">${pct(row.withInput, row.records)}</span></td>
        <td>${row.withOutput}/${row.records}<br><span class="muted">${pct(row.withOutput, row.records)}</span></td>
        <td>${row.reviewRelevantOutputGaps}<br><span class="muted">${row.benignOutputGaps} benign/no-model-output gaps; ${escapeHtml(JSON.stringify(row.outputGapClasses))}</span></td>
        <td>${row.sampleGaps
          .map(
            (sample) =>
              `${link(sample.playbackHref, sample.taskId || `${sample.runId}:${sample.step}`)} <span class="muted">${escapeHtml(sample.outputGapClass)}</span>`,
          )
          .join("<br>")}</td>
      </tr>`,
    )
    .join("\n");
  const gapRows = payload.reviewRelevantGaps
    .map(
      (row) => `<tr>
        <td>${row.rank}</td>
        <td><code>${escapeHtml(row.taskId)}</code><br><span class="muted">${escapeHtml(row.runId)} ${escapeHtml(row.side)}/${escapeHtml(row.adapter)} step ${escapeHtml(row.step)}</span></td>
        <td>${escapeHtml(row.provider)}<br><span class="muted">${escapeHtml(row.model)}</span></td>
        <td>${row.totalTokens}<br><span class="muted">completion ${row.completionTokens}; cache ${row.cacheReadTokens}${row.cachePercent !== null ? ` (${row.cachePercent}%)` : ""}</span></td>
        <td><b>${escapeHtml(row.outputGapClass)}</b><br><span class="muted">${escapeHtml(row.reviewNote)}</span></td>
        <td>${link(row.href, "gap page")} ${link(row.playbackHref, "playback")}<br><span class="muted">${row.playbackGapCount} gaps in same playback; ${row.taskGapCount} for same task</span><pre>${escapeHtml(row.inputPreview)}</pre></td>
      </tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Trajectory I/O Completeness</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:14px 0; }
    .card { background:#fff; border:1px solid #d7ded1; border-radius:8px; padding:10px; }
    .card b { display:block; font-size:20px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d7ded1; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f2f5ef; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
    pre { max-width:540px; max-height:180px; overflow:auto; white-space:pre-wrap; background:#f8faf6; border:1px solid #d7ded1; padding:7px; }
  </style>
</head>
<body>
  <header><h1>Benchmark Trajectory I/O Completeness</h1><div class="muted">Generated ${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">
      <div class="card"><span class="muted">Records</span><b>${payload.summary.records}</b></div>
      <div class="card"><span class="muted">With input</span><b>${payload.summary.withInput}</b></div>
      <div class="card"><span class="muted">With output</span><b>${payload.summary.withOutput}</b></div>
      <div class="card"><span class="muted">Review-relevant output gaps</span><b>${payload.summary.reviewRelevantOutputGaps}</b></div>
      <div class="card"><span class="muted">Gap playbacks</span><b>${payload.summary.reviewRelevantGapPlaybacks}</b></div>
      <div class="card"><span class="muted">Benign/no-model output gaps</span><b>${payload.summary.benignOutputGaps}</b></div>
      <div class="card"><span class="muted">Missing input</span><b>${payload.summary.missingInput}</b></div>
      <div class="card"><span class="muted">Playback files</span><b>${payload.summary.playbackFiles}/${payload.summary.files}</b></div>
    </section>
    <table>
      <thead><tr><th>Benchmark</th><th>Input panes</th><th>Output panes</th><th>Output gap split</th><th>Sample gap playback</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h2>Review-Relevant Output Gaps</h2>
    <table>
      <thead><tr><th>#</th><th>Task</th><th>Provider</th><th>Tokens</th><th>Disposition</th><th>Input and playback</th></tr></thead>
      <tbody>${gapRows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function readme(payload) {
  return [
    "# Benchmark Trajectory I/O Completeness",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Records: ${payload.summary.records}`,
    `- With normalized input: ${payload.summary.withInput}`,
    `- With normalized output: ${payload.summary.withOutput}`,
    `- Missing output with token usage: ${payload.summary.missingOutputWithTokens}`,
    `- Review-relevant empty-response token gaps: ${payload.summary.reviewRelevantOutputGaps}`,
    `- Review-relevant gap rows rendered: ${payload.summary.reviewRelevantGapRows}`,
    `- Review-relevant gap detail pages: ${payload.summary.reviewRelevantGapReviewPages}`,
    `- Review-relevant gap playback files: ${payload.summary.reviewRelevantGapPlaybacks}`,
    `- Review-relevant gap tasks: ${payload.summary.reviewRelevantGapTasks}`,
    `- Benign tool/action/environment output gaps: ${payload.summary.benignOutputGaps}`,
    `- Missing output without token usage: ${payload.summary.missingOutputWithoutTokens}`,
    `- Missing input: ${payload.summary.missingInput}`,
    `- Output gap classes: ${JSON.stringify(payload.summary.outputGapClasses)}`,
    "",
    "| benchmark | records | with input | with output | missing output with tokens |",
    "|---|---:|---:|---:|---:|",
    ...payload.rows.map(
      (row) =>
        `| \`${row.benchmark}\` | ${row.records} | ${row.withInput} | ${row.withOutput} | ${row.missingOutputWithTokens} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  const payload = buildPayload();
  mkdirSync(REPORT_DIR, { recursive: true });
  mkdirSync(path.join(REPORT_DIR, "review-gaps"), { recursive: true });
  for (const gap of payload.reviewRelevantGaps) {
    writeFileSync(path.join(REPORT_DIR, gap.href), gapPage(gap), "utf8");
  }
  writeFileSync(
    path.join(REPORT_DIR, "trajectory-io-completeness.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), readme(payload), "utf8");
  process.stdout.write(`benchmark trajectory io completeness ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
