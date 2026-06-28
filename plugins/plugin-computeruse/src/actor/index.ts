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
  type AgentDispatchContext,
  type AgentMiddleware,
  type AgentRunContext,
  type AgentRunSummary,
  type AgentStepContext,
  type AgentStepDecision,
  type BudgetCapOptions,
  createBudgetCapMiddleware,
  createImageRetentionMiddleware,
  createOperatorNormalizerMiddleware,
  createTrajectoryMiddleware,
  type ImageRetentionMiddleware,
  normalizeProposedAction,
  type TrajectoryEntry,
  type TrajectoryMiddleware,
} from "./agent-callbacks.js";
export {
  _resetAgentLoopsForTests,
  AGENT_LOOP_SETTING,
  type AgentLoop,
  type AgentLoopDeps,
  type AgentLoopRegistration,
  type AgentStepInput,
  createAgentLoop,
  DEFAULT_AGENT_LOOP_MODEL,
  LocalGrounderLoop,
  listAgentLoops,
  matchesModelFamily,
  type PredictClickInput,
  registerAgentLoop,
  selectAgentLoopRegistration,
  unregisterAgentLoop,
} from "./agent-loop.js";
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
