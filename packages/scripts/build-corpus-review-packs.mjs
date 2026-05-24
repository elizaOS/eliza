#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "corpus-review-packs");
const PACK_DIR = path.join(REPORT_DIR, "families");
const CORPUS_DIR = path.join(REPO_ROOT, "reports", "benchmarks", "benchmark-results-corpus-review");
const REMEDIATION_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "corpus-remediation-matrix");

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

function fmt(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : String(value ?? "");
}

function pct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "n/a";
}

function relHref(href, fromDir = REPORT_DIR, sourceDir = CORPUS_DIR) {
  if (!href) return "";
  const text = String(href);
  if (text.startsWith("/") || text.startsWith("file://")) return "";
  const absolute = text.startsWith("reports/") ? path.join(REPO_ROOT, text) : path.resolve(sourceDir, text);
  return path.relative(fromDir, absolute).replaceAll(path.sep, "/");
}

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function countWarnings(rows) {
  const counts = {};
  for (const row of rows || []) {
    for (const warning of row.warnings || []) {
      counts[warning] = (counts[warning] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function buildPayload() {
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const remediation = readJson("reports/benchmark-analysis/corpus-remediation-matrix/corpus-remediation.json");
  const manual = readJson("reports/benchmark-analysis/manual-review/manual-review.json");

  const remediationById = new Map((remediation.rows || []).map((row) => [row.benchmarkId, row]));
  const manualById = new Map(
    (manual.items || []).filter((item) => item.kind === "benchmark-family").map((item) => [item.id, item]),
  );
  const canonicalById = new Map();
  for (const row of corpus.canonicalFiles || []) {
    if (!canonicalById.has(row.benchmark_id)) canonicalById.set(row.benchmark_id, []);
    canonicalById.get(row.benchmark_id).push(row);
  }
  const canonicalByRunId = new Map((corpus.canonicalFiles || []).map((row) => [row.run_id, row]));
  const latestByRunId = new Map((corpus.latestRows || []).map((row) => [row.run_id, row]));

  const packs = (corpus.reviewFindings || [])
    .slice()
    .sort((a, b) => String(a.benchmark_id).localeCompare(String(b.benchmark_id)))
    .map((finding) => {
      const rem = remediationById.get(finding.benchmark_id) || {};
      const manualItem = manualById.get(finding.benchmark_id) || null;
      const canonical = canonicalById.get(finding.benchmark_id) || [];
      const fileName = `${slug(finding.benchmark_id)}.html`;
      const warningRows = (rem.warningRows || []).map((row) => {
        const latest = latestByRunId.get(row.runId) || {};
        const canonicalRow = canonicalByRunId.get(row.runId) || {};
        return {
          ...row,
          provider: latest.provider || "",
          model: latest.model || "",
          cachePercent: Number.isFinite(Number(latest.cache_hit_ratio))
            ? Number(latest.cache_hit_ratio) * 100
            : null,
          callPreviewCount: (latest.call_previews || []).length,
          playbackHref: relHref(canonicalRow.playback_file, PACK_DIR, CORPUS_DIR),
        };
      });
      return {
        benchmarkId: finding.benchmark_id,
        fileName,
        href: `families/${fileName}`,
        disposition: finding.disposition,
        reasons: finding.reasons || [],
        latestRows: finding.latest_rows || rem.latestRows || 0,
        succeededRows: finding.succeeded_rows || rem.succeededRows || 0,
        normalizedCalls: finding.normalized_calls || rem.normalizedCalls || 0,
        tokenTotal: finding.token_total || rem.tokenTotal || 0,
        cachedTokenTotal: finding.cached_token_total || rem.cachedTokenTotal || 0,
        cachePercent: finding.cache_percent ?? rem.cachePercent ?? null,
        trajectoryLikeFiles: finding.trajectory_like_files || rem.trajectoryLikeFiles || 0,
        outputFiles: finding.output_files || rem.outputFiles || 0,
        historyPairs: finding.history_pairs || 0,
        previousPairs: finding.previous_pairs || rem.previousPairs || 0,
        regressionPairs: finding.regression_pairs || rem.regressionPairs || 0,
        familyPageHref: relHref(finding.family_page || rem.familyPageHref, PACK_DIR, CORPUS_DIR),
        gapPageHref: relHref(rem.gapPageHref, PACK_DIR, REMEDIATION_DIR),
        firstPlaybackHref: relHref(rem.firstPlaybackHref || canonical.find((row) => row.playback_file)?.playback_file, PACK_DIR, REMEDIATION_DIR),
        canonicalPlaybackCount: rem.canonicalPlaybackCount ?? canonical.filter((row) => row.playback_file).length,
        canonicalPlaybackHrefs: canonical
          .filter((row) => row.playback_file)
          .slice(0, 8)
          .map((row) => relHref(row.playback_file, PACK_DIR, CORPUS_DIR)),
        warningRows,
        warningCounts: countWarnings(warningRows),
        zeroMetricRows: rem.zeroMetricRows || [],
        tokenlessTelemetry: rem.tokenlessTelemetry || null,
        rerunCommand: rem.rerunCommand || "",
        manualReview: manualItem
          ? {
              priority: manualItem.priority,
              disposition: manualItem.disposition,
              summary: manualItem.summary,
              agentVerdict: manualItem.agentVerdict,
              recommendedAction: manualItem.recommendedAction,
              noteHref: relHref(`reports/benchmark-analysis/manual-review/${manualItem.noteHref}`, PACK_DIR),
            }
          : null,
      };
    });

  const summary = {
    familyCount: packs.length,
    packPages: packs.length,
    reviewPass: packs.filter((pack) => pack.disposition === "review-pass").length,
    needsReview: packs.filter((pack) => pack.disposition === "needs-review").length,
    telemetryGap: packs.filter((pack) => pack.disposition === "telemetry-gap").length,
    blocked: packs.filter((pack) => pack.disposition === "blocked").length,
    withFamilyPage: packs.filter((pack) => pack.familyPageHref).length,
    withCanonicalPlayback: packs.filter((pack) => pack.canonicalPlaybackCount > 0).length,
    canonicalPlaybackFiles: packs.reduce((sum, pack) => sum + pack.canonicalPlaybackCount, 0),
    withManualReviewNote: packs.filter((pack) => pack.manualReview?.noteHref).length,
    rerunCommands: packs.filter((pack) => pack.rerunCommand).length,
    warningRows: packs.reduce((sum, pack) => sum + pack.warningRows.length, 0),
    warningFamilies: packs.filter((pack) => pack.warningRows.length > 0).length,
    warningRowsWithPlayback: packs.reduce(
      (sum, pack) => sum + pack.warningRows.filter((row) => row.playbackHref).length,
      0,
    ),
    warningRowsWithCallPreview: packs.reduce(
      (sum, pack) => sum + pack.warningRows.filter((row) => row.callPreviewCount > 0).length,
      0,
    ),
    warningCounts: countWarnings(packs.flatMap((pack) => pack.warningRows)),
    zeroMetricRows: packs.reduce((sum, pack) => sum + pack.zeroMetricRows.length, 0),
    normalizedCalls: packs.reduce((sum, pack) => sum + pack.normalizedCalls, 0),
    tokenTotal: packs.reduce((sum, pack) => sum + pack.tokenTotal, 0),
    cachedTokenTotal: packs.reduce((sum, pack) => sum + pack.cachedTokenTotal, 0),
  };

  return { schema: "eliza_corpus_review_packs_v1", generatedAt: new Date().toISOString(), summary, packs };
}

function packHtml(payload, pack) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(pack.benchmarkId)} Corpus Pack</title>
<style>
body{margin:0;background:#f7f8f5;color:#172017;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{background:#fff;border-bottom:1px solid #d7ded1;padding:16px 20px}main{padding:16px 20px}h1{margin:0 0 5px;font-size:22px;letter-spacing:0}h2{margin:0;padding:10px 12px;background:#f2f5ef;border-bottom:1px solid #d7ded1;font-size:15px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-bottom:12px}.metric,.panel{background:#fff;border:1px solid #d7ded1;border-radius:8px;overflow:hidden}.metric{padding:10px}.metric strong{display:block;font-size:20px}.body{padding:12px;overflow:auto}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #d7ded1;padding:8px;text-align:left;vertical-align:top}th{background:#fbfcfa}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}pre{white-space:pre-wrap;margin:0;max-height:180px;overflow:auto}a{color:#116b5b;text-decoration:none;margin-right:8px}a:hover{text-decoration:underline}.muted{color:#5f685d}
</style></head><body>
<header><h1>${escapeHtml(pack.benchmarkId)}</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
<main>
  <section class="grid">
    <div class="metric"><span>disposition</span><strong>${escapeHtml(pack.disposition)}</strong></div>
    <div class="metric"><span>latest success</span><strong>${pack.succeededRows}/${pack.latestRows}</strong></div>
    <div class="metric"><span>calls</span><strong>${fmt(pack.normalizedCalls)}</strong></div>
    <div class="metric"><span>cache</span><strong>${pct(pack.cachePercent)}</strong></div>
    <div class="metric"><span>canonical playback</span><strong>${pack.canonicalPlaybackCount}</strong></div>
    <div class="metric"><span>manual note</span><strong>${pack.manualReview ? "yes" : "no"}</strong></div>
  </section>
  <section class="panel"><h2>Primary Links</h2><div class="body">${link(pack.familyPageHref, "family page")} ${link(pack.gapPageHref, "gap page")} ${link(pack.firstPlaybackHref, "first playback")} ${pack.manualReview ? link(pack.manualReview.noteHref, "manual note") : ""}</div></section>
  <section class="panel"><h2>Telemetry And Warnings</h2><div class="body"><table><tbody>
    <tr><th>tokens/cache</th><td>${fmt(pack.tokenTotal)} tokens, ${fmt(pack.cachedTokenTotal)} cached tokens, cache ${pct(pack.cachePercent)}</td></tr>
    <tr><th>artifacts</th><td>${pack.trajectoryLikeFiles} trajectory-like files, ${pack.outputFiles} output files, ${pack.canonicalPlaybackCount} canonical playback files</td></tr>
    <tr><th>history</th><td>${pack.historyPairs} history pairs, ${pack.previousPairs} previous pairs, ${pack.regressionPairs} regressions</td></tr>
    <tr><th>reasons</th><td>${pack.reasons.map(escapeHtml).join("<br>")}</td></tr>
    <tr><th>warning counts</th><td>${Object.keys(pack.warningCounts).length ? Object.entries(pack.warningCounts).map(([warning, count]) => `<div><code>${escapeHtml(warning)}</code>: ${escapeHtml(count)}</div>`).join("") : "none"}</td></tr>
    <tr><th>warnings</th><td>${pack.warningRows.length ? `<table><thead><tr><th>run</th><th>agent</th><th>warning</th><th>score/tasks</th><th>model/cache</th><th>review</th></tr></thead><tbody>${pack.warningRows.map((row) => `<tr><td><code>${escapeHtml(row.runId)}</code></td><td>${escapeHtml(row.agent)}</td><td>${(row.warnings || []).map((warning) => `<code>${escapeHtml(warning)}</code>`).join("<br>")}</td><td>${escapeHtml(row.score ?? "n/a")}/${escapeHtml(row.totalTasks ?? "n/a")}</td><td>${escapeHtml(row.provider || "n/a")} ${escapeHtml(row.model || "")}<br>${fmt(row.llmCallCount)} calls; ${fmt(row.totalTokens)} tokens; cache ${pct(row.cachePercent)}</td><td>${link(row.playbackHref, "playback")}<span class="muted">${escapeHtml(row.callPreviewCount)} previews</span></td></tr>`).join("")}</tbody></table>` : "none"}</td></tr>
    <tr><th>zero metrics</th><td>${pack.zeroMetricRows.length ? `<pre>${escapeHtml(JSON.stringify(pack.zeroMetricRows.slice(0, 5), null, 2))}</pre>` : "none"}</td></tr>
    <tr><th>tokenless telemetry</th><td>${pack.tokenlessTelemetry ? `<pre>${escapeHtml(JSON.stringify(pack.tokenlessTelemetry, null, 2))}</pre>` : "none"}</td></tr>
  </tbody></table></div></section>
  <section class="panel"><h2>Playback And Manual Review</h2><div class="body"><table><tbody>
    <tr><th>sample playback</th><td>${pack.canonicalPlaybackHrefs.map((href) => link(href, "playback")).join(" ")}</td></tr>
    <tr><th>rerun</th><td>${pack.rerunCommand ? `<code>${escapeHtml(pack.rerunCommand)}</code><br><span class="muted">then <code>bun run bench:analysis:build</code></span>` : "No remediation rerun queued."}</td></tr>
    <tr><th>manual</th><td>${pack.manualReview ? `${escapeHtml(pack.manualReview.agentVerdict)}; ${escapeHtml(pack.manualReview.recommendedAction)}` : "No manual-review note queued for this review-pass family."}</td></tr>
  </tbody></table></div></section>
</main></body></html>`;
}

function indexHtml(payload) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Corpus Review Packs</title>
<style>body{margin:0;background:#f7f8f5;color:#172017;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{background:#fff;border-bottom:1px solid #d7ded1;padding:16px 20px}main{padding:16px 20px}h1{margin:0 0 5px;font-size:22px;letter-spacing:0}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:12px}.card{background:#fff;border:1px solid #d7ded1;border-radius:8px;padding:10px}.card strong{display:block;font-size:20px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d7ded1}th,td{border-bottom:1px solid #d7ded1;padding:8px;text-align:left;vertical-align:top}th{background:#f2f5ef}a{color:#116b5b;text-decoration:none}a:hover{text-decoration:underline}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.muted{color:#5f685d}</style></head><body>
<header><h1>Corpus Review Packs</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
<main><section class="cards">${["familyCount", "needsReview", "reviewPass", "warningRows", "warningRowsWithPlayback", "warningRowsWithCallPreview", "telemetryGap", "blocked"].map((key) => `<div class="card"><span>${escapeHtml(key)}</span><strong>${escapeHtml(payload.summary[key])}</strong></div>`).join("")}</section>
<table><thead><tr><th>family</th><th>disposition</th><th>calls/cache</th><th>warnings</th><th>playback</th><th>links</th></tr></thead><tbody>${payload.packs.map((pack) => `<tr><td><code>${escapeHtml(pack.benchmarkId)}</code></td><td>${escapeHtml(pack.disposition)}</td><td>${fmt(pack.normalizedCalls)}<br><span class="muted">${pct(pack.cachePercent)}</span></td><td>${pack.warningRows.length}<br><span class="muted">${Object.keys(pack.warningCounts).join(", ")}</span></td><td>${pack.canonicalPlaybackCount}</td><td><a href="${escapeHtml(pack.href)}">pack</a></td></tr>`).join("")}</tbody></table></main></body></html>`;
}

function markdown(payload) {
  return [
    "# Corpus Review Packs",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Summary: ${payload.summary.packPages}/${payload.summary.familyCount} pack pages, ${payload.summary.withCanonicalPlayback} with canonical playback, ${payload.summary.warningRows} warning rows, ${payload.summary.warningRowsWithPlayback} warning rows with playback, ${payload.summary.warningRowsWithCallPreview} warning rows with call previews, ${payload.summary.withManualReviewNote} manual notes, ${payload.summary.rerunCommands} rerun commands.`,
    "",
    "| Family | Pack | Disposition | Calls | Cache |",
    "| --- | --- | --- | ---: | ---: |",
    ...payload.packs.map((pack) => `| \`${pack.benchmarkId}\` | \`${pack.href}\` | ${pack.disposition} | ${pack.normalizedCalls} | ${pct(pack.cachePercent)} |`),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(PACK_DIR, { recursive: true });
  const payload = buildPayload();
  for (const pack of payload.packs) {
    writeFileSync(path.join(PACK_DIR, pack.fileName), packHtml(payload, pack), "utf8");
  }
  writeFileSync(path.join(REPORT_DIR, "corpus-review-packs.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  writeFileSync(path.join(REPORT_DIR, "index.html"), indexHtml(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(`corpus review packs ${payload.summary.packPages} pages at ${REPORT_DIR}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
