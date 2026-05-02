import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAggregate, writeReportBundle } from "../reporter.ts";
import type { ScenarioReport } from "../types.ts";

function createScenarioReport(
  id: string,
  status: ScenarioReport["status"],
): ScenarioReport {
  return {
    id,
    title: id,
    domain: "test",
    tags: [],
    status,
    durationMs: 100,
    turns: [],
    finalChecks: [],
    actionsCalled: [],
    failedAssertions: [],
    providerName: "test-provider",
  };
}

describe("reporter", () => {
  it("writes a matrix report plus per-scenario reports", () => {
    const reportDir = mkdtempSync(path.join(os.tmpdir(), "scenario-report-"));
    const report = buildAggregate(
      [
        createScenarioReport("browser.keep", "passed"),
        createScenarioReport("messaging.fail", "failed"),
      ],
      "test-provider",
      "2026-04-17T00:00:00.000Z",
      "2026-04-17T00:01:00.000Z",
      "test-run",
    );

    writeReportBundle(report, reportDir);

    const entries = readdirSync(reportDir).sort();
    expect(entries).toContain("matrix.json");
    expect(entries).toContain("001-browser.keep.json");
    expect(entries).toContain("002-messaging.fail.json");

    const matrix = JSON.parse(
      readFileSync(path.join(reportDir, "matrix.json"), "utf8"),
    ) as ReturnType<typeof buildAggregate>;
    expect(matrix.passedCount).toBe(1);
    expect(matrix.failedCount).toBe(1);
    expect(matrix.skippedCount).toBe(0);
  });
});
