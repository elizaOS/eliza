#!/usr/bin/env node
// Rolls per-capture findings into a single markdown report.
//
// Usage:
//   node scripts/ai-qa/build-report.mjs --run-dir reports/ai-qa/<run-id>

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

function parseArgs(argv) {
  const out = { runDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--run-dir") {
      out.runDir = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function findLatestRunDir() {
  const root = join(REPO_ROOT, "reports", "ai-qa");
  if (!existsSync(root)) return null;
  const entries = await readdir(root);
  const dirs = [];
  for (const entry of entries) {
    const full = join(root, entry);
    const st = await stat(full).catch(() => null);
    if (st?.isDirectory()) dirs.push({ name: entry, full });
  }
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => (a.name < b.name ? 1 : -1));
  return dirs[0].full;
}

const SEVERITY_ORDER = ["P0", "P1", "P2", "P3"];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = args.runDir
    ? resolve(args.runDir)
    : await findLatestRunDir();
  if (!runDir || !existsSync(runDir)) {
    console.error("[ai-qa] no run dir; build-report skipped");
    process.exit(2);
  }
  const findingsDir = join(runDir, "findings");
  if (!existsSync(findingsDir)) {
    console.error("[ai-qa] no findings dir; run analyze.mjs first");
    process.exit(2);
  }
  const files = (await readdir(findingsDir)).filter((f) => f.endsWith(".json"));
  const records = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(findingsDir, file), "utf-8"));
      records.push(raw);
    } catch (error) {
      console.error(`[ai-qa] skip ${file}:`, error.message);
    }
  }

  // Index by severity → list of {finding, capture}
  const bySeverity = { P0: [], P1: [], P2: [], P3: [] };
  const byRoute = new Map();
  let failedAnalysis = 0;
  for (const record of records) {
    if (!record.analysisOk || !record.finding) {
      failedAnalysis += 1;
      continue;
    }
    const findings = record.finding.findings ?? [];
    const key = `${record.routeId}`;
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key).push(record);
    for (const f of findings) {
      const sev = SEVERITY_ORDER.includes(f.severity) ? f.severity : "P3";
      bySeverity[sev].push({ record, finding: f });
    }
  }

  const lines = [];
  lines.push(`# AI QA Report — ${runDir.split("/").pop()}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Run dir: \`${relative(REPO_ROOT, runDir)}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Captures analyzed: ${records.length - failedAnalysis}`);
  lines.push(`- Analysis failures: ${failedAnalysis}`);
  for (const sev of SEVERITY_ORDER) {
    lines.push(`- ${sev}: ${bySeverity[sev].length}`);
  }
  lines.push("");

  for (const sev of SEVERITY_ORDER) {
    if (bySeverity[sev].length === 0) continue;
    lines.push(`## ${sev} — ${bySeverity[sev].length} findings`);
    lines.push("");
    for (const { record, finding } of bySeverity[sev]) {
      lines.push(
        `### ${finding.title} — ${record.routeId} @ ${record.viewport} ${record.theme}`,
      );
      lines.push("");
      lines.push(`- Route: \`${record.routePath}\``);
      lines.push(`- Category: ${finding.category}`);
      lines.push(`- Detail: ${finding.detail}`);
      lines.push(`- Fix: ${finding.fix}`);
      if (record.screenshotRelPath) {
        lines.push(
          `- Screenshot: \`${join(relative(REPO_ROOT, runDir), record.screenshotRelPath)}\``,
        );
      }
      lines.push("");
    }
  }

  lines.push("## Per-route summary");
  lines.push("");
  const routeKeys = Array.from(byRoute.keys()).sort();
  for (const key of routeKeys) {
    const recs = byRoute.get(key);
    const totalFindings = recs.reduce(
      (sum, r) => sum + (r.finding?.findings?.length ?? 0),
      0,
    );
    lines.push(`- **${key}** — ${recs.length} captures, ${totalFindings} findings`);
  }
  lines.push("");

  const outPath = join(runDir, "report.md");
  await writeFile(outPath, lines.join("\n"));
  console.error(`[ai-qa] wrote ${outPath}`);
}

main().catch((error) => {
  console.error("[ai-qa] fatal:", error);
  process.exit(1);
});
