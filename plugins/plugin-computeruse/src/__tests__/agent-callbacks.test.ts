/**
 * Agent-loop callback middleware (#9170 M11).
 *
 * Pure middlewares (budget cap, image-retention, operator-normalizer,
 * trajectory) plus the fold helpers are asserted directly; the runner
 * integration (default pipeline, budget abort, trajectory on the report) is
 * covered in computer-use-agent.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  type AgentMiddleware,
  createBudgetCapMiddleware,
  createImageRetentionMiddleware,
  createOperatorNormalizerMiddleware,
  createTrajectoryMiddleware,
  normalizeProposedAction,
  runBeforeStep,
  runTransformProposed,
} from "../actor/agent-callbacks.js";
import type { CascadeResult, ProposedAction } from "../actor/types.js";

function stepCtx(over: Partial<{ step: number; elapsedMs: number }> = {}) {
  return {
    step: over.step ?? 1,
    maxSteps: 5,
    goal: "g",
    elapsedMs: over.elapsedMs ?? 0,
  };
}

function cascade(action: Partial<ProposedAction>): CascadeResult {
  return {
    scene_summary: "s",
    rois: [],
    proposed: {
      kind: "click",
      displayId: 0,
      rationale: "r",
      ...action,
    } as ProposedAction,
  };
}

describe("budget-cap middleware", () => {
  it("aborts once the step budget is exceeded", async () => {
    const mw = createBudgetCapMiddleware({ maxSteps: 2 });
    expect((await runBeforeStep([mw], stepCtx({ step: 2 }))).abort).toBeFalsy();
    const d = await runBeforeStep([mw], stepCtx({ step: 3 }));
    expect(d.abort).toBe(true);
    expect(d.reason).toContain("step budget");
  });

  it("aborts once the time budget is exceeded", async () => {
    const mw = createBudgetCapMiddleware({ maxDurationMs: 1000 });
    expect(
      (await runBeforeStep([mw], stepCtx({ elapsedMs: 500 }))).abort,
    ).toBeFalsy();
    const d = await runBeforeStep([mw], stepCtx({ elapsedMs: 1500 }));
    expect(d.abort).toBe(true);
    expect(d.reason).toContain("time budget");
  });
});

describe("image-retention middleware", () => {
  it("keeps only the N most-recent steps' captures", async () => {
    const mw = createImageRetentionMiddleware({ keepLast: 2 });
    const cap = (id: number) => new Map([[id, { display: { id } } as never]]);
    await mw.onCaptures?.(cap(0), stepCtx({ step: 1 }));
    await mw.onCaptures?.(cap(0), stepCtx({ step: 2 }));
    await mw.onCaptures?.(cap(1), stepCtx({ step: 3 }));
    const retained = mw.retained();
    expect(retained.map((r) => r.step)).toEqual([2, 3]);
    expect(retained[1]?.displayIds).toEqual([1]);
  });
});

describe("operator-normalizer", () => {
  it("rounds coordinates, normalizes newlines, dedupes hotkey keys", () => {
    const action: ProposedAction = {
      kind: "drag",
      displayId: 0,
      x: 10.6,
      y: 20.4,
      startX: 1.5,
      startY: 2.5,
      dx: 3.2,
      dy: -4.8,
      text: "a\r\nb",
      keys: ["ctrl", "ctrl", " shift "],
      rationale: "r",
    };
    const out = normalizeProposedAction(action);
    expect(out.x).toBe(11);
    expect(out.y).toBe(20);
    expect(out.startX).toBe(2);
    expect(out.dy).toBe(-5);
    expect(out.text).toBe("a\nb");
    expect(out.keys).toEqual(["ctrl", "shift"]);
  });

  it("is idempotent on already-clean input", () => {
    const clean: ProposedAction = {
      kind: "click",
      displayId: 0,
      x: 5,
      y: 5,
      rationale: "r",
    };
    expect(normalizeProposedAction(normalizeProposedAction(clean))).toEqual(
      clean,
    );
  });

  it("transforms the proposed action through the pipeline fold", async () => {
    const mw = createOperatorNormalizerMiddleware();
    const result = await runTransformProposed(
      [mw],
      cascade({ x: 9.9, y: 0.1 }),
      stepCtx(),
    );
    expect(result.proposed.x).toBe(10);
    expect(result.proposed.y).toBe(0);
  });
});

describe("trajectory middleware", () => {
  it("records one entry per dispatched step", async () => {
    const mw = createTrajectoryMiddleware();
    await mw.afterStep?.({
      step: 1,
      goal: "g",
      proposed: cascade({ kind: "click", rationale: "click save" }),
      dispatchSuccess: true,
    });
    await mw.afterStep?.({
      step: 2,
      goal: "g",
      proposed: cascade({ kind: "type", rationale: "type hello" }),
      dispatchSuccess: false,
      error: "boom",
    });
    const entries = mw.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      step: 1,
      actionKind: "click",
      success: true,
    });
    expect(entries[1]).toMatchObject({
      step: 2,
      actionKind: "type",
      success: false,
      error: "boom",
    });
  });
});

describe("runBeforeStep fold", () => {
  it("returns the first aborting middleware's reason", async () => {
    const a: AgentMiddleware = {
      name: "a",
      beforeStep: () => ({ abort: false }),
    };
    const b: AgentMiddleware = {
      name: "b",
      beforeStep: () => ({ abort: true, reason: "stop here" }),
    };
    const c: AgentMiddleware = {
      name: "c",
      beforeStep: () => ({ abort: true, reason: "too late" }),
    };
    const d = await runBeforeStep([a, b, c], stepCtx());
    expect(d.abort).toBe(true);
    expect(d.reason).toBe("stop here");
  });
});
