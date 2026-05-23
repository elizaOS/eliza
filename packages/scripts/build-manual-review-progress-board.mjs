#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "manual-review-progress");

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

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function noteVerdict(item) {
  const verdict = String(item.verdict || "").trim();
  return verdict || "unreviewed";
}

function packKeyForItem(item) {
  if (item.kind === "benchmark-family") return `corpus:${item.id}`;
  if (item.kind === "code-agent-benchmark") return `benchmark:${item.id}`;
  if (item.kind === "live-test") return `live/e2e:${item.id}`;
  if (item.kind === "scenario") return `scenario:${item.id}`;
  return "";
}

function countBy(rows, keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row) || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildPayload() {
  const manual = readJson("reports/benchmark-analysis/manual-review/manual-review.json");
  const reviewPacks = readJson("reports/benchmark-analysis/review-pack-index/review-pack-index.json");

  const packByKey = new Map((reviewPacks.rows || []).map((row) => [`${row.surface}:${row.id}`, row]));
  const rows = (manual.items || []).map((item) => {
    const pack = packByKey.get(packKeyForItem(item)) || null;
    const noteHref = relHref(item.noteHref, path.join(REPO_ROOT, "reports", "benchmark-analysis", "manual-review"));
    const viewerHref = relHref(
      item.viewerHref || item.viewer,
      path.join(REPO_ROOT, "reports", "benchmark-analysis", "manual-review"),
    );
    const row = {
      kind: item.kind,
      id: item.id,
      disposition: item.disposition,
      priority: item.priority || 0,
      verdict: noteVerdict(item),
      agentVerdict: item.agentVerdict || "",
      summary: item.summary || "",
      noteHref,
      viewerHref,
      packHref: pack?.packHref ? relHref(pack.packHref, path.join(REPO_ROOT, "reports", "benchmark-analysis", "review-pack-index")) : "",
      playbackHref: pack?.playbackHref
        ? relHref(pack.playbackHref, path.join(REPO_ROOT, "reports", "benchmark-analysis", "review-pack-index"))
        : "",
      gapHref: pack?.gapHref
        ? relHref(pack.gapHref, path.join(REPO_ROOT, "reports", "benchmark-analysis", "review-pack-index"))
        : "",
      rerunCommand: pack?.rerunCommand || "",
      hasPack: Boolean(pack),
      noteExists: Boolean(noteHref) && existsSync(path.resolve(REPORT_DIR, noteHref)),
      viewerExists: Boolean(viewerHref) && existsSync(path.resolve(REPORT_DIR, viewerHref)),
      packExists: Boolean(pack?.packHref) && existsSync(path.resolve(REPORT_DIR, relHref(pack.packHref, path.join(REPO_ROOT, "reports", "benchmark-analysis", "review-pack-index")))),
      playbackExists:
        Boolean(pack?.playbackHref) &&
        existsSync(path.resolve(REPORT_DIR, relHref(pack.playbackHref, path.join(REPO_ROOT, "reports", "benchmark-analysis", "review-pack-index")))),
    };
    return row;
  }).sort((a, b) => b.priority - a.priority || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  const unreviewedRows = rows.filter((row) => row.verdict === "unreviewed");
  const summary = {
    itemCount: rows.length,
    noteCount: rows.filter((row) => row.noteExists).length,
    reviewed: rows.filter((row) => row.verdict !== "unreviewed").length,
    unreviewed: unreviewedRows.length,
    highPriority: rows.filter((row) => row.priority >= 80).length,
    highPriorityUnreviewed: rows.filter((row) => row.priority >= 80 && row.verdict === "unreviewed").length,
    withPack: rows.filter((row) => row.hasPack).length,
    withPlayback: rows.filter((row) => row.playbackExists).length,
    withGapPage: rows.filter((row) => row.gapHref).length,
    withRerunCommand: rows.filter((row) => row.rerunCommand).length,
    byKind: countBy(rows, (row) => row.kind),
    byVerdict: countBy(rows, (row) => row.verdict),
    byAgentVerdict: countBy(rows, (row) => row.agentVerdict),
  };

  return {
    schema: "eliza_manual_review_progress_v1",
    generatedAt: new Date().toISOString(),
    summary,
    nextUnreviewed: unreviewedRows.slice(0, 50),
    rows,
  };
}

function renderHtml(payload) {
  const metrics = [
    ["Review items", fmt(payload.summary.itemCount)],
    ["Notes found", fmt(payload.summary.noteCount)],
    ["Unreviewed", fmt(payload.summary.unreviewed)],
    ["High priority", fmt(payload.summary.highPriorityUnreviewed)],
    ["Pack-linked", fmt(payload.summary.withPack)],
    ["Playback-linked", fmt(payload.summary.withPlayback)],
    ["Rerun commands", fmt(payload.summary.withRerunCommand)],
  ];
  const rows = payload.rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.priority)}</td>
      <td>${escapeHtml(row.kind)}<br><code>${escapeHtml(row.id)}</code></td>
      <td>${escapeHtml(row.verdict)}<br><span>${escapeHtml(row.agentVerdict)}</span></td>
      <td>${escapeHtml(row.disposition)}</td>
      <td>${link(row.noteHref, "note")} ${link(row.viewerHref, "target")} ${link(row.packHref, "pack")} ${link(row.playbackHref, "playback")} ${link(row.gapHref, "gap")}</td>
      <td>${row.rerunCommand ? `<code>${escapeHtml(row.rerunCommand)}</code>` : ""}</td>
      <td>${escapeHtml(row.summary)}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Manual Review Progress</title>
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
    <h1>Manual Review Progress</h1>
    <div class="sub">Durable note progress joined to pack, playback, gap, and rerun evidence. Generated ${escapeHtml(payload.generatedAt)}.</div>
  </header>
  <main>
    <section class="metrics">
      ${metrics.map(([label, value]) => `<div class="metric"><strong>${escapeHtml(value)}</strong>${escapeHtml(label)}</div>`).join("")}
    </section>
    <table>
      <thead>
        <tr><th>Priority</th><th>Item</th><th>Verdict</th><th>Disposition</th><th>Links</th><th>Rerun</th><th>Summary</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function writeOutputs(payload) {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(path.join(REPORT_DIR, "manual-review-progress.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  writeFileSync(path.join(REPORT_DIR, "index.html"), renderHtml(payload), "utf8");
  writeFileSync(
    path.join(REPORT_DIR, "README.md"),
    `# Manual Review Progress

Generated: ${payload.generatedAt}

- Items: ${payload.summary.itemCount}
- Notes found: ${payload.summary.noteCount}
- Reviewed: ${payload.summary.reviewed}
- Unreviewed: ${payload.summary.unreviewed}
- High-priority unreviewed: ${payload.summary.highPriorityUnreviewed}
- Pack-linked review items: ${payload.summary.withPack}
- Playback-linked review items: ${payload.summary.withPlayback}
- Rerun commands: ${payload.summary.withRerunCommand}
`,
    "utf8",
  );
}

const payload = buildPayload();
writeOutputs(payload);
console.log(
  `[manual-review-progress] ${payload.summary.reviewed}/${payload.summary.itemCount} reviewed; ${payload.summary.withPack} pack-linked`,
);
