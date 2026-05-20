/**
 * DAG Trace - Full observability for game tick execution.
 *
 * Enable with FEED_DAG_TRACE=true environment variable.
 * Captures all inputs/outputs at every DAG node, full LLM prompts/responses,
 * and per-NPC agent trajectories.
 */

export { GAME_TICK_DAG, PHASE_COLORS } from "./dag-definition";
export {
  getLLMCallCallback,
  installLLMInterceptor,
  setLLMCallCallback,
  uninstallLLMInterceptor,
} from "./llm-interceptor";
export { endTrace, getActiveTracer, startTrace, TickTracer } from "./tracer";
export type {
  DagDefinition,
  DagNodeDefinition,
  EdgeDefinition,
  LLMCallInput,
  LLMCallTrace,
  NodeTrace,
  NPCDecision,
  NPCGroupMessage,
  NPCPost,
  NPCTickTrajectory,
  NPCTrade,
  SubOperation,
  TickTrace,
  TokenStatsSummary,
} from "./types";
export { writeTickTrace } from "./writer";
