/**
 * Type contracts for the LifeOps-shaped scheduled-task layer.
 *
 * These extend the existing core `Task` shape with the structural fields the
 * personal-assistant plugin attaches today: gates, escalation, completion
 * checks, anchors, and pipeline hooks. The runtime side of these contracts is
 * stubbed in ./runner.ts; the real runner currently lives in the plugin.
 *
 * STUB — see ./README.md for the tracked migration.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/scheduled-task/types.ts ->
 *               packages/core/src/scheduled-task/types.ts)
 */

import type { Task } from "../types/task.js";

/** Reference to a gate registered in the GateRegistry. */
export interface GateSpec {
	readonly gateId: string;
	/** Optional per-task arguments forwarded to the gate evaluator. */
	readonly args?: Record<string, unknown>;
}

/** Reference to an escalation ladder registered in the EscalationLadderRegistry. */
export interface EscalationLadderRef {
	readonly ladderId: string;
	/** Optional per-task overrides — additional context passed to step handlers. */
	readonly context?: Record<string, unknown>;
}

/**
 * A completion check the runner consults to decide whether a fired task is
 * "done" or needs another pass. Returning `done: false` keeps the task in the
 * follow-up loop without rescheduling it from scratch.
 */
export type CompletionCheck = (
	task: ScheduledTask,
) => Promise<CompletionCheckResult> | CompletionCheckResult;

export type CompletionCheckResult =
	| { readonly done: true }
	| { readonly done: false; readonly reason?: string };

/** Reference to an anchor registered in the AnchorRegistry. */
export interface AnchorRef {
	readonly anchorId: string;
	/** Optional offset expression — interpretation owned by the implementation. */
	readonly offset?: string;
}

/** Hooks the runner invokes around each fire of a scheduled task. */
export interface PipelineHooks {
	beforeFire?: (task: ScheduledTask) => Promise<void> | void;
	afterFire?: (task: ScheduledTask) => Promise<void> | void;
	onError?: (task: ScheduledTask, error: unknown) => Promise<void> | void;
}

/**
 * The LifeOps-shaped scheduled task. Extends the core `Task` with the
 * structural fields described above. All extension fields are optional so an
 * ordinary core `Task` is still a valid `ScheduledTask`.
 */
export interface ScheduledTask extends Task {
	readonly gates?: readonly GateSpec[];
	readonly escalation?: EscalationLadderRef;
	readonly completionCheck?: CompletionCheck;
	readonly anchors?: readonly AnchorRef[];
	readonly pipeline?: PipelineHooks;
}
