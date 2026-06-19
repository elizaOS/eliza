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
  "scenario-review-packs",
);
const PACK_DIR = path.join(REPORT_DIR, "scenarios");
const OUTCOME_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "scenario-outcome-matrix");

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

function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "");
}

function relHref(href, fromDir = REPORT_DIR, sourceDir = OUTCOME_DIR) {
  if (!href) return "";
  const text = String(href);
  if (text.startsWith("/") || text.startsWith("file://")) return "";
  const absolute = text.startsWith("reports/")
    ? path.join(REPO_ROOT, text)
    : path.resolve(sourceDir, text);
  return path.relative(fromDir, absolute).replaceAll(path.sep, "/");
}

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function buildPayload() {
  const outcome = readJson("reports/benchmark-analysis/scenario-outcome-matrix/scenario-outcome-matrix.json");
  const remediation = readJson(
    "reports/benchmark-analysis/scenario-remediation-matrix/scenario-remediation.json",
  );
  const manual = readJson("reports/benchmark-analysis/manual-review/manual-review.json");

  const remediationByKey = new Map((remediation.rows || []).map((row) => [`${row.scope}:${row.id}`, row]));
  const manualByKey = new Map(
    (manual.items || []).filter((item) => item.kind === "scenario").map((item) => [item.id, item]),
  );

  const packs = (outcome.rows || [])
    .slice()
    .sort((a, b) => String(a.key).localeCompare(String(b.key)))
    .map((row) => {
      const key = `${row.scope}:${row.id}`;
      const rem = remediationByKey.get(key) || {};
      const manualItem = manualByKey.get(key) || null;
      const fileName = `${slug(row.scope)}-${slug(row.id)}.html`;
      const sourceDir = rem.id ? path.join(REPO_ROOT, "reports", "benchmark-analysis", "scenario-remediation-matrix") : OUTCOME_DIR;
      return {
        key,
        id: row.id,
        scope: row.scope,
        fileName,
        href: `scenarios/${fileName}`,
        disposition: row.disposition,
        verdict: row.verdict,
        reviewClass: row.reviewClass,
        recommendedAction: rem.recommendedAction || row.recommendedAction || "",
        category: row.category || "",
        categoryDisposition: row.categoryDisposition || "",
        attempts: row.attempts || 0,
        passed: row.passed || 0,
        failed: row.failed || 0,
        skipped: row.skipped || 0,
        other: row.other || 0,
        playbackHref: relHref(row.playbackHref, PACK_DIR, OUTCOME_DIR),
        primaryViewerHref: relHref(row.primaryViewerHref, PACK_DIR, OUTCOME_DIR),
        categoryPageHref: relHref(rem.categoryPageHref || row.categoryPageHref, PACK_DIR, sourceDir),
        rerunCommand: row.rerunCommand || rem.rerunCommand || "",
        reasons: row.reasons || [],
        runs: (row.runs || []).map((run) => ({
          run: run.run,
          status: run.status,
          durationMs: run.durationMs,
          viewerHref: relHref(run.viewer, PACK_DIR, OUTCOME_DIR),
        })),
        failureDetails: (rem.failureDetails || []).map((failure) => ({
          run: failure.run,
          category: failure.category,
          detail: failure.detail,
          durationMs: failure.durationMs,
          viewerHref: relHref(failure.viewerHref, PACK_DIR, path.join(REPO_ROOT, "reports", "scenarios", "failure-analysis")),
          playbackHref: relHref(failure.playbackHref, PACK_DIR, path.join(REPO_ROOT, "reports", "scenarios", "failure-analysis")),
        })),
        manualReview: manualItem
          ? {
              priority: manualItem.priority,
              disposition: manualItem.disposition,
              summary: manualItem.summary,
              agentVerdict: manualItem.agentVerdict,
              recommendedAction: manualItem.recommendedAction,
              noteHref: relHref(
                `reports/benchmark-analysis/manual-review/${manualItem.noteHref}`,
                PACK_DIR,
              ),
            }
          : null,
      };
    });

  const summary = {
    scenarioCount: packs.length,
    packPages: packs.length,
    playbackLinkedRows: packs.filter((pack) => pack.playbackHref).length,
    passed: packs.filter((pack) => pack.disposition === "passed").length,
    failedOnly: packs.filter((pack) => pack.disposition === "failed-only").length,
    nonPassing: packs.filter((pack) => pack.disposition === "non-passing").length,
    actionableRows: packs.filter((pack) => pack.reviewClass === "actionable").length,
    evidenceLimitedRows: packs.filter((pack) => pack.reviewClass === "evidence-limited").length,
    categoryLinkedRows: packs.filter((pack) => pack.categoryPageHref).length,
    rerunCommands: packs.filter((pack) => pack.rerunCommand).length,
    manualReviewNotes: packs.filter((pack) => pack.manualReview?.noteHref).length,
    failureDetailRows: packs.reduce((sum, pack) => sum + pack.failureDetails.length, 0),
    byScope: packs.reduce((counts, pack) => {
      counts[pack.scope] = (counts[pack.scope] || 0) + 1;
      return counts;
    }, {}),
  };

  return {
    schema: "eliza_scenario_review_packs_v1",
    generatedAt: new Date().toISOString(),
    summary,
    packs,
  };
}

function packHtml(payload, pack) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pack.scope)} ${escapeHtml(pack.id)} Scenario Pack</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px; margin-bottom:12px; }
    .metric,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; overflow:hidden; }
    .metric { padding:10px; }
    .metric strong { display:block; font-size:20px; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:8px; text-align:left; vertical-align:top; }
    th { background:#fbfcfa; }
    code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    pre { white-space:pre-wrap; margin:0; max-height:180px; overflow:auto; }
    a { color:#116b5b; text-decoration:none; margin-right:8px; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(pack.id)}</h1><div class="muted">${escapeHtml(pack.scope)} / ${escapeHtml(pack.key)}</div></header>
  <main>
    <section class="grid">
      <div class="metric"><span>disposition</span><strong>${escapeHtml(pack.disposition)}</strong></div>
      <div class="metric"><span>verdict</span><strong>${escapeHtml(pack.verdict)}</strong></div>
      <div class="metric"><span>category</span><strong>${escapeHtml(pack.category || "none")}</strong></div>
      <div class="metric"><span>attempts</span><strong>${pack.attempts}</strong></div>
      <div class="metric"><span>passed/failed</span><strong>${pack.passed}/${pack.failed}</strong></div>
      <div class="metric"><span>manual note</span><strong>${pack.manualReview ? "yes" : "no"}</strong></div>
    </section>
    <section class="panel"><h2>Primary Links</h2><div class="body">
      ${link(pack.playbackHref, "playback")} ${link(pack.primaryViewerHref, "run viewer")} ${link(pack.categoryPageHref, "failure category")} ${pack.manualReview ? link(pack.manualReview.noteHref, "manual note") : ""}
    </div></section>
    <section class="panel"><h2>Outcome</h2><div class="body"><table><tbody>
      <tr><th>review class</th><td>${escapeHtml(pack.reviewClass)}</td></tr>
      <tr><th>counts</th><td>${pack.passed} passed, ${pack.failed} failed, ${pack.skipped} skipped, ${pack.other} other</td></tr>
      <tr><th>reasons</th><td>${(pack.reasons || []).map(escapeHtml).join("<br>")}</td></tr>
      <tr><th>next action</th><td>${escapeHtml(pack.recommendedAction || "No remediation action needed.")}</td></tr>
      <tr><th>rerun</th><td>${pack.rerunCommand ? `<code>${escapeHtml(pack.rerunCommand)}</code><br><span class="muted">then <code>bun run bench:analysis:build</code></span>` : "No rerun required for passing scenario."}</td></tr>
    </tbody></table></div></section>
    <section class="panel"><h2>Runs</h2><div class="body"><table><thead><tr><th>run</th><th>status</th><th>duration</th><th>viewer</th></tr></thead><tbody>
      ${pack.runs.map((run) => `<tr><td>${escapeHtml(run.run)}</td><td>${escapeHtml(run.status)}</td><td>${escapeHtml(run.durationMs ?? "")}ms</td><td>${link(run.viewerHref, "viewer")}</td></tr>`).join("")}
    </tbody></table></div></section>
    <section class="panel"><h2>Failure Details And Manual Review</h2><div class="body"><table><tbody>
      <tr><th>failures</th><td>${pack.failureDetails.length ? pack.failureDetails.map((failure) => `<div><b>${escapeHtml(failure.run)}</b> ${escapeHtml(failure.category)} ${escapeHtml(failure.durationMs ?? "")}ms<br>${escapeHtml(failure.detail)}<br>${link(failure.viewerHref, "viewer")} ${link(failure.playbackHref, "playback")}</div>`).join("<hr>") : "No failure detail rows."}</td></tr>
      <tr><th>manual</th><td>${pack.manualReview ? `${escapeHtml(pack.manualReview.agentVerdict)}; ${escapeHtml(pack.manualReview.recommendedAction)}` : "No scenario manual-review note; scenario is currently passing."}</td></tr>
    </tbody></table></div></section>
  </main>
</body>
</html>`;
}

function indexHtml(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Scenario Review Packs</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
    .card { background:#fff; border:1px solid #d7ded1; border-radius:8px; padding:10px; }
    .card strong { display:block; font-size:20px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d7ded1; }
    th,td { border-bottom:1px solid #d7ded1; padding:8px; text-align:left; vertical-align:top; }
    th { background:#f2f5ef; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Scenario Review Packs</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">
      ${["scenarioCount", "passed", "failedOnly", "nonPassing", "actionableRows", "evidenceLimitedRows", "rerunCommands", "manualReviewNotes"].map((key) => `<div class="card"><span>${escapeHtml(key)}</span><strong>${escapeHtml(payload.summary[key])}</strong></div>`).join("")}
    </section>
    <table><thead><tr><th>scenario</th><th>disposition</th><th>verdict</th><th>links</th></tr></thead><tbody>
      ${payload.packs.map((pack) => `<tr><td><code>${escapeHtml(pack.key)}</code></td><td>${escapeHtml(pack.disposition)}<br><span class="muted">${pack.passed}/${pack.failed}/${pack.skipped}/${pack.other}</span></td><td>${escapeHtml(pack.verdict)}<br><span class="muted">${escapeHtml(pack.category)}</span></td><td><a href="${escapeHtml(pack.href)}">pack</a></td></tr>`).join("")}
    </tbody></table>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Scenario Review Packs",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Summary: ${payload.summary.packPages}/${payload.summary.scenarioCount} pack pages, ${payload.summary.playbackLinkedRows} playback links, ${payload.summary.rerunCommands} rerun commands, ${payload.summary.manualReviewNotes} manual notes.`,
    "",
    "| Scenario | Pack | Disposition | Verdict |",
    "| --- | --- | --- | --- |",
    ...payload.packs.map(
      (pack) => `| \`${pack.key}\` | \`${pack.href}\` | ${pack.disposition} | ${pack.verdict} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(PACK_DIR, { recursive: true });
  const payload = buildPayload();
  for (const pack of payload.packs) {
    writeFileSync(path.join(PACK_DIR, pack.fileName), packHtml(payload, pack), "utf8");
  }
  writeFileSync(
    path.join(REPORT_DIR, "scenario-review-packs.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), indexHtml(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(`scenario review packs ${payload.summary.packPages} pages at ${REPORT_DIR}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
