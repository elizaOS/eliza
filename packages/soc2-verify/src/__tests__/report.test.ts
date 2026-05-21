import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../evidence/report.js";
import type { EvidenceReport } from "../types.js";

describe("evidence report rendering", () => {
  it("renders an empty report without throwing", () => {
    const r: EvidenceReport = {
      generated_at: "2026-05-21T00:00:00Z",
      branch: "test",
      commit: "abcd",
      controls: {},
      overall: { pass: 0, fail: 0, warn: 0, skip: 0, readiness_score: 0 },
    };
    const md = renderMarkdown(r);
    expect(md).toContain("SOC2 Evidence Report");
    expect(md).toContain("Readiness");
  });

  it("renders a populated report with control sections", () => {
    const r: EvidenceReport = {
      generated_at: "2026-05-21T00:00:00Z",
      branch: "test",
      commit: "abcd",
      controls: {
        "CC6.1": {
          checks: [
            {
              id: "CC6.1-codeowners-present",
              title: "CODEOWNERS exists",
              severity: "high",
              status: "pass",
              evidence: "fine",
            },
          ],
          summary: { pass: 1, fail: 0, warn: 0, skip: 0 },
        },
      },
      overall: { pass: 1, fail: 0, warn: 0, skip: 0, readiness_score: 1 },
    };
    const md = renderMarkdown(r);
    expect(md).toContain("CC6.1");
    expect(md).toContain("CODEOWNERS exists");
    expect(md).toContain("100.0%");
  });
});
