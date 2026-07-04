/**
 * Tests the SOC2 verification orchestrator and critical-failure summary logic.
 */

import { describe, expect, it } from "vitest";
import { hasCriticalFailures, runVerification } from "../runners/run.js";

describe("runVerification orchestrator", () => {
  it("runs the dynamic-only subset end-to-end", async () => {
    const r = await runVerification({
      elizaRoot: process.cwd(),
      outerRoot: process.cwd(),
      include: ["roundtrip", "audit-dispatcher", "redaction"],
    });
    expect(r.overall.pass + r.overall.fail).toBeGreaterThan(0);
    expect(typeof r.overall.readiness_score).toBe("number");
    expect(typeof r.generated_at).toBe("string");
  });

  it("hasCriticalFailures handles empty report", () => {
    expect(
      hasCriticalFailures({
        generated_at: "x",
        branch: "x",
        commit: "x",
        controls: {},
        overall: { pass: 0, fail: 0, warn: 0, skip: 0, readiness_score: 0 },
      }),
    ).toBe(false);
  });

  it("hasCriticalFailures only flags failed critical checks", () => {
    expect(
      hasCriticalFailures({
        generated_at: "x",
        branch: "x",
        commit: "x",
        controls: {
          "CC1.1": {
            summary: { pass: 1, fail: 1, warn: 1, skip: 0 },
            checks: [
              {
                id: "critical-pass",
                title: "Critical pass",
                severity: "critical",
                status: "pass",
                evidence: "ok",
              },
              {
                id: "high-fail",
                title: "High fail",
                severity: "high",
                status: "fail",
                evidence: "not critical",
              },
            ],
          },
        },
        overall: { pass: 1, fail: 1, warn: 1, skip: 0, readiness_score: 0.5 },
      }),
    ).toBe(false);

    expect(
      hasCriticalFailures({
        generated_at: "x",
        branch: "x",
        commit: "x",
        controls: {
          "CC1.1": {
            summary: { pass: 0, fail: 1, warn: 0, skip: 0 },
            checks: [
              {
                id: "critical-fail",
                title: "Critical fail",
                severity: "critical",
                status: "fail",
                evidence: "bad",
              },
            ],
          },
        },
        overall: { pass: 0, fail: 1, warn: 0, skip: 0, readiness_score: 0 },
      }),
    ).toBe(true);
  });
});
