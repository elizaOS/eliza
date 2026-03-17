import { beforeEach, describe, expect, test, vi } from "vitest";
import { createTaskAction } from "../advanced-capabilities/actions/createTask";
import type { IAgentRuntime, Memory, UUID } from "../types";

function makeMessage(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000101" as UUID,
		roomId: "00000000-0000-0000-0000-000000000201" as UUID,
		entityId: "00000000-0000-0000-0000-000000000301" as UUID,
		agentId: "00000000-0000-0000-0000-000000000401" as UUID,
		content: { text },
		createdAt: Date.now(),
	};
}

describe("createTaskAction", () => {
	let runtime: IAgentRuntime;
	let createTaskMock: ReturnType<typeof vi.fn>;
	let getTasksMock: ReturnType<typeof vi.fn>;
	let useModelMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		createTaskMock = vi.fn(async (task) => ({
			...task,
			id: "00000000-0000-0000-0000-000000000777" as UUID,
		}));
		getTasksMock = vi.fn(async () => []);
		useModelMock = vi.fn(async () =>
			[
				"<response>",
				"<triggerType>interval</triggerType>",
				"<displayName>PR Summary</displayName>",
				"<instructions>Summarize open pull requests.</instructions>",
				"<intervalMs>3600000</intervalMs>",
				"<wakeMode>inject_now</wakeMode>",
				"</response>",
			].join("\n"),
		);

		const runtimePartial: Partial<IAgentRuntime> = {
			agentId: "00000000-0000-0000-0000-000000000401" as UUID,
			enableAutonomy: true,
			useModel: useModelMock,
			getTasks: getTasksMock,
			createTask: createTaskMock,
			getSetting: () => undefined,
			getService: () =>
				({
					getAutonomousRoomId: () =>
						"00000000-0000-0000-0000-000000000888" as UUID,
				}) as { getAutonomousRoomId: () => UUID },
		};

		runtime = runtimePartial as IAgentRuntime;
	});

	test("validate passes for trigger-like prompt when autonomy is enabled", async () => {
		const result = await createTaskAction.validate(
			runtime,
			makeMessage("create a trigger every hour to summarize PRs"),
		);
		expect(result).toBe(true);
	});

	test("validate fails when autonomy is disabled", async () => {
		runtime.enableAutonomy = false;
		const result = await createTaskAction.validate(
			runtime,
			makeMessage("create a trigger every hour"),
		);
		expect(result).toBe(false);
	});

	test("creates a trigger task and returns success", async () => {
		const callback = vi.fn(async () => []);
		const result = await createTaskAction.handler(
			runtime,
			makeMessage(
				"create a trigger every hour to summarize open pull requests",
			),
			undefined,
			undefined,
			callback,
		);

		expect(result?.success).toBe(true);
		expect(createTaskMock).toHaveBeenCalledTimes(1);
		const taskArg = createTaskMock.mock.calls[0][0];
		expect(taskArg.name).toBe("TRIGGER_DISPATCH");
		expect(taskArg.tags).toContain("trigger");
		expect(taskArg.metadata.trigger.displayName).toBe("PR Summary");
		expect(callback).toHaveBeenCalledTimes(1);
	});

	test("returns duplicate message when equivalent trigger exists", async () => {
		const existingTask = {
			id: "00000000-0000-0000-0000-000000000500" as UUID,
			metadata: {
				trigger: {
					enabled: true,
					triggerType: "interval",
					instructions: "Summarize open pull requests.",
					intervalMs: 3600000,
					createdBy: "00000000-0000-0000-0000-000000000301",
				},
			},
		};
		getTasksMock.mockResolvedValueOnce([existingTask]);

		const result = await createTaskAction.handler(
			runtime,
			makeMessage(
				"create a trigger every hour to summarize open pull requests",
			),
			undefined,
			undefined,
			undefined,
		);

		expect(result?.success).toBe(true);
		expect(result?.text).toContain("already exists");
		expect(createTaskMock).not.toHaveBeenCalled();
	});
});
