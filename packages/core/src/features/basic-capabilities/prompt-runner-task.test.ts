import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/model";
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

function runtimeWithModel(useModel: IAgentRuntime["useModel"]): IAgentRuntime {
	return { useModel } as IAgentRuntime;
}

describe("prompt-runner TaskWorker", () => {
	it("invokes TEXT_LARGE with the system prompt wrapping the task prompt", async () => {
		const useModel = vi.fn(async () => "ok");
		const runtime = runtimeWithModel(useModel as IAgentRuntime["useModel"]);

		await promptRunnerTaskWorker.execute(
			runtime,
			{},
			makeTask("send the morning summary"),
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		const [modelType, params] = useModel.mock.calls[0] as [
			string,
			{ prompt: string },
		];
		expect(modelType).toBe(ModelType.TEXT_LARGE);
		expect(params.prompt).toContain("autonomous agent");
		expect(params.prompt).toContain("send the morning summary");
	});

	it("throws if metadata.prompt is missing", async () => {
		const useModel = vi.fn();
		const runtime = runtimeWithModel(useModel as IAgentRuntime["useModel"]);
		await expect(
			promptRunnerTaskWorker.execute(runtime, {}, makeTask(undefined)),
		).rejects.toThrow(/missing metadata.prompt/);
		expect(useModel).not.toHaveBeenCalled();
	});

	it("throws if metadata.prompt is empty string", async () => {
		const useModel = vi.fn();
		const runtime = runtimeWithModel(useModel as IAgentRuntime["useModel"]);
		await expect(
			promptRunnerTaskWorker.execute(runtime, {}, makeTask("")),
		).rejects.toThrow(/missing metadata.prompt/);
		expect(useModel).not.toHaveBeenCalled();
	});

	it("exports a stable worker name", () => {
		expect(PROMPT_RUNNER_TASK_WORKER_NAME).toBe("prompt.run");
		expect(promptRunnerTaskWorker.name).toBe(PROMPT_RUNNER_TASK_WORKER_NAME);
	});
});
