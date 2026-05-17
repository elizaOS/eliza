/**
 * vision-CUA E2E harness test.
 *
 * Runs the stub-mode pipeline against each of the three fixtures
 * (single-display FHD, ultra-wide, multi-display composite) and asserts:
 *   - every required pipeline stage produced an `ok` record,
 *   - the click target was reconstructed in display-absolute coords,
 *   - the state-change verifier flipped (because the stub `frame-after`
 *     paints the close-button green),
 *   - a trace JSON was written to `reports/`.
 *
 * Stub mode is the default. Set `ELIZA_VISION_CUA_E2E_REAL=1` to flip the
 * harness to the real runtime path (not yet wired — see README.md).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FixtureId, listFixtures } from "./src/fixtures.ts";
import { runRealPipeline, runStubPipeline } from "./src/pipeline.ts";
import type { PipelineStage } from "./src/types.ts";

let tempReportDir: string;

beforeAll(() => {
  tempReportDir = mkdtempSync(join(tmpdir(), "vision-cua-e2e-test-"));
});

afterAll(() => {
  if (tempReportDir && existsSync(tempReportDir)) {
    rmSync(tempReportDir, { recursive: true, force: true });
  }
});

const REQUIRED_STAGES: ReadonlyArray<PipelineStage> = [
  "capture",
  "tile",
  "describe",
  "ocr",
  "ground",
  "click",
  "recapture",
  "verify_state_change",
];

describe("vision-CUA E2E pipeline (stub mode)", () => {
  it("lists exactly the three expected fixtures", () => {
    expect(listFixtures()).toEqual([
      "single-1920x1080",
      "ultra-wide-5120x1440",
      "multi-display-composite",
    ]);
  });

  const fixtures: ReadonlyArray<FixtureId> = [
    "single-1920x1080",
    "ultra-wide-5120x1440",
    "multi-display-composite",
  ];

  it.each(fixtures)("runs end-to-end against fixture %s", async (fixtureId) => {
    const { trace, reportPath, recordedClicks } = await runStubPipeline({
      fixtureId,
      reportDir: tempReportDir,
      runId: `vision-cua-e2e-test-${fixtureId}`,
    });

    expect(trace.fixture_id).toBe(fixtureId);
    expect(trace.mode).toBe("stub");
    expect(trace.displays.length).toBeGreaterThan(0);

    // One click per display.
    expect(recordedClicks.length).toBe(trace.displays.length);

    for (const display of trace.displays) {
      const exercised = new Set(
        display.stages.filter((s) => s.ok).map((s) => s.stage),
      );
      for (const required of REQUIRED_STAGES) {
        expect(exercised.has(required)).toBe(true);
      }
      expect(display.tileCount).toBeGreaterThan(0);
      expect(display.clickTarget).toBeDefined();
      expect(display.clickTarget?.absoluteX).toBeGreaterThanOrEqual(0);
      expect(display.clickTarget?.absoluteY).toBeGreaterThanOrEqual(0);
      expect(display.stateChangeDetected).toBe(true);
    }

    expect(trace.failures).toEqual([]);
    expect(trace.success).toBe(true);
    expect(trace.stages.length).toBeGreaterThan(0);

    expect(reportPath).not.toBeNull();
    expect(existsSync(reportPath as string)).toBe(true);
  });

  it("exercises the tiler with strictly more than one tile on the ultra-wide fixture", async () => {
    const { trace } = await runStubPipeline({
      fixtureId: "ultra-wide-5120x1440",
      reportDir: tempReportDir,
      runId: `vision-cua-e2e-test-ultra-tilecount-${Date.now()}`,
    });
    expect(trace.displays[0]?.tileCount).toBeGreaterThan(1);
  });

  it("records two displays with disjoint click targets for the multi-display fixture", async () => {
    const { trace } = await runStubPipeline({
      fixtureId: "multi-display-composite",
      reportDir: tempReportDir,
      runId: `vision-cua-e2e-test-multi-${Date.now()}`,
    });
    expect(trace.displays.length).toBe(2);
    const [d1, d2] = trace.displays;
    expect(d1?.displayId).not.toBe(d2?.displayId);
    expect(d1?.clickTarget?.displayId).toBe(d1?.displayId);
    expect(d2?.clickTarget?.displayId).toBe(d2?.displayId);
  });
});

// ── Real-mode block ─────────────────────────────────────────────────────────
//
// Opt-in only: gate on `ELIZA_VISION_CUA_E2E_REAL=1`. This block is responsible
// for the parity assertion — capture / tile / describe / OCR / ground / click
// flow against the live runtime stack — and for writing a trace JSON to a
// caller-supplied path (`ELIZA_VISION_CUA_E2E_REPORT_PATH`) so `scripts/run-real.sh`
// can pick it up.
const REAL_ENABLED = process.env.ELIZA_VISION_CUA_E2E_REAL === "1";
const realDescribe = REAL_ENABLED ? describe : describe.skip;

realDescribe("vision-CUA E2E pipeline (real mode)", () => {
  it("drives capture → tile → describe → OCR → ground → click against the live stack", async () => {
    const reportPath = process.env.ELIZA_VISION_CUA_E2E_REPORT_PATH;
    const reportDir = reportPath ? join(reportPath, "..") : tempReportDir;
    const runId = reportPath
      ? reportPath.replace(/^.*\//, "").replace(/\.json$/, "")
      : `vision-cua-e2e-real-${Date.now()}`;

    const {
      trace,
      reportPath: writtenPath,
      recordedClicks,
    } = await runRealPipeline({
      reportDir,
      runId,
      noopClick: process.env.ELIZA_VISION_CUA_E2E_NOOP_CLICK === "1",
      skipControlledWindow:
        process.env.ELIZA_VISION_CUA_E2E_NO_CONTROLLED_WINDOW === "1",
      controlledWindowBinary:
        process.env.ELIZA_VISION_CUA_E2E_CONTROLLED_WINDOW_BINARY,
    });

    // Provider-shaped invariants. These hold regardless of whether the
    // stack succeeded end-to-end, so the trace remains useful for triage.
    expect(trace.mode).toBe("real");
    expect(trace.fixture_id).toMatch(/^live:/);
    expect(writtenPath).not.toBeNull();
    expect(existsSync(writtenPath as string)).toBe(true);

    // Enumerate must succeed — without displays we have nothing to assert.
    const enumerate = trace.stages.find(
      (s) => s.stage === "enumerate_displays",
    );
    expect(enumerate?.ok).toBe(true);
    expect(trace.displays.length).toBeGreaterThan(0);

    // Capture must produce non-empty bytes for every display.
    for (const display of trace.displays) {
      const captureStage = display.stages.find((s) => s.stage === "capture");
      expect(captureStage?.ok).toBe(true);
    }

    // Click must have been recorded for every display the pipeline reached
    // — even in noop mode the recorder logs the intent.
    expect(recordedClicks.length).toBe(trace.displays.length);
  }, 180_000);
});
