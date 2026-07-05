/**
 * The correlation header that joins the three otherwise-disjoint trace stores —
 * the file `RecordedTrajectory` (trajectory-recorder.ts), the DB
 * `TrajectoriesService`, and the orchestrator's `OrchestratorTaskDocument`
 * (#13775). The schemas are NOT merged (different consumers); each carries this
 * additive envelope so a parent turn, its DB row, and any sub-agent trajectory
 * it spawned can be stitched back together on a single `traceId`.
 *
 * `traceId` is minted at the root turn (message.ts) and propagated to spawned
 * sub-agents through the env vars below; a sub-agent's own recorder reads them
 * back via {@link resolveTraceCorrelationFromEnv} so its inner model
 * prompts/responses land under the parent's trace.
 */

export interface TraceCorrelation {
	/** Root-turn identifier every joined store shares. Minted once, propagated. */
	traceId: string;
	/** Scenario/run this trace belongs to, when driven by the scenario CLI. */
	runId?: string;
	/** Room the root turn ran in. */
	roomId?: string;
	/** Orchestrator task this trace (or its sub-agent) belongs to. */
	taskId?: string;
	/** ACP session id of the sub-agent that produced a child trajectory. */
	sessionId?: string;
	/** Parent trajectory step id a child trajectory hangs off. */
	parentStepId?: string;
	/** Ingested child trajectory id, stamped when attaching a sub-agent trace. */
	childTrajectoryId?: string;
}

/**
 * Env keys carrying the correlation header across a process boundary (parent →
 * spawned sub-agent). The orchestrator stamps these onto `SpawnOptions.env`;
 * they must be set explicitly rather than left to the broad `ELIZA_` forwarding
 * so a child never inherits an ambiguous parent value.
 */
export const TRACE_ENV = {
	TRACE_ID: "ELIZA_TRACE_ID",
	TASK_ID: "ELIZA_TASK_ID",
	PARENT_STEP_ID: "ELIZA_PARENT_TRAJECTORY_STEP_ID",
} as const;

/**
 * Read whatever correlation the current process inherited from its spawner.
 * A root turn has none of these set; a spawned sub-agent has at least
 * `ELIZA_TRACE_ID`. Returns only the fields actually present — `traceId` is
 * optional here (unlike the interface) precisely because the caller decides
 * whether to mint one when absent.
 */
export function resolveTraceCorrelationFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): Partial<TraceCorrelation> {
	const out: Partial<TraceCorrelation> = {};
	const traceId = env[TRACE_ENV.TRACE_ID]?.trim();
	if (traceId) out.traceId = traceId;
	const taskId = env[TRACE_ENV.TASK_ID]?.trim();
	if (taskId) out.taskId = taskId;
	const parentStepId = env[TRACE_ENV.PARENT_STEP_ID]?.trim();
	if (parentStepId) out.parentStepId = parentStepId;
	return out;
}
