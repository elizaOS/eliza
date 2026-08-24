/**
 * Exercises the sub-planner helpers (`actionHasSubActions`,
 * `detectSubActionCycles`, `resolveSubActions`, `runSubPlanner`): child-action
 * resolution and simile matching, native-tool exposure, context propagation,
 * and role/context gating. Mocked runtime with stubbed useModel/execute/evaluate;
 * deterministic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Action, IAgentRuntime, Memory } from "../../types";
import { _resetActionRolePolicyCacheForTests } from "../action-role-policy";
import {
	actionHasSubActions,
	detectSubActionCycles,
	resolveSubActions,
	runSubPlanner,
	subPlannerCallDigest,
} from "../sub-planner";

type SubPlannerTestRuntime = Pick<IAgentRuntime, "actions" | "useModel"> & {
	logger: Pick<IAgentRuntime["logger"], "debug" | "warn" | "error">;
};

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
	const runtime: SubPlannerTestRuntime = {
		actions,
		useModel: useModel as IAgentRuntime["useModel"],
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	};
	return runtime as IAgentRuntime;
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
	const ORIGINAL_ACTION_ROLE_POLICY = process.env.ACTION_ROLE_POLICY;

	afterEach(() => {
		if (ORIGINAL_ACTION_ROLE_POLICY === undefined) {
			delete process.env.ACTION_ROLE_POLICY;
		} else {
			process.env.ACTION_ROLE_POLICY = ORIGINAL_ACTION_ROLE_POLICY;
		}
		_resetActionRolePolicyCacheForTests();
	});

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

	it("does not replay an exact prior non-retryable nested operation", async () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const call = { name: "CHILD", params: { target: "same" } };
		const execute = vi.fn(async () => ({ success: true }));
		const result = await runSubPlanner({
			runtime: makeRuntime(
				[parent, child],
				vi.fn(async () => ({
					text: "",
					toolCalls: [
						{ id: "call-replay", name: "CHILD", arguments: call.params },
					],
				})),
			),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: {
				message: makeMessage(),
				previousResults: [
					{
						success: false,
						data: {
							subSteps: [
								{
									action: "CHILD",
									success: false,
									callDigest: subPlannerCallDigest(call),
									retryable: false,
								},
							],
						},
					},
				],
			},
			execute,
			evaluate: async () => ({
				success: false,
				decision: "FINISH",
				messageToUser: "That exact operation cannot be retried this turn.",
			}),
		});

		expect(execute).not.toHaveBeenCalled();
		expect(result.trajectory.steps[0]?.result?.data).toMatchObject({
			retryable: false,
			replaySuppressed: true,
			code: "PRIOR_NON_RETRYABLE_SUBSTEP",
		});
	});

	it("resolves child action similes before rejecting sub-planner tool calls", async () => {
		const child = makeAction({
			name: "GOOGLE_CALENDAR",
			similes: ["CALENDAR_READ"],
		});
		const parent = makeAction({
			name: "CALENDAR",
			subActions: ["GOOGLE_CALENDAR"],
			subPlanner: true,
		});
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [{ id: "call-1", name: "CALENDAR_READ", arguments: {} }],
		}));
		const execute = vi.fn(async () => ({
			success: true,
			text: "calendar done",
			data: { actionName: "GOOGLE_CALENDAR" },
		}));

		await runSubPlanner({
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
			expect.objectContaining({ name: "GOOGLE_CALENDAR" }),
			expect.objectContaining({ actions: [child] }),
		);
	});

	it("records a simile call under the canonical child identity", async () => {
		const child = makeAction({
			name: "GOOGLE_CALENDAR",
			similes: ["CALENDAR_READ"],
		});
		const parent = makeAction({
			name: "CALENDAR",
			subActions: ["GOOGLE_CALENDAR"],
			subPlanner: true,
		});
		const result = await runSubPlanner({
			runtime: makeRuntime(
				[parent, child],
				vi.fn(async () => ({
					text: "",
					toolCalls: [
						{
							id: "call-canonical",
							name: "CALENDAR_READ",
							arguments: { calendar: "primary" },
						},
					],
				})),
			),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute: vi.fn(async () => ({ success: true, text: "done" })),
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				messageToUser: "Done.",
			}),
		});

		const recordedCall = result.trajectory.steps[0]?.toolCall;
		if (!recordedCall) throw new Error("Expected a recorded child call");
		expect(recordedCall).toMatchObject({
			name: "GOOGLE_CALENDAR",
			params: { calendar: "primary" },
		});
		expect(subPlannerCallDigest(recordedCall)).toBe(
			subPlannerCallDigest({
				name: "GOOGLE_CALENDAR",
				params: { calendar: "primary" },
			}),
		);
	});

	it("suppresses a second-pass replay when the model changes child aliases", async () => {
		const child = makeAction({
			name: "GOOGLE_CALENDAR",
			similes: ["CALENDAR_READ", "READ_CALENDAR"],
		});
		const parent = makeAction({
			name: "CALENDAR",
			subActions: ["GOOGLE_CALENDAR"],
			subPlanner: true,
		});
		const params = { calendar: "primary" };
		const first = await runSubPlanner({
			runtime: makeRuntime(
				[parent, child],
				vi.fn(async () => ({
					text: "",
					toolCalls: [
						{ id: "call-first", name: "CALENDAR_READ", arguments: params },
					],
				})),
			),
			action: parent,
			context: { id: "ctx-first", events: [] },
			ctx: { message: makeMessage() },
			execute: vi.fn(async () => ({
				success: false,
				text: "calendar access is permanently unavailable",
				data: { retryable: false },
			})),
			evaluate: async () => ({
				success: false,
				decision: "FINISH",
				messageToUser: "Calendar access is unavailable.",
			}),
		});
		const firstCall = first.trajectory.steps[0]?.toolCall;
		if (!firstCall)
			throw new Error("Expected the first child call to be recorded");
		expect(firstCall?.name).toBe("GOOGLE_CALENDAR");

		const secondExecute = vi.fn(async () => ({ success: true }));
		const second = await runSubPlanner({
			runtime: makeRuntime(
				[parent, child],
				vi.fn(async () => ({
					text: "",
					toolCalls: [
						{ id: "call-second", name: "READ_CALENDAR", arguments: params },
					],
				})),
			),
			action: parent,
			context: { id: "ctx-second", events: [] },
			ctx: {
				message: makeMessage(),
				previousResults: [
					{
						success: false,
						data: {
							subSteps: [
								{
									action: firstCall.name,
									success: false,
									callDigest: subPlannerCallDigest(firstCall),
									retryable: false,
								},
							],
						},
					},
				],
			},
			execute: secondExecute,
			evaluate: async () => ({
				success: false,
				decision: "FINISH",
				messageToUser: "That operation is already known to be unavailable.",
			}),
		});

		expect(secondExecute).not.toHaveBeenCalled();
		expect(second.trajectory.steps[0]?.result?.data).toMatchObject({
			retryable: false,
			replaySuppressed: true,
			code: "PRIOR_NON_RETRYABLE_SUBSTEP",
		});
	});

	it("keeps replay correlation stable without embedding raw parameters", () => {
		const canary = "SYNTH-SUBPLANNER-TOKEN-CANARY-3333";
		const first = subPlannerCallDigest({
			name: "GOOGLE_CALENDAR",
			params: { nested: { count: 2, token: canary }, calendar: "primary" },
		});
		const reordered = subPlannerCallDigest({
			name: "GOOGLE_CALENDAR",
			params: { calendar: "primary", nested: { token: canary, count: 2 } },
		});

		expect(first).toBe(reordered);
		expect(first).not.toContain(canary);
		expect(first).toMatch(/^GOOGLECALENDAR\|[a-f0-9]{64}$/);
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

		// Sub-planner exposes each child action as its own native tool, plus
		// the universal terminal sentinels (REPLY/IGNORE/STOP). Stage 1
		// routing already happened at the top level, so the parent action
		// itself is NOT exposed inside its own sub-planner pass.
		const modelCall = useModel.mock.calls[0];
		expect(modelCall).toBeDefined();
		const modelParams = modelCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
			tools?: Array<{ name: string; type?: string }>;
			toolChoice?: string;
			responseSchema?: unknown;
		};
		const toolNames = (modelParams.tools ?? []).map((t) => t.name);
		expect(toolNames).toContain("CHILD_A");
		expect(toolNames).toContain("CHILD_B");
		expect(toolNames).toContain("REPLY");
		expect(toolNames).toContain("IGNORE");
		expect(toolNames).toContain("STOP");
		expect(toolNames).not.toContain("PARENT");
		// Tools array carries the per-action contracts, so the JSON-schema
		// fallback path must NOT be active.
		expect(modelParams.responseSchema).toBeUndefined();
	});

	it("uses selected plus parent contexts for sub-action execution gates", async () => {
		const child = makeAction({
			name: "CHILD",
			contexts: ["web"],
		});
		const parent = makeAction({
			name: "PARENT",
			contexts: ["research_workflow", "web"],
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

		// The execute callback receives selected contexts plus the parent's declared
		// contexts. Child-only contexts are no longer added as an authorization
		// shortcut; parents must declare every child context they intend to expose.
		const [, executedCtx] = execute.mock.calls[0] ?? [];
		expect(executedCtx).toBeDefined();
		const activeContexts = (executedCtx as { activeContexts?: string[] })
			?.activeContexts;
		expect(activeContexts).toEqual(
			expect.arrayContaining(["research_workflow", "web"]),
		);
	});

	it("does not expose child actions whose role gate is not satisfied", async () => {
		const child = makeAction({
			name: "OWNER_CHILD",
			contexts: ["admin"],
			roleGate: { minRole: "OWNER" },
		});
		const parent = makeAction({
			name: "PARENT",
			contexts: ["admin"],
			subActions: ["OWNER_CHILD"],
			subPlanner: true,
		});

		await expect(
			runSubPlanner({
				runtime: makeRuntime([parent, child]),
				action: parent,
				context: { id: "ctx", events: [] },
				ctx: {
					message: makeMessage(),
					activeContexts: ["admin"],
					userRoles: ["USER"],
				},
			}),
		).rejects.toThrow(/no sub-actions available/i);
	});

	it("does not expose a child action when ACTION_ROLE_POLICY matches only a child simile", async () => {
		process.env.ACTION_ROLE_POLICY = JSON.stringify({ BASH: "NONE" });
		_resetActionRolePolicyCacheForTests();
		const child = makeAction({
			name: "SHELL",
			similes: ["BASH", "EXEC", "RUN_COMMAND"],
			contexts: ["terminal"],
			contextGate: { anyOf: ["terminal"], roleGate: { minRole: "OWNER" } },
		});
		const parent = makeAction({
			name: "PARENT",
			contexts: ["general"],
			subActions: ["SHELL"],
			subPlanner: true,
		});
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [{ id: "call-1", name: "SHELL", arguments: {} }],
		}));
		const execute = vi.fn(async () => ({
			success: true,
			text: "shell done",
			data: { actionName: "SHELL" },
		}));

		await expect(
			runSubPlanner({
				runtime: makeRuntime([parent, child], useModel),
				action: parent,
				context: { id: "ctx", events: [] },
				ctx: {
					message: makeMessage(),
					activeContexts: ["general"],
					userRoles: ["GUEST"],
				},
				execute,
				evaluate: async () => ({
					success: true,
					decision: "FINISH",
					thought: "Done.",
					messageToUser: "Done.",
				}),
			}),
		).rejects.toThrow(/no sub-actions available/i);

		expect(useModel).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("sub-planner additional branch coverage", () => {
	function makeReportingRuntime(actions: Action[], useModel = vi.fn()) {
		const reportError = vi.fn();
		const runtime = makeRuntime(actions, useModel);
		(runtime as { reportError: unknown }).reportError = reportError;
		return { runtime, reportError };
	}

	function makeRecorder() {
		const recordStage = vi.fn(
			async (_trajectoryId: string, _stage: unknown) => undefined,
		);
		const recorder = {
			startTrajectory: vi.fn(() => "trj-sub-planner-test"),
			recordStage,
			endTrajectory: vi.fn(async () => undefined),
			load: vi.fn(async () => null),
			list: vi.fn(async () => []),
		};
		return { recorder, recordStage };
	}

	it("actionHasSubActions is false for missing and empty declarations", () => {
		expect(actionHasSubActions(makeAction({ name: "NO_SUBS" }))).toBe(false);
		expect(
			actionHasSubActions(makeAction({ name: "EMPTY_SUBS", subActions: [] })),
		).toBe(false);
	});

	it("resolveSubActions accepts inline child objects, preserves order, and deduplicates repeats", () => {
		const child = makeAction({ name: "CHILD" });
		const inline = makeAction({ name: "INLINE_CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD", "CHILD", inline],
		});

		expect(resolveSubActions(makeRuntime([parent, child]), parent)).toEqual([
			child,
			inline,
		]);
	});

	it("resolveSubActions throws for a string reference with no registered child", () => {
		const parent = makeAction({
			name: "PARENT",
			subActions: ["DOES_NOT_EXIST"],
		});

		expect(() => resolveSubActions(makeRuntime([parent]), parent)).toThrow(
			"Sub-action not found: DOES_NOT_EXIST",
		);
	});

	it("detectSubActionCycles finds a self-cycle and returns nothing for acyclic graphs", () => {
		const selfLoop = makeAction({ name: "LOOP", subActions: ["LOOP"] });
		expect(detectSubActionCycles([selfLoop])).toEqual([["LOOP", "LOOP"]]);

		const parent = makeAction({ name: "A", subActions: ["B"] });
		const child = makeAction({ name: "B" });
		expect(detectSubActionCycles([parent, child])).toEqual([]);
	});

	it("subPlannerCallDigest normalizes case and separators and treats missing params as empty", () => {
		const loose = subPlannerCallDigest({
			name: "google calendar",
			params: { calendar: "primary" },
		});
		expect(loose).toBe(
			subPlannerCallDigest({
				name: "GOOGLE_CALENDAR",
				params: { calendar: "primary" },
			}),
		);
		expect(subPlannerCallDigest({ name: "CHILD" })).toBe(
			subPlannerCallDigest({ name: "CHILD", params: {} }),
		);
		expect(subPlannerCallDigest({ name: "CHILD", params: { a: 1 } })).not.toBe(
			subPlannerCallDigest({ name: "CHILD", params: { a: 2 } }),
		);
	});

	it("rejects when the declaration resolves to zero children", async () => {
		const parent = makeAction({
			name: "EMPTY_PARENT",
			subActions: [],
			subPlanner: true,
		});

		await expect(
			runSubPlanner({
				runtime: makeRuntime([parent]),
				action: parent,
				context: { id: "ctx", events: [] },
				ctx: { message: makeMessage() },
			}),
		).rejects.toThrow("Action EMPTY_PARENT has no sub-actions");
	});

	it("rejects when the declared graph loops back to the parent", async () => {
		const child = makeAction({ name: "CHILD", subActions: ["PARENT"] });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});

		await expect(
			runSubPlanner({
				runtime: makeRuntime([parent, child]),
				action: parent,
				context: { id: "ctx", events: [] },
				ctx: { message: makeMessage() },
			}),
		).rejects.toThrow(/Sub-action cycle detected/i);
	});

	it("exposes each simile as its own alias tool beside the canonical child tool", async () => {
		const child = makeAction({
			name: "GOOGLE_CALENDAR",
			description: "Read calendar events",
			similes: ["CALENDAR_READ"],
		});
		const parent = makeAction({
			name: "CALENDAR",
			subActions: ["GOOGLE_CALENDAR"],
			subPlanner: true,
		});
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [{ id: "call-1", name: "GOOGLE_CALENDAR", arguments: {} }],
		}));
		const execute = vi.fn(async () => ({
			success: true,
			text: "calendar done",
			data: { actionName: "GOOGLE_CALENDAR" },
		}));

		await runSubPlanner({
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

		const modelParams = useModel.mock.calls[0]?.[1] as {
			tools?: Array<{ name: string; description?: string }>;
		};
		const tools = modelParams.tools ?? [];
		const names = tools.map((tool) => tool.name);
		expect(names).toContain("GOOGLE_CALENDAR");
		expect(names).toContain("CALENDAR_READ");
		const alias = tools.find((tool) => tool.name === "CALENDAR_READ");
		expect(alias?.description).toContain("Alias for GOOGLE_CALENDAR");
	});

	it("unions caller-selected and declared contexts exactly once per context", async () => {
		const child = makeAction({
			name: "CHILD",
			contexts: ["web"],
		});
		const parent = makeAction({
			name: "PARENT",
			contexts: ["research_workflow", "web"],
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
				activeContexts: ["research_workflow", "research_workflow"],
			},
			execute,
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				thought: "Done.",
				messageToUser: "Done.",
			}),
		});

		const [, executedCtx] = execute.mock.calls[0] ?? [];
		expect(
			(executedCtx as { activeContexts?: string[] })?.activeContexts,
		).toEqual(["research_workflow", "web"]);
	});

	it("records a subPlanner trajectory stage carrying the child surface area", async () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const { recorder, recordStage } = makeRecorder();

		await runSubPlanner({
			runtime: makeRuntime(
				[parent, child],
				vi.fn(async () => ({
					text: "",
					toolCalls: [{ id: "call-1", name: "CHILD", arguments: {} }],
				})),
			),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute: vi.fn(async () => ({ success: true, text: "done" })),
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				messageToUser: "Done.",
			}),
			recorder,
			trajectoryId: "trj-sub-planner-test",
			parentStageId: "stage-parent-1",
		});

		expect(recordStage).toHaveBeenCalled();
		const stage = recordStage.mock.calls
			.map((call) => call[1])
			.find(
				(
					candidate,
				): candidate is {
					stageId?: string;
					kind?: string;
					parentStageId?: string;
					tool?: { name?: string; args?: { childActions?: string[] } };
				} =>
					(candidate as { kind?: string } | undefined)?.kind === "subPlanner",
			);
		expect(stage).toBeDefined();
		expect(stage?.kind).toBe("subPlanner");
		expect(stage?.parentStageId).toBe("stage-parent-1");
		expect(stage?.tool?.name).toBe("sub-planner:PARENT");
		expect(stage?.tool?.args.childActions).toContain("CHILD");
	});

	it("keeps planning when the trajectory recorder fails and reports the error", async () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const recordStage = vi.fn(async () => {
			throw new Error("disk full");
		});
		const recorder = {
			startTrajectory: vi.fn(() => "trj-sub-planner-test"),
			recordStage,
			endTrajectory: vi.fn(async () => undefined),
			load: vi.fn(async () => null),
			list: vi.fn(async () => []),
		};
		const { runtime, reportError } = makeReportingRuntime(
			[parent, child],
			vi.fn(async () => ({
				text: "",
				toolCalls: [{ id: "call-1", name: "CHILD", arguments: {} }],
			})),
		);

		const result = await runSubPlanner({
			runtime,
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute: vi.fn(async () => ({ success: true, text: "done" })),
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				messageToUser: "Done.",
			}),
			recorder,
			trajectoryId: "trj-sub-planner-test",
		});

		expect(result.status).toBe("finished");
		expect(reportError).toHaveBeenCalledWith(
			"SubPlanner.recordStage",
			expect.any(Error),
			expect.objectContaining({ actionName: "PARENT" }),
		);
	});

	it("fails a tool call with an empty action name without executing any child", async () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const execute = vi.fn(async () => ({ success: true }));

		await runSubPlanner({
			runtime: makeRuntime(
				[parent, child],
				vi.fn(async () => ({
					text: "",
					toolCalls: [{ id: "call-empty", name: "", arguments: {} }],
				})),
			),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute,
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				messageToUser: "Nothing to do.",
			}),
		});

		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects a tool call naming an action outside the sub-planner surface", async () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const execute = vi.fn(async () => ({ success: true }));

		// Observed contract: the loop retries unavailable tool names and the
		// trajectory limit guard rejects once the unavailable_tool_calls cap is
		// exceeded; no child action ever executes.
		await expect(
			runSubPlanner({
				runtime: makeRuntime(
					[parent, child],
					vi.fn(async () => ({
						text: "",
						toolCalls: [
							{ id: "call-stray", name: "TOTALLY_UNRELATED", arguments: {} },
						],
					})),
				),
				action: parent,
				context: { id: "ctx", events: [] },
				ctx: { message: makeMessage() },
				execute,
			}),
		).rejects.toThrow(/Trajectory limit exceeded: unavailable_tool_calls/);

		expect(execute).not.toHaveBeenCalled();
	});
});
