#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "review-pack-agent-verdicts");
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

function verdictFor(row) {
  const text = `${row.status} ${row.disposition} ${row.reviewClass} ${row.primaryIssue}`.toLowerCase();
  if (/hyperliquid_bench/.test(row.id)) {
    return {
      verdict: "blocked-external-credential",
      decision: "blocked",
      confidence: "high",
      reason: "No Hyperliquid private key is present, so the benchmark family has no latest runnable evidence.",
      action: "Provide HL_PRIVATE_KEY, rerun hyperliquid_bench, and rebuild the analysis stack.",
    };
  }
  if (row.surface === "benchmark" && row.id === "osworld") {
    return {
      verdict: "blocked-external-runtime",
      decision: "blocked",
      confidence: "high",
      reason: "OSWorld is smoke-only and has no runnable live provider in the current environment.",
      action: "Configure a runnable OSWorld provider, rerun five live tasks, and rebuild.",
    };
  }
  if (/failed|model-wrapper-failed/.test(text) && row.surface === "live/e2e") {
    return {
      verdict: "needs-live-test-fix",
      decision: "fix",
      confidence: "medium",
      reason: row.primaryIssue || "The latest wrapped live/e2e run failed.",
      action: "Open the wrapped playback and failure report, fix the environment, fixture, or assertion, then rerun through the artifact wrapper.",
    };
  }
  if (/telemetry-gap|zero metric|tokenless|no-call-artifact/.test(text)) {
    return {
      verdict: "needs-telemetry-review",
      decision: "inspect",
      confidence: "medium",
      reason: row.primaryIssue || "Telemetry is present but incomplete for model/token review.",
      action: "Inspect the linked pack and playback/gap page, then decide whether to accept the limitation or rerun with fuller telemetry.",
    };
  }
  if (/blocked|missing-live|missing|external/.test(text)) {
    return {
      verdict: "blocked-or-missing-evidence",
      decision: "blocked",
      confidence: "medium",
      reason: row.primaryIssue || "The row is blocked or missing required evidence.",
      action: "Resolve the blocker or rerun prerequisite, then rebuild.",
    };
  }
  if (/inferior|weak-output|needs-output|output/.test(text) && row.surface === "benchmark") {
    return {
      verdict: "needs-output-quality-review",
      decision: "inspect",
      confidence: "medium",
      reason: row.primaryIssue || "The benchmark has weak or inferior output quality despite available playback.",
      action: "Open the benchmark pack and trajectory playback, compare target/baseline outputs, and route to agent, harness, or prompt work.",
    };
  }
  if (row.surface === "scenario" && row.status === "passed") {
    return {
      verdict: "accepted-scenario-pass",
      decision: "accept",
      confidence: "high",
      reason: "Scenario passed and has playback evidence.",
      action: "No action unless qualitative review finds a hidden fixture issue.",
    };
  }
  if (row.surface === "scenario" && /evidence-limited/.test(text)) {
    return {
      verdict: "needs-scenario-rerun-or-evidence-review",
      decision: "rerun",
      confidence: "medium",
      reason: row.primaryIssue || "Scenario evidence is limited, often from partial or reconstructed runs.",
      action: "Use the single-scenario rerun command, then inspect the refreshed playback.",
    };
  }
  if (row.surface === "scenario" && row.status !== "passed") {
    return {
      verdict: "needs-scenario-fix-review",
      decision: "fix",
      confidence: "medium",
      reason: row.primaryIssue || "Scenario is non-passing and has playback evidence.",
      action: "Open the scenario pack/playback, inspect the failing step and assertion, then route to fixture, runner, connector, or product behavior work.",
    };
  }
  if (row.surface === "corpus" && row.status === "needs-review") {
    return {
      verdict: "needs-corpus-family-review",
      decision: "inspect",
      confidence: "medium",
      reason: row.primaryIssue || "Corpus family has publication warnings or version gaps.",
      action: "Open the corpus pack and canonical playback, inspect warnings/calls/outputs, and decide rerun versus accepted limitation.",
    };
  }
  if (row.surface === "live/e2e" && /structured-present/.test(text)) {
    return {
      verdict: "accepted-live-structured-evidence",
      decision: "accept",
      confidence: "high",
      reason: "Wrapped playback and structured prompt/response sidecar evidence are both present.",
      action: "No action unless qualitative review finds an assertion or prompt issue.",
    };
  }
  if (row.surface === "live/e2e" && /model-wrapper-pass/.test(text)) {
    return {
      verdict: "accepted-live-wrapper-pass-with-sidecar-caveat",
      decision: "accept-caveat",
      confidence: "medium",
      reason: row.primaryIssue || "Wrapped run passed but script-level structured sidecar may be reason-coded absent.",
      action: "Use playback as behavioral evidence; rerun only if prompt/response sidecar is required for this script.",
    };
  }
  if (/review-pass|passed|model-wrapper-pass/.test(text)) {
    return {
      verdict: "accepted-review-pass",
      decision: "accept",
      confidence: "high",
      reason: row.primaryIssue || "The row has passing or review-pass evidence and linked artifacts.",
      action: "No action unless qualitative playback review finds a hidden issue.",
    };
  }
  return {
    verdict: "needs-human-review",
    decision: "inspect",
    confidence: "low",
    reason: row.primaryIssue || "The row needs a reviewer decision.",
    action: "Open the pack and playback, then record the decision in the manual review note if one exists.",
  };
}

function buildPayload() {
  const packIndex = readJson("reports/benchmark-analysis/review-pack-index/review-pack-index.json");
  const rows = (packIndex.rows || []).map((row) => {
    const verdict = verdictFor(row);
    return {
      surface: row.surface,
      id: row.id,
      label: row.label,
      status: row.status,
      disposition: row.disposition,
      reviewClass: row.reviewClass,
      priority: row.priority || 0,
      ...verdict,
      packHref: relHref(row.packHref),
      playbackHref: relHref(row.playbackHref),
      gapHref: relHref(row.gapHref),
      manualNoteHref: relHref(row.manualNoteHref),
      rerunCommand: row.rerunCommand || "",
      primaryIssue: row.primaryIssue || "",
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
  }).sort((a, b) => {
    const rank = { blocked: 0, fix: 1, rerun: 2, inspect: 3, "accept-caveat": 4, accept: 5 };
    return (rank[a.decision] ?? 9) - (rank[b.decision] ?? 9) ||
      b.priority - a.priority ||
      a.surface.localeCompare(b.surface) ||
      a.id.localeCompare(b.id);
  });

  const summary = {
    rowCount: rows.length,
    reviewedRows: rows.filter((row) => row.verdict).length,
    acceptRows: rows.filter((row) => row.decision === "accept").length,
    acceptCaveatRows: rows.filter((row) => row.decision === "accept-caveat").length,
    inspectRows: rows.filter((row) => row.decision === "inspect").length,
    fixRows: rows.filter((row) => row.decision === "fix").length,
    rerunRows: rows.filter((row) => row.decision === "rerun").length,
    blockedRows: rows.filter((row) => row.decision === "blocked").length,
    withPack: rows.filter((row) => row.linkState.packExists).length,
    withPlayback: rows.filter((row) => row.linkState.playbackExists).length,
    withManualNote: rows.filter((row) => row.linkState.manualNoteExists).length,
    withRerunCommand: rows.filter((row) => row.rerunCommand).length,
    bySurface: by(rows, (row) => row.surface),
    byVerdict: by(rows, (row) => row.verdict),
    byDecision: by(rows, (row) => row.decision),
  };

  return {
    schema: "eliza_review_pack_agent_verdicts_v1",
    generatedAt: new Date().toISOString(),
    summary,
    rows,
  };
}

function renderHtml(payload) {
  const metrics = [
    ["Rows reviewed", `${fmt(payload.summary.reviewedRows)} / ${fmt(payload.summary.rowCount)}`],
    ["Accepted", fmt(payload.summary.acceptRows)],
    ["Accepted caveat", fmt(payload.summary.acceptCaveatRows)],
    ["Inspect", fmt(payload.summary.inspectRows)],
    ["Fix", fmt(payload.summary.fixRows)],
    ["Rerun", fmt(payload.summary.rerunRows)],
    ["Blocked", fmt(payload.summary.blockedRows)],
  ];
  const rows = payload.rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.decision)}<br><span>${escapeHtml(row.confidence)}</span></td>
      <td>${escapeHtml(row.verdict)}<br><span>${escapeHtml(row.surface)}</span></td>
      <td><strong>${escapeHtml(row.label)}</strong><br><code>${escapeHtml(row.id)}</code></td>
      <td>${escapeHtml(row.status)}<br><span>${escapeHtml(row.reviewClass)}</span></td>
      <td>${escapeHtml(row.reason)}<br><span>${escapeHtml(row.action)}</span></td>
      <td>${link(row.packHref, "pack")} ${link(row.playbackHref, "playback")} ${link(row.gapHref, "gap")} ${link(row.manualNoteHref, "note")}</td>
      <td>${row.rerunCommand ? `<code>${escapeHtml(row.rerunCommand)}</code>` : ""}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Review Pack Agent Verdicts</title>
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
    <h1>Review Pack Agent Verdicts</h1>
    <div class="sub">Agent verdicts for every benchmark, corpus, scenario, and live/e2e review pack row. Generated ${escapeHtml(payload.generatedAt)}.</div>
  </header>
  <main>
    <section class="metrics">
      ${metrics.map(([label, value]) => `<div class="metric"><strong>${escapeHtml(value)}</strong>${escapeHtml(label)}</div>`).join("")}
    </section>
    <table>
      <thead>
        <tr><th>Decision</th><th>Verdict</th><th>Target</th><th>Status</th><th>Reason / Action</th><th>Links</th><th>Rerun</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function writeOutputs(payload) {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(path.join(REPORT_DIR, "review-pack-agent-verdicts.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  writeFileSync(path.join(REPORT_DIR, "index.html"), renderHtml(payload), "utf8");
  writeFileSync(
    path.join(REPORT_DIR, "README.md"),
    `# Review Pack Agent Verdicts

Generated: ${payload.generatedAt}

- Rows reviewed: ${payload.summary.reviewedRows}/${payload.summary.rowCount}
- Accepted: ${payload.summary.acceptRows}
- Accepted with caveat: ${payload.summary.acceptCaveatRows}
- Inspect: ${payload.summary.inspectRows}
- Fix: ${payload.summary.fixRows}
- Rerun: ${payload.summary.rerunRows}
- Blocked: ${payload.summary.blockedRows}
`,
    "utf8",
  );
}

const payload = buildPayload();
writeOutputs(payload);
console.log(
  `[review-pack-agent-verdicts] ${payload.summary.reviewedRows}/${payload.summary.rowCount} rows reviewed`,
);
