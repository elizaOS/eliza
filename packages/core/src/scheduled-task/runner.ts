/**
 * ScheduledTaskRunner — wraps the existing core task-scheduler with the
 * LifeOps-shaped extensions (gates / escalation / completion checks / anchors
 * / pipeline hooks).
 *
 * STUB. The real implementation lives in
 *   plugins/plugin-personal-assistant/src/lifeops/scheduled-task/runner.ts
 * and migrates here per ./README.md.
 *
 * Design note: this class does NOT replace `services/task-scheduler.ts` — it
 * composes on top of it. The base scheduler still owns the timer, dirty-agent
 * tracking, and DB fetching; this runner only adds the structural pre/post
 * processing for LifeOps-shaped tasks.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/scheduled-task/runner.ts ->
 *               packages/core/src/scheduled-task/runner.ts)
 */

import type { ScheduledTask } from "./types.js";

/**
 * Construction options for the runner. The real runner will accept the gate /
 * escalation / anchor registries plus a handle to the base task-scheduler.
 * The stub leaves the shape narrow to avoid premature commitment.
 */
export interface ScheduledTaskRunnerOptions {
	/** Optional tag — useful for logging once the real runner lands. */
	readonly label?: string;
}

export interface ScheduledTaskRunner {
	/** Evaluate all configured gates for the task; resolves to `true` if every gate is open. */
	checkGates(task: ScheduledTask): Promise<boolean>;
	/** Fire a single scheduled task through the full pipeline (beforeFire → execute → afterFire). */
	fire(task: ScheduledTask): Promise<void>;
	/** Run the configured completionCheck, if any. Tasks without a check are treated as done. */
	checkCompletion(task: ScheduledTask): Promise<boolean>;
	/** Climb the configured escalation ladder one step. */
	escalate(task: ScheduledTask): Promise<void>;
}

/**
 * Stub runner. Every method throws "not implemented".
 *
 * Once migrated, this class will hold references to the gate / escalation /
 * anchor registries and delegate timer + DB work to the base task-scheduler.
 */
export class StubScheduledTaskRunner implements ScheduledTaskRunner {
	constructor(private readonly opts: ScheduledTaskRunnerOptions = {}) {}

	get label(): string {
		return this.opts.label ?? "scheduled-task-runner";
	}

	async checkGates(_task: ScheduledTask): Promise<boolean> {
		throw new Error(
			"[StubScheduledTaskRunner] not implemented — see packages/core/src/scheduled-task/README.md",
		);
	}

	async fire(_task: ScheduledTask): Promise<void> {
		throw new Error(
			"[StubScheduledTaskRunner] not implemented — see packages/core/src/scheduled-task/README.md",
		);
	}

	async checkCompletion(_task: ScheduledTask): Promise<boolean> {
		throw new Error(
			"[StubScheduledTaskRunner] not implemented — see packages/core/src/scheduled-task/README.md",
		);
	}

	async escalate(_task: ScheduledTask): Promise<void> {
		throw new Error(
			"[StubScheduledTaskRunner] not implemented — see packages/core/src/scheduled-task/README.md",
		);
	}
}
