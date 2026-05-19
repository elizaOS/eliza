import type { Action } from "@elizaos/core";
import { bowAction } from "./bow";
import { pickUpAction } from "./pickUp";
import { placeDownAction } from "./placeDown";
import { runActionGroupAction } from "./runActionGroup";
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

export const actions: Action[] = [
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
