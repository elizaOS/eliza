import { describe, expect, it, vi } from "vitest";
import type { Action, IAgentRuntime, Memory } from "../../types";
import {
	actionHasSubActions,
	detectSubActionCycles,
	resolveSubActions,
	runSubPlanner,
} from "../sub-planner";

function makeAction(overrides: Partial<Action>): Action {
	return {
		name: "TEST_ACTION",
		description: "Run the test action",
		validate: async () => true,
		handler: async () => ({ success: true }),
		...overrides,
	};
}

function makeRuntime(actions: Action[], useModel = vi.fn()): IAgentRuntime {
	return {
		actions,
		useModel,
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

function makeMessage(): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		content: { text: "hello" },
	} as Memory;
}

describe("sub-planner helpers", () => {
	it("detects declared sub-actions and resolves them by exact name", () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});

		expect(actionHasSubActions(parent)).toBe(true);
		expect(resolveSubActions(makeRuntime([parent, child]), parent)).toEqual([
			child,
		]);
	});

	it("detects sub-action cycles", () => {
		const a = makeAction({ name: "A", subActions: ["B"] });
		const b = makeAction({ name: "B", subActions: ["C"] });
		const c = makeAction({ name: "C", subActions: ["A"] });

		expect(detectSubActionCycles([a, b, c])).toEqual([["A", "B", "C", "A"]]);
	});

	it("runs the planner with only child actions available to execution", async () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [{ id: "call-1", name: "CHILD", arguments: {} }],
		}));
		const execute = vi.fn(async () => ({
			success: true,
			text: "child done",
			data: { actionName: "CHILD" },
		}));

		const result = await runSubPlanner({
			runtime: makeRuntime([parent, child], useModel),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute,
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				thought: "Done.",
				messageToUser: "Done.",
			}),
		});

		expect(execute).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			expect.objectContaining({ name: "CHILD" }),
			expect.objectContaining({ actions: [child] }),
		);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Done.");
	});
});
