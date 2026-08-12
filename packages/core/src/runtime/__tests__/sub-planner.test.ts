/**
 * Exercises the sub-planner helpers (`actionHasSubActions`,
 * `detectSubActionCycles`, `resolveSubActions`, `runSubPlanner`): child-action
 * resolution and simile matching, native-tool exposure, context propagation,
 * role/context gating, and real nested-to-parent result collapse after terminal
 * persistence or compaction. Scripted model/executor/evaluator doubles make the
 * planner loops deterministic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { subPlannerResultToPlannerToolResult } from "../../services/message";
import type { Action, ActionResult, IAgentRuntime, Memory } from "../../types";
import { _resetActionRolePolicyCacheForTests } from "../action-role-policy";
import {
	FAILED_TOOL_FALLBACK_MESSAGE,
	type PlannerLoopResult,
	type PlannerToolResult,
	runPlannerLoop,
	TOOL_RESULT_UNAVAILABLE_MESSAGE,
} from "../planner-loop";
import {
	actionHasSubActions,
	detectSubActionCycles,
	resolveSubActions,
	runSubPlanner,
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

async function runNestedParent(args: {
	childResult: ActionResult;
	silentTerminal?: "IGNORE" | "STOP";
}): Promise<{
	result: PlannerLoopResult;
	subResult: PlannerLoopResult;
	collapsed: PlannerToolResult;
	outerEvaluate: ReturnType<typeof vi.fn>;
}> {
	const child = makeAction({ name: "CHILD" });
	const parent = makeAction({
		name: "PARENT",
		subActions: ["CHILD"],
		subPlanner: true,
	});
	const innerUseModel = args.silentTerminal
		? vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [{ id: "child", name: "CHILD", arguments: {} }],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "silent-terminal",
							name: args.silentTerminal,
							arguments: {},
						},
					],
				})
		: vi.fn(async () => ({
				text: "",
				toolCalls: [{ id: "child", name: "CHILD", arguments: {} }],
			}));
	const innerRuntime = makeRuntime([parent, child], innerUseModel);
	let subResult: PlannerLoopResult | undefined;
	let collapsed: PlannerToolResult | undefined;
	const outerEvaluate = vi.fn(async () => ({
		success: true,
		decision: "FINISH" as const,
		thought: "Revive a reply after the nested planner stopped.",
		messageToUser: "REVIVED OUTER REPLY",
	}));
	const result = await runPlannerLoop({
		runtime: {
			useModel: vi.fn(async () => ({
				text: "",
				toolCalls: [{ id: "parent", name: "PARENT", arguments: {} }],
			})),
		},
		context: { id: "outer", events: [] },
		tools: [{ name: "PARENT", description: "Run the nested planner." }],
		evaluate: outerEvaluate,
		executeToolCall: async () => {
			subResult = await runSubPlanner({
				runtime: innerRuntime,
				action: parent,
				context: { id: "inner", events: [] },
				ctx: { message: makeMessage() },
				execute: vi.fn(async () => args.childResult),
				...(args.silentTerminal
					? {
							evaluate: vi.fn(async () => ({
								success: true,
								decision: "CONTINUE" as const,
								thought: "Let the nested planner choose its terminal.",
							})),
							config: {
								contextWindowTokens: 1_200,
								compactionReserveTokens: 1_000,
								compactionKeepSteps: 0,
							},
						}
					: {}),
			});
			collapsed = subPlannerResultToPlannerToolResult(subResult);
			return collapsed;
		},
	});

	if (!subResult || !collapsed) {
		throw new Error("Nested planner did not produce a collapsed result");
	}
	return { result, subResult, collapsed, outerEvaluate };
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

	it("collapses a non-silent successful run from its tool result after the terminal append", async () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const runResult = await runSubPlanner({
			runtime: makeRuntime(
				[parent, child],
				vi.fn(async () => ({
					text: "",
					toolCalls: [{ id: "call-success", name: "CHILD", arguments: {} }],
				})),
			),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute: vi.fn(async () => ({
				success: true,
				text: "task task-42 started",
				userFacingText: "Task task-42 started.",
				verifiedUserFacing: true,
				data: { taskId: "task-42" },
				continueChain: false,
			})),
		});

		expect(runResult.trajectory.steps.at(-1)).toMatchObject({
			terminalOnly: true,
			terminalMessage: runResult.finalMessage,
		});
		expect(subPlannerResultToPlannerToolResult(runResult)).toMatchObject({
			success: true,
			userFacingText: "Task task-42 started.",
			data: { taskId: "task-42" },
			continueChain: false,
		});
	});

	it("collapses a non-silent failed run without losing its machine failure fields", async () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const runResult = await runSubPlanner({
			runtime: makeRuntime(
				[parent, child],
				vi.fn(async () => ({
					text: "",
					toolCalls: [{ id: "call-failure", name: "CHILD", arguments: {} }],
				})),
			),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute: vi.fn(async () => ({
				success: false,
				text: "boom",
				error: "boom",
				data: { code: "CHILD_BOOM" },
				continueChain: false,
			})),
		});

		expect(runResult.trajectory.steps.at(-1)).toMatchObject({
			terminalOnly: true,
			terminalMessage: runResult.finalMessage,
		});
		const collapsed = subPlannerResultToPlannerToolResult(runResult);
		expect(collapsed).toMatchObject({
			success: false,
			error: "boom",
			data: { code: "CHILD_BOOM" },
			continueChain: false,
		});
		expect(collapsed.verifiedUserFacing).toBeUndefined();
	});

	it("collapses an actual tool result archived by compaction before terminal output", async () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [{ id: "call-archive", name: "CHILD", arguments: {} }],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "reply-archive",
						name: "REPLY",
						arguments: { text: "Archived task task-archive started." },
					},
				],
			});
		const runResult = await runSubPlanner({
			runtime: makeRuntime([parent, child], useModel),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute: vi.fn(async () => ({
				success: true,
				text: `task task-archive started ${"private diagnostics ".repeat(500)}`,
				userFacingText: "Archived task task-archive started.",
				data: { taskId: "task-archive" },
			})),
			evaluate: vi.fn(async () => ({
				success: true,
				decision: "CONTINUE",
				thought: "The child result is complete; emit a terminal reply.",
			})),
			config: {
				contextWindowTokens: 1_200,
				compactionReserveTokens: 1_000,
				compactionKeepSteps: 0,
			},
		});

		expect(runResult.trajectory.archivedSteps).toEqual([
			expect.objectContaining({
				toolCall: expect.objectContaining({ name: "CHILD" }),
				result: expect.objectContaining({
					success: true,
					data: { taskId: "task-archive" },
				}),
			}),
		]);
		expect(runResult.trajectory.steps.at(-1)).toMatchObject({
			terminalOnly: true,
			terminalMessage: "Archived task task-archive started.",
		});
		expect(subPlannerResultToPlannerToolResult(runResult)).toMatchObject({
			success: true,
			userFacingText: "Archived task task-archive started.",
			data: { taskId: "task-archive" },
		});
	});

	it.each([
		{ name: "without a mutation receipt", withReceipt: false },
		{ name: "with an applied mutation receipt", withReceipt: true },
	])(
		"keeps raw nested diagnostics out of the parent reply $name",
		async ({ withReceipt }) => {
			const observedAt = "2026-08-12T06:00:00.000Z";
			const { result, collapsed, outerEvaluate } = await runNestedParent({
				childResult: {
					success: true,
					text: "K9_SECRET",
					userFacingText: "Canonical only.",
					verifiedUserFacing: true,
					...(withReceipt
						? {
								effectReceipts: [
									{
										receiptId: "receipt-nested-1",
										operation: "nested.apply",
										resource: { kind: "nested", id: "nested-1" },
										artifacts: [],
										idempotency: { key: "nested-1", replayed: false },
										observedAt,
										outcome: "applied" as const,
										commit: {
											kind: "durable" as const,
											id: "nested-commit-1",
											committedAt: observedAt,
										},
									},
								],
								userFacingEffectReceiptIds: ["receipt-nested-1"],
							}
						: {}),
					data: { nestedId: "nested-1" },
					continueChain: false,
				},
			});

			// The aggregate remains available to planner/trajectory consumers. Only
			// a receipt-bound mutation may retain canonical terminal authority.
			expect(collapsed.text).toContain("K9_SECRET");
			expect(collapsed.userFacingText).toBe("Canonical only.");
			expect(collapsed.continueChain).toBe(false);
			expect(collapsed.data).toMatchObject({ nestedId: "nested-1" });
			expect(result.finalMessage).toBe(
				withReceipt ? "Canonical only." : TOOL_RESULT_UNAVAILABLE_MESSAGE,
			);
			expect(result.finalMessage).not.toContain("K9_SECRET");
			expect(result.trajectory.steps.at(-1)?.terminalMessage).toBe(
				result.finalMessage,
			);
			expect(outerEvaluate).not.toHaveBeenCalled();
			if (withReceipt) {
				expect(collapsed.verifiedUserFacing).toBe(true);
				expect(collapsed.userFacingEffectReceiptIds).toEqual([
					"receipt-nested-1",
				]);
			} else {
				expect(collapsed.verifiedUserFacing).toBeUndefined();
				expect(collapsed.userFacingEffectReceiptIds).toBeUndefined();
			}
		},
	);

	it("keeps a nested failure and its canonical failure text authoritative", async () => {
		const { result, collapsed, outerEvaluate } = await runNestedParent({
			childResult: {
				success: false,
				text: "FAILURE_DIAGNOSTIC_SECRET",
				userFacingText: "The nested operation failed.",
				verifiedUserFacing: true,
				turnComplete: true,
				error: "nested failure",
				data: { code: "NESTED_FAILURE" },
				continueChain: false,
			},
		});

		expect(collapsed).toMatchObject({
			success: false,
			userFacingText: "The nested operation failed.",
			error: "nested failure",
			data: { code: "NESTED_FAILURE" },
			continueChain: false,
		});
		expect(result.finalMessage).toBe("The nested operation failed.");
		expect(result.finalMessage).not.toContain("FAILURE_DIAGNOSTIC_SECRET");
		expect(outerEvaluate).not.toHaveBeenCalled();
	});

	it("keeps an archived unresolved child failure authoritative after a later child succeeds", async () => {
		const childA = makeAction({ name: "CHILD_A" });
		const childB = makeAction({ name: "CHILD_B" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD_A", "CHILD_B"],
			subPlanner: true,
		});
		const innerUseModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [{ id: "child-a", name: "CHILD_A", arguments: {} }],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [{ id: "child-b", name: "CHILD_B", arguments: {} }],
			});
		const innerEvaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "CONTINUE" as const,
				thought: "CHILD_A failed; run the independent CHILD_B step.",
			})
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "CHILD_B succeeded, but CHILD_A is still unresolved.",
				messageToUser: "The nested workflow failed.",
			});
		const observedAt = "2026-08-12T07:00:00.000Z";
		const execute = vi.fn(
			async (
				_runtime: IAgentRuntime,
				_ctx: unknown,
				toolCall: { name: string },
			): Promise<ActionResult> =>
				toolCall.name === "CHILD_A"
					? {
							success: false,
							text: `CHILD_A_PRIVATE_DIAGNOSTIC ${"failure detail ".repeat(500)}`,
							error: "child A exploded",
							data: { code: "CHILD_A_BOOM" },
						}
					: {
							success: true,
							text: "CHILD_B_PRIVATE_DIAGNOSTIC",
							data: { taskId: "task-b" },
							effectReceipts: [
								{
									receiptId: "receipt-child-b",
									operation: "child_b.finish",
									resource: { kind: "child_b", id: "task-b" },
									artifacts: [],
									idempotency: { key: "task-b", replayed: false },
									observedAt,
									outcome: "applied" as const,
									commit: {
										kind: "durable" as const,
										id: "commit-child-b",
										committedAt: observedAt,
									},
								},
							],
						},
		);
		let subResult: PlannerLoopResult | undefined;
		let collapsed: PlannerToolResult | undefined;
		const outerEvaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought:
				"The later child succeeded, so claim the whole parent succeeded.",
			messageToUser: "Everything succeeded.",
		}));

		const result = await runPlannerLoop({
			runtime: {
				useModel: vi.fn(async () => ({
					text: "",
					toolCalls: [{ id: "parent", name: "PARENT", arguments: {} }],
				})),
			},
			context: { id: "outer-failure-authority", events: [] },
			tools: [{ name: "PARENT", description: "Run both child operations." }],
			evaluate: outerEvaluate,
			executeToolCall: async () => {
				subResult = await runSubPlanner({
					runtime: makeRuntime([parent, childA, childB], innerUseModel),
					action: parent,
					context: { id: "inner-failure-authority", events: [] },
					ctx: { message: makeMessage() },
					execute,
					evaluate: innerEvaluate,
					config: {
						contextWindowTokens: 1_200,
						compactionReserveTokens: 1_000,
						compactionKeepSteps: 0,
					},
				});
				collapsed = subPlannerResultToPlannerToolResult(subResult);
				return collapsed;
			},
		});

		if (!subResult || !collapsed) {
			throw new Error("Nested planner did not produce a collapsed result");
		}
		expect(subResult.trajectory.archivedSteps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolCall: expect.objectContaining({ name: "CHILD_A" }),
					result: expect.objectContaining({ success: false }),
				}),
			]),
		);
		expect(subResult.evaluator?.success).toBe(false);
		expect(collapsed).toMatchObject({
			success: false,
			userFacingText: FAILED_TOOL_FALLBACK_MESSAGE,
			data: { taskId: "task-b" },
		});
		expect(collapsed.verifiedUserFacing).toBeUndefined();
		expect(collapsed.text).toContain("FAIL CHILD_A");
		expect(collapsed.text).toContain("OK CHILD_B");
		expect(collapsed.effectReceipts).toEqual([
			expect.objectContaining({ receiptId: "receipt-child-b" }),
		]);
		expect(outerEvaluate).toHaveBeenCalledTimes(1);
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
		expect(result.finalMessage).not.toContain("Everything succeeded");
		expect(result.finalMessage).not.toContain("PRIVATE_DIAGNOSTIC");
		expect(result.trajectory.steps.at(-1)).toMatchObject({
			terminalOnly: true,
			terminalMessage: result.finalMessage,
		});
	});

	it.each(["STOP", "IGNORE"] as const)(
		"propagates an archived nested %s as authoritative parent silence",
		async (silentTerminal) => {
			const { result, subResult, collapsed, outerEvaluate } =
				await runNestedParent({
					childResult: {
						success: true,
						text: `ARCHIVED_SECRET ${"private diagnostics ".repeat(500)}`,
						userFacingText: "Do not revive this child answer.",
					},
					silentTerminal,
				});

			expect(subResult.trajectory.archivedSteps).toEqual([
				expect.objectContaining({
					toolCall: expect.objectContaining({ name: "CHILD" }),
				}),
			]);
			expect(subResult.endedWithDeliberateSilence).toBe(true);
			expect(subResult.silentTerminalAction).toBe(silentTerminal);
			expect(collapsed.text).toContain("ARCHIVED_SECRET");
			expect(collapsed.userFacingText).toBeUndefined();
			expect(collapsed.continueChain).toBe(false);
			expect(collapsed.silentTerminalAction).toBe(silentTerminal);
			expect(result.endedWithDeliberateSilence).toBe(true);
			expect(result.silentTerminalAction).toBe(silentTerminal);
			expect(result.finalMessage).toBeUndefined();
			expect(result.trajectory.steps.at(-1)?.terminalOnly).not.toBe(true);
			expect(outerEvaluate).not.toHaveBeenCalled();
		},
	);

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
