/**
 * Prompt-runner TaskWorker.
 *
 * A canonical "scheduled prompt" task: a recurring or one-shot Task whose
 * metadata.prompt is fed to TEXT_LARGE through a generic task-handler system
 * prompt. Lets users (and the UI) schedule arbitrary natural-language jobs
 * without authoring a bespoke worker per prompt.
 *
 * Tasks created for this worker should use:
 *   {
 *     name: PROMPT_RUNNER_TASK_WORKER_NAME,
 *     metadata: { kind: 'prompt', prompt: '...', updateInterval?, ... },
 *     tags: ['queue', 'repeat'?],
 *   }
 */

import { ModelType } from "../../types/model.ts";
import type { IAgentRuntime } from "../../types/runtime.ts";
import type { Task, TaskWorker } from "../../types/task.ts";

export const PROMPT_RUNNER_TASK_WORKER_NAME = "prompt.run";

/** Discriminator on TaskMetadata so the UI can route prompt-tasks distinctly. */
export const PROMPT_RUNNER_TASK_KIND = "prompt";

/** Strongly-typed metadata fields the worker reads. Lives alongside the
 * generic TaskMetadata.[key: string] index signature; declared here so the
 * worker site has a single source of truth. */
export interface PromptRunnerTaskMetadata {
	kind: typeof PROMPT_RUNNER_TASK_KIND;
	/** The user prompt to execute. Required. */
	prompt: string;
}

const PROMPT_RUNNER_SYSTEM_PROMPT =
	"You are an autonomous agent processing a scheduled task. Execute the user's intent and report what you did.\n\nTask: {{prompt}}";

function readPrompt(task: Task): string | null {
	const meta = task.metadata as Record<string, unknown> | undefined;
	if (!meta) return null;
	const prompt = meta.prompt;
	return typeof prompt === "string" && prompt.length > 0 ? prompt : null;
}

export const promptRunnerTaskWorker: TaskWorker = {
	name: PROMPT_RUNNER_TASK_WORKER_NAME,
	execute: async (runtime: IAgentRuntime, _options, task: Task) => {
		const prompt = readPrompt(task);
		if (prompt == null) {
			throw new Error(
				`prompt-runner task ${task.id ?? "?"} missing metadata.prompt`,
			);
		}

		const composed = PROMPT_RUNNER_SYSTEM_PROMPT.replace("{{prompt}}", prompt);

		await runtime.useModel(ModelType.TEXT_LARGE, { prompt: composed });
		return undefined;
	},
};
