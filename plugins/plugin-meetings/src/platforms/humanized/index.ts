/** Humanized input layer public surface. */

export {
  PlaywrightInputDriver,
  selectInputDriver,
  XtestInputDriver,
} from "./input-driver.js";
export { buildMocapLibrary, MOCAP_LIBRARY, MocapEngine } from "./mocap.js";
export type {
  InputDriver,
  MocapLibrary,
  MocapMovement,
  MocapSequence,
  Rect,
} from "./types.js";
export {
  type PointerLocation,
  X11Input,
  type X11InputOptions,
} from "./x11-input.js";
