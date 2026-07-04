/**
 * SOC2 evidence report rendering and persistence for auditor-readable artifacts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvidenceReport } from "../types.js";

const STATUS_SYMBOL: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  warn: "WARN",
  skip: "SKIP",
};

export function renderMarkdown(report: EvidenceReport): string {
  const lines: string[] = [];
  lines.push("# SOC2 Evidence Report");
  lines.push("");
  lines.push(`- Generated: \`${report.generated_at}\``);
  lines.push(`- Branch: \`${report.branch}\``);
  lines.push(`- Commit: \`${report.commit}\``);
  lines.push("");
  lines.push("## Overall");
  lines.push("");
  lines.push(`| Pass | Fail | Warn | Skip | Readiness Score |`);
  lines.push(`| ---: | ---: | ---: | ---: | ---: |`);
  lines.push(
    `| ${report.overall.pass} | ${report.overall.fail} | ${report.overall.warn} | ${report.overall.skip} | ${(report.overall.readiness_score * 100).toFixed(1)}% |`,
  );
  lines.push("");
  lines.push("Readiness score = pass / (pass + fail), excluding warn/skip.");
  lines.push("");

  const tscIds = Object.keys(report.controls).sort();
  for (const tsc of tscIds) {
    const block = report.controls[tsc]!;
    lines.push(`## ${tsc}`);
    lines.push("");
    lines.push(
      `Summary — pass: ${block.summary.pass} · fail: ${block.summary.fail} · warn: ${block.summary.warn} · skip: ${block.summary.skip}`,
    );
    lines.push("");
    lines.push(`| Status | Severity | Check | Evidence |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const c of block.checks) {
      const ev = c.evidence
        .replace(/(?:\r\n|\r|\n)+/g, " ")
        .replace(/\|/g, "\\|")
        .slice(0, 400);
      lines.push(
        `| ${STATUS_SYMBOL[c.status] ?? c.status} | ${c.severity} | **${c.id}** — ${c.title} | ${ev} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export interface WriteOptions {
  outDir: string;
}

export function writeReport(
  report: EvidenceReport,
  opts: WriteOptions,
): { jsonPath: string; mdPath: string } {
  mkdirSync(opts.outDir, { recursive: true });
  const jsonPath = join(opts.outDir, "evidence-report.json");
  const mdPath = join(opts.outDir, "evidence-report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");
  return { jsonPath, mdPath };
}

/** Helper used by the CLI for the default --out=./.soc2-evidence/<timestamp>/ behavior. */
export function defaultOutDir(baseDir: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(baseDir, ts);
  mkdirSync(dirname(dir), { recursive: true });
  return dir;
}
