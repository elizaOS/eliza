#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "review-pack-index");

const SOURCES = {
  benchmark: {
    root: path.join(REPO_ROOT, "reports", "benchmark-analysis", "benchmark-review-packs"),
    packDir: path.join(REPO_ROOT, "reports", "benchmark-analysis", "benchmark-review-packs", "benchmarks"),
    json: "reports/benchmark-analysis/benchmark-review-packs/benchmark-review-packs.json",
  },
  corpus: {
    root: path.join(REPO_ROOT, "reports", "benchmark-analysis", "corpus-review-packs"),
    packDir: path.join(REPO_ROOT, "reports", "benchmark-analysis", "corpus-review-packs", "families"),
    json: "reports/benchmark-analysis/corpus-review-packs/corpus-review-packs.json",
  },
  scenario: {
    root: path.join(REPO_ROOT, "reports", "benchmark-analysis", "scenario-review-packs"),
    packDir: path.join(REPO_ROOT, "reports", "benchmark-analysis", "scenario-review-packs", "scenarios"),
    json: "reports/benchmark-analysis/scenario-review-packs/scenario-review-packs.json",
  },
  live: {
    root: path.join(REPO_ROOT, "reports", "benchmark-analysis", "live-test-review-packs"),
    packDir: path.join(REPO_ROOT, "reports", "benchmark-analysis", "live-test-review-packs", "scripts"),
    json: "reports/benchmark-analysis/live-test-review-packs/live-test-review-packs.json",
  },
};

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

function fmt(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : String(value ?? "");
}

function relHref(href, sourceDir) {
  if (!href) return "";
  const text = String(href);
  if (text.startsWith("/") || text.startsWith("file://")) return "";
  const absolute = text.startsWith("reports/")
    ? path.join(REPO_ROOT, text)
    : path.resolve(sourceDir, text);
  return path.relative(REPORT_DIR, absolute).replaceAll(path.sep, "/");
}

function existsFromReport(href) {
  return Boolean(href) && existsSync(path.resolve(REPORT_DIR, href));
}

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function firstText(values) {
  return values.find((value) => String(value || "").trim()) || "";
}

function priorityFor(row) {
  if (row.manualReview?.priority) return row.manualReview.priority;
  if (row.surface === "scenario" && row.rerunCommand) return 60;
  if (row.surface === "live/e2e" && row.rerunCommand) return 65;
  if (row.surface === "corpus" && row.rerunCommand) return 55;
  return 25;
}

function buildBenchmarkRows(payload) {
  return (payload.packs || []).map((pack) => {
    const source = SOURCES.benchmark;
    const playbackHref = relHref(
      firstText([
        pack.trajectory?.targetPlaybackHref,
        (pack.samples || []).find((sample) => sample.playbackHref)?.playbackHref,
      ]),
      source.packDir,
    );
    const manualNoteHref = relHref(pack.manualReview?.noteHref, source.packDir);
    const row = {
      surface: "benchmark",
      id: pack.benchmark,
      label: pack.benchmark,
      status: pack.disposition || pack.status || "",
      disposition: pack.qualityBand || pack.disposition || "",
      reviewClass: pack.qualityBand || pack.readiness || "",
      packHref: relHref(pack.href, source.root),
      playbackHref,
      manualNoteHref,
      rerunCommand: pack.version?.rerunCommand || "",
      primaryIssue: firstText([
        pack.nextAction,
        (pack.version?.caveats || [])[0],
        (pack.evidence || []).find((item) => /caveat|missing|blocked|output/i.test(String(item))),
      ]),
      metrics: {
        sampleRows: (pack.samples || []).length,
        samplePlaybackRows: (pack.samples || []).filter((sample) => sample.playbackHref).length,
        targetPlayback: Boolean(pack.trajectory?.targetPlaybackComplete),
        cachePercent: pack.tokens?.trajectoryCachePercent,
        tokens: pack.tokens?.trajectoryTokens || 0,
      },
    };
    return { ...row, priority: priorityFor(row), linkState: linkState(row) };
  });
}

function buildCorpusRows(payload) {
  return (payload.packs || []).map((pack) => {
    const source = SOURCES.corpus;
    const playbackHref = relHref(pack.firstPlaybackHref, source.packDir);
    const manualNoteHref = relHref(pack.manualReview?.noteHref, source.packDir);
    const row = {
      surface: "corpus",
      id: pack.benchmarkId,
      label: pack.benchmarkId,
      status: pack.disposition,
      disposition: pack.disposition,
      reviewClass: pack.disposition,
      packHref: relHref(pack.href, source.root),
      playbackHref,
      gapHref: relHref(pack.gapPageHref, source.packDir),
      manualNoteHref,
      rerunCommand: pack.rerunCommand || "",
      primaryIssue: firstText([...(pack.reasons || []), pack.manualReview?.recommendedAction]),
      metrics: {
        canonicalPlaybackCount: pack.canonicalPlaybackCount || 0,
        warningRows: (pack.warningRows || []).length,
        zeroMetricRows: (pack.zeroMetricRows || []).length,
        cachePercent: pack.cachePercent,
        tokens: pack.tokenTotal || 0,
      },
    };
    return { ...row, priority: priorityFor(row), linkState: linkState(row) };
  });
}

function buildScenarioRows(payload) {
  return (payload.packs || []).map((pack) => {
    const source = SOURCES.scenario;
    const manualNoteHref = relHref(pack.manualReview?.noteHref, source.packDir);
    const row = {
      surface: "scenario",
      id: pack.key,
      label: pack.id,
      status: pack.disposition,
      disposition: pack.verdict,
      reviewClass: pack.reviewClass,
      packHref: relHref(pack.href, source.root),
      playbackHref: relHref(pack.playbackHref, source.packDir),
      manualNoteHref,
      rerunCommand: pack.rerunCommand || "",
      primaryIssue: firstText([...(pack.reasons || []), pack.recommendedAction]),
      metrics: {
        attempts: pack.attempts || 0,
        passed: pack.passed || 0,
        failed: pack.failed || 0,
        failureDetails: (pack.failureDetails || []).length,
      },
    };
    return { ...row, priority: priorityFor(row), linkState: linkState(row) };
  });
}

function buildLiveRows(payload) {
  return (payload.packs || []).map((pack) => {
    const source = SOURCES.live;
    const manualNoteHref = relHref(pack.manualReview?.noteHref, source.packDir);
    const row = {
      surface: "live/e2e",
      id: pack.id,
      label: `${pack.packageName}:${pack.script}`,
      status: pack.disposition,
      disposition: pack.verdict,
      reviewClass: pack.structured?.completeness || pack.verdict,
      packHref: relHref(pack.href, source.root),
      playbackHref: relHref(pack.playbackHref, source.packDir),
      manualNoteHref,
      rerunCommand: pack.rerunCommand || "",
      primaryIssue: firstText([...(pack.reasons || []), pack.recommendedAction]),
      metrics: {
        latestWrappedExitCode: pack.latestWrappedExitCode,
        structuredCalls: pack.structured?.callCount || 0,
        failed: pack.latestWrappedExitCode !== 0,
        tokens: pack.structured?.totalTokens || 0,
      },
    };
    return { ...row, priority: priorityFor(row), linkState: linkState(row) };
  });
}

function linkState(row) {
  return {
    packExists: existsFromReport(row.packHref),
    playbackExists: existsFromReport(row.playbackHref),
    gapExists: row.gapHref ? existsFromReport(row.gapHref) : false,
    manualNoteExists: row.manualNoteHref ? existsFromReport(row.manualNoteHref) : false,
  };
}

function isNeedsReview(row) {
  return !["review-pass", "passed", "complete", "superior"].includes(String(row.status || "")) ||
    /blocked|caveat|needs|failed|missing|gap|inferior|non-passing|telemetry/i.test(
      `${row.status} ${row.disposition} ${row.reviewClass}`,
    );
}

function buildPayload() {
  const benchmark = readJson(SOURCES.benchmark.json);
  const corpus = readJson(SOURCES.corpus.json);
  const scenario = readJson(SOURCES.scenario.json);
  const live = readJson(SOURCES.live.json);
  const manual = readJson("reports/benchmark-analysis/manual-review/manual-review.json");

  const rows = [
    ...buildBenchmarkRows(benchmark),
    ...buildCorpusRows(corpus),
    ...buildScenarioRows(scenario),
    ...buildLiveRows(live),
  ].sort((a, b) => b.priority - a.priority || a.surface.localeCompare(b.surface) || a.id.localeCompare(b.id));

  const surfaceCounts = rows.reduce((acc, row) => {
    acc[row.surface] = (acc[row.surface] || 0) + 1;
    return acc;
  }, {});
  const summary = {
    packCount: rows.length,
    benchmarkPacks: surfaceCounts.benchmark || 0,
    corpusPacks: surfaceCounts.corpus || 0,
    scenarioPacks: surfaceCounts.scenario || 0,
    liveTestPacks: surfaceCounts["live/e2e"] || 0,
    withPlayback: rows.filter((row) => row.playbackHref && row.linkState.playbackExists).length,
    withManualReviewNote: rows.filter((row) => row.manualNoteHref && row.linkState.manualNoteExists).length,
    withRerunCommand: rows.filter((row) => row.rerunCommand).length,
    needsReview: rows.filter(isNeedsReview).length,
    humanReviewed: manual.summary?.reviewed || 0,
    agentTriaged: manual.summary?.agentReviewed || 0,
    manualNotes: manual.summary?.noteCount || 0,
    surfaceCounts,
  };

  return {
    schema: "eliza_review_pack_index_v1",
    generatedAt: new Date().toISOString(),
    summary,
    sourceSummaries: {
      benchmark: benchmark.summary,
      corpus: corpus.summary,
      scenario: scenario.summary,
      liveTest: live.summary,
      manualReview: manual.summary,
    },
    rows,
  };
}

function renderHtml(payload) {
  const metrics = [
    ["Pack rows", fmt(payload.summary.packCount)],
    ["Playback-linked", fmt(payload.summary.withPlayback)],
    ["Manual notes", fmt(payload.summary.withManualReviewNote)],
    ["Rerun commands", fmt(payload.summary.withRerunCommand)],
    ["Needs review", fmt(payload.summary.needsReview)],
    ["Human reviewed", fmt(payload.summary.humanReviewed)],
  ];
  const rows = payload.rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.surface)}</td>
      <td><strong>${escapeHtml(row.label)}</strong><br><code>${escapeHtml(row.id)}</code></td>
      <td>${escapeHtml(row.status)}<br><span>${escapeHtml(row.disposition)}</span></td>
      <td>${escapeHtml(row.reviewClass)}</td>
      <td>${link(row.packHref, "pack")} ${link(row.playbackHref, "playback")} ${link(row.gapHref, "gap")} ${link(row.manualNoteHref, "note")}</td>
      <td>${row.rerunCommand ? `<code>${escapeHtml(row.rerunCommand)}</code>` : ""}</td>
      <td>${escapeHtml(row.primaryIssue)}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Global Review Pack Index</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:18px 20px 32px; }
    h1 { margin:0 0 6px; font-size:24px; letter-spacing:0; }
    .sub { color:#556052; }
    .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:16px 0; }
    .metric { background:#fff; border:1px solid #d7ded1; border-radius:8px; padding:12px; }
    .metric strong { display:block; font-size:22px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d7ded1; }
    th, td { border-bottom:1px solid #e2e7de; padding:8px; text-align:left; vertical-align:top; }
    th { background:#eef2ea; position:sticky; top:0; z-index:1; }
    code { font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-word; }
    a { color:#245b3d; font-weight:600; margin-right:8px; }
    span { color:#697466; }
  </style>
</head>
<body>
  <header>
    <h1>Global Review Pack Index</h1>
    <div class="sub">Single queue over benchmark, corpus, scenario, and live/e2e review packs. Generated ${escapeHtml(payload.generatedAt)}.</div>
  </header>
  <main>
    <section class="metrics">
      ${metrics.map(([label, value]) => `<div class="metric"><strong>${escapeHtml(value)}</strong>${escapeHtml(label)}</div>`).join("")}
    </section>
    <table>
      <thead>
        <tr><th>Surface</th><th>Target</th><th>Status</th><th>Class</th><th>Links</th><th>Rerun</th><th>Primary issue</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function writeOutputs(payload) {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(path.join(REPORT_DIR, "review-pack-index.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  writeFileSync(path.join(REPORT_DIR, "index.html"), renderHtml(payload), "utf8");
  writeFileSync(
    path.join(REPORT_DIR, "README.md"),
    `# Global Review Pack Index

Generated: ${payload.generatedAt}

- Pack rows: ${payload.summary.packCount}
- Playback-linked rows: ${payload.summary.withPlayback}
- Manual-note links: ${payload.summary.withManualReviewNote}
- Rerun commands: ${payload.summary.withRerunCommand}
- Human-reviewed manual notes: ${payload.summary.humanReviewed}

Open \`index.html\` for the consolidated review queue.
`,
    "utf8",
  );
}

const payload = buildPayload();
writeOutputs(payload);
console.log(
  `[review-pack-index] wrote ${payload.summary.packCount} rows (${payload.summary.withPlayback} playback, ${payload.summary.withManualReviewNote} manual notes)`,
);
