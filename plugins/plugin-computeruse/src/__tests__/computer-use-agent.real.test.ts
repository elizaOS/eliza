/**
 * WS7 — Linux end-to-end agent loop test.
 *
 * Skipped by default (matches `*.real.test.ts` in `vitest.config.ts`). Run
 * explicitly with:
 *
 *   bunx vitest run src/__tests__/computer-use-agent.real.test.ts --reporter=default \
 *     --config=<(echo "export default { test: { include: ['src/__tests__/computer-use-agent.real.test.ts'] } }")
 *
 * Or via the simpler form:
 *
 *   bun x vitest run --reporter=default --testPathIgnorePatterns='[]' \
 *     src/__tests__/computer-use-agent.real.test.ts
 *
 * What it asserts:
 *   - On a Linux host with `xrandr` / `import` (ImageMagick) or `scrot`
 *     installed, `runComputerUseAgentLoop` captures the live screen,
 *     marshals it through a stub Brain, walks two steps (`wait` →
 *     `finish`), and terminates cleanly with `reason: "finish"`.
 *   - No NVIDIA GPU required — the Brain is fully stubbed via the
 *     `Brain.invokeModel` injection point.
 */

import { describe, expect, it } from "vitest";
import { Brain } from "../actor/brain.js";
import {
  runComputerUseAgentLoop,
  type ComputerUseAgentReport,
} from "../actions/use-computer-agent.js";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type { Scene, SceneOcrBox } from "../scene/scene-types.js";
import { listDisplays } from "../platform/displays.js";
import type { DisplayCapture } from "../platform/capture.js";
import { captureAllDisplays } from "../platform/capture.js";

function fakeScene(): Scene {
  const ds = listDisplays();
  const ocr: SceneOcrBox[] = [
    {
      id: "t0-1",
      text: "Hello",
      bbox: [100, 100, 80, 24],
      conf: 0.9,
      displayId: ds[0]?.id ?? 0,
    },
  ];
  return {
    timestamp: Date.now(),
    displays: ds.map((d) => ({
      id: d.id,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      primary: d.primary,
      name: d.name,
    })),
    focused_window: null,
    apps: [],
    ocr,
    ax: [],
    vlm_scene: null,
    vlm_elements: null,
  };
}

function fakeService(): ComputerUseService {
  return {
    getCurrentScene: () => fakeScene(),
    refreshScene: async () => fakeScene(),
    getDisplays: () =>
      listDisplays().map((d) => ({
        id: d.id,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor,
        primary: d.primary,
        name: d.name,
      })),
  } as unknown as ComputerUseService;
}

describe("Computer-use agent — real Linux end-to-end with stub VLM", () => {
  it(
    "captures live screen frames, walks wait→finish, terminates cleanly",
    async () => {
      // Try a real capture once. If the host has no screen tools we skip,
      // since the env is the constraint, not the cascade logic.
      let captures: DisplayCapture[] = [];
      try {
        captures = await captureAllDisplays();
      } catch (err) {
        console.warn(
          `[computer-use-agent.real] live capture failed (${String(err)}); skipping real-screen E2E`,
        );
        return;
      }
      expect(captures.length).toBeGreaterThan(0);
      // PNG signature on the first capture proves it's a real frame.
      expect(captures[0]?.frame.subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );

      let step = 0;
      const brain = new Brain(null, {
        invokeModel: async () => {
          step += 1;
          if (step === 1) {
            return JSON.stringify({
              scene_summary: "screen captured",
              target_display_id: captures[0]!.display.id,
              roi: [],
              proposed_action: { kind: "wait", rationale: "wait one tick" },
            });
          }
          return JSON.stringify({
            scene_summary: "done",
            target_display_id: captures[0]!.display.id,
            roi: [],
            proposed_action: { kind: "finish", rationale: "goal reached" },
          });
        },
      });

      const report: ComputerUseAgentReport = await runComputerUseAgentLoop(
        null,
        { goal: "wait then finish", maxSteps: 5 },
        fakeService(),
        { brain, captureAll: async () => captures },
      );
      expect(report.reason).toBe("finish");
      expect(report.finished).toBe(true);
      expect(report.steps.length).toBe(2);
      expect(report.steps[0]?.actionKind).toBe("wait");
      expect(report.steps[1]?.actionKind).toBe("finish");
      expect(report.steps[0]?.result.success).toBe(true);
      expect(report.steps[1]?.result.success).toBe(true);
    },
    60_000,
  );
});
