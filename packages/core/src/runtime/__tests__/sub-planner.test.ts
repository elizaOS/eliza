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

	it("passes child actions to the model as native tool definitions", async () => {
		const childA = makeAction({
			name: "CHILD_A",
			description: "Do thing A",
		});
		const childB = makeAction({
			name: "CHILD_B",
			description: "Do thing B",
		});
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD_A", "CHILD_B"],
			subPlanner: true,
		});
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [{ id: "call-1", name: "CHILD_A", arguments: {} }],
		}));
		const execute = vi.fn(async () => ({
			success: true,
			text: "done",
			data: { actionName: "CHILD_A" },
		}));

		await runSubPlanner({
			runtime: makeRuntime([parent, childA, childB], useModel),
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

		// Sub-planner exposes the same single PLAN_ACTIONS wrapper tool as the
		// top-level planner so the cache key stays stable across descents. Child
		// action specs render into the sub-planner's system prompt; the LLM
		// picks one by name and passes it back via `action`. This keeps the tool
		// list byte-identical regardless of which child set is in play.
		const modelCall = useModel.mock.calls[0];
		expect(modelCall).toBeDefined();
		const modelParams = modelCall?.[1] as {
			tools?: Array<{ name: string; type?: string }>;
			toolChoice?: string;
			responseSchema?: unknown;
		};
		expect(modelParams.tools).toEqual([
			expect.objectContaining({ name: "PLAN_ACTIONS", type: "function" }),
		]);
		// Sub-planner uses the wrapper, so the JSON-schema fallback path must
		// NOT be active.
		expect(modelParams.responseSchema).toBeUndefined();
	});

	it("expands activeContexts for sub-action execution so child gates pass", async () => {
		// Reproduce the production case: parent and children with non-overlapping
		// `contexts`. Without ctx expansion, the per-action context gate in
		// execute-planned-tool-call.ts rejects the child even though the parent's
		// `subActions` declaration explicitly authorized it.
		const child = makeAction({
			name: "CHILD",
			contexts: ["web"],
		});
		const parent = makeAction({
			name: "PARENT",
			contexts: ["research_workflow"],
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [{ id: "call-1", name: "CHILD", arguments: {} }],
		}));
		const execute = vi.fn(async () => ({
			success: true,
			text: "ok",
			data: { actionName: "CHILD" },
		}));

		await runSubPlanner({
			runtime: makeRuntime([parent, child], useModel),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: {
				message: makeMessage(),
				activeContexts: ["research_workflow"],
			},
			execute,
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				thought: "Done.",
				messageToUser: "Done.",
			}),
		});

		// The execute callback must receive a ctx where activeContexts now includes
		// the child's contexts (so the gate admits it). The original parent
		// activeContexts is preserved as well.
		const [, executedCtx] = execute.mock.calls[0] ?? [];
		expect(executedCtx).toBeDefined();
		const activeContexts = (executedCtx as { activeContexts?: string[] })
			?.activeContexts;
		expect(activeContexts).toEqual(
			expect.arrayContaining(["research_workflow", "web"]),
		);
	});
});
