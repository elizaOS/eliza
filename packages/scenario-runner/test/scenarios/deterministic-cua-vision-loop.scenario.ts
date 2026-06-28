/**
 * #9105 §9 — CUA Brain→dispatch vision loop (deterministic, zero-cost).
 *
 * Proves two already-landed seams together, with no live model and no device:
 *
 *   1. Click-by-OCR-text: the real `OcrCoordinateGroundingActor` resolves a
 *      `ref`/hint against the scene's OCR boxes and returns a click point at
 *      the matched box's display-absolute center (the M2 grounding path).
 *   2. dHash describe-dedup: the real `Brain` is driven over N IDENTICAL frames
 *      for the same goal. Because the frame dHash + goal are unchanged, the
 *      (otherwise remote) IMAGE_DESCRIPTION model is invoked at most once and
 *      every subsequent observe is served from the call-site dHash cache —
 *      `Brain.getStats().invocations` stays at 1 while `cacheHits` grows.
 *
 * Each loop step also runs the real `buildGetScreen` over the same fixture
 * frame to "verify" the screen, exercising the GET_SCREEN OCR path on the
 * verify half of the loop.
 */

import { deflateSync } from "node:zlib";
import type { Action } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { OcrCoordinateGroundingActor } from "../../../../plugins/plugin-computeruse/src/actor/actor.ts";
import {
  Brain,
  type BrainStats,
} from "../../../../plugins/plugin-computeruse/src/actor/brain.ts";
import type { DisplayCapture } from "../../../../plugins/plugin-computeruse/src/platform/capture.ts";
import type {
  Scene,
  SceneOcrBox,
} from "../../../../plugins/plugin-computeruse/src/scene/scene-types.ts";
import { buildGetScreen } from "../../../../plugins/plugin-vision/src/get-screen.ts";
import type {
  OcrWithCoordsInput,
  OcrWithCoordsResult,
  OcrWithCoordsService,
} from "../../../../plugins/plugin-vision/src/ocr-with-coords.ts";

// ── fixture PNG synthesizer (16x16 RGB) ──────────────────────────────────────
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makeTinyPng(seed = 0): Buffer {
  const w = 16;
  const h = 16;
  const rows: number[] = [];
  for (let y = 0; y < h; y += 1) {
    rows.push(0);
    for (let x = 0; x < w; x += 1) {
      const v = ((x + seed) * 16) % 255;
      rows.push(v, v, v);
    }
  }
  const idat = deflateSync(Buffer.from(rows));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const DISPLAY_ID = 0;
const FRAME_SEED = 23;
const LOOP_STEPS = 4;
const SAVE_BOX: SceneOcrBox = {
  id: "t0-1",
  text: "Save",
  bbox: [320, 200, 80, 32],
  conf: 0.99,
  displayId: DISPLAY_ID,
};

function fixtureScene(): Scene {
  return {
    timestamp: 1_700_000_000_000,
    displays: [
      {
        id: DISPLAY_ID,
        bounds: [0, 0, 16, 16],
        scaleFactor: 1,
        primary: true,
        name: "scenario-display",
      },
    ],
    focused_window: null,
    apps: [],
    ocr: [SAVE_BOX],
    ax: [],
    vlm_scene: null,
    vlm_elements: null,
  };
}

function fixtureCapture(): Map<number, DisplayCapture> {
  const m = new Map<number, DisplayCapture>();
  m.set(DISPLAY_ID, {
    display: {
      id: DISPLAY_ID,
      bounds: [0, 0, 16, 16],
      scaleFactor: 1,
      primary: true,
      name: "scenario-display",
    },
    frame: makeTinyPng(FRAME_SEED),
  });
  return m;
}

// Deterministic Brain output that proposes clicking the Save OCR box.
const BRAIN_OUTPUT = JSON.stringify({
  scene_summary: "A dialog with a Save button is on screen.",
  target_display_id: DISPLAY_ID,
  roi: [],
  proposed_action: {
    kind: "click",
    ref: SAVE_BOX.id,
    rationale: "Click Save to commit.",
  },
});

// Coord-OCR provider used by the GET_SCREEN verify step.
class FixtureCoordOcrProvider implements OcrWithCoordsService {
  readonly name = "fixture-coord-ocr-loop";
  async describe(input: OcrWithCoordsInput): Promise<OcrWithCoordsResult> {
    return {
      blocks: [
        {
          text: SAVE_BOX.text,
          bbox: {
            x: SAVE_BOX.bbox[0] + input.sourceX,
            y: SAVE_BOX.bbox[1] + input.sourceY,
            width: SAVE_BOX.bbox[2],
            height: SAVE_BOX.bbox[3],
          },
          words: [],
          semantic_position: "center",
        },
      ],
    };
  }
}

interface LoopStepRecord {
  step: number;
  brainStats: BrainStats;
  click: { x: number; y: number; displayId: number };
  verifyElements: number;
}

// Module-scoped Brain + records so a custom finalCheck can read the counters.
const brain = new Brain(null, {
  invokeModel: async () => BRAIN_OUTPUT,
});
const ocrActor = new OcrCoordinateGroundingActor(() => fixtureScene());
const ocrProvider = new FixtureCoordOcrProvider();
const stepRecords: LoopStepRecord[] = [];

async function runOneLoopStep(step: number): Promise<LoopStepRecord> {
  // 1. Brain observes the (identical) frame + goal — dedups after the first.
  const plan = await brain.observeAndPlan({
    scene: fixtureScene(),
    goal: "click save",
    captures: fixtureCapture(),
  });
  // 2. Click-by-OCR-text: ground the Brain's ref against the scene's OCR boxes.
  const grounded = await ocrActor.ground({
    displayId: plan.target_display_id,
    croppedImage: Buffer.alloc(0),
    hint: SAVE_BOX.text,
    ref: plan.proposed_action.ref,
  });
  // 3. GET_SCREEN verifies the screen via the real OCR path.
  const verify = await buildGetScreen({
    pngBytes: makeTinyPng(FRAME_SEED),
    displayId: DISPLAY_ID,
    includeOcr: true,
    ocrService: ocrProvider,
  });
  const record: LoopStepRecord = {
    step,
    brainStats: brain.getStats(),
    click: { x: grounded.x, y: grounded.y, displayId: grounded.displayId },
    verifyElements: verify.elementCount,
  };
  stepRecords.push(record);
  return record;
}

const cuaLoopScenarioAction: Action = {
  name: "CUA_VISION_LOOP",
  description:
    "Scenario-only Brain→dispatch loop over identical frames; proves click-by-OCR grounding and dHash describe-dedup.",
  validate: async () => true,
  handler: async (_runtime, _message, _state, _options, callback) => {
    const last = await runOneLoopStep(stepRecords.length + 1);
    const text = `CUA loop step ${last.step}: grounded click at (${last.click.x},${last.click.y}) on display ${last.click.displayId}; Brain invocations=${last.brainStats.invocations} cacheHits=${last.brainStats.cacheHits}`;
    if (callback) await callback({ text, actions: ["CUA_VISION_LOOP"] });
    // Center of the Save box [320,200,80,32] → (360, 216).
    const expectedX = SAVE_BOX.bbox[0] + SAVE_BOX.bbox[2] / 2;
    const expectedY = SAVE_BOX.bbox[1] + SAVE_BOX.bbox[3] / 2;
    const clickOk = last.click.x === expectedX && last.click.y === expectedY;
    return {
      success: clickOk && last.verifyElements === 1,
      text,
      values: {
        invocations: last.brainStats.invocations,
        cacheHits: last.brainStats.cacheHits,
        clickX: last.click.x,
        clickY: last.click.y,
      },
      data: { actionName: "CUA_VISION_LOOP", ...last },
    };
  },
};

async function seedLoop(ctx: ScenarioContext): Promise<string | undefined> {
  const runtime = ctx.runtime as { actions?: Action[] } | undefined;
  if (!runtime) return "scenario runtime was not available";
  stepRecords.length = 0;
  runtime.actions = [
    ...(runtime.actions ?? []).filter((a) => a.name !== "CUA_VISION_LOOP"),
    cuaLoopScenarioAction,
  ];
  return undefined;
}

function expectGroundedClickAndDedup(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = execution.actionsCalled.find(
    (a) => a.actionName === "CUA_VISION_LOOP",
  );
  if (!action) return "CUA_VISION_LOOP was not called";
  if (action.result?.success !== true) {
    return `loop step result.success !== true: ${JSON.stringify(action.result)}`;
  }
  const data = action.result?.data as LoopStepRecord | undefined;
  if (!data) return "loop step produced no record";
  // Click must land on the Save box center: [320,200,80,32] → (360,216).
  if (data.click.x !== 360 || data.click.y !== 216) {
    return `grounded click [${data.click.x},${data.click.y}] !== Save box center [360,216]`;
  }
  // The remote describe model is dedup'd: never more than one invocation.
  if (data.brainStats.invocations > 1) {
    return `Brain invocations grew past 1 on identical frames (saw ${data.brainStats.invocations})`;
  }
  return undefined;
}

export default scenario({
  id: "deterministic-cua-vision-loop",
  lane: "pr-deterministic",
  title: "CUA Brain loop dedups the describe model on identical frames",
  domain: "computeruse",
  tags: ["pr", "deterministic", "zero-cost", "computeruse", "vision", "dhash"],
  isolation: "shared-runtime",
  seed: [
    {
      type: "custom",
      name: "register a scenario CUA vision-loop action",
      apply: seedLoop,
    },
  ],
  turns: Array.from({ length: LOOP_STEPS }, (_, i) => ({
    kind: "action" as const,
    name: `CUA loop step ${i + 1} grounds a click and reuses the cached plan`,
    actionName: "CUA_VISION_LOOP",
    text: "Advance the CUA loop one step",
    assertTurn: expectGroundedClickAndDedup,
  })),
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CUA_VISION_LOOP",
      status: "success",
      minCount: LOOP_STEPS,
    },
    {
      type: "custom",
      name: "across all identical frames the describe model fired at most once and the cache absorbed the rest",
      predicate: (): string | undefined => {
        if (stepRecords.length !== LOOP_STEPS) {
          return `expected ${LOOP_STEPS} loop steps, recorded ${stepRecords.length}`;
        }
        const finalStats = brain.getStats();
        if (finalStats.invocations !== 1) {
          return `expected exactly 1 IMAGE_DESCRIPTION invocation across ${LOOP_STEPS} identical frames, saw ${finalStats.invocations}`;
        }
        // First step is the model call; the remaining steps are cache hits.
        if (finalStats.cacheHits !== LOOP_STEPS - 1) {
          return `expected ${LOOP_STEPS - 1} cache hits, saw ${finalStats.cacheHits}`;
        }
        // Every recorded step must show the same grounded click point.
        for (const r of stepRecords) {
          if (r.click.x !== 360 || r.click.y !== 216) {
            return `step ${r.step} click [${r.click.x},${r.click.y}] drifted from Save box center [360,216]`;
          }
        }
        return undefined;
      },
    },
  ],
});
