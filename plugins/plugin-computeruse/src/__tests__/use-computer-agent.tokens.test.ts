/**
 * #9105 — per-run model-call telemetry.
 *
 * The default `LocalGrounderLoop` exposes `getStats()` (delegating to the
 * wrapped `Brain`); `runComputerUseAgentLoop` reads it in `finalize()`,
 * attaches `report.modelStats`, and logs `evt:"computeruse.agent.tokens"`.
 * A loop that does not implement the optional `getStats()` leaves
 * `report.modelStats` undefined.
 *
 * Synthetic-deps style mirrors `computer-use-agent.test.ts` (fake Brain via
 * `invokeModel`, fake `captureAll`, fake service).
 */

import { describe, expect, it } from "vitest";
import {
  type ComputerUseAgentReport,
  runComputerUseAgentLoop,
} from "../actions/use-computer-agent.js";
import type {
  AgentLoop,
  AgentStepInput,
  PredictClickInput,
} from "../actor/agent-loop.js";
import { Brain } from "../actor/brain.js";
import type { CascadeResult, GroundingResult } from "../actor/types.js";
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
    ocr: [],
    ax: [],
    vlm_scene: null,
    vlm_elements: null,
  };
}

function fakeService(): ComputerUseService {
  return {
    getCurrentScene: () => syntheticScene(),
    refreshScene: async () => syntheticScene(),
    getDisplays: () => [display()],
    setSceneVlmAnnotations: () => {},
  } as unknown as ComputerUseService;
}

async function captureAll(): Promise<DisplayCapture[]> {
  return [
    {
      display: { ...display(), id: 0 },
      frame: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64, 0),
      ]),
    },
  ];
}

function finishBrain(): Brain {
  // Explicitly opt into the imageless policy under test — the production
  // default is "always" until a real-model trajectory validates on-escalation.
  return new Brain(null, {
    imagePolicy: "on-escalation",
    invokeModel: async () =>
      JSON.stringify({
        scene_summary: "done",
        target_display_id: 0,
        roi: [],
        proposed_action: { kind: "finish", rationale: "ok" },
      }),
  });
}

describe("runComputerUseAgentLoop — model-call telemetry (#9105)", () => {
  it("attaches modelStats from the default loop's Brain", async () => {
    const report: ComputerUseAgentReport = await runComputerUseAgentLoop(
      null,
      { goal: "g" },
      fakeService(),
      { brain: finishBrain(), captureAll },
    );

    expect(report.reason).toBe("finish");
    // First (and only) model call cannot be a cache hit. `finish` needs no
    // coordinate, so the opted-in "on-escalation" policy plans imageless and
    // counts the saved image tokens (frame header is not a real IHDR → the
    // estimate uses the BRAIN_MAX_PIXELS ceiling).
    expect(report.modelStats).toEqual({
      invocations: 1,
      cacheHits: 0,
      imagelessCalls: 1,
      estImageTokensSaved: 1748,
    });
  });

  it("counts one model invocation per planning step", async () => {
    const report = await runComputerUseAgentLoop(
      null,
      { goal: "g", maxSteps: 3 },
      fakeService(),
      {
        // Always `wait` → never finishes → runs the full maxSteps budget.
        brain: new Brain(null, {
          imagePolicy: "on-escalation",
          invokeModel: async () =>
            JSON.stringify({
              scene_summary: "thinking",
              target_display_id: 0,
              roi: [],
              proposed_action: { kind: "wait", rationale: "loading" },
            }),
        }),
        captureAll,
      },
    );

    expect(report.reason).toBe("max_steps");
    expect(report.steps.length).toBe(3);
    // One invocation per step; the synthetic frame is not a decodable PNG so
    // the dHash cache never engages. `wait` needs no coordinate, so every step
    // plans imageless under the opted-in "on-escalation" policy.
    expect(report.modelStats?.invocations).toBe(3);
    expect(report.modelStats?.cacheHits).toBe(0);
    expect(report.modelStats?.imagelessCalls).toBe(3);
  });

  it("leaves modelStats undefined when the loop does not implement getStats()", async () => {
    const statelessLoop: AgentLoop = {
      name: "test/stateless",
      predictStep: async (_input: AgentStepInput): Promise<CascadeResult> => ({
        scene_summary: "stateless",
        rois: [],
        proposed: { kind: "finish", rationale: "ok", displayId: 0 },
      }),
      predictClick: async (
        _input: PredictClickInput,
      ): Promise<GroundingResult | null> => null,
    };

    const report = await runComputerUseAgentLoop(
      null,
      { goal: "g" },
      fakeService(),
      { loop: statelessLoop, captureAll },
    );

    expect(report.reason).toBe("finish");
    expect(report.modelStats).toBeUndefined();
  });
});
