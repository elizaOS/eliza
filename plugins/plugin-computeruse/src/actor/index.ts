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
  Brain,
  BrainParseError,
  BRAIN_MAX_PIXELS,
  BRAIN_MAX_ROIS,
  brainPromptFor,
  encodeForBrain,
  parseBrainOutput,
  type BrainDeps,
  type BrainInput,
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
  makeComputerInterface,
  type MouseButton,
  type ScreenshotResult,
  type ScrollDelta,
} from "./computer-interface.js";
export { dispatch, type DispatchDeps } from "./dispatch.js";
export {
  type ActionResult as ActorActionResult,
  type BrainActionKind,
  type BrainOutput,
  type BrainProposedAction,
  type BrainRoi,
  type CascadeResult,
  type GroundingResult,
  type ProposedAction,
  type ReferenceTarget,
} from "./types.js";
