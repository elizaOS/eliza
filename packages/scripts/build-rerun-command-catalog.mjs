#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "rerun-command-catalog");
const PACK_INDEX_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "review-pack-index");

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

function relHref(href, sourceDir = PACK_INDEX_DIR) {
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

function by(rows, keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row) || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function classify(row) {
  if (row.id === "hyperliquid_bench") {
    return {
      runnableNow: false,
      blocker: "missing-HL_PRIVATE_KEY",
      followUp: "Provide HL_PRIVATE_KEY, run the command, then run bun run bench:analysis:build.",
    };
  }
  if (row.surface === "benchmark" && row.id === "osworld") {
    return {
      runnableNow: false,
      blocker: "missing-OSWorld-provider",
      followUp: "Configure Docker, VMware, VirtualBox, or AWS OSWorld provider, run the command, then run bun run bench:analysis:build.",
    };
  }
  if (row.surface === "scenario") {
    return {
      runnableNow: true,
      blocker: "",
      followUp: "After rerun, run bun run bench:analysis:build to refresh scenario packs and playback indexes.",
    };
  }
  if (row.surface === "live/e2e") {
    return {
      runnableNow: true,
      blocker: "",
      followUp: "After rerun, run bun run bench:analysis:build to refresh live/e2e playback, prompt/response, and review packs.",
    };
  }
  return {
    runnableNow: true,
    blocker: "",
    followUp: "After rerun, run bun run bench:analysis:build to refresh benchmark and corpus reports.",
  };
}

function buildPayload() {
  const packIndex = readJson("reports/benchmark-analysis/review-pack-index/review-pack-index.json");
  const verdicts = readJson(
    "reports/benchmark-analysis/review-pack-agent-verdicts/review-pack-agent-verdicts.json",
  );
  const verdictByKey = new Map((verdicts.rows || []).map((row) => [`${row.surface}:${row.id}`, row]));
  const rows = (packIndex.rows || [])
    .filter((row) => row.rerunCommand)
    .map((row, index) => {
      const verdict = verdictByKey.get(`${row.surface}:${row.id}`) || {};
      const run = classify(row);
      return {
        ordinal: index + 1,
        surface: row.surface,
        id: row.id,
        label: row.label,
        status: row.status,
        reviewClass: row.reviewClass,
        agentDecision: verdict.decision || "",
        agentVerdict: verdict.verdict || "",
        command: row.rerunCommand,
        runnableNow: run.runnableNow,
        blocker: run.blocker,
        followUp: run.followUp,
        packHref: relHref(row.packHref),
        playbackHref: relHref(row.playbackHref),
        gapHref: relHref(row.gapHref),
        manualNoteHref: relHref(row.manualNoteHref),
        linkState: {
          packExists: Boolean(row.packHref) && existsSync(path.resolve(REPORT_DIR, relHref(row.packHref))),
          playbackExists: row.playbackHref
            ? existsSync(path.resolve(REPORT_DIR, relHref(row.playbackHref)))
            : false,
          gapExists: row.gapHref ? existsSync(path.resolve(REPORT_DIR, relHref(row.gapHref))) : false,
          manualNoteExists: row.manualNoteHref
            ? existsSync(path.resolve(REPORT_DIR, relHref(row.manualNoteHref)))
            : false,
        },
      };
    })
    .sort((a, b) =>
      Number(a.runnableNow) - Number(b.runnableNow) ||
      a.surface.localeCompare(b.surface) ||
      a.id.localeCompare(b.id),
    )
    .map((row, index) => ({ ...row, ordinal: index + 1 }));

  const summary = {
    commandCount: rows.length,
    runnableNow: rows.filter((row) => row.runnableNow).length,
    blocked: rows.filter((row) => !row.runnableNow).length,
    withPack: rows.filter((row) => row.linkState.packExists).length,
    withPlayback: rows.filter((row) => row.linkState.playbackExists).length,
    withManualNote: rows.filter((row) => row.linkState.manualNoteExists).length,
    withGapPage: rows.filter((row) => row.linkState.gapExists).length,
    bySurface: by(rows, (row) => row.surface),
    byDecision: by(rows, (row) => row.agentDecision),
    byBlocker: by(rows, (row) => row.blocker || "none"),
  };

  return {
    schema: "eliza_rerun_command_catalog_v1",
    generatedAt: new Date().toISOString(),
    summary,
    rebuildCommand: "bun run bench:analysis:build",
    verifyCommand: "bun run bench:analysis:verify",
    rows,
  };
}

function renderHtml(payload) {
  const metrics = [
    ["Commands", fmt(payload.summary.commandCount)],
    ["Runnable now", fmt(payload.summary.runnableNow)],
    ["Blocked", fmt(payload.summary.blocked)],
    ["Pack-linked", fmt(payload.summary.withPack)],
    ["Playback-linked", fmt(payload.summary.withPlayback)],
    ["Manual notes", fmt(payload.summary.withManualNote)],
  ];
  const rows = payload.rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.ordinal)}</td>
      <td>${escapeHtml(row.surface)}<br><span>${escapeHtml(row.agentDecision)}</span></td>
      <td><strong>${escapeHtml(row.label)}</strong><br><code>${escapeHtml(row.id)}</code></td>
      <td>${row.runnableNow ? "yes" : "no"}<br><span>${escapeHtml(row.blocker)}</span></td>
      <td><code>${escapeHtml(row.command)}</code><br><span>${escapeHtml(row.followUp)}</span></td>
      <td>${link(row.packHref, "pack")} ${link(row.playbackHref, "playback")} ${link(row.gapHref, "gap")} ${link(row.manualNoteHref, "note")}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rerun Command Catalog</title>
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
    <h1>Rerun Command Catalog</h1>
    <div class="sub">Every rerun command surfaced by benchmark, corpus, scenario, and live/e2e review packs. Generated ${escapeHtml(payload.generatedAt)}.</div>
  </header>
  <main>
    <section class="metrics">
      ${metrics.map(([label, value]) => `<div class="metric"><strong>${escapeHtml(value)}</strong>${escapeHtml(label)}</div>`).join("")}
    </section>
    <table>
      <thead>
        <tr><th>#</th><th>Surface</th><th>Target</th><th>Runnable</th><th>Command / Follow-up</th><th>Links</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function writeOutputs(payload) {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(path.join(REPORT_DIR, "rerun-command-catalog.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  writeFileSync(path.join(REPORT_DIR, "index.html"), renderHtml(payload), "utf8");
  writeFileSync(
    path.join(REPORT_DIR, "README.md"),
    `# Rerun Command Catalog

Generated: ${payload.generatedAt}

- Commands: ${payload.summary.commandCount}
- Runnable now: ${payload.summary.runnableNow}
- Blocked: ${payload.summary.blocked}
- Pack-linked commands: ${payload.summary.withPack}
- Playback-linked commands: ${payload.summary.withPlayback}
- Manual-note linked commands: ${payload.summary.withManualNote}

After any command or batch of commands, run:

\`\`\`bash
${payload.rebuildCommand}
${payload.verifyCommand}
\`\`\`
`,
    "utf8",
  );
}

const payload = buildPayload();
writeOutputs(payload);
console.log(
  `[rerun-command-catalog] ${payload.summary.commandCount} commands, ${payload.summary.runnableNow} runnable now`,
);
