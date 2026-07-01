import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  defaultOutDir,
  renderMarkdown,
  writeReport,
} from "../evidence/report.js";
import type { EvidenceReport } from "../types.js";

describe("evidence report rendering", () => {
  it("renders empty reports with metadata, zero counts, and no control sections", () => {
    const r: EvidenceReport = {
      generated_at: "2026-05-21T00:00:00Z",
      branch: "test",
      commit: "abcd",
      controls: {},
      overall: { pass: 0, fail: 0, warn: 0, skip: 0, readiness_score: 0 },
    };
    const md = renderMarkdown(r);
    expect(md).toContain("# SOC2 Evidence Report");
    expect(md).toContain("- Generated: `2026-05-21T00:00:00Z`");
    expect(md).toContain("- Branch: `test`");
    expect(md).toContain("- Commit: `abcd`");
    expect(md).toContain("| 0 | 0 | 0 | 0 | 0.0% |");
    expect(md).toContain(
      "Readiness score = pass / (pass + fail), excluding warn/skip.",
    );
    expect(md).not.toMatch(/^## CC/m);
  });

  it("renders populated control sections sorted by TSC with escaped evidence", () => {
    const longEvidence = `${"x".repeat(410)}|pipe`;
    const r: EvidenceReport = {
      generated_at: "2026-05-21T00:00:00Z",
      branch: "test",
      commit: "abcd",
      controls: {
        "CC9.1": {
          checks: [
            {
              id: "CC9.1-security-md",
              title: "Security policy exists",
              severity: "medium",
              status: "warn",
              evidence: "missing optional review date",
            },
          ],
          summary: { pass: 0, fail: 0, warn: 1, skip: 0 },
        },
        "CC6.1": {
          checks: [
            {
              id: "CC6.1-codeowners-present",
              title: "CODEOWNERS exists",
              severity: "high",
              status: "pass",
              evidence: `line one\nline two | ${longEvidence}`,
            },
          ],
          summary: { pass: 1, fail: 0, warn: 0, skip: 0 },
        },
      },
      overall: { pass: 1, fail: 0, warn: 1, skip: 0, readiness_score: 1 },
    };
    const md = renderMarkdown(r);
    expect(md).toContain("| 1 | 0 | 1 | 0 | 100.0% |");
    expect(md.indexOf("## CC6.1")).toBeLessThan(md.indexOf("## CC9.1"));
    expect(md).toContain("Summary — pass: 1 · fail: 0 · warn: 0 · skip: 0");
    expect(md).toContain(
      "| PASS | high | **CC6.1-codeowners-present** — CODEOWNERS exists |",
    );
    expect(md).toContain("line one line two \\| ");
    expect(md).not.toContain("|pipe");
    expect(md).toContain(
      "| WARN | medium | **CC9.1-security-md** — Security policy exists | missing optional review date |",
    );
  });

  it("fuzzes evidence text so markdown table rows stay single-line and pipe-safe", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1_000 }), (evidence) => {
        const md = renderMarkdown({
          generated_at: "2026-05-21T00:00:00Z",
          branch: "test",
          commit: "abcd",
          controls: {
            "CC6.1": {
              checks: [
                {
                  id: "CC6.1-hostile-evidence",
                  title: "Hostile evidence text",
                  severity: "high",
                  status: "fail",
                  evidence,
                },
              ],
              summary: { pass: 0, fail: 1, warn: 0, skip: 0 },
            },
          },
          overall: {
            pass: 0,
            fail: 1,
            warn: 0,
            skip: 0,
            readiness_score: 0,
          },
        });

        const row = md
          .split("\n")
          .find((line) => line.includes("CC6.1-hostile-evidence"));
        expect(row).toBeDefined();
        expect(row).not.toMatch(/\r|\n/);
        expect(row?.match(/(?<!\\)\|/g)).toHaveLength(5);
        expect(row?.length).toBeLessThanOrEqual(520);
      }),
      { numRuns: 300 },
    );
  });

  it("writes matching JSON and markdown evidence files", () => {
    const outDir = mkdtempSync(join(tmpdir(), "soc2-report-"));
    const report: EvidenceReport = {
      generated_at: "2026-05-21T00:00:00Z",
      branch: "test",
      commit: "abcd",
      controls: {},
      overall: { pass: 1, fail: 0, warn: 0, skip: 0, readiness_score: 1 },
    };

    const paths = writeReport(report, { outDir });

    expect(basename(paths.jsonPath)).toBe("evidence-report.json");
    expect(basename(paths.mdPath)).toBe("evidence-report.md");
    expect(JSON.parse(readFileSync(paths.jsonPath, "utf8"))).toEqual(report);
    expect(readFileSync(paths.mdPath, "utf8")).toBe(renderMarkdown(report));

    rmSync(outDir, { recursive: true, force: true });
  });

  it("creates timestamped default output directories under the requested base", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "soc2-default-out-"));

    const outDir = defaultOutDir(baseDir);

    expect(dirname(outDir)).toBe(baseDir);
    expect(existsSync(baseDir)).toBe(true);
    expect(basename(outDir)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
    );

    rmSync(baseDir, { recursive: true, force: true });
  });
});
