/**
 * WS7 — Brain / Actor / Cascade public surface.
 */

export {
  type Actor,
  type ActorGroundArgs,
  OcrCoordinateGroundingActor,
  OsAtlasProActor,
  type OsAtlasProActorOptions,
  resolveReference,
} from "./actor.js";
export {
  BRAIN_MAX_PIXELS,
  BRAIN_MAX_ROIS,
  Brain,
  type BrainDeps,
  type BrainInput,
  BrainParseError,
  brainPromptFor,
  encodeForBrain,
  parseBrainOutput,
} from "./brain.js";
export {
  Cascade,
  type CascadeDeps,
  type CascadeInput,
  getRegisteredActor,
  setActor,
} from "./cascade.js";
export {
  type ComputerInterface,
  type ComputerInterfaceDeps,
  type CursorPosition,
  DefaultComputerInterface,
  type DisplayPoint,
  type DragPath,
  type MouseButton,
  makeComputerInterface,
  type ScreenshotResult,
  type ScrollDelta,
} from "./computer-interface.js";
export { type DispatchDeps, dispatch } from "./dispatch.js";
export type {
  ActionResult as ActorActionResult,
  BrainActionKind,
  BrainOutput,
  BrainProposedAction,
  BrainRoi,
  CascadeResult,
  GroundingResult,
  ProposedAction,
  ReferenceTarget,
} from "./types.js";
