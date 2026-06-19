#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "manual-review");
const NOTES_DIR = path.join(REPORT_DIR, "items");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

function rel(target, from = REPORT_DIR) {
  return path.relative(from, path.join(REPO_ROOT, target)).replaceAll(path.sep, "/");
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
  return String(value || "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

function verdictFromText(text) {
  const match = String(text || "").match(/^verdict:\s*(\S+)/m);
  return match ? match[1] : "unreviewed";
}

function frontmatterValue(text, key) {
  const match = String(text || "").match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return "";
  const raw = match[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function existingNotesByKey() {
  if (!existsSync(NOTES_DIR)) return new Map();
  const byKey = new Map();
  for (const filename of readdirSync(NOTES_DIR)) {
    if (!filename.endsWith(".md")) continue;
    const notePath = path.join(NOTES_DIR, filename);
    const text = readFileSync(notePath, "utf8");
    const kind = frontmatterValue(text, "kind");
    const id = frontmatterValue(text, "id");
    if (!kind || !id) continue;
    const key = `${kind}:${id}`;
    const entry = {
      filename,
      verdict: verdictFromText(text),
      text,
    };
    const existing = byKey.get(key);
    if (!existing || (existing.verdict === "unreviewed" && entry.verdict !== "unreviewed")) {
      byKey.set(key, entry);
    }
  }
  return byKey;
}

function agentTriage(item) {
  const disposition = String(item.disposition || "");
  const kind = String(item.kind || "");
  const id = String(item.id || "");
  const reasons = (item.reasons || []).join(" ");
  const summary = item.summary || "";
  if (id === "hyperliquid_bench") {
    return {
      agentVerdict: "blocked-external-credential",
      recommendedAction:
        "Provide HL_PRIVATE_KEY, rerun hyperliquid_bench through the benchmark matrix, and regenerate the corpus review.",
      agentEvidence:
        "No latest rows, normalized calls, or trajectory-like artifacts exist for this benchmark family without the private key.",
    };
  }
  if (id === "osworld-live") {
    return {
      agentVerdict: "blocked-external-runtime",
      recommendedAction:
        "Configure a runnable OSWorld provider, rerun live scored OSWorld with five tasks, and regenerate the benchmark reports.",
      agentEvidence:
        "The readiness probe currently reports no runnable Docker, VMware, VirtualBox, AWS, or explicit OSWorld provider.",
    };
  }
  if (kind === "goal" && disposition === "caveated") {
    return {
      agentVerdict: "accepted-caveat-with-rerun-gate",
      recommendedAction:
        "Keep the caveat visible in the audit, then replace it with fresh evidence once the blocker or rerun prerequisite is removed.",
      agentEvidence: reasons || summary,
    };
  }
  if (kind === "benchmark-family") {
    return {
      agentVerdict: disposition === "needs-review" ? "needs-corpus-family-review" : disposition,
      recommendedAction:
        disposition === "needs-review"
          ? "Open the linked corpus family page or playback, inspect warnings/calls/outputs, and decide whether the benchmark needs a rerun, publication fix, or accepted limitation."
          : "Open the linked target and confirm whether the corpus disposition remains accurate.",
      agentEvidence: reasons || summary,
    };
  }
  if (kind === "code-agent-benchmark") {
    return {
      agentVerdict:
        disposition === "weak-output" || disposition === "inferior"
          ? "needs-output-quality-review"
          : disposition === "missing-live"
            ? "blocked-live-runtime"
            : "needs-code-agent-review",
      recommendedAction:
        "Open the trajectory playback, compare target and baseline behavior, and decide whether the agent output, benchmark harness, or live runtime needs work.",
      agentEvidence: reasons || summary,
    };
  }
  if (kind === "live-test") {
    return {
      agentVerdict:
        disposition === "model-wrapper-failed"
          ? "needs-live-test-fix"
          : disposition === "model-artifact-hint"
            ? "model-artifact-evidence-present"
            : disposition,
      recommendedAction:
        disposition === "model-wrapper-failed"
          ? "Open the wrapped playback/report, fix the failing environment, fixture, or assertion, then rerun through the live-test artifact wrapper."
          : "Open the linked model-script or playback target and confirm the artifact classification.",
      agentEvidence: reasons || summary,
    };
  }
  if (kind === "scenario-failure-category") {
    return {
      agentVerdict: "needs-scenario-category-fix",
      recommendedAction:
        "Use the category page to fix the shared runner, fixture, connector, or product behavior before re-running affected scenarios.",
      agentEvidence: reasons || summary,
    };
  }
  if (kind === "scenario") {
    return {
      agentVerdict:
        disposition === "failed-only" || disposition === "non-passing"
          ? "needs-scenario-playback-review"
          : disposition,
      recommendedAction:
        "Open the scenario playback, inspect the failing step and expected assertions, then route to fixture, runner, connector, or product behavior work.",
      agentEvidence: reasons || summary,
    };
  }
  return {
    agentVerdict: disposition || "needs-review",
    recommendedAction: "Open the linked target and record a manual decision.",
    agentEvidence: reasons || summary,
  };
}

function agentSection(triage) {
  return [
    "Agent triage:",
    "",
    `- Agent verdict: ${triage.agentVerdict}`,
    `- Recommended action: ${triage.recommendedAction}`,
    `- Agent evidence: ${triage.agentEvidence}`,
    "",
  ].join("\n");
}

function ensureAgentSection(text, triage) {
  if (
    /Agent triage:/.test(text) &&
    /Agent verdict:/.test(text) &&
    /Recommended action:/.test(text) &&
    /Agent evidence:/.test(text)
  ) {
    return text;
  }
  const section = agentSection(triage);
  if (/Manual notes:/.test(text)) {
    return text.replace(/\nManual notes:/, `\n${section}Manual notes:`);
  }
  return `${text.trimEnd()}\n\n${section}Manual notes:\n\n- \n`;
}

function noteTemplate(item, viewerHref, triage) {
  return [
    "---",
    `kind: ${item.kind}`,
    `id: ${JSON.stringify(item.id)}`,
    `disposition: ${item.disposition}`,
    `priority: ${item.priority}`,
    "verdict: unreviewed",
    "---",
    "",
    `# ${item.kind}: ${item.id}`,
    "",
    `Target: [open viewer](${viewerHref})`,
    "",
    `Current disposition: \`${item.disposition}\``,
    "",
    `Summary: ${item.summary || ""}`,
    "",
    "Reasons:",
    ...(item.reasons || []).map((reason) => `- ${reason}`),
    "",
    agentSection(triage).trimEnd(),
    "",
    "Manual notes:",
    "",
    "- ",
    "",
    "Decision:",
    "",
    "- Keep / fix / rerun / accepted caveat:",
    "- Follow-up owner:",
    "- Follow-up command or artifact:",
    "",
  ].join("\n");
}

function buildPayload() {
  const queue = readJson("reports/benchmark-analysis/review-queue/review-queue.json");
  mkdirSync(NOTES_DIR, { recursive: true });
  const reusableNotes = existingNotesByKey();
  const used = new Set();
  const items = (queue.items || []).map((item, index) => {
    let base = `${String(index + 1).padStart(4, "0")}-${slug(item.kind)}-${slug(item.id)}`;
    if (!base || base === `${String(index + 1).padStart(4, "0")}-`) {
      base = `${String(index + 1).padStart(4, "0")}-review-item`;
    }
    let filename = `${base}.md`;
    let dedupe = 2;
    const reusable = reusableNotes.get(`${item.kind}:${item.id}`);
    if (reusable && !used.has(reusable.filename)) {
      filename = reusable.filename;
    }
    while (used.has(filename)) {
      filename = `${base}-${dedupe}.md`;
      dedupe += 1;
    }
    used.add(filename);
    const notePath = path.join(NOTES_DIR, filename);
    const viewerHref = item.viewer || "";
    const triage = agentTriage(item);
    if (!existsSync(notePath)) {
      writeFileSync(notePath, noteTemplate(item, viewerHref, triage), "utf8");
    } else {
      const existingText = readFileSync(notePath, "utf8");
      const updatedText = ensureAgentSection(existingText, triage);
      if (updatedText !== existingText) {
        writeFileSync(notePath, updatedText, "utf8");
      }
    }
    const noteText = readFileSync(notePath, "utf8");
    return {
      ...item,
      ...triage,
      noteHref: `items/${filename}`,
      viewerHref,
      verdict: verdictFromText(noteText),
      noteBytes: Buffer.byteLength(noteText),
    };
  });
  const summary = {
    itemCount: items.length,
    noteCount: items.filter((item) => item.noteHref).length,
    unreviewed: items.filter((item) => item.verdict === "unreviewed").length,
    reviewed: items.filter((item) => item.verdict !== "unreviewed").length,
    agentReviewed: items.filter((item) => item.agentVerdict).length,
    highPriorityAgentReviewed: items.filter(
      (item) => Number(item.priority) >= 80 && item.agentVerdict,
    ).length,
    highPriority: items.filter((item) => Number(item.priority) >= 80).length,
    highPriorityUnreviewed: items.filter(
      (item) => Number(item.priority) >= 80 && item.verdict === "unreviewed",
    ).length,
    byAgentVerdict: items.reduce((acc, item) => {
      acc[item.agentVerdict] = (acc[item.agentVerdict] || 0) + 1;
      return acc;
    }, {}),
    byKind: queue.summary?.byKind || {},
    byDisposition: queue.summary?.byDisposition || {},
  };
  return {
    schema: "eliza_benchmark_manual_review_workspace_v1",
    generatedAt: new Date().toISOString(),
    summary,
    items,
  };
}

function html(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Manual Review Workspace</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:11px; }
    .card b { display:block; margin-top:4px; font-size:21px; }
    .panel { overflow:hidden; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f8faf5; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
  </style>
</head>
<body>
  <header><h1>Benchmark Manual Review Workspace</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <div class="cards">
      <div class="card"><span class="muted">Review items</span><b>${escapeHtml(payload.summary.itemCount)}</b><span>queue-backed notes</span></div>
      <div class="card"><span class="muted">High priority</span><b>${escapeHtml(payload.summary.highPriority)}</b><span>${escapeHtml(payload.summary.highPriorityUnreviewed)} unreviewed</span></div>
      <div class="card"><span class="muted">Agent triage</span><b>${escapeHtml(payload.summary.agentReviewed)}</b><span>${escapeHtml(payload.summary.highPriorityAgentReviewed)} high priority</span></div>
      <div class="card"><span class="muted">Reviewed</span><b>${escapeHtml(payload.summary.reviewed)}</b><span>${escapeHtml(payload.summary.unreviewed)} unreviewed</span></div>
      <div class="card"><span class="muted">Note files</span><b>${escapeHtml(payload.summary.noteCount)}</b><span>preserved across rebuilds</span></div>
    </div>
    <section class="panel"><div class="body">
      <p>Each row has a generated Markdown note under <code>reports/benchmark-analysis/manual-review/items/</code>. Rebuilds create missing notes but do not overwrite existing note files, so manual verdicts and notes are preserved.</p>
      <p><a href="../review-queue/index.html">Open review queue</a> · <a href="../index.html">Open hub</a></p>
    </div></section>
    <section class="panel"><div class="body"><table><thead><tr><th>priority</th><th>kind</th><th>id</th><th>disposition</th><th>manual verdict</th><th>agent triage</th><th>action</th><th>note</th><th>target</th></tr></thead><tbody>${payload.items
      .map((item) => `<tr><td>${escapeHtml(item.priority)}</td><td>${escapeHtml(item.kind)}</td><td><code>${escapeHtml(item.id)}</code></td><td>${escapeHtml(item.disposition)}</td><td class="${item.verdict === "unreviewed" ? "warn" : ""}">${escapeHtml(item.verdict)}</td><td>${escapeHtml(item.agentVerdict)}</td><td>${escapeHtml(item.recommendedAction)}</td><td><a href="${escapeHtml(item.noteHref)}">note</a></td><td><a href="${escapeHtml(item.viewerHref)}">target</a></td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Benchmark Manual Review Workspace",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Review items: ${payload.summary.itemCount}`,
    `- Note files: ${payload.summary.noteCount}`,
    `- Agent-triaged items: ${payload.summary.agentReviewed}`,
    `- High-priority unreviewed: ${payload.summary.highPriorityUnreviewed}/${payload.summary.highPriority}`,
    `- High-priority agent-triaged: ${payload.summary.highPriorityAgentReviewed}/${payload.summary.highPriority}`,
    "",
    "Generated note files are created only when missing. Existing manual notes are preserved across rebuilds.",
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "manual-review.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `benchmark manual review workspace ${payload.summary.noteCount} notes at ${path.join(REPORT_DIR, "index.html")}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
