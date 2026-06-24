/**
 * WS7 — Agent loop integration test (no live screen).
 *
 * Drives `runComputerUseAgentLoop` with fully synthetic deps: a fake Brain,
 * a fake `captureAll` that emits a hand-rolled PNG, and a fake service that
 * returns a deterministic Scene. Asserts:
 *
 *   - Loop terminates on `finish` and reports `reason: "finish"`.
 *   - Loop terminates on `maxSteps` after that many turns when the Brain
 *     keeps emitting `wait`.
 *   - Cascade errors surface as `reason: "error"`, not exceptions.
 *   - Dispatch failures (out-of-bounds, etc.) abort the loop.
 *   - Each step's `result.success` mirrors the dispatch outcome.
 *
 * This is the in-suite counterpart to `computer-use-agent.real.test.ts`,
 * which exercises the live capture path on a Linux host (skipped by
 * default).
 */

import type { Content } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  type ComputerUseAgentReport,
  type ComputerUseAgentStepProgress,
  formatComputerUseAgentProgress,
  runComputerUseAgentLoop,
} from "../actions/use-computer-agent.js";
import { Brain } from "../actor/brain.js";
import type { DisplayCapture } from "../platform/capture.js";
import type { Scene } from "../scene/scene-types.js";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type { DisplayDescriptor } from "../types.js";

function display(): DisplayDescriptor {
  return {
    id: 0,
    bounds: [0, 0, 1920, 1080],
    scaleFactor: 1,
    primary: true,
    name: "fake",
  };
}

function syntheticScene(): Scene {
  return {
    timestamp: Date.now(),
    displays: [display()],
    focused_window: null,
    apps: [],
    ocr: [
      {
        id: "t0-1",
        text: "Save",
        bbox: [100, 100, 80, 32],
        conf: 0.97,
        displayId: 0,
      },
    ],
    ax: [],
    vlm_scene: null,
    vlm_elements: null,
  };
}

function fakeService(refresh?: () => Promise<Scene>): ComputerUseService {
  return {
    getCurrentScene: () => syntheticScene(),
    refreshScene: refresh ?? (async () => syntheticScene()),
    getDisplays: () => [display()],
    setSceneVlmAnnotations: () => {},
  } as unknown as ComputerUseService;
}

function fakeCaptures(): Map<number, DisplayCapture> {
  const m = new Map<number, DisplayCapture>();
  m.set(0, {
    display: { ...display(), id: 0 },
    frame: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0),
    ]),
  });
  return m;
}

async function captureAll(): Promise<DisplayCapture[]> {
  return Array.from(fakeCaptures().values());
}

describe("runComputerUseAgentLoop — fake Brain", () => {
  it("terminates cleanly on `finish`", async () => {
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "done",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "finish", rationale: "ok" },
        }),
    });
    const report = await runComputerUseAgentLoop(
      null,
      { goal: "g" },
      fakeService(),
      { brain, captureAll },
    );
    expect(report.reason).toBe("finish");
    expect(report.finished).toBe(true);
    expect(report.steps.length).toBe(1);
    expect(report.steps[0]?.actionKind).toBe("finish");
  });

  it("records a trajectory on the report via the default middleware (#9170 M11)", async () => {
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "done",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "finish", rationale: "all set" },
        }),
    });
    const report = await runComputerUseAgentLoop(
      null,
      { goal: "g" },
      fakeService(),
      { brain, captureAll },
    );
    expect(report.trajectory).toHaveLength(1);
    expect(report.trajectory?.[0]).toMatchObject({
      step: 1,
      actionKind: "finish",
      success: true,
    });
  });

  it("aborts on the wall-clock budget before any step (#9170 M11)", async () => {
    const brain = new Brain(null, {
      invokeModel: async () => {
        throw new Error("brain should not be called once budget is blown");
      },
    });
    // now(): first call = run start (0), second = beforeStep elapsed (5000ms).
    let t = 0;
    const ticks = [0, 5000];
    const now = () => ticks[Math.min(t++, ticks.length - 1)] ?? 5000;
    const report = await runComputerUseAgentLoop(
      null,
      { goal: "g", maxDurationMs: 100 },
      fakeService(),
      { brain, captureAll, now },
    );
    expect(report.reason).toBe("budget");
    expect(report.steps.length).toBe(0);
    expect(report.error).toContain("time budget");
  });

  it("emits per-step callback content when streamProgress is true", async () => {
    const progress: Content[] = [];
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "done",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "finish", rationale: "ok" },
        }),
    });

    const report = await runComputerUseAgentLoop(
      null,
      { goal: "g", streamProgress: true },
      fakeService(),
      {
        brain,
        captureAll,
        onCompactStepProgress: (content) => {
          progress.push(content);
        },
      },
    );

    expect(report.reason).toBe("finish");
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({
      text: "Step 1: finish — ok",
      source: "action_progress",
      merge: "replace",
      metadata: {
        transient: true,
        compactProgress: true,
        progress: {
          source: "computeruse",
          actionName: "COMPUTER_USE_AGENT",
          step: 1,
          kind: "finish",
          rationale: "ok",
          success: true,
        },
      },
    });
  });

  it("keeps the loop result when per-step callback delivery fails", async () => {
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "done",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "finish", rationale: "ok" },
        }),
    });

    const report = await runComputerUseAgentLoop(
      null,
      { goal: "g", streamProgress: true },
      fakeService(),
      {
        brain,
        captureAll,
        onCompactStepProgress: () => {
          throw new Error("send failed");
        },
      },
    );

    expect(report.reason).toBe("finish");
    expect(report.steps[0]?.actionKind).toBe("finish");
  });

  it("keeps per-step callbacks behind the streamProgress flag", async () => {
    const progress: Content[] = [];
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "done",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "finish", rationale: "ok" },
        }),
    });

    await runComputerUseAgentLoop(null, { goal: "g" }, fakeService(), {
      brain,
      captureAll,
      onCompactStepProgress: (content) => {
        progress.push(content);
      },
    });

    expect(progress).toEqual([]);
  });

  it("hits maxSteps when the Brain keeps emitting wait", async () => {
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "still loading",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "wait", rationale: "..." },
        }),
    });
    const report: ComputerUseAgentReport = await runComputerUseAgentLoop(
      null,
      { goal: "g", maxSteps: 3 },
      fakeService(),
      { brain, captureAll },
    );
    expect(report.reason).toBe("max_steps");
    expect(report.finished).toBe(false);
    expect(report.steps.length).toBe(3);
  });

  it("emits a per-step progress callback when streamProgress is set (#8912)", async () => {
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "still loading",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "wait", rationale: "waiting for page" },
        }),
    });
    const progress: ComputerUseAgentStepProgress[] = [];
    const report = await runComputerUseAgentLoop(
      null,
      { goal: "g", maxSteps: 3, streamProgress: true },
      fakeService(),
      { brain, captureAll, onStepProgress: (p) => void progress.push(p) },
    );
    // One callback per dispatched step, in order, carrying kind + rationale.
    expect(progress.length).toBe(report.steps.length);
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress[0]).toMatchObject({
      step: 1,
      maxSteps: 3,
      actionKind: "wait",
      rationale: "waiting for page",
      result: { success: true },
    });
  });

  it("does not call progress callback when streamProgress is unset", async () => {
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "done",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "finish", rationale: "ok" },
        }),
    });
    let calls = 0;
    await runComputerUseAgentLoop(null, { goal: "g" }, fakeService(), {
      brain,
      captureAll,
      onStepProgress: () => {
        calls += 1;
      },
    });
    expect(calls).toBe(0);
  });

  it("surfaces cascade failures as `reason: error` instead of throwing", async () => {
    // Brain emits a click with no ref + no roi → cascade can't resolve it.
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "S",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "click", rationale: "where?" },
        }),
    });
    const report = await runComputerUseAgentLoop(
      null,
      { goal: "g" },
      fakeService(),
      { brain, captureAll },
    );
    expect(report.reason).toBe("error");
    // The loop wraps Brain→Cascade as the default "local-grounder" loop
    // (#9170 M10); planning/grounding failures surface under that loop name.
    expect(report.error).toContain('agent loop "local-grounder" failed');
  });

  it("aborts on dispatch error (out-of-bounds)", async () => {
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "S",
          target_display_id: 0,
          roi: [
            {
              displayId: 0,
              bbox: [9_000, 9_000, 10, 10],
              reason: "off-screen",
            },
          ],
          proposed_action: { kind: "click", rationale: "click out-of-bounds" },
        }),
    });
    const report = await runComputerUseAgentLoop(
      null,
      { goal: "g" },
      fakeService(),
      { brain, captureAll },
    );
    expect(report.reason).toBe("error");
    expect(report.steps.length).toBe(1);
    expect(report.steps[0]?.result.success).toBe(false);
    expect(report.error).toMatch(/outside display/);
  });

  it("aborts on scene refresh error", async () => {
    const brain = new Brain(null, {
      invokeModel: async () => "{}",
    });
    const report = await runComputerUseAgentLoop(
      null,
      { goal: "g" },
      fakeService(async () => {
        throw new Error("scene-broken");
      }),
      { brain, captureAll },
    );
    expect(report.reason).toBe("error");
    expect(report.error).toContain("scene-broken");
  });

  it("aborts when no displays can be captured", async () => {
    const brain = new Brain(null, {
      invokeModel: async () => "{}",
    });
    const report = await runComputerUseAgentLoop(
      null,
      { goal: "g" },
      fakeService(),
      {
        brain,
        captureAll: async () => [],
      },
    );
    expect(report.reason).toBe("error");
    expect(report.error).toBe("no displays captured");
  });

  it("clamps maxSteps to [1, 20]", async () => {
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "S",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "wait", rationale: "" },
        }),
    });
    const r1 = await runComputerUseAgentLoop(
      null,
      { goal: "g", maxSteps: 0 },
      fakeService(),
      { brain, captureAll },
    );
    expect(r1.steps.length).toBe(1);
    const r2 = await runComputerUseAgentLoop(
      null,
      { goal: "g", maxSteps: 100 },
      fakeService(),
      { brain, captureAll },
    );
    expect(r2.steps.length).toBe(20);
  });

  it("emits opt-in step progress after each dispatched step", async () => {
    let step = 0;
    const brain = new Brain(null, {
      invokeModel: async () => {
        step += 1;
        if (step === 1) {
          return JSON.stringify({
            scene_summary: "waiting for modal",
            target_display_id: 0,
            roi: [],
            proposed_action: {
              kind: "wait",
              rationale: "wait for the modal to settle",
            },
          });
        }
        return JSON.stringify({
          scene_summary: "done",
          target_display_id: 0,
          roi: [],
          proposed_action: { kind: "finish", rationale: "goal reached" },
        });
      },
    });
    const progress: ComputerUseAgentStepProgress[] = [];
    const report = await runComputerUseAgentLoop(
      null,
      { goal: "watch the screen", maxSteps: 5, streamProgress: true },
      fakeService(),
      {
        brain,
        captureAll,
        onStepProgress: (event) => {
          progress.push(event);
        },
      },
    );

    expect(report.reason).toBe("finish");
    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({
      goal: "watch the screen",
      step: 1,
      maxSteps: 5,
      actionKind: "wait",
      rationale: "wait for the modal to settle",
      result: { success: true },
    });
    const firstProgress = progress[0];
    expect(firstProgress).toBeDefined();
    if (!firstProgress) {
      throw new Error("expected first progress event");
    }
    expect(formatComputerUseAgentProgress(firstProgress)).toBe(
      "Step 1/5: wait - wait for the modal to settle",
    );
  });

  it("emits a failed step progress event before aborting", async () => {
    const brain = new Brain(null, {
      invokeModel: async () =>
        JSON.stringify({
          scene_summary: "S",
          target_display_id: 0,
          roi: [
            {
              displayId: 0,
              bbox: [9_000, 9_000, 10, 10],
              reason: "off-screen",
            },
          ],
          proposed_action: { kind: "click", rationale: "click out-of-bounds" },
        }),
    });
    const progress: ComputerUseAgentStepProgress[] = [];
    const report = await runComputerUseAgentLoop(
      null,
      { goal: "click", maxSteps: 2, streamProgress: true },
      fakeService(),
      {
        brain,
        captureAll,
        onStepProgress: (event) => {
          progress.push(event);
        },
      },
    );

    expect(report.reason).toBe("error");
    expect(progress).toHaveLength(1);
    expect(progress[0]?.result.success).toBe(false);
    const firstProgress = progress[0];
    expect(firstProgress).toBeDefined();
    if (!firstProgress) {
      throw new Error("expected failed progress event");
    }
    expect(formatComputerUseAgentProgress(firstProgress)).toContain(
      "failed: Coordinates",
    );
  });
});
