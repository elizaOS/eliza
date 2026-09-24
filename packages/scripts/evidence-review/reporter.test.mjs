/**
 * Unit tests for the human-speed streaming reporter and admin summary. Output
 * is captured through an injected write sink and a fake monotonic clock so the
 * exact status-transition lines and summary text are asserted deterministically,
 * with explicit coverage that a failed lane surfaces as FAIL and is not
 * swallowed into a green summary.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createMatrixReporter,
  formatDuration,
  renderMatrixSummary,
} from "./reporter.mjs";

function collector() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

test("formatDuration renders ms, seconds, and minutes", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(850), "850ms");
  assert.equal(formatDuration(1500), "1.5s");
  assert.equal(formatDuration(65000), "1m05s");
  assert.equal(formatDuration(Number.NaN), "—");
  assert.equal(formatDuration(-5), "—");
});

test("reporter streams pending->running->passed transitions with timing", () => {
  const { lines, write } = collector();
  let clock = 1000;
  const reporter = createMatrixReporter({
    write,
    total: 2,
    now: () => clock,
  });
  reporter.header();

  reporter.laneStart({ id: "test-all", label: "Test matrix" });
  clock = 3500; // 2.5s elapsed
  reporter.laneEnd({ id: "test-all", label: "Test matrix" }, "passed");

  reporter.laneStart({ id: "app-audit", label: "Visual audit" });
  clock = 4200;
  reporter.laneEnd({ id: "app-audit", label: "Visual audit" }, "passed");

  assert.equal(lines[0], "Running 2 evidence lanes at human speed.");
  assert.equal(lines[1], "[>] [1/2] RUNNING test-all — Test matrix");
  assert.equal(lines[2], "[+] [1/2] PASS test-all — Test matrix  (2.5s)");
  assert.equal(lines[3], "[>] [2/2] RUNNING app-audit — Visual audit");
  assert.match(lines[4], /^\[\+\] \[2\/2\] PASS app-audit/);
});

test("reporter marks a failed lane as FAIL, not passed", () => {
  const { lines, write } = collector();
  const reporter = createMatrixReporter({ write, total: 1, now: () => 0 });
  reporter.laneStart({ id: "e2e", label: "e2e" });
  reporter.laneEnd({ id: "e2e", label: "e2e" }, "failed");
  assert.match(lines.at(-1), /\[x\] \[1\/1\] FAIL e2e/);
  assert.ok(!lines.some((l) => /PASS/.test(l)));
});

test("reporter surfaces a skipped lane with its reason", () => {
  const { lines, write } = collector();
  const reporter = createMatrixReporter({ write, total: 1, now: () => 0 });
  reporter.laneSkip(
    { id: "ios-sim-capture", label: "iOS capture" },
    "no booted iOS Simulator",
  );
  assert.equal(
    lines.at(-1),
    "[-] [1/1] SKIP ios-sim-capture — iOS capture  — no booted iOS Simulator",
  );
});

test("reporter rejects invalid construction", () => {
  assert.throws(() => createMatrixReporter({ total: 1 }), /write/);
  assert.throws(
    () => createMatrixReporter({ write: () => {}, total: 0 }),
    /positive integer total/,
  );
});

test("summary tallies pass/fail/skip and reports overall FAILED on any failure", () => {
  const steps = [
    { id: "test-all", status: "passed", durationMs: 2500 },
    {
      id: "app-audit",
      status: "failed",
      durationMs: 900,
      artifactPath: "packages/app/aesthetic-audit-output",
    },
    {
      id: "ios-sim-capture",
      status: "skipped",
      durationMs: 0,
      skipReason: "no booted iOS Simulator",
    },
  ];
  const summary = renderMatrixSummary(steps, {
    manifestPath: "/repo/evidence/matrix-run.json",
    dashboardPath: "/repo/evidence/index.html",
  });

  assert.equal(summary.overall, "FAILED");
  assert.deepEqual(summary.counts, {
    passed: 1,
    failed: 1,
    skipped: 1,
    planned: 0,
  });
  assert.match(summary.text, /FAIL {3}app-audit/);
  assert.match(summary.text, /SKIP {3}ios-sim-capture/);
  assert.match(summary.text, /skip: no booted iOS Simulator/);
  assert.match(summary.text, /FAILED: 1 passed, 1 failed, 1 skipped/);
  assert.match(
    summary.text,
    /Evidence dashboard: \/repo\/evidence\/index\.html/,
  );
});

test("summary reads PASSED when no lane failed", () => {
  const steps = [
    { id: "test-all", status: "passed", durationMs: 10 },
    { id: "app-audit", status: "skipped", durationMs: 0, skipReason: "off" },
  ];
  const summary = renderMatrixSummary(steps, {});
  assert.equal(summary.overall, "PASSED");
  assert.match(summary.text, /PASSED: 1 passed, 0 failed, 1 skipped/);
});

test("summary reads PLANNED when every lane is dry-run planned", () => {
  const steps = [
    { id: "test-all", status: "planned", durationMs: 0 },
    { id: "app-audit", status: "planned", durationMs: 0 },
  ];
  const summary = renderMatrixSummary(steps, {});
  assert.equal(summary.overall, "PLANNED");
  assert.match(summary.text, /PLANNED: 2 planned/);
});
