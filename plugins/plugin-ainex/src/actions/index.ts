// The plugin ships two action surfaces:
//
//   `actions`   — the default 15-action "programmatic" mode. Each action
//                 maps to a specific bridge command (walk.set, head.set,
//                 action.play, etc.). This is what the plugin registers
//                 by default.
//
//   `runRlAction` — a single opt-in action that ships free-form chat text
//                   to `policy.start` for the text-conditioned RL policy.
//                   Enable by adding `runRlAction` to your character's
//                   plugin config or via `selectActions(runtime, "rl")`
//                   for a custom mode.
//
// The `selectActions(runtime)` helper resolves the surface from
// `ELIZA_AINEX_MODE` ("programmatic" | "rl" | "both"; default
// "programmatic").

import type { Action, IAgentRuntime } from "@elizaos/core";
import { bowAction } from "./bow";
import { pickUpAction } from "./pickUp";
import { placeDownAction } from "./placeDown";
import { runActionGroupAction } from "./runActionGroup";
import { runRlAction } from "./runRl";
import { setServoAction } from "./setServo";
import { sideStepLeftAction } from "./sideStepLeft";
import { sideStepRightAction } from "./sideStepRight";
import { sitAction } from "./sit";
import { standAction } from "./stand";
import { stopAction } from "./stop";
import { turnLeftAction } from "./turnLeft";
import { turnRightAction } from "./turnRight";
import { walkBackwardAction } from "./walkBackward";
import { walkForwardAction } from "./walkForward";
import { waveAction } from "./wave";

export {
  bowAction,
  pickUpAction,
  placeDownAction,
  runActionGroupAction,
  runRlAction,
  setServoAction,
  sideStepLeftAction,
  sideStepRightAction,
  sitAction,
  standAction,
  stopAction,
  turnLeftAction,
  turnRightAction,
  walkBackwardAction,
  walkForwardAction,
  waveAction,
};

const PROGRAMMATIC_ACTIONS: readonly Action[] = [
  walkForwardAction,
  walkBackwardAction,
  sideStepLeftAction,
  sideStepRightAction,
  turnLeftAction,
  turnRightAction,
  stopAction,
  standAction,
  sitAction,
  waveAction,
  bowAction,
  pickUpAction,
  placeDownAction,
  setServoAction,
  runActionGroupAction,
];

export const actions: Action[] = [...PROGRAMMATIC_ACTIONS];

/**
 * Resolve the action surface from `ELIZA_AINEX_MODE` setting.
 *   "programmatic" (default) → 15 actions
 *   "rl"                      → [runRlAction]
 *   "both"                    → 15 + runRl = 16
 */
export function selectActions(runtime: IAgentRuntime): Action[] {
  const mode = String(
    runtime.getSetting("ELIZA_AINEX_MODE") ?? "programmatic",
  ).toLowerCase();
  if (mode === "rl") return [runRlAction];
  if (mode === "both") return [...PROGRAMMATIC_ACTIONS, runRlAction];
  return [...PROGRAMMATIC_ACTIONS];
}
