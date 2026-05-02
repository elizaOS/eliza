/**
 * Trajectory Context — Tag orchestrator LLM calls for trajectory logging.
 *
 * Sets a lightweight context object on the runtime before `useModel()` calls
 * so the trajectory logger can identify orchestrator-specific LLM invocations
 * (coordination decisions, stall classification, idle checks, etc.) and tag
 * them with meaningful metadata instead of the generic "action" / "runtime.useModel".
 *
 * The eliza trajectory-persistence layer reads `runtime.__orchestratorTrajectoryCtx`
 * in its `appendLlmCall` patch and writes the context into the trajectory record.
 *
 * @module services/trajectory-context
 */

/**
 * Any runtime-like object. We accept both `AgentRuntime` and `IAgentRuntime`
 * since different call sites use different types. Using a minimal interface
 * avoids index-signature incompatibilities with ElizaOS types.
 */
type RuntimeLike = object;

/**
 * Orchestrator decision types that map to specific LLM call sites.
 */
export type OrchestratorDecisionType =
  | "coordination"
  | "turn-complete"
  | "idle-check"
  | "stall-classification"
  | "stall-classify-decide"
  | "swarm-context-generation"
  | "event-triage"
  | "launch-failure-message"
  | "task-validation"
  | "acceptance-verifier";

export interface OrchestratorTrajectoryContext {
  /** Source identifier — always "orchestrator" */
  source: "orchestrator";
  /** Which decision type triggered this LLM call */
  decisionType: OrchestratorDecisionType;
  /** PTY session ID of the agent being evaluated */
  sessionId?: string;
  /** Durable task thread identifier */
  threadId?: string;
  /** Acceptance verifier job identifier */
  verifierJobId?: string;
  /** Human-readable task label */
  taskLabel?: string;
  /** Repository URL or identifier (for trajectory feedback filtering) */
  repo?: string;
  /** Workspace directory path */
  workdir?: string;
  /** Original task description assigned to the agent */
  originalTask?: string;
}

const CTX_KEY = "__orchestratorTrajectoryCtx";

/**
 * Set orchestrator trajectory context on the runtime.
 * Call this before `runtime.useModel()` and clear it after.
 */
export function setTrajectoryContext(
  runtime: RuntimeLike,
  ctx: OrchestratorTrajectoryContext,
): void {
  (runtime as Record<string, unknown>)[CTX_KEY] = ctx;
}

/**
 * Clear orchestrator trajectory context from the runtime.
 */
export function clearTrajectoryContext(runtime: RuntimeLike): void {
  (runtime as Record<string, unknown>)[CTX_KEY] = undefined;
}

/**
 * Read the current orchestrator trajectory context (if any).
 * Used by the trajectory logger on the eliza side.
 */
export function readTrajectoryContext(
  runtime: unknown,
): OrchestratorTrajectoryContext | undefined {
  if (!runtime || typeof runtime !== "object") return undefined;
  const ctx = (runtime as Record<string, unknown>)[CTX_KEY];
  if (!ctx || typeof ctx !== "object") return undefined;
  const candidate = ctx as Partial<OrchestratorTrajectoryContext>;
  if (candidate.source !== "orchestrator" || !candidate.decisionType)
    return undefined;
  return candidate as OrchestratorTrajectoryContext;
}

/**
 * Wrap a `useModel()` call with trajectory context tagging.
 * Ensures the context is always cleared, even if the call throws.
 *
 * @example
 * ```ts
 * const result = await withTrajectoryContext(
 *   ctx.runtime,
 *   { source: "orchestrator", decisionType: "coordination", sessionId },
 *   () => ctx.runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
 * );
 * ```
 */
export async function withTrajectoryContext<T>(
  runtime: RuntimeLike,
  ctx: OrchestratorTrajectoryContext,
  fn: () => Promise<T>,
): Promise<T> {
  setTrajectoryContext(runtime, ctx);
  try {
    return await fn();
  } finally {
    clearTrajectoryContext(runtime);
  }
}
