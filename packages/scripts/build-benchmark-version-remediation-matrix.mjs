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
  "version-remediation-matrix",
);
const VERSION_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmarks",
  "code-agent-version-comparison",
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

function relFromVersion(href) {
  if (!href) return "";
  const text = String(href);
  if (text.startsWith("/") || text.startsWith("file://")) return "";
  const absolute = text.startsWith("reports/")
    ? path.join(REPO_ROOT, text)
    : path.resolve(VERSION_DIR, text);
  const relative = path.relative(REPORT_DIR, absolute).replaceAll(path.sep, "/");
  return relative.startsWith("../") ? relative : `./${relative}`;
}

function benchmarkCommand(benchmark) {
  const base =
    "PYTHONPATH=. python -m benchmarks.orchestrator run --all-harnesses --provider cerebras --model gpt-oss-120b --force --show-incompatible";
  if (benchmark === "osworld") {
    return `${base} --benchmarks osworld --max-tasks 5`;
  }
  return `${base} --benchmarks ${benchmark}`;
}

function classify(entry, closureRow) {
  const comparison = entry.comparison || {};
  const current = comparison.current || {};
  const previous = comparison.previous || null;
  const hasPrevious = Boolean(comparison.hasPrevious && previous);
  const currentTargetPlayback = Boolean(current.targetPlaybackHref);
  const previousTargetPlayback = Boolean(previous?.targetPlaybackHref);

  if (entry.benchmark === "osworld") {
    return {
      gapType: "osworld-provider-caveat",
      disposition: "blocked",
      action:
        "Configure Docker, VMware, VirtualBox, or AWS OSWorld runtime, rerun live OSWorld, then rerun once more to create a live previous baseline.",
    };
  }
  if (!hasPrevious) {
    if (comparison.noEarlierPreviousRow) {
      return {
        gapType: "no-earlier-previous-row",
        disposition: "needs-earlier-baseline",
        action:
          "Keep the current playback-backed row and note that a newer non-current row exists; rerun after the next instrumentation change to create an earlier baseline for this selected current row.",
      };
    }
    return {
      gapType: "no-previous-run",
      disposition: "needs-history",
      action:
        "Keep the current playback-backed row and rerun the benchmark after the next instrumentation change so the selected current row has a previous row.",
    };
  }
  if (!previousTargetPlayback) {
    return {
      gapType: "previous-aggregate-only",
      disposition: "needs-playback-baseline",
      action:
        "Rerun this benchmark with trajectory output enabled so the prior baseline is replaced by a playback-backed comparison row.",
    };
  }
  if (!currentTargetPlayback) {
    return {
      gapType: "partial-playback",
      disposition: "needs-playback-check",
      action:
        "Inspect the linked viewers and rerun with trajectory output if current target playback is missing.",
    };
  }
  if (closureRow?.readiness !== "complete") {
    return {
      gapType: "closure-caveat",
      disposition: "caveated",
      action: closureRow?.recommendedAction || "Clear the benchmark closure caveat.",
    };
  }
  return {
    gapType: "complete-history",
    disposition: "complete",
    action:
      "No version-history remediation is needed; keep the playback-backed current and previous rows in the report set.",
  };
}

function versionGapReview(row) {
  if (row.gapType === "previous-aggregate-only") {
    return {
      reviewClass: "previous-viewer-no-trajectory",
      canReviewOffline: true,
      primaryEvidenceHref: row.previousViewerHref,
      supportingEvidenceHrefs: [row.currentTargetPlaybackHref, row.currentViewerHref].filter(Boolean),
      summary: `${row.benchmark} has previous aggregate viewer ${row.previousRunId}, but previous target/baseline trajectory files are both zero and no previous playback records were recovered.`,
      manualReviewPrompt:
        "Open the previous aggregate viewer for score/status context, then use the current playback to review behavior; rerun with trajectory output when call-by-call previous comparison is required.",
    };
  }
  if (row.gapType === "no-previous-run") {
    return {
      reviewClass: "current-only-history",
      canReviewOffline: true,
      primaryEvidenceHref: row.currentTargetPlaybackHref || row.currentViewerHref,
      supportingEvidenceHrefs: [row.currentBaselinePlaybackHref, row.currentViewerHref].filter(Boolean),
      summary: `${row.benchmark} has only one indexed row, so the current playback is reviewable but no historical comparison exists yet.`,
      manualReviewPrompt:
        "Review the current playback-backed row now; rerun after the next instrumentation change to create a previous row.",
    };
  }
  if (row.gapType === "no-earlier-previous-row") {
    return {
      reviewClass: "indexed-rows-not-earlier",
      canReviewOffline: true,
      primaryEvidenceHref: row.currentTargetPlaybackHref || row.currentViewerHref,
      supportingEvidenceHrefs: [row.currentBaselinePlaybackHref, row.currentViewerHref].filter(Boolean),
      summary: `${row.benchmark} has ${row.rowCount} indexed rows, but none are earlier than the selected current row.`,
      manualReviewPrompt:
        "Review the selected current playback and keep this distinct from true no-history rows; rerun later to create an earlier baseline for this selected row.",
    };
  }
  if (row.gapType === "osworld-provider-caveat") {
    return {
      reviewClass: "external-provider-blocked",
      canReviewOffline: true,
      primaryEvidenceHref: row.currentTargetPlaybackHref || row.currentViewerHref,
      supportingEvidenceHrefs: [row.currentBaselinePlaybackHref, row.currentViewerHref].filter(Boolean),
      summary: "OSWorld has smoke playback, but live provider execution is externally blocked.",
      manualReviewPrompt:
        "Review the smoke playback as local evidence; configure an OSWorld runtime provider before expecting live version history.",
    };
  }
  return {
    reviewClass: "playback-backed-history",
    canReviewOffline: true,
    primaryEvidenceHref: row.previousTargetPlaybackHref || row.currentTargetPlaybackHref,
    supportingEvidenceHrefs: [row.currentTargetPlaybackHref, row.previousViewerHref, row.currentViewerHref].filter(Boolean),
    summary: `${row.benchmark} has playback-backed current and previous rows for comparison.`,
    manualReviewPrompt: "Open current and previous playback links to compare call-by-call behavior and cache evidence.",
  };
}

function buildPayload() {
  const version = readJson(
    "reports/benchmarks/code-agent-version-comparison/version-comparison.json",
  );
  const closure = readJson(
    "reports/benchmark-analysis/benchmark-closure-matrix/benchmark-closure-matrix.json",
  );
  const closureByBenchmark = new Map(
    (closure.rows || []).map((row) => [row.benchmark, row]),
  );

  const rows = (version.benchmarks || []).map((entry) => {
    const comparison = entry.comparison || {};
    const current = comparison.current || {};
    const previous = comparison.previous || null;
    const closureRow = closureByBenchmark.get(entry.benchmark);
    const classified = classify(entry, closureRow);
    const hasPrevious = Boolean(comparison.hasPrevious && previous);
    const previousTargetPlayback = Boolean(previous?.targetPlaybackHref);
    const currentTargetPlayback = Boolean(current.targetPlaybackHref);
    const row = {
      benchmark: entry.benchmark,
      rowCount: entry.rowCount,
      readiness: closureRow?.readiness || "",
      versionAvailable: Boolean(closureRow?.versionAvailable),
      hasPrevious,
      noEarlierPreviousRow: Boolean(comparison.noEarlierPreviousRow),
      gapType: classified.gapType,
      disposition: classified.disposition,
      currentRunId: current.runId || "",
      currentMode: current.mode || "",
      currentStatus: current.status || "",
      currentViewerHref: relFromVersion(current.viewerHref),
      currentTargetPlaybackHref: relFromVersion(current.targetPlaybackHref),
      currentBaselinePlaybackHref: relFromVersion(current.baselinePlaybackHref),
      currentTargetPlaybackRecords: Number(current.targetPlaybackRecords || 0),
      currentTargetTokens: Number(current.targetTotalTokens || 0),
      currentTargetCacheReadTokens: Number(current.targetPlaybackCacheReadTokens || 0),
      previousRunId: previous?.runId || "",
      previousMode: previous?.mode || "",
      previousStatus: previous?.status || "",
      previousViewerHref: relFromVersion(previous?.viewerHref),
      previousTargetPlaybackHref: relFromVersion(previous?.targetPlaybackHref),
      previousBaselinePlaybackHref: relFromVersion(previous?.baselinePlaybackHref),
      previousTargetTrajectoryFiles: Number(previous?.targetTrajectoryFiles || 0),
      previousBaselineTrajectoryFiles: Number(previous?.baselineTrajectoryFiles || 0),
      previousTargetPlaybackRecords: Number(previous?.targetPlaybackRecords || 0),
      previousTargetTokens: Number(previous?.targetTotalTokens || 0),
      previousTargetCacheReadTokens: Number(previous?.targetPlaybackCacheReadTokens || 0),
      comparablePlaybackPair: hasPrevious && currentTargetPlayback && previousTargetPlayback,
      notes: comparison.notes || [],
      caveats: closureRow?.caveats || [],
      action: classified.action,
      rerunCommand: benchmarkCommand(entry.benchmark),
      followedBy: "bun run bench:analysis:build",
    };
    row.versionGapReview = versionGapReview(row);
    return row;
  });

  const aggregateOnlyRows = rows.filter((row) => row.gapType === "previous-aggregate-only");
  const noPreviousRunRows = rows.filter((row) => row.gapType === "no-previous-run");
  const summary = {
    benchmarkCount: rows.length,
    withPrevious: rows.filter((row) => row.hasPrevious).length,
    withoutPrevious: rows.filter((row) => !row.hasPrevious).length,
    currentPlaybackLinks: rows.filter((row) => row.currentTargetPlaybackHref).length,
    comparablePlaybackPairs: rows.filter((row) => row.comparablePlaybackPair).length,
    previousPlaybackGaps: rows.filter(
      (row) => row.hasPrevious && !row.previousTargetPlaybackHref,
    ).length,
    previousAggregateOnly: rows.filter((row) => row.gapType === "previous-aggregate-only")
      .length,
    completeHistory: rows.filter((row) => row.gapType === "complete-history").length,
    noPreviousRun: rows.filter((row) => row.gapType === "no-previous-run").length,
    noEarlierPreviousRow: rows.filter((row) => row.gapType === "no-earlier-previous-row")
      .length,
    osworldProviderCaveats: rows.filter((row) => row.gapType === "osworld-provider-caveat")
      .length,
    previousAggregateOnlyWithViewer: rows.filter(
      (row) => row.gapType === "previous-aggregate-only" && row.previousViewerHref,
    ).length,
    previousAggregateOnlyWithNoTrajectoryFiles: rows.filter(
      (row) =>
        row.gapType === "previous-aggregate-only" &&
        row.previousTargetTrajectoryFiles === 0 &&
        row.previousBaselineTrajectoryFiles === 0,
    ).length,
    rerunCommands: rows.filter((row) => row.rerunCommand).length,
    previousPlaybackGapBenchmarks: rows
      .filter((row) => row.hasPrevious && !row.previousTargetPlaybackHref)
      .map((row) => row.benchmark),
    previousAggregateOnlyBenchmarks: aggregateOnlyRows.map((row) => row.benchmark),
    noPreviousRunBenchmarks: noPreviousRunRows.map((row) => row.benchmark),
    noEarlierPreviousRowBenchmarks: rows
      .filter((row) => row.gapType === "no-earlier-previous-row")
      .map((row) => row.benchmark),
    versionGapReviewRows: rows.filter((row) => row.versionGapReview?.canReviewOffline).length,
    previousAggregateOnlyReviewRows: aggregateOnlyRows.filter(
      (row) =>
        row.versionGapReview?.primaryEvidenceHref &&
        row.previousViewerHref &&
        row.previousTargetTrajectoryFiles === 0 &&
        row.previousBaselineTrajectoryFiles === 0 &&
        row.previousTargetPlaybackRecords === 0,
    ).length,
  };

  return {
    schema: "eliza_benchmark_version_remediation_matrix_v1",
    generatedAt: new Date().toISOString(),
    sourceVersionComparison: "../../benchmarks/code-agent-version-comparison/index.html",
    summary,
    rows,
  };
}

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function html(payload) {
  const rows = payload.rows
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.benchmark)}</code><br><span class="muted">${escapeHtml(row.readiness)}</span></td>
        <td><b>${escapeHtml(row.disposition)}</b><br><code>${escapeHtml(row.gapType)}</code></td>
        <td>${escapeHtml(row.currentRunId)}<br>${link(row.currentViewerHref, "viewer")} ${link(row.currentTargetPlaybackHref, "target playback")} ${link(row.currentBaselinePlaybackHref, "baseline playback")}</td>
        <td>${row.hasPrevious ? escapeHtml(row.previousRunId) : "<span class=\"bad\">none</span>"}<br>${link(row.previousViewerHref, "viewer")} ${link(row.previousTargetPlaybackHref, "target playback")} ${link(row.previousBaselinePlaybackHref, "baseline playback")}<br><span class="muted">trajectory files target=${escapeHtml(row.previousTargetTrajectoryFiles)} baseline=${escapeHtml(row.previousBaselineTrajectoryFiles)}</span></td>
        <td>${escapeHtml(row.action)}${row.notes.length ? `<br><span class="muted">${escapeHtml(row.notes.join(" "))}</span>` : ""}<br><b>${escapeHtml(row.versionGapReview.reviewClass)}</b><br>${escapeHtml(row.versionGapReview.summary)}<br>${link(row.versionGapReview.primaryEvidenceHref, "primary evidence")}</td>
        <td><code>${escapeHtml(row.rerunCommand)}</code><br><span class="muted">${escapeHtml(row.followedBy)}</span></td>
      </tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Version Remediation Matrix</title>
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
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; white-space:pre-wrap; }
    a { color:#116b5b; text-decoration:none; margin-right:8px; }
    a:hover { text-decoration:underline; }
    .bad { color:#a12222; font-weight:700; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header>
    <h1>Benchmark Version Remediation Matrix</h1>
    <div class="muted">Generated ${escapeHtml(payload.generatedAt)} from <a href="${escapeHtml(payload.sourceVersionComparison)}">version comparison</a>.</div>
  </header>
  <main>
    <section class="cards">
      <div class="card"><span class="muted">Benchmarks</span><b>${payload.summary.benchmarkCount}</b></div>
      <div class="card"><span class="muted">With previous</span><b>${payload.summary.withPrevious}</b></div>
      <div class="card"><span class="muted">Comparable playback</span><b>${payload.summary.comparablePlaybackPairs}</b></div>
      <div class="card"><span class="muted">Previous playback gaps</span><b>${payload.summary.previousPlaybackGaps}</b></div>
      <div class="card"><span class="muted">Aggregate viewers</span><b>${payload.summary.previousAggregateOnlyWithViewer}</b><span class="muted">${payload.summary.previousAggregateOnlyWithNoTrajectoryFiles} without trajectory files</span></div>
      <div class="card"><span class="muted">Aggregate-only names</span><b>${escapeHtml(payload.summary.previousAggregateOnlyBenchmarks.join(", ") || "none")}</b></div>
      <div class="card"><span class="muted">No previous run</span><b>${payload.summary.noPreviousRun}</b></div>
      <div class="card"><span class="muted">No earlier previous row</span><b>${payload.summary.noEarlierPreviousRow}</b></div>
      <div class="card"><span class="muted">Rerun commands</span><b>${payload.summary.rerunCommands}</b></div>
    </section>
    <table>
      <thead><tr><th>Benchmark</th><th>Status</th><th>Current</th><th>Previous</th><th>Action</th><th>Rerun</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function readme(payload) {
  return [
    "# Benchmark Version Remediation Matrix",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Benchmarks: ${payload.summary.benchmarkCount}`,
    `- With previous rows: ${payload.summary.withPrevious}`,
    `- Without previous rows: ${payload.summary.withoutPrevious}`,
    `- Comparable playback pairs: ${payload.summary.comparablePlaybackPairs}`,
    `- Previous playback gaps: ${payload.summary.previousPlaybackGaps} (${payload.summary.previousPlaybackGapBenchmarks.join(", ") || "none"})`,
    `- Aggregate-only previous rows: ${payload.summary.previousAggregateOnlyBenchmarks.join(", ") || "none"}; ${payload.summary.previousAggregateOnlyReviewRows} have previous viewers and zero target/baseline trajectory files.`,
    `- True no-previous-run benchmarks: ${payload.summary.noPreviousRunBenchmarks.join(", ") || "none"}`,
    `- No-earlier previous rows: ${payload.summary.noEarlierPreviousRow}`,
    `- Previous aggregate-only rows with viewer links: ${payload.summary.previousAggregateOnlyWithViewer}`,
    `- Previous aggregate-only rows with zero target/baseline trajectory files: ${payload.summary.previousAggregateOnlyWithNoTrajectoryFiles}`,
    `- Rerun commands: ${payload.summary.rerunCommands}`,
    "",
    "| benchmark | disposition | gap type | current run | previous run |",
    "|---|---|---|---|---|",
    ...payload.rows.map(
      (row) =>
        `| \`${row.benchmark}\` | ${row.disposition} | \`${row.gapType}\` | \`${row.currentRunId}\` | ${row.previousRunId ? `\`${row.previousRunId}\`` : "none"} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  const payload = buildPayload();
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    path.join(REPORT_DIR, "version-remediation.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), readme(payload), "utf8");
  process.stdout.write(`benchmark version remediation matrix ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
