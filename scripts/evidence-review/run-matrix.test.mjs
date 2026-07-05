/**
 * Unit tests for the evidence matrix runner's planning logic. The real command
 * executes expensive test and device lanes; these tests keep the option parser
 * and step selector deterministic without spawning the matrix itself.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  MATRIX_STEPS,
  parseMatrixArgs,
  selectMatrixSteps,
} from "./run-matrix.mjs";

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
