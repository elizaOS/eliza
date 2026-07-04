#!/usr/bin/env bun
/**
 * E2E coverage matrix report CLI (issue #8802).
 *
 * Builds the canonical coverage matrix (slash commands, #8791 shortcuts, plugin
 * routes, views) from real source, writes `reports/coverage/e2e-matrix.json` +
 * a self-contained HTML contact sheet + a markdown summary, prints a one-line
 * status, and exits non-zero on a blocking gap when enforcement is on.
 *
 * Advisory-then-required (mirrors `.github/workflows/coverage-gate.yml`):
 *   - default: report only, exit 0 (advisory).
 *   - `--fail-on-missing` or `E2E_COVERAGE_GATE_ENFORCE=1`: exit 1 on a blocking
 *     gap (required).
 *
 * Usage:
 *   bun packages/scripts/e2e-coverage/write-coverage-matrix-report.ts [--report-dir <dir>] [--json]
 *       [--fail-on-missing]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildCoverageMatrix,
  type CoverageMatrix,
  REPO_ROOT,
} from "./inventory.ts";

interface CliOptions {
  reportDir: string;
  json: boolean;
  failOnMissing: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    reportDir: path.join(REPO_ROOT, "reports/coverage"),
    json: false,
    failOnMissing:
      process.env.E2E_COVERAGE_GATE_ENFORCE === "1" ||
      process.env.E2E_COVERAGE_GATE_ENFORCE === "true",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report-dir") {
      options.reportDir = path.resolve(argv[++i] ?? options.reportDir);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fail-on-missing") {
      options.failOnMissing = true;
    } else if (arg === "--no-fail") {
      options.failOnMissing = false;
    }
  }
  return options;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderViewerHtml(): string {
  // A self-contained contact sheet that reads window.E2E_COVERAGE_DATA from the
  // sibling matrix-data.js, mirroring the scenario-catalog viewer shape.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>elizaOS e2e coverage matrix</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #0b0b0d; color: #e9e9ec; }
  header { padding: 20px 24px; border-bottom: 1px solid #222; position: sticky; top: 0; background: #0b0b0d; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
  .card { border: 1px solid #222; border-radius: 8px; padding: 10px 14px; min-width: 120px; }
  .card .n { font-size: 22px; font-weight: 700; }
  .card .l { font-size: 12px; color: #9a9aa2; }
  main { padding: 16px 24px 64px; }
  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  input, select { background: #141417; color: inherit; border: 1px solid #2a2a2e; border-radius: 6px; padding: 6px 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1c1c20; vertical-align: top; }
  th { color: #9a9aa2; font-weight: 600; position: sticky; top: 0; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .covered { background: #11331f; color: #5fe39a; }
  .exempt { background: #2c2a13; color: #e6d36a; }
  .missing { background: #3a1414; color: #ff8585; }
  .kind { color: #9a9aa2; font-size: 12px; }
  code { background: #141417; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>elizaOS e2e coverage matrix <span class="kind">— issue #8802</span></h1>
  <div class="kind" id="meta"></div>
  <div class="cards" id="cards"></div>
</header>
<main>
  <div class="controls">
    <input id="q" type="search" placeholder="filter by id / detail…" />
    <select id="kind"><option value="">all kinds</option></select>
    <select id="status">
      <option value="">all statuses</option>
      <option value="covered">covered</option>
      <option value="exempt">exempt</option>
      <option value="missing">missing</option>
    </select>
  </div>
  <table>
    <thead><tr><th>Surface</th><th>Kind</th><th>Status</th><th>Detail</th><th>Artifacts</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</main>
<script src="./matrix-data.js"></script>
<script>
  const data = window.E2E_COVERAGE_DATA || { items: [], summary: {} };
  const s = data.summary || {};
  document.getElementById('meta').textContent =
    'generated ' + (data.generatedAt || '') + ' · schema ' + (data.schema || '');
  const cardDefs = [
    ['commands', (s.commands||{}).covered + '/' + (s.commands||{}).total],
    ['plugin routes', (s.pluginRoutes||{}).covered + '/' + (s.pluginRoutes||{}).total + ' (+' + (s.pluginRoutes||{}).exempt + ' exempt)'],
    ['shortcuts', (s.shortcuts||{}).gated ? 'gated on #8791' : ((s.shortcuts||{}).covered + '/' + (s.shortcuts||{}).total)],
    ['view gates', (s.views||{}).gates],
    ['blocking gaps', s.blockingGaps],
    ['advisory gaps', s.advisoryGaps],
  ];
  document.getElementById('cards').innerHTML = cardDefs
    .map(([l, n]) => '<div class="card"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>')
    .join('');
  const kinds = [...new Set((data.items||[]).map(i => i.kind))];
  const ksel = document.getElementById('kind');
  for (const k of kinds) { const o = document.createElement('option'); o.value = k; o.textContent = k; ksel.appendChild(o); }
  function render() {
    const q = document.getElementById('q').value.toLowerCase();
    const kf = ksel.value, sf = document.getElementById('status').value;
    const rows = (data.items||[]).filter(i =>
      (!kf || i.kind === kf) && (!sf || i.status === sf) &&
      (!q || (i.id + ' ' + i.detail).toLowerCase().includes(q)))
      .map(i => '<tr><td><code>' + i.id + '</code></td><td class="kind">' + i.kind +
        '</td><td><span class="pill ' + i.status + '">' + i.status + '</span></td><td>' +
        i.detail + '</td><td class="kind">' + (i.artifacts||[]).join('<br>') + '</td></tr>').join('');
    document.getElementById('rows').innerHTML = rows;
  }
  for (const id of ['q','kind','status']) document.getElementById(id).addEventListener('input', render);
  render();
</script>
</body>
</html>
`;
}

function renderMarkdown(matrix: CoverageMatrix): string {
  const s = matrix.summary;
  const lines: string[] = [];
  lines.push("# e2e coverage matrix (issue #8802)");
  lines.push("");
  lines.push(`Generated: ${matrix.generatedAt}`);
  lines.push("");
  lines.push(`- Commands: ${s.commands.covered}/${s.commands.total} covered`);
  lines.push(
    `- Plugin routes: ${s.pluginRoutes.covered}/${s.pluginRoutes.total} covered (+${s.pluginRoutes.exempt} exempt)`,
  );
  lines.push(
    `- Shortcuts: ${s.shortcuts.gated ? "gated on #8791 (advisory)" : `${s.shortcuts.covered}/${s.shortcuts.total}`}`,
  );
  lines.push(`- View gates: ${s.views.gates}`);
  lines.push(
    `- Blocking gaps: ${s.blockingGaps} · Advisory gaps: ${s.advisoryGaps}`,
  );
  lines.push("");
  if (matrix.blockingGaps.length > 0) {
    lines.push("## Blocking gaps");
    for (const gap of matrix.blockingGaps) {
      lines.push(`- \`${gap.id}\` — ${gap.detail}`);
    }
    lines.push("");
  }
  if (matrix.advisoryGaps.length > 0) {
    lines.push("## Advisory gaps");
    for (const gap of matrix.advisoryGaps) {
      lines.push(`- \`${gap.id}\` — ${gap.detail}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const matrix = buildCoverageMatrix({
    generatedAt: new Date().toISOString(),
  });

  mkdirSync(options.reportDir, { recursive: true });
  writeFileSync(
    path.join(options.reportDir, "e2e-matrix.json"),
    `${JSON.stringify(matrix, null, 2)}\n`,
  );
  const viewerDir = path.join(options.reportDir, "viewer");
  mkdirSync(viewerDir, { recursive: true });
  writeFileSync(path.join(viewerDir, "index.html"), renderViewerHtml());
  writeFileSync(
    path.join(viewerDir, "matrix-data.js"),
    `window.E2E_COVERAGE_DATA = ${JSON.stringify(matrix)};\n`,
  );
  writeFileSync(
    path.join(options.reportDir, "README.md"),
    renderMarkdown(matrix),
  );

  const s = matrix.summary;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
  } else {
    process.stdout.write(
      `e2e coverage — commands ${s.commands.covered}/${s.commands.total}; ` +
        `routes ${s.pluginRoutes.covered}/${s.pluginRoutes.total} (+${s.pluginRoutes.exempt} exempt); ` +
        `blocking gaps ${s.blockingGaps}; advisory ${s.advisoryGaps}\n`,
    );
    for (const gap of matrix.blockingGaps) {
      process.stdout.write(`  BLOCKING ${gap.id}: ${escapeHtml(gap.detail)}\n`);
    }
  }

  if (options.failOnMissing && matrix.blockingGaps.length > 0) {
    process.stderr.write(
      `\n${matrix.blockingGaps.length} blocking e2e coverage gap(s); see ${path.relative(REPO_ROOT, options.reportDir)}/README.md\n`,
    );
    return 1;
  }
  return 0;
}

process.exit(main());
