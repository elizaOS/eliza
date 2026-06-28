/**
 * #9105 §9 — Multi-display coordinate routing (deterministic, zero-cost).
 *
 * The EPIC's "Have vs Want" row for "multi-display coords" is: capture / OCR /
 * coords must be display-absolute and the correct display must be targeted. A
 * click grounded against text on a *non-primary* display must (a) route to that
 * display's id and (b) resolve to a global pixel point with that display's
 * origin offset applied — not the primary's.
 *
 * This scenario proves the contract end-to-end across the two real seams that
 * own it, with no live model and no real desktop:
 *
 *   1. displayId ROUTING — the real `OcrCoordinateGroundingActor.ground()`
 *      resolves a Brain `ref`/hint against the scene's OCR boxes. The matched
 *      box carries its own `displayId`, so grounding returns
 *      `target.displayId` (here display 1, the secondary). When the same label
 *      ("Save") exists on BOTH displays, `resolveReference`'s preference score
 *      routes the hint to the *requested* display, not the primary.
 *
 *   2. display-absolute COORDS — the real `DefaultComputerInterface` is driven
 *      with an injected 2-display registry (display 0 at origin (0,0),
 *      display 1 at origin (2560,0)) and a fake input driver that records the
 *      global pixel point each click is dispatched to. The grounded
 *      display-local bbox-center, dispatched on display 1, lands at
 *      `display1.bounds.x + localX` — the secondary origin offset is applied.
 *
 *   3. ROUTING is STRICT — `requireDisplay` throws on an unknown displayId; the
 *      interface never silently falls back to the primary. The scenario asserts
 *      the throw so "route to the right display" can't degrade to "route to
 *      whatever's primary".
 *
 * The check surface is the executor's load-bearing set only: `assertTurn`
 * (reads `result.success`/`result.data`), an `actionCalled` `status:"success"`
 * gate, `selectedActionArguments` (reads the action's params + `result.text`),
 * and a `custom` predicate that reads the module-scoped step record. No
 * `plannerIncludesAll`/`plannerExcludes` (dead no-op fields).
 */

import type { Action } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { OcrCoordinateGroundingActor } from "../../../../plugins/plugin-computeruse/src/actor/actor.ts";
import {
  type ComputerInterface,
  type DisplayPoint,
  makeComputerInterface,
} from "../../../../plugins/plugin-computeruse/src/actor/computer-interface.ts";
import type { Scene } from "../../../../plugins/plugin-computeruse/src/scene/scene-types.ts";
import type { DisplayDescriptor } from "../../../../plugins/plugin-computeruse/src/types.ts";

// ── two-display fixture ──────────────────────────────────────────────────────
// Display 0 is the primary at origin (0,0); display 1 is the secondary placed
// to its right at origin (2560,0). A "Save" OCR box exists on BOTH displays so
// the hint path has to *route* rather than pick the only candidate.
const PRIMARY: DisplayDescriptor = {
  id: 0,
  bounds: [0, 0, 2560, 1600],
  scaleFactor: 1,
  primary: true,
  name: "eDP-1",
};
const SECONDARY: DisplayDescriptor = {
  id: 1,
  bounds: [2560, 0, 3840, 2160],
  scaleFactor: 1,
  primary: false,
  name: "HDMI-0",
};
const DISPLAYS: DisplayDescriptor[] = [PRIMARY, SECONDARY];

// Display-local bbox [x, y, w, h] of the Save button on each display.
const SAVE_BBOX_LOCAL: [number, number, number, number] = [320, 200, 80, 32];
// Display-local bbox-center the grounder resolves to: (360, 216).
const LOCAL_CENTER_X = SAVE_BBOX_LOCAL[0] + SAVE_BBOX_LOCAL[2] / 2;
const LOCAL_CENTER_Y = SAVE_BBOX_LOCAL[1] + SAVE_BBOX_LOCAL[3] / 2;
// Brain wants to click Save on the SECONDARY display.
const TARGET_DISPLAY = SECONDARY.id;
// Global pixel point with the secondary origin offset applied:
//   (2560 + 360, 0 + 216) = (2920, 216).
const EXPECTED_GLOBAL_X = SECONDARY.bounds[0] + LOCAL_CENTER_X;
const EXPECTED_GLOBAL_Y = SECONDARY.bounds[1] + LOCAL_CENTER_Y;
// The Brain ref points at the secondary display's Save box id `t1-1`.
const TARGET_REF = "t1-1";

function fixtureScene(): Scene {
  return {
    timestamp: 1_700_000_000_000,
    displays: DISPLAYS,
    focused_window: null,
    apps: [],
    ocr: [
      // Save on the PRIMARY (a decoy the routing must NOT pick for the hint).
      {
        id: "t0-1",
        text: "Save",
        bbox: SAVE_BBOX_LOCAL,
        conf: 0.99,
        displayId: PRIMARY.id,
      },
      // Save on the SECONDARY (the routing target).
      {
        id: TARGET_REF,
        text: "Save",
        bbox: SAVE_BBOX_LOCAL,
        conf: 0.99,
        displayId: SECONDARY.id,
      },
    ],
    ax: [],
    vlm_scene: null,
    vlm_elements: null,
  };
}

interface MultiDisplayRecord {
  /** displayId the grounder routed to. */
  groundedDisplayId: number;
  /** display-local click point from the grounder. */
  local: { x: number; y: number };
  /** global pixel point the click was dispatched to. */
  global: { x: number; y: number };
  /** whether targeting an unknown displayId was rejected (strict routing). */
  unknownDisplayRejected: boolean;
}

// Module-scoped so a custom finalCheck can read the recorded routing.
let lastRecord: MultiDisplayRecord | null = null;

/**
 * Run the real grounding → dispatch path once on the secondary display and
 * record where the click landed in global pixel space.
 */
async function runMultiDisplayDispatch(): Promise<MultiDisplayRecord> {
  // 1. ROUTE: the real OCR/AX grounder picks the Save box on the requested
  //    (secondary) display via its `ref`, and returns display-local coords
  //    tagged with that display's id.
  const actor = new OcrCoordinateGroundingActor(() => fixtureScene());
  const grounded = await actor.ground({
    displayId: TARGET_DISPLAY,
    croppedImage: Buffer.alloc(0),
    hint: "Save",
    ref: TARGET_REF,
  });

  // 2. TRANSLATE: the real ComputerInterface, driven with the 2-display
  //    registry + a fake driver, maps the display-local point to a global
  //    point with the secondary display's origin offset applied.
  let dispatched: { x: number; y: number } | null = null;
  const iface: ComputerInterface = makeComputerInterface({
    listDisplays: () => DISPLAYS,
    driver: {
      click: async (x: number, y: number) => {
        dispatched = { x, y };
      },
    },
  });
  const point: DisplayPoint = {
    displayId: grounded.displayId,
    x: grounded.x,
    y: grounded.y,
  };
  await iface.leftClick(point);
  if (!dispatched) {
    throw new Error("[scenario] click was never dispatched to the driver");
  }

  // 3. STRICT: an unknown displayId must be rejected, never coerced to primary.
  let unknownDisplayRejected = false;
  try {
    await iface.leftClick({ displayId: 999, x: 0, y: 0 });
  } catch {
    unknownDisplayRejected = true;
  }

  const record: MultiDisplayRecord = {
    groundedDisplayId: grounded.displayId,
    local: { x: grounded.x, y: grounded.y },
    global: dispatched,
    unknownDisplayRejected,
  };
  lastRecord = record;
  return record;
}

const multiDisplayAction: Action = {
  name: "MULTI_DISPLAY_ROUTE",
  description:
    "Scenario-only: ground a click on a non-primary display and dispatch it; proves displayId routing + display-absolute coords.",
  validate: async () => true,
  handler: async (_runtime, _message, _state, _options, callback) => {
    const rec = await runMultiDisplayDispatch();
    const routedToSecondary = rec.groundedDisplayId === TARGET_DISPLAY;
    const globalOffsetApplied =
      rec.global.x === EXPECTED_GLOBAL_X && rec.global.y === EXPECTED_GLOBAL_Y;
    const ok =
      routedToSecondary && globalOffsetApplied && rec.unknownDisplayRejected;
    // `result.text` is part of the `selectedActionArguments` blob, so the
    // routed displayId + global coords are asserted as load-bearing arguments.
    const text =
      `Routed to displayId=${rec.groundedDisplayId}; ` +
      `local=(${rec.local.x},${rec.local.y}); ` +
      `global=(${rec.global.x},${rec.global.y}); ` +
      `unknownDisplayRejected=${rec.unknownDisplayRejected}`;
    if (callback) await callback({ text, actions: ["MULTI_DISPLAY_ROUTE"] });
    return {
      success: ok,
      text,
      values: {
        groundedDisplayId: rec.groundedDisplayId,
        globalX: rec.global.x,
        globalY: rec.global.y,
      },
      data: { actionName: "MULTI_DISPLAY_ROUTE", ...rec },
    };
  },
};

async function seedMultiDisplay(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const runtime = ctx.runtime as { actions?: Action[] } | undefined;
  if (!runtime) return "scenario runtime was not available";
  lastRecord = null;
  runtime.actions = [
    ...(runtime.actions ?? []).filter((a) => a.name !== "MULTI_DISPLAY_ROUTE"),
    multiDisplayAction,
  ];
  return undefined;
}

function expectMultiDisplayRouting(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = execution.actionsCalled.find(
    (a) => a.actionName === "MULTI_DISPLAY_ROUTE",
  );
  if (!action) return "MULTI_DISPLAY_ROUTE was not called";
  if (action.result?.success !== true) {
    return `multi-display dispatch result.success !== true: ${JSON.stringify(action.result)}`;
  }
  const data = action.result?.data as MultiDisplayRecord | undefined;
  if (!data) return "multi-display dispatch produced no record";
  if (data.groundedDisplayId !== TARGET_DISPLAY) {
    return `grounded displayId ${data.groundedDisplayId} !== secondary display ${TARGET_DISPLAY}`;
  }
  if (
    data.global.x !== EXPECTED_GLOBAL_X ||
    data.global.y !== EXPECTED_GLOBAL_Y
  ) {
    return `global click [${data.global.x},${data.global.y}] !== secondary-absolute [${EXPECTED_GLOBAL_X},${EXPECTED_GLOBAL_Y}] (origin offset not applied)`;
  }
  if (!data.unknownDisplayRejected) {
    return "an unknown displayId was NOT rejected — routing silently fell back instead of failing";
  }
  return undefined;
}

export default scenario({
  id: "deterministic-computeruse-multi-display",
  lane: "pr-deterministic",
  title: "Multi-display click routes to the right display in absolute coords",
  domain: "computeruse",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "computeruse",
    "multi-display",
    "coords",
  ],
  isolation: "shared-runtime",
  seed: [
    {
      type: "custom",
      name: "register a scenario multi-display routing action",
      apply: seedMultiDisplay,
    },
  ],
  turns: [
    {
      kind: "action",
      name: "click Save on the secondary display routes + offsets correctly",
      actionName: "MULTI_DISPLAY_ROUTE",
      text: "Click Save on the second monitor",
      assertTurn: expectMultiDisplayRouting,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "MULTI_DISPLAY_ROUTE",
      status: "success",
      minCount: 1,
    },
    {
      // The routed displayId + display-absolute global coords are carried in
      // the action's `result.text`, which `selectedActionArguments` reads.
      type: "selectedActionArguments",
      actionName: "MULTI_DISPLAY_ROUTE",
      includesAll: [
        `displayId=${TARGET_DISPLAY}`,
        `global=(${EXPECTED_GLOBAL_X},${EXPECTED_GLOBAL_Y})`,
        "unknownDisplayRejected=true",
      ],
    },
    {
      type: "custom",
      name: "click routed to the secondary display with its origin offset applied and unknown displays rejected",
      predicate: (): string | undefined => {
        if (!lastRecord) return "multi-display dispatch did not run";
        if (lastRecord.groundedDisplayId !== TARGET_DISPLAY) {
          return `routed to display ${lastRecord.groundedDisplayId}, expected ${TARGET_DISPLAY}`;
        }
        if (
          lastRecord.local.x !== LOCAL_CENTER_X ||
          lastRecord.local.y !== LOCAL_CENTER_Y
        ) {
          return `display-local center [${lastRecord.local.x},${lastRecord.local.y}] !== [${LOCAL_CENTER_X},${LOCAL_CENTER_Y}]`;
        }
        if (
          lastRecord.global.x !== EXPECTED_GLOBAL_X ||
          lastRecord.global.y !== EXPECTED_GLOBAL_Y
        ) {
          return `global click [${lastRecord.global.x},${lastRecord.global.y}] drifted from secondary-absolute [${EXPECTED_GLOBAL_X},${EXPECTED_GLOBAL_Y}]`;
        }
        if (!lastRecord.unknownDisplayRejected) {
          return "unknown displayId was not rejected by requireDisplay";
        }
        return undefined;
      },
    },
  ],
});
