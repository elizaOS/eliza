import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKpiReporter } from "./kpi-reporting.mjs";

test("KPI persistence distinguishes missing, corrupt and unknown provenance", () => {
  const directory = mkdtempSync(join(tmpdir(), "benchmark-kpi-"));
  const before = {
    repo: process.env.ELIZA_REPO_DIR,
    output: process.env.BENCHMARK_OUTPUT_ROOT,
  };
  process.env.ELIZA_REPO_DIR = directory;
  process.env.BENCHMARK_OUTPUT_ROOT = join(directory, "output");
  try {
    const reporter = createKpiReporter("test", directory);
    assert.equal(reporter.readLatest("latency"), null);
    const { file } = reporter.recordResult(
      "latency",
      { value: 3 },
      "2026-01-01T00:00:00Z",
    );
    const record = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(record.git.dirty, null);
    assert.equal(reporter.readLatest("latency").value, 3);
    writeFileSync(
      join(reporter.RESULTS_ROOT, "latency", "latest.json"),
      "broken",
    );
    assert.throws(() => reporter.readLatest("latency"), SyntaxError);
  } finally {
    for (const [key, value] of [
      ["ELIZA_REPO_DIR", before.repo],
      ["BENCHMARK_OUTPUT_ROOT", before.output],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
