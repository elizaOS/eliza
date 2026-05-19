/**
 * WS7 — Agent loop integration test (no live screen).
 *
 * Drives `runComputerUseAgentLoop` with fully synthetic deps: a stub Brain,
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

import { describe, expect, it } from "vitest";
import {
  type ComputerUseAgentReport,
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

describe("runComputerUseAgentLoop — stubbed Brain", () => {
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
    expect(report.error).toContain("cascade failed");
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
});
