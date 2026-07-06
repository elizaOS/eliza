/**
 * Prompt-runner TaskWorker.
 *
 * A canonical "scheduled prompt" task: a recurring or one-shot Task whose
 * metadata.prompt enters the normal message-service loop with a generic
 * task-handler system prompt, so scheduled natural-language jobs can use tools
 * and persist visible results without authoring a bespoke worker per prompt.
 * Headless runtimes without a message service fall back to TEXT_LARGE and still
 * record the generated result as message memory.
 *
 * Tasks created for this worker should use:
 *   {
 *     name: PROMPT_RUNNER_TASK_WORKER_NAME,
 *     metadata: { kind: 'prompt', prompt: '...', updateInterval?, ... },
 *     tags: ['queue', 'repeat'?],
 *   }
 */

import type { Memory } from "../../types/memory.ts";
import { ModelType } from "../../types/model.ts";
import { asUUID } from "../../types/primitives.ts";
import type { IAgentRuntime } from "../../types/runtime.ts";
import type { Task, TaskWorker } from "../../types/task.ts";
import { stringToUuid } from "../../utils.ts";

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
	"Process the scheduled task below. Execute the user's intent and report what you did.\n\nTask: {{prompt}}";
const PROMPT_RUNNER_SOURCE = "prompt-runner";

function readPrompt(task: Task): string | null {
	const meta = task.metadata as Record<string, unknown> | undefined;
	if (!meta) return null;
	const prompt = meta.prompt;
	if (typeof prompt !== "string") return null;
	const trimmed = prompt.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function promptRunnerRoomId(runtime: IAgentRuntime, task: Task) {
	return task.roomId ?? stringToUuid(`prompt-runner-room:${runtime.agentId}`);
}

function promptRunnerEntityId(runtime: IAgentRuntime, task: Task) {
	return (
		task.entityId ??
		stringToUuid(`prompt-runner-entity:${runtime.agentId}:${task.id ?? "task"}`)
	);
}

function promptRunnerMemoryMetadata(
	task: Task,
	role: "user" | "assistant",
): Memory["metadata"] {
	return {
		type: "message",
		source: PROMPT_RUNNER_SOURCE,
		taskId: task.id,
		taskName: task.name,
		role,
	};
}

async function persistPromptRunnerResponse(
	runtime: IAgentRuntime,
	task: Task,
	inputMemory: Memory,
	response: Memory["content"],
): Promise<Memory[]> {
	const text = typeof response.text === "string" ? response.text : "";
	const responseMemory: Memory = {
		id: asUUID(crypto.randomUUID()),
		entityId: runtime.agentId,
		agentId: runtime.agentId,
		roomId: inputMemory.roomId,
		worldId: inputMemory.worldId,
		content: {
			...response,
			text,
			source: PROMPT_RUNNER_SOURCE,
			inReplyTo: inputMemory.id,
		},
		createdAt: Date.now(),
		metadata: promptRunnerMemoryMetadata(task, "assistant"),
	};
	await runtime.createMemory(responseMemory, "messages");
	return [responseMemory];
}

async function runPromptThroughMessageService(
	runtime: IAgentRuntime,
	task: Task,
	composedPrompt: string,
): Promise<boolean> {
	if (!runtime.messageService) return false;
	const inputMemory: Memory = {
		id: asUUID(crypto.randomUUID()),
		entityId: promptRunnerEntityId(runtime, task),
		agentId: runtime.agentId,
		roomId: promptRunnerRoomId(runtime, task),
		worldId: task.worldId,
		content: {
			text: composedPrompt,
			source: PROMPT_RUNNER_SOURCE,
		},
		createdAt: Date.now(),
		metadata: promptRunnerMemoryMetadata(task, "user"),
	};

	await runtime.messageService.handleMessage(
		runtime,
		inputMemory,
		(response) =>
			persistPromptRunnerResponse(runtime, task, inputMemory, response),
		{ keepExistingResponses: true },
	);
	return true;
}

function textFromModelResult(result: unknown): string {
	if (typeof result === "string") return result;
	if (
		result &&
		typeof result === "object" &&
		"text" in result &&
		typeof (result as { text?: unknown }).text === "string"
	) {
		return (result as { text: string }).text;
	}
	return String(result ?? "");
}

async function runPromptDirectly(
	runtime: IAgentRuntime,
	task: Task,
	composedPrompt: string,
): Promise<void> {
	const result = await runtime.useModel(ModelType.TEXT_LARGE, {
		prompt: composedPrompt,
		priority: "background",
	});
	const text = textFromModelResult(result).trim();
	if (!text) return;
	const inputMemory: Memory = {
		id: asUUID(crypto.randomUUID()),
		entityId: promptRunnerEntityId(runtime, task),
		agentId: runtime.agentId,
		roomId: promptRunnerRoomId(runtime, task),
		worldId: task.worldId,
		content: {
			text: composedPrompt,
			source: PROMPT_RUNNER_SOURCE,
		},
		createdAt: Date.now(),
		metadata: promptRunnerMemoryMetadata(task, "user"),
	};
	await runtime.createMemory(inputMemory, "messages");
	await persistPromptRunnerResponse(runtime, task, inputMemory, { text });
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

		const handled = await runPromptThroughMessageService(
			runtime,
			task,
			composed,
		);
		if (!handled) {
			// Scheduled jobs are background work: on single-lane local backends this
			// lets interactive chat turns jump the model lane and caps the job by the
			// device-class background budget (#11914).
			await runPromptDirectly(runtime, task, composed);
		}
		return undefined;
	},
};
