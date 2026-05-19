import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSpeculativeBenchmarkReport,
  latestSpeculativeReportPath,
  writeSpeculativeBenchmarkReport,
} from "./speculative_benchmark_report.mjs";

test("builds the shared speculative report shape for each speculator", () => {
  for (const speculator of ["dflash", "eagle3", "mtp"]) {
    const report = buildSpeculativeBenchmarkReport({
      speculator,
      verifier: "unit",
      tier: "0_8b",
      specBinary: "/tmp/missing-spec-binary",
      withDrafter: { drafted: 4, accepted: 3, tokensPerSecond: 12 },
      withoutDrafter: { tokensPerSecond: 6 },
    });

    assert.equal(report.reportSchema, "eliza.speculative-benchmark.v1");
    assert.equal(report.speculator, speculator);
    assert.equal(report.acceptanceRate, 0.75);
    assert.equal(report.speedup, 2);
    assert.equal(report.summary.speculator, speculator);
  }
});

test("writes timestamped and latest report files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-report-"));
  const verifyDir = path.join(root, "verify");
  const reportPath = path.join(root, "report.json");
  const report = buildSpeculativeBenchmarkReport({
    speculator: "eagle3",
    verifier: "unit",
    tier: "0_8b",
    status: "metadata-only",
  });

  const written = writeSpeculativeBenchmarkReport(reportPath, report, {
    verifyDir,
  });

  assert.equal(written.reportPath, reportPath);
  assert.equal(written.latestPath, latestSpeculativeReportPath(verifyDir, "eagle3"));
  assert.equal(JSON.parse(fs.readFileSync(reportPath, "utf8")).speculator, "eagle3");
  assert.equal(
    JSON.parse(fs.readFileSync(written.latestPath, "utf8")).reportSchema,
    "eliza.speculative-benchmark.v1",
  );
});

test("rejects unknown speculative report speculators", () => {
  assert.throws(
    () => buildSpeculativeBenchmarkReport({ speculator: "unknown" }),
    /unsupported speculative benchmark speculator/,
  );
});
