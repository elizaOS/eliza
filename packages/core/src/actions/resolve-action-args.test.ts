/**
 * Unit tests for umbrella action argument resolution.
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory } from "../types/index.js";
import {
	resolveActionArgs,
	type SubactionsMap,
} from "./resolve-action-args.js";

type TaskSubactions = "CREATE" | "DELETE" | "LIST";

const taskSubactions: SubactionsMap<TaskSubactions> = {
	CREATE: {
		description: "Create a new task with a title and optional due date",
		descriptionCompressed: "create task with title and optional due date",
		required: ["title"],
		optional: ["dueDate"],
	},
	DELETE: {
		description: "Delete an existing task by its ID",
		descriptionCompressed: "delete task by id",
		required: ["taskId"],
	},
	LIST: {
		description: "List all active tasks",
		descriptionCompressed: "list active tasks",
		required: [],
	},
};

function makeMockRuntime(modelResponse?: string): IAgentRuntime {
	return {
		useModel: vi.fn().mockResolvedValue(modelResponse ?? "{}"),
	} as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
	return {
		id: "msg-1",
		entityId: "user-1",
		agentId: "agent-1",
		roomId: "room-1",
		createdAt: Date.now(),
		content: { text },
	};
}

describe("resolveActionArgs", () => {
	it("preserves an explicitly empty required array without model extraction when its contract allows it", async () => {
		const runtime = makeMockRuntime();
		const result = await resolveActionArgs({
			runtime,
			message: makeMessage(
				"Issue a knowledge-only grant with no subject filter",
			),
			actionName: "GRANT",
			subactions: {
				ISSUE: {
					description: "Issue a scoped grant",
					descriptionCompressed: "issue grant",
					required: ["subjectIds"],
					allowEmptyArrays: ["subjectIds"],
				},
			},
			options: { parameters: { action: "ISSUE", subjectIds: [] } },
		});
		expect(result).toEqual({
			ok: true,
			subaction: "ISSUE",
			params: { action: "ISSUE", subjectIds: [] },
		});
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("retains an explicit empty array while extracting another missing parameter", async () => {
		const runtime = makeMockRuntime(
			JSON.stringify({
				action: "ISSUE",
				params: {
					principalId: "caregiver",
					subjectIds: ["unrequested-subject"],
				},
				missing: [],
				confidence: 0.95,
			}),
		);
		const result = await resolveActionArgs({
			runtime,
			message: makeMessage("Issue this knowledge-only grant to the caregiver"),
			actionName: "GRANT",
			subactions: {
				ISSUE: {
					description: "Issue a scoped grant",
					descriptionCompressed: "issue grant",
					required: ["principalId", "subjectIds"],
					allowEmptyArrays: ["subjectIds"],
				},
			},
			options: { parameters: { action: "ISSUE", subjectIds: [] } },
		});
		expect(result).toEqual({
			ok: true,
			subaction: "ISSUE",
			params: { principalId: "caregiver", subjectIds: [] },
		});
	});

	it("accepts an allowed empty array extracted from the request", async () => {
		const runtime = makeMockRuntime(
			JSON.stringify({
				action: "ISSUE",
				params: { subjectIds: [] },
				missing: [],
				confidence: 0.95,
			}),
		);
		const result = await resolveActionArgs({
			runtime,
			message: makeMessage(
				"Issue a knowledge-only grant with an explicitly empty subject list",
			),
			actionName: "GRANT",
			subactions: {
				ISSUE: {
					description: "Issue a scoped grant",
					descriptionCompressed: "issue grant",
					required: ["subjectIds"],
					allowEmptyArrays: ["subjectIds"],
				},
			},
		});
		expect(result).toEqual({
			ok: true,
			subaction: "ISSUE",
			params: { subjectIds: [] },
		});
	});

	it("still rejects omitted and null arrays, and empty arrays without an explicit allowance", async () => {
		for (const input of [
			{ parameters: { action: "ISSUE" }, allowEmptyArrays: ["subjectIds"] },
			{
				parameters: { action: "ISSUE", subjectIds: null },
				allowEmptyArrays: ["subjectIds"],
			},
			{ parameters: { action: "ISSUE", subjectIds: [] }, allowEmptyArrays: [] },
		]) {
			const runtime = makeMockRuntime(
				JSON.stringify({
					action: "ISSUE",
					params: {},
					missing: ["subjectIds"],
					confidence: 0.95,
				}),
			);
			const result = await resolveActionArgs({
				runtime,
				message: makeMessage("Issue a grant"),
				actionName: "GRANT",
				subactions: {
					ISSUE: {
						description: "Issue a scoped grant",
						descriptionCompressed: "issue grant",
						required: ["subjectIds"],
						allowEmptyArrays: input.allowEmptyArrays,
					},
				},
				options: { parameters: input.parameters },
			});
			expect(result).toMatchObject({ ok: false, missing: ["subjectIds"] });
		}
	});

	it("preserves an explicit description clear while extracting a missing goal ID", async () => {
		const runtime = makeMockRuntime(
			JSON.stringify({
				action: "UPDATE",
				params: { id: "goal-1", description: "Old description" },
				missing: [],
				confidence: 0.95,
			}),
		);
		const result = await resolveActionArgs({
			runtime,
			message: makeMessage("clear the description of my goal"),
			actionName: "OWNER_GOALS",
			subactions: {
				UPDATE: {
					description: "Update an owner goal by ID",
					descriptionCompressed: "update goal",
					required: ["id"],
					optional: ["description"],
				},
			},
			options: { parameters: { action: "UPDATE", id: null, description: "" } },
		});
		expect(result).toEqual({
			ok: true,
			subaction: "UPDATE",
			params: { id: "goal-1", description: "" },
		});
	});

	it("trusts complete planner-supplied parameters without invoking model extraction", async () => {
		const runtime = makeMockRuntime();
		const message = makeMessage("create a task");

		const result = await resolveActionArgs<TaskSubactions>({
			runtime,
			message,
			actionName: "TASK",
			subactions: taskSubactions,
			options: {
				parameters: {
					action: "CREATE",
					title: "Buy groceries",
					dueDate: "tomorrow",
				},
			},
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.subaction).toBe("CREATE");
			expect(result.params).toEqual({
				action: "CREATE",
				title: "Buy groceries",
				dueDate: "tomorrow",
			});
		}
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("extracts subaction and parameters from model output when planner parameters are incomplete", async () => {
		const modelOutput = JSON.stringify({
			action: "CREATE",
			params: { title: "Schedule doctor appointment" },
			missing: [],
			confidence: 0.95,
		});

		const runtime = makeMockRuntime(modelOutput);
		const message = makeMessage("remind me to schedule doctor appointment");

		const result = await resolveActionArgs<TaskSubactions>({
			runtime,
			message,
			actionName: "TASK",
			subactions: taskSubactions,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.subaction).toBe("CREATE");
			expect(result.params).toEqual({
				title: "Schedule doctor appointment",
			});
		}
		expect(runtime.useModel).toHaveBeenCalled();
	});

	it.each([null, ""])(
		"uses extracted parameters when the planner supplied an absent value (%j)",
		async (plannerTitle) => {
			const modelOutput = JSON.stringify({
				action: "CREATE",
				params: { title: "Buy groceries" },
				missing: [],
				confidence: 0.95,
			});

			const runtime = makeMockRuntime(modelOutput);
			const message = makeMessage("create a task to buy groceries");

			const result = await resolveActionArgs<TaskSubactions>({
				runtime,
				message,
				actionName: "TASK",
				subactions: taskSubactions,
				options: {
					parameters: {
						action: "CREATE",
						title: plannerTitle,
					},
				},
			});

			expect(result).toEqual({
				ok: true,
				subaction: "CREATE",
				params: { title: "Buy groceries" },
			});
			expect(runtime.useModel).toHaveBeenCalled();
		},
	);

	it("returns clarification failure when required parameters cannot be extracted", async () => {
		const modelOutput = JSON.stringify({
			action: "DELETE",
			params: {},
			missing: ["taskId"],
			confidence: 0.9,
		});

		const runtime = makeMockRuntime(modelOutput);
		const message = makeMessage("delete that task");

		const result = await resolveActionArgs<TaskSubactions>({
			runtime,
			message,
			actionName: "TASK",
			subactions: taskSubactions,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.missing).toEqual(["taskId"]);
			expect(result.clarification).toContain("taskId");
		}
	});

	it("applies defaultSubaction when model does not specify a subaction", async () => {
		const modelOutput = JSON.stringify({
			action: null,
			params: {},
			missing: [],
			confidence: 0.8,
		});

		const runtime = makeMockRuntime(modelOutput);
		const message = makeMessage("show my tasks");

		const result = await resolveActionArgs<TaskSubactions>({
			runtime,
			message,
			actionName: "TASK",
			subactions: taskSubactions,
			defaultSubaction: "LIST",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.subaction).toBe("LIST");
		}
	});

	it("returns failure when confidence is below the threshold", async () => {
		const modelOutput = JSON.stringify({
			action: "CREATE",
			params: { title: "something vague" },
			missing: [],
			confidence: 0.3,
		});

		const runtime = makeMockRuntime(modelOutput);
		const message = makeMessage("maybe do that");

		const result = await resolveActionArgs<TaskSubactions>({
			runtime,
			message,
			actionName: "TASK",
			subactions: taskSubactions,
		});

		expect(result.ok).toBe(false);
	});
});
