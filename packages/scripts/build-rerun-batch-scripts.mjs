#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "rerun-batches");

const BATCHES = [
  { id: "all-runnable", label: "All runnable commands", filter: () => true },
  { id: "benchmarks", label: "Code-agent benchmarks", filter: (row) => row.surface === "benchmark" },
  { id: "corpus", label: "Benchmark corpus families", filter: (row) => row.surface === "corpus" },
  { id: "scenarios", label: "Scenarios", filter: (row) => row.surface === "scenario" },
  { id: "live-e2e", label: "Live/e2e tests", filter: (row) => row.surface === "live/e2e" },
];

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

function scriptFor(batch, rows) {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    `# Generated ${new Date().toISOString()}`,
    `# Batch: ${batch.label}`,
    `# Commands: ${rows.length}`,
    "# Raw secret values are intentionally not embedded.",
    "",
    'cd "$(dirname "$0")/../../.."',
    "",
  ];
  for (const row of rows) {
    lines.push(`echo "[${row.surface}] ${row.id}"`);
    lines.push(row.command);
    lines.push("");
  }
  lines.push("bun run bench:analysis:build");
  lines.push("bun run bench:analysis:verify");
  lines.push("");
  return `${lines.join("\n")}`;
}

function buildPayload() {
  const catalog = readJson("reports/benchmark-analysis/rerun-command-catalog/rerun-command-catalog.json");
  const runnableRows = (catalog.rows || []).filter((row) => row.runnableNow);
  const blockedRows = (catalog.rows || []).filter((row) => !row.runnableNow);
  const batches = BATCHES.map((batch) => {
    const rows = runnableRows.filter(batch.filter);
    const fileName = `${batch.id}.sh`;
    return {
      id: batch.id,
      label: batch.label,
      fileName,
      href: fileName,
      commandCount: rows.length,
      surfaces: [...new Set(rows.map((row) => row.surface))],
      firstCommand: rows[0]?.command || "",
      lastCommand: rows.at(-1)?.command || "",
    };
  });
  return {
    schema: "eliza_rerun_batches_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      batchCount: batches.length,
      runnableCommands: runnableRows.length,
      blockedCommands: blockedRows.length,
      allRunnableCommands: batches.find((batch) => batch.id === "all-runnable")?.commandCount || 0,
      benchmarkCommands: batches.find((batch) => batch.id === "benchmarks")?.commandCount || 0,
      corpusCommands: batches.find((batch) => batch.id === "corpus")?.commandCount || 0,
      scenarioCommands: batches.find((batch) => batch.id === "scenarios")?.commandCount || 0,
      liveE2eCommands: batches.find((batch) => batch.id === "live-e2e")?.commandCount || 0,
    },
    batches,
    blockedRows: blockedRows.map((row) => ({
      surface: row.surface,
      id: row.id,
      blocker: row.blocker,
      command: row.command,
      followUp: row.followUp,
    })),
  };
}

function renderHtml(payload) {
  const metrics = [
    ["Batches", fmt(payload.summary.batchCount)],
    ["Runnable commands", fmt(payload.summary.runnableCommands)],
    ["Blocked commands", fmt(payload.summary.blockedCommands)],
    ["Scenario commands", fmt(payload.summary.scenarioCommands)],
    ["Live/e2e commands", fmt(payload.summary.liveE2eCommands)],
  ];
  const rows = payload.batches.map((batch) => `
    <tr>
      <td><a href="${escapeHtml(batch.href)}">${escapeHtml(batch.fileName)}</a></td>
      <td>${escapeHtml(batch.label)}</td>
      <td>${escapeHtml(batch.commandCount)}</td>
      <td>${escapeHtml(batch.surfaces.join(", "))}</td>
      <td><code>${escapeHtml(batch.firstCommand)}</code></td>
    </tr>`).join("");
  const blocked = payload.blockedRows.map((row) => `
    <tr>
      <td>${escapeHtml(row.surface)}</td>
      <td><code>${escapeHtml(row.id)}</code></td>
      <td>${escapeHtml(row.blocker)}</td>
      <td><code>${escapeHtml(row.command)}</code></td>
      <td>${escapeHtml(row.followUp)}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rerun Batches</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:18px 20px 32px; }
    h1 { margin:0 0 6px; font-size:24px; letter-spacing:0; }
    .sub { color:#556052; }
    .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:16px 0; }
    .metric { background:#fff; border:1px solid #d7ded1; border-radius:8px; padding:12px; }
    .metric strong { display:block; font-size:22px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d7ded1; margin-bottom:18px; }
    th, td { border-bottom:1px solid #e2e7de; padding:8px; text-align:left; vertical-align:top; }
    th { background:#eef2ea; }
    code { font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-word; }
    a { color:#245b3d; font-weight:600; }
  </style>
</head>
<body>
  <header>
    <h1>Rerun Batches</h1>
    <div class="sub">Executable batches generated from the rerun command catalog. Generated ${escapeHtml(payload.generatedAt)}.</div>
  </header>
  <main>
    <section class="metrics">
      ${metrics.map(([label, value]) => `<div class="metric"><strong>${escapeHtml(value)}</strong>${escapeHtml(label)}</div>`).join("")}
    </section>
    <h2>Runnable Batches</h2>
    <table>
      <thead><tr><th>Script</th><th>Batch</th><th>Commands</th><th>Surfaces</th><th>First command</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h2>Blocked Commands</h2>
    <table>
      <thead><tr><th>Surface</th><th>Target</th><th>Blocker</th><th>Command</th><th>Follow-up</th></tr></thead>
      <tbody>${blocked}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function writeOutputs(payload) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const catalog = readJson("reports/benchmark-analysis/rerun-command-catalog/rerun-command-catalog.json");
  const runnableRows = (catalog.rows || []).filter((row) => row.runnableNow);
  for (const batch of payload.batches) {
    const spec = BATCHES.find((candidate) => candidate.id === batch.id);
    const rows = runnableRows.filter(spec.filter);
    const scriptPath = path.join(REPORT_DIR, batch.fileName);
    writeFileSync(scriptPath, scriptFor(batch, rows), "utf8");
    chmodSync(scriptPath, 0o755);
  }
  writeFileSync(path.join(REPORT_DIR, "rerun-batches.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  writeFileSync(path.join(REPORT_DIR, "index.html"), renderHtml(payload), "utf8");
  writeFileSync(
    path.join(REPORT_DIR, "README.md"),
    `# Rerun Batches

Generated: ${payload.generatedAt}

- Batch scripts: ${payload.summary.batchCount}
- Runnable commands: ${payload.summary.runnableCommands}
- Blocked commands excluded from runnable scripts: ${payload.summary.blockedCommands}
- All-runnable commands: ${payload.summary.allRunnableCommands}
- Benchmark commands: ${payload.summary.benchmarkCommands}
- Corpus commands: ${payload.summary.corpusCommands}
- Scenario commands: ${payload.summary.scenarioCommands}
- Live/e2e commands: ${payload.summary.liveE2eCommands}

Run a batch from the repository root, for example:

\`\`\`bash
reports/benchmark-analysis/rerun-batches/scenarios.sh
\`\`\`
`,
    "utf8",
  );
}

const payload = buildPayload();
writeOutputs(payload);
console.log(
  `[rerun-batches] ${payload.summary.batchCount} batches, ${payload.summary.runnableCommands} runnable commands`,
);
