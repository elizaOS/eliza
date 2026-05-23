#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "agent-review");
const QUEUE_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "review-queue");

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

function rel(target, from = REPORT_DIR) {
  return path.relative(from, path.join(REPO_ROOT, target)).replaceAll(path.sep, "/");
}

function resolveQueueViewer(viewer) {
  const resolved = path.resolve(QUEUE_DIR, viewer || "");
  const relative = path.relative(REPO_ROOT, resolved).replaceAll(path.sep, "/");
  if (!relative.startsWith("reports/")) return null;
  return { absolute: resolved, relative };
}

function loadLiveRunEvidence(viewer) {
  const resolved = resolveQueueViewer(viewer);
  if (!resolved || !resolved.relative.includes("/live-test-runs/")) return null;
  const runDir = path.dirname(resolved.absolute);
  const reportPath = path.join(runDir, "report.json");
  if (!existsSync(reportPath)) return null;
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const combined = [report.stderr, report.stdout]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\r/g, "");
  const firstLines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  return {
    label: report.label,
    exitCode: report.exitCode,
    command: report.command,
    durationMs: report.durationMs,
    eventCount: (report.events || []).length,
    artifactCount: (report.artifactPaths || []).length,
    reportHref: rel(path.relative(REPO_ROOT, reportPath)),
    excerpt: firstLines.join("\n").slice(0, 1800),
  };
}

function recommendation(item, liveEvidence) {
  if (item.id === "hyperliquid_bench") {
    return {
      verdict: "blocked-external-credential",
      action: "Provide HL_PRIVATE_KEY and rerun hyperliquid_bench through the benchmark matrix so latest rows, normalized calls, and trajectory playback can be generated.",
      evidence: "The gap page reports CEREBRAS_API_KEY present and HL_PRIVATE_KEY absent; no latest rows or trajectories exist for this family.",
    };
  }
  if (item.id === "osworld-live") {
    return {
      verdict: "blocked-external-runtime",
      action: "Start/configure a runnable OSWorld provider, then rerun OSWorld live scoring with five tasks and regenerate the report stack.",
      evidence: "The OSWorld readiness probe reports no Docker daemon, VMware/VirtualBox provider, local VM file, AWS provider, or OSWORLD provider configuration.",
    };
  }
  if (item.id === "corpus-publication-gaps") {
    return {
      verdict: "accepted-review-caveat",
      action: "Use the corpus review and queue to prioritize 30 needs-review benchmark families; fix publication warnings when rerunning those families.",
      evidence: item.reasons?.join(" ") || item.summary,
    };
  }
  if (item.id === "five-examples-per-benchmark") {
    return {
      verdict: "accepted-osworld-caveat",
      action: "Keep expanded five-example proof for all runnable benchmarks; replace OSWorld smoke-only row after OSWorld runtime access is available.",
      evidence: item.reasons?.join(" ") || item.summary,
    };
  }
  if (item.kind === "live-test" && liveEvidence) {
    const timedOut = Number(liveEvidence.exitCode) === 124;
    return {
      verdict: timedOut ? "needs-timeout-or-scope-fix" : "needs-live-test-fix",
      action: timedOut
        ? "Inspect the playback/report excerpt, then rerun with a narrower quick path or increased timeout so the live/e2e artifact has a conclusive pass/fail result."
        : "Inspect the playback/report excerpt, fix the failing environment, fixture, or assertion, then rerun through the live-test artifact wrapper.",
      evidence: `Wrapped run ${liveEvidence.label || "unknown"} exited ${liveEvidence.exitCode}; eventCount=${liveEvidence.eventCount}; artifactCount=${liveEvidence.artifactCount}.`,
    };
  }
  return {
    verdict: "needs-human-review",
    action: "Open the linked target and decide whether this item needs a product fix, runner fix, rerun, or accepted caveat.",
    evidence: item.reasons?.join(" ") || item.summary,
  };
}

function buildPayload() {
  const queue = readJson("reports/benchmark-analysis/review-queue/review-queue.json");
  const manual = readJson("reports/benchmark-analysis/manual-review/manual-review.json");
  const manualByKey = new Map(
    (manual.items || []).map((item) => [`${item.kind}\0${item.id}`, item]),
  );
  const highPriorityItems = (queue.items || [])
    .filter((item) => Number(item.priority) >= 80)
    .map((item) => {
      const manualItem = manualByKey.get(`${item.kind}\0${item.id}`) || {};
      const target = resolveQueueViewer(item.viewer);
      const liveEvidence = loadLiveRunEvidence(item.viewer);
      const rec = recommendation(item, liveEvidence);
      return {
        ...item,
        targetHref: target ? rel(target.relative) : item.viewer,
        targetExists: target ? existsSync(target.absolute) : false,
        manualNoteHref: manualItem.noteHref ? rel(`reports/benchmark-analysis/manual-review/${manualItem.noteHref}`) : "",
        manualVerdict: manualItem.verdict || "unknown",
        agentVerdict: rec.verdict,
        recommendedAction: rec.action,
        agentEvidence: rec.evidence,
        liveEvidence,
      };
    });
  const byAgentVerdict = highPriorityItems.reduce((acc, item) => {
    acc[item.agentVerdict] = (acc[item.agentVerdict] || 0) + 1;
    return acc;
  }, {});
  return {
    schema: "eliza_benchmark_agent_review_digest_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      highPriorityCount: highPriorityItems.length,
      targetLinksExisting: highPriorityItems.filter((item) => item.targetExists).length,
      manualNotesLinked: highPriorityItems.filter((item) => item.manualNoteHref).length,
      liveFailuresReviewed: highPriorityItems.filter((item) => item.kind === "live-test" && item.liveEvidence).length,
      externalBlockers: highPriorityItems.filter((item) => String(item.agentVerdict).startsWith("blocked-")).length,
      caveatsReviewed: highPriorityItems.filter((item) => String(item.agentVerdict).startsWith("accepted-")).length,
      byAgentVerdict,
    },
    items: highPriorityItems,
  };
}

function html(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Review Digest</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:11px; }
    .card b { display:block; margin-top:4px; font-size:21px; }
    .panel { margin-bottom:12px; overflow:hidden; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f8faf5; }
    code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    pre { white-space:pre-wrap; max-width:760px; margin:0; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    .ok { color:#17633a; font-weight:700; }
  </style>
</head>
<body>
  <header><h1>Agent Review Digest</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <div class="cards">
      <div class="card"><span class="muted">High-priority reviewed</span><b>${escapeHtml(payload.summary.highPriorityCount)}</b><span>queue items</span></div>
      <div class="card"><span class="muted">Live failures reviewed</span><b>${escapeHtml(payload.summary.liveFailuresReviewed)}</b><span>wrapper reports inspected</span></div>
      <div class="card"><span class="muted">External blockers</span><b>${escapeHtml(payload.summary.externalBlockers)}</b><span>credential/runtime gates</span></div>
      <div class="card"><span class="muted">Target links</span><b>${escapeHtml(payload.summary.targetLinksExisting)}/${escapeHtml(payload.summary.highPriorityCount)}</b><span>resolve locally</span></div>
    </div>
    <section class="panel"><h2>First-Pass Triage</h2><div class="body"><table><thead><tr><th>priority</th><th>item</th><th>agent verdict</th><th>recommended action</th><th>evidence</th><th>links</th></tr></thead><tbody>${payload.items
      .map((item) => `<tr><td>${escapeHtml(item.priority)}</td><td><code>${escapeHtml(item.kind)}:${escapeHtml(item.id)}</code><br><span class="muted">${escapeHtml(item.summary)}</span></td><td class="${String(item.agentVerdict).startsWith("blocked") || String(item.agentVerdict).startsWith("needs") ? "bad" : "warn"}">${escapeHtml(item.agentVerdict)}</td><td>${escapeHtml(item.recommendedAction)}</td><td>${escapeHtml(item.agentEvidence)}${item.liveEvidence?.excerpt ? `<details><summary>run excerpt</summary><pre>${escapeHtml(item.liveEvidence.excerpt)}</pre></details>` : ""}</td><td><a href="${escapeHtml(item.targetHref)}">target</a><br><a href="${escapeHtml(item.manualNoteHref)}">note</a>${item.liveEvidence?.reportHref ? `<br><a href="${escapeHtml(item.liveEvidence.reportHref)}">report</a>` : ""}</td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Agent Review Digest",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- High-priority items reviewed: ${payload.summary.highPriorityCount}`,
    `- Live/e2e wrapper failures reviewed: ${payload.summary.liveFailuresReviewed}`,
    `- External blockers: ${payload.summary.externalBlockers}`,
    `- Target links existing: ${payload.summary.targetLinksExisting}/${payload.summary.highPriorityCount}`,
    "",
    "## Verdict Counts",
    "",
    ...Object.entries(payload.summary.byAgentVerdict).map(([key, count]) => `- ${key}: ${count}`),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "agent-review.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `benchmark agent review digest ${payload.summary.highPriorityCount} high-priority items at ${path.join(REPORT_DIR, "index.html")}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
