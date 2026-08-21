/**
 * Unit tests for the evidence matrix runner's planning and execution logic. The
 * option parser and step selector are exercised with no side effects; execution
 * is proven against lightweight fixture lanes — one that exits 0 and one that
 * exits non-zero — driven through the real spawn path so the streamed reporter
 * transitions, the honest device-lane skip, and the not-swallowed failure are
 * all asserted without the expensive real matrix.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  captureEvidenceBaseline,
  createVerifiedBundle,
  executeMatrixProduction,
  executeSteps,
  MATRIX_STEPS,
  matrixStepsForOptions,
  parseMatrixArgs,
  probeRequirement,
  runReviewer,
  selectMatrixSteps,
} from "./run-matrix.mjs";

const REPO_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
);

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
  assert.deepEqual(steps.find((step) => step.id === "e2e-recordings").command, [
    "node",
    "scripts/e2e-recordings/run-all.mjs",
  ]);
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
  assert.equal(options.reviewOcr, "on");
  assert.equal(options.tier, "cpu");
  assert.deepEqual(
    steps.find((step) => step.id === "ios-sim-capture").command,
    ["node", "scripts/e2e-recordings/capture-ios-sim.mjs"],
  );
  assert.deepEqual(
    steps.find((step) => step.id === "android-emu-capture").command,
    ["node", "scripts/e2e-recordings/capture-android-emu.mjs"],
  );
});

test("audit:app is the sole maintained app visual crawler", () => {
  assert.equal(
    existsSync(
      path.join(REPO_ROOT, "scripts", "view-audit", "cdp-crawler.mjs"),
    ),
    false,
  );
  const appPackage = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "packages", "app", "package.json")),
  );
  assert.match(appPackage.scripts["audit:app"], /audit:app:capture/);
  assert.match(appPackage.scripts["audit:app"], /audit:ocr/);
  assert.equal(
    existsSync(
      path.join(
        REPO_ROOT,
        "packages/app/test/ui-smoke/all-views-aesthetic-audit.spec.ts",
      ),
    ),
    true,
  );
  assert.equal(
    existsSync(
      path.join(
        REPO_ROOT,
        "packages/app/test/ui-smoke/all-views-interaction.spec.ts",
      ),
    ),
    true,
  );
});

test("contribution rubric documents the exact-bundle reviewer command", () => {
  const rubric = readFileSync(
    path.join(
      REPO_ROOT,
      "packages/skills/skills/contribute-to-eliza/references/evidence-review-rubric.md",
    ),
    "utf8",
  );
  assert.match(
    rubric,
    /evidence:review:no-open -- --bundle=evidence\/runs\/<run-id>/,
  );
  assert.doesNotMatch(rubric, /test:matrix:review -- --bundle/);
});

test("can skip device lanes while keeping test and visual evidence lanes", () => {
  const options = parseMatrixArgs(["--skip-devices"]);
  const steps = selectMatrixSteps(MATRIX_STEPS, options);
  assert.deepEqual(
    steps.map((step) => step.id),
    ["test-all", "e2e-recordings", "app-audit"],
  );
});

test("provider qualification is an explicit matrix producer", () => {
  const defaults = parseMatrixArgs([]);
  assert.equal(
    matrixStepsForOptions(defaults).some(
      (step) => step.id === "provider-qualification",
    ),
    false,
  );

  const options = parseMatrixArgs([
    "--provider-qualification-config=/private/operator/matrix.json",
    "--only=provider-qualification",
  ]);
  const selected = selectMatrixSteps(matrixStepsForOptions(options), options);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "provider-qualification");
  assert.deepEqual(selected[0].command, [
    "node",
    "scripts/evidence-review/provider-qualification-producer.mjs",
    "/private/operator/matrix.json",
  ]);
});

test("validates explicit step ids and requires OCR", () => {
  const options = parseMatrixArgs([
    "--only=e2e-recordings,app-audit",
    "--review-ocr=on",
    "--open",
  ]);
  assert.equal(options.reviewOcr, "on");
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
    () => parseMatrixArgs(["--review-ocr=off"]),
    /--review-ocr must be on/,
  );
  assert.throws(
    () => parseMatrixArgs(["--review-ocr=auto"]),
    /--review-ocr must be on/,
  );
  assert.throws(
    () => parseMatrixArgs(["--provider-qualification-config="]),
    /requires a file/,
  );
  assert.equal(parseMatrixArgs(["--tier=full"]).tier, "full");
  assert.throws(() => parseMatrixArgs(["--tier=fast"]), /--tier must be/);
});

test("creates and verifies the exact matrix bundle before reviewing it", () => {
  const calls = [];
  const bundleDir = path.join(REPO_ROOT, "evidence", "runs", "exact-run");
  const run = (command, args) => {
    calls.push([command, args]);
    if (args.includes("create")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          schema: 1,
          command: "bundle:create",
          runId: "exact-run",
          bundleDir,
          manifestPath: `${bundleDir}/manifest.json`,
          manifestSha256: "a".repeat(64),
          artifactCount: 1,
        }),
        stderr: "",
      };
    }
    if (args.includes("verify")) {
      return { status: 0, stdout: "bundle exact-run\n  OK\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const options = parseMatrixArgs(["--no-open"]);
  const bundled = createVerifiedBundle(
    options,
    "/tmp/matrix-run.json",
    "/tmp/silo-baseline.json",
    { run },
  );
  assert.equal(bundled.bundleDir, bundleDir);
  assert.equal(calls.length, 2);
  assert.ok(calls[0][1].includes("matrix=/tmp/matrix-run.json"));
  assert.ok(calls[0][1].includes("/tmp/silo-baseline.json"));
  assert.ok(calls[0][1].includes("--json"));
  assert.deepEqual(calls[1][1].slice(-2), ["verify", bundleDir]);

  const reviewed = runReviewer(options, bundled.bundleDir, { run });
  assert.equal(reviewed.bundleDir, bundleDir);
  assert.ok(calls[2][1].includes(`--bundle=${bundleDir}`));
  assert.ok(
    calls[2][1].some((arg) => arg.includes("evidence/review/exact-run")),
  );
});

test("matrix rejects noisy or redirected bundle-create output", () => {
  const options = parseMatrixArgs([]);
  assert.throws(
    () =>
      createVerifiedBundle(options, "/tmp/matrix.json", "/tmp/base.json", {
        run: () => ({
          status: 0,
          stdout: 'progress\n{"schema":1}',
          stderr: "",
        }),
      }),
    /invalid JSON/,
  );
  assert.throws(
    () =>
      createVerifiedBundle(options, "/tmp/matrix.json", "/tmp/base.json", {
        run: () => ({
          status: 0,
          stdout: JSON.stringify({
            schema: 1,
            command: "bundle:create",
            runId: "redirected",
            bundleDir: "/tmp/redirected",
            manifestPath: "/tmp/redirected/manifest.json",
            manifestSha256: "a".repeat(64),
          }),
          stderr: "",
        }),
      }),
    /paths outside its run/,
  );
});

test("captures the producer baseline before lane execution", () => {
  const staging = mkdtempSync(path.join(os.tmpdir(), "matrix-baseline-"));
  try {
    const calls = [];
    const baselinePath = captureEvidenceBaseline(staging, {
      run: (command, args) => {
        calls.push([command, args]);
        const outIndex = args.indexOf("--out") + 1;
        writeFileSync(args[outIndex], '{"schema":1,"files":{}}\n');
        return { status: 0, stdout: args[outIndex], stderr: "" };
      },
    });
    assert.equal(baselinePath, path.join(staging, "silo-baseline.json"));
    assert.equal(calls.length, 1);
    assert.ok(calls[0][1].includes("snapshot"));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test("provider production runs after baseline and before bundle ingestion", () => {
  const options = parseMatrixArgs([
    "--provider-qualification-config=/private/operator/matrix.json",
    "--only=provider-qualification",
  ]);
  const steps = selectMatrixSteps(matrixStepsForOptions(options), options);
  const calls = [];
  const result = executeMatrixProduction(steps, options, "/tmp/staging", {
    captureBaseline: () => {
      calls.push("baseline");
      return "/tmp/baseline.json";
    },
    execute: (selected) => {
      calls.push(`execute:${selected[0].id}`);
      return [{ ...selected[0], status: "passed" }];
    },
    write: () => {
      calls.push("manifest");
      return { manifestPath: "/tmp/matrix-run.json" };
    },
    createBundle: (_bundleOptions, manifestPath, baselinePath) => {
      calls.push(`bundle:${manifestPath}:${baselinePath}`);
      return { bundleDir: "/tmp/bundle" };
    },
  });
  assert.deepEqual(calls, [
    "baseline",
    "execute:provider-qualification",
    "manifest",
    "bundle:/tmp/matrix-run.json:/tmp/baseline.json",
  ]);
  assert.equal(result.results[0].status, "passed");
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
