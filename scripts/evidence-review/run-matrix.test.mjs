/**
 * Unit tests for the evidence matrix runner's planning and execution logic. The
 * option parser and step selector are exercised with no side effects; execution
 * is proven against lightweight fixture lanes — one that exits 0 and one that
 * exits non-zero — driven through the real spawn path so the streamed reporter
 * transitions, the honest device-lane skip, and the not-swallowed failure are
 * all asserted without the expensive real matrix.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSteps,
  MATRIX_STEPS,
  parseMatrixArgs,
  probeRequirement,
  selectMatrixSteps,
} from "./run-matrix.mjs";

function fixtureLane(id, exitCode) {
  return {
    id,
    label: `fixture ${id}`,
    command: ["node", "-e", `process.exit(${exitCode})`],
    tags: ["fixture"],
  };
}

function recordingReporter() {
  const events = [];
  return {
    events,
    header() {
      events.push(["header"]);
    },
    laneStart(step) {
      events.push(["start", step.id]);
    },
    laneEnd(step, status) {
      events.push(["end", step.id, status]);
    },
    laneSkip(step, reason) {
      events.push(["skip", step.id, reason]);
    },
  };
}

test("selects all real matrix lanes by default", () => {
  const options = parseMatrixArgs([]);
  const steps = selectMatrixSteps(MATRIX_STEPS, options);
  assert.deepEqual(
    steps.map((step) => step.id),
    [
      "test-all",
      "e2e-recordings",
      "app-audit",
      "ios-sim-capture",
      "android-emu-capture",
    ],
  );
  assert.equal(options.review, true);
  assert.equal(options.open, false);
});

test("can skip device lanes while keeping test and visual evidence lanes", () => {
  const options = parseMatrixArgs(["--skip-devices"]);
  const steps = selectMatrixSteps(MATRIX_STEPS, options);
  assert.deepEqual(
    steps.map((step) => step.id),
    ["test-all", "e2e-recordings", "app-audit"],
  );
});

test("validates explicit step ids and OCR mode", () => {
  const options = parseMatrixArgs([
    "--only=e2e-recordings,app-audit",
    "--review-ocr=auto",
    "--open",
  ]);
  assert.equal(options.reviewOcr, "auto");
  assert.equal(options.open, true);
  assert.deepEqual(
    selectMatrixSteps(MATRIX_STEPS, options).map((step) => step.id),
    ["e2e-recordings", "app-audit"],
  );
  assert.throws(
    () => selectMatrixSteps(MATRIX_STEPS, parseMatrixArgs(["--only=missing"])),
    /unknown matrix step/,
  );
  assert.throws(
    () => parseMatrixArgs(["--review-ocr=yes"]),
    /--review-ocr must be auto, on, or off/,
  );
});

test("a filter combination selecting zero lanes fails with an actionable message", () => {
  // --skip-devices drops the device lanes, --only keeps only a device lane, so
  // the intersection is empty. This must be a clear error, not an opaque
  // reporter-constructor throw and not a fake pass.
  assert.throws(
    () =>
      selectMatrixSteps(
        MATRIX_STEPS,
        parseMatrixArgs(["--skip-devices", "--only=ios-sim-capture"]),
      ),
    /no lanes selected - check --only\/--skip filters/,
  );
});

test("probeRequirement passes lanes with no external dependency", () => {
  assert.deepEqual(probeRequirement(null), { reachable: true, reason: null });
  assert.deepEqual(probeRequirement(undefined), {
    reachable: true,
    reason: null,
  });
});

test("probeRequirement reports an honest skip reason when no device is booted", () => {
  const noBooted = probeRequirement("ios-simulator", {
    runProbe: () => ({ status: 0, stdout: "== Devices ==\n" }),
  });
  assert.equal(noBooted.reachable, false);
  assert.match(noBooted.reason, /no booted iOS Simulator/);

  const booted = probeRequirement("ios-simulator", {
    runProbe: () => ({ status: 0, stdout: "iPhone 16 (ABC) (Booted)\n" }),
  });
  assert.deepEqual(booted, { reachable: true, reason: null });

  const noAndroid = probeRequirement("android-emulator", {
    runProbe: () => ({ status: 0, stdout: "List of devices attached\n\n" }),
  });
  assert.equal(noAndroid.reachable, false);
  assert.match(noAndroid.reason, /no attached Android device/);

  const android = probeRequirement("android-emulator", {
    runProbe: () => ({
      status: 0,
      stdout: "List of devices attached\nemulator-5554\tdevice\n",
    }),
  });
  assert.deepEqual(android, { reachable: true, reason: null });
});

test("executeSteps runs real fixture lanes and streams pass/fail transitions", () => {
  const reporter = recordingReporter();
  const steps = [fixtureLane("green-lane", 0), fixtureLane("red-lane", 3)];
  const results = executeSteps(steps, parseMatrixArgs([]), {
    reporter,
    probe: () => ({ reachable: true, reason: null }),
  });

  assert.deepEqual(
    results.map((r) => [r.id, r.status, r.exitCode]),
    [
      ["green-lane", "passed", 0],
      ["red-lane", "failed", 3],
    ],
  );
  // The failure is surfaced as a real FAIL transition, never swallowed.
  assert.deepEqual(reporter.events, [
    ["start", "green-lane"],
    ["end", "green-lane", "passed"],
    ["start", "red-lane"],
    ["end", "red-lane", "failed"],
  ]);
});

test("executeSteps stops after first failure when --stop-on-failure is set", () => {
  const reporter = recordingReporter();
  const steps = [fixtureLane("red-lane", 1), fixtureLane("never-runs", 0)];
  const results = executeSteps(steps, parseMatrixArgs(["--stop-on-failure"]), {
    reporter,
    probe: () => ({ reachable: true, reason: null }),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "failed");
  assert.ok(!reporter.events.some((e) => e[1] === "never-runs"));
});

test("executeSteps skips an unreachable device lane with a reason, never runs it", () => {
  const reporter = recordingReporter();
  const steps = [
    fixtureLane("green-lane", 0),
    { ...fixtureLane("ios-sim-capture", 1), requires: "ios-simulator" },
  ];
  const results = executeSteps(steps, parseMatrixArgs([]), {
    reporter,
    probe: (req) =>
      req === "ios-simulator"
        ? { reachable: false, reason: "no booted iOS Simulator" }
        : { reachable: true, reason: null },
  });

  const ios = results.find((r) => r.id === "ios-sim-capture");
  assert.equal(ios.status, "skipped");
  assert.equal(ios.skipReason, "no booted iOS Simulator");
  assert.equal(ios.exitCode, null);
  assert.deepEqual(reporter.events, [
    ["start", "green-lane"],
    ["end", "green-lane", "passed"],
    ["skip", "ios-sim-capture", "no booted iOS Simulator"],
  ]);
});

test("executeSteps writes planned records without running under --dry-run", () => {
  const reporter = recordingReporter();
  const steps = [fixtureLane("green-lane", 0)];
  const results = executeSteps(steps, parseMatrixArgs(["--dry-run"]), {
    reporter,
    probe: () => {
      throw new Error("probe must not run in dry-run");
    },
  });
  assert.equal(results[0].status, "planned");
  assert.equal(results[0].exitCode, null);
  assert.deepEqual(reporter.events, []);
});
