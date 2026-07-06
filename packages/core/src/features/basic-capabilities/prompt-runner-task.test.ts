/**
 * Unit coverage for the prompt-runner `TaskWorker` (`promptRunnerTaskWorker`):
 * it runs scheduled prompt tasks through the message-service loop when present,
 * persists produced assistant text, falls back to background `TEXT_LARGE` when
 * no message service is available, and rejects a missing or empty prompt.
 * Deterministic harness — stub runtime functions, no live model.
 */
import { describe, expect, it, vi } from "vitest";
import type { HandlerCallback } from "../../types/components";
import type { Memory } from "../../types/memory";
import type { IMessageService } from "../../types/message-service";
import { ModelType } from "../../types/model";
import type { UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { Task } from "../../types/task";
import {
	PROMPT_RUNNER_TASK_KIND,
	PROMPT_RUNNER_TASK_WORKER_NAME,
	promptRunnerTaskWorker,
} from "./prompt-runner-task";

function makeTask(prompt: unknown): Task {
	return {
		id: "task-1" as Task["id"],
		name: PROMPT_RUNNER_TASK_WORKER_NAME,
		metadata: {
			kind: PROMPT_RUNNER_TASK_KIND,
			prompt,
		},
		tags: ["queue", "repeat"],
	} satisfies Task;
}

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;

function makeRuntime(overrides: Partial<IAgentRuntime> = {}) {
	const useModel = vi.fn(async () => "the scheduled report is done");
	const createMemory = vi.fn(async () => crypto.randomUUID() as UUID);
	const runtime = {
		agentId: AGENT_ID,
		useModel,
		createMemory,
		messageService: null,
		...overrides,
	} as unknown as IAgentRuntime;
	return { runtime, useModel, createMemory };
}

describe("prompt-runner TaskWorker", () => {
	it("runs prompt tasks through the message service and persists the callback response", async () => {
		let capturedMessage: Memory | null = null;
		const messageService = {
			handleMessage: vi.fn(
				async (
					_runtime: IAgentRuntime,
					message: Memory,
					callback?: HandlerCallback,
				) => {
					capturedMessage = message;
					await callback?.({
						text: "I sent the morning summary.",
						actions: ["SEND_MESSAGE"],
					});
					return {
						didRespond: true,
						responseContent: { text: "I sent the morning summary." },
						responseMessages: [],
					};
				},
			),
		} as unknown as IMessageService;
		const { runtime, useModel, createMemory } = makeRuntime({
			messageService,
		});

		await promptRunnerTaskWorker.execute(
			runtime,
			{},
			makeTask("send the morning summary"),
		);

		expect(useModel).not.toHaveBeenCalled();
		expect(messageService.handleMessage).toHaveBeenCalledTimes(1);
		expect(capturedMessage?.content.text).toContain("scheduled task");
		expect(capturedMessage?.content.text).toContain("send the morning summary");
		expect(capturedMessage?.content.source).toBe("prompt-runner");
		expect(createMemory).toHaveBeenCalledTimes(1);
		const [assistantMemory, table] = createMemory.mock.calls[0] as [
			Memory,
			string,
		];
		expect(table).toBe("messages");
		expect(assistantMemory.entityId).toBe(AGENT_ID);
		expect(assistantMemory.content.text).toBe("I sent the morning summary.");
		expect(assistantMemory.content.actions).toEqual(["SEND_MESSAGE"]);
		expect(assistantMemory.content.source).toBe("prompt-runner");
		expect(assistantMemory.content.inReplyTo).toBe(capturedMessage?.id);
	});

	it("does not duplicate simple responses already persisted by the message service", async () => {
		let capturedMessage: Memory | null = null;
		const { runtime, useModel, createMemory } = makeRuntime();
		const responseMemory: Memory = {
			id: crypto.randomUUID() as UUID,
			entityId: AGENT_ID,
			agentId: AGENT_ID,
			roomId: crypto.randomUUID() as UUID,
			content: {
				text: "I sent the morning summary.",
				actions: ["REPLY"],
			},
			createdAt: Date.now(),
		};
		const messageService = {
			handleMessage: vi.fn(
				async (
					_runtime: IAgentRuntime,
					message: Memory,
					callback?: HandlerCallback,
				) => {
					capturedMessage = message;
					await createMemory(responseMemory, "messages");
					await callback?.(responseMemory.content);
					return {
						didRespond: true,
						responseContent: responseMemory.content,
						responseMessages: [responseMemory],
						mode: "simple" as const,
					};
				},
			),
		} as unknown as IMessageService;
		runtime.messageService = messageService;

		await promptRunnerTaskWorker.execute(
			runtime,
			{},
			makeTask("send the morning summary"),
		);

		expect(useModel).not.toHaveBeenCalled();
		expect(messageService.handleMessage).toHaveBeenCalledTimes(1);
		expect(capturedMessage?.content.source).toBe("prompt-runner");
		expect(createMemory).toHaveBeenCalledTimes(1);
		expect(createMemory).toHaveBeenCalledWith(responseMemory, "messages");
	});

	it("falls back to TEXT_LARGE and stores the generated text when no message service is available", async () => {
		const { runtime, useModel, createMemory } = makeRuntime();

		await promptRunnerTaskWorker.execute(
			runtime,
			{},
			makeTask("send the morning summary"),
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		const [modelType, params] = useModel.mock.calls[0] as [
			string,
			{ prompt: string; priority?: string },
		];
		expect(modelType).toBe(ModelType.TEXT_LARGE);
		expect(params.prompt).toContain("scheduled task");
		expect(params.prompt).toContain("send the morning summary");
		expect(params.priority).toBe("background");
		expect(createMemory).toHaveBeenCalledTimes(2);
		const [inputMemory] = createMemory.mock.calls[0] as [Memory, string];
		const [assistantMemory, table] = createMemory.mock.calls[1] as [
			Memory,
			string,
		];
		expect(table).toBe("messages");
		expect(inputMemory.content.source).toBe("prompt-runner");
		expect(assistantMemory.content.text).toBe("the scheduled report is done");
		expect(assistantMemory.content.inReplyTo).toBe(inputMemory.id);
	});

	it("throws if metadata.prompt is missing", async () => {
		const { runtime, useModel, createMemory } = makeRuntime();
		await expect(
			promptRunnerTaskWorker.execute(runtime, {}, makeTask(undefined)),
		).rejects.toThrow(/missing metadata.prompt/);
		expect(useModel).not.toHaveBeenCalled();
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("throws if metadata.prompt is empty string", async () => {
		const { runtime, useModel, createMemory } = makeRuntime();
		await expect(
			promptRunnerTaskWorker.execute(runtime, {}, makeTask("  ")),
		).rejects.toThrow(/missing metadata.prompt/);
		expect(useModel).not.toHaveBeenCalled();
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("exports a stable worker name", () => {
		expect(PROMPT_RUNNER_TASK_WORKER_NAME).toBe("prompt.run");
		expect(promptRunnerTaskWorker.name).toBe(PROMPT_RUNNER_TASK_WORKER_NAME);
	});
});
