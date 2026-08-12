/**
 * Regression coverage (#8007) for planner multi-step advance: each succeeded
 * nested operation's receipt-backed status reaches the next turn so the loop
 * advances (provision → spawn → submit) instead of re-dispatching the first
 * step, and a weak model that re-emits an identical call is bounded. Deterministic —
 * scripted `useModel` + tool executor shaped like the orchestrator's real
 * returns; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import type { GenerateTextResult, ToolDefinition } from "../../types/model";
import { runPlannerLoop } from "../planner-loop";
import { plannerToolCallDigest } from "../planner-trajectory";

/**
 * Regression for #8007 — "v5 planner loops on `decision: CONTINUE` without
 * advancing past the first successful tool call."
 *
 * The reported failure: a multi-step orchestrator flow (plugin-agent-orchestrator
 * TASKS: provision_workspace → spawn_agent → submit_workspace) returned a
 * partial-success ActionResult, the evaluator kept emitting
 * `{ success:false, decision:"CONTINUE" }`, and the planner re-dispatched the
 * SAME first step (provision_workspace) instead of advancing — looping until a
 * trajectory limit fired and the user saw a timeout.
 *
 * The parent planner receives only receipt-backed nested operation status;
 * arguments, raw child output, identifiers, and result data remain outside the
 * model boundary. A defense-in-depth loop-breaker also caps a model that still
 * re-emits an already-succeeded call.
 *
 * These tests drive the real `runPlannerLoop` with a scripted model + scripted
 * tool executor shaped exactly like the orchestrator's real returns
 * (see plugins/plugin-agent-orchestrator/src/actions/tasks.ts):
 *   provision_workspace → { success:true, text:"Created workspace w1",
 *                           data:{ workspaceId, path, branch, isWorktree } }
 *   spawn_agent         → { success:true, ..., continueChain:false }  (terminal)
 */

const TASKS_TOOL: ToolDefinition = {
	name: "TASKS",
	description: "Orchestrator multi-step workspace tasks",
	parameters: {
		type: "object",
		properties: {
			subaction: { type: "string" },
			repo: { type: "string" },
		},
		required: ["subaction"],
	},
};

function tasksToolCall(subaction: string, id: string): GenerateTextResult {
	return {
		text: "",
		finishReason: "tool-calls",
		toolCalls: [
			{
				id,
				toolName: "TASKS",
				input: { subaction, repo: "org/hello-world" },
			} as never,
		],
		usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
	} as GenerateTextResult;
}

const observedAt = "2026-08-12T12:00:00.000Z";

function completedNestedResult(
	operation: string,
	params: Record<string, unknown>,
	options: { continueChain?: false; rawText?: string; rawData?: object } = {},
) {
	const receipt = {
		receiptId: `receipt-${operation}`,
		operation: `tasks.${operation}`,
		resource: { kind: "tasks.operation", id: `resource-${operation}` },
		artifacts: [],
		idempotency: { key: `tasks-${operation}`, replayed: false },
		observedAt,
		outcome: "applied" as const,
		commit: {
			kind: "durable" as const,
			id: `commit-${operation}`,
			committedAt: observedAt,
		},
	};
	return {
		success: true as const,
		text: options.rawText,
		data: options.rawData,
		continueChain: options.continueChain,
		effectReceipts: [receipt],
		subSteps: [
			{
				operation,
				callDigest: plannerToolCallDigest({ name: operation, params }),
				nominalSuccess: true,
				effect: { kind: "receipts" as const, receiptIds: [receipt.receiptId] },
				retryable: true,
			},
		],
	};
}

describe("#8007 planner multi-step advance", () => {
	it("advances provision → spawn and surfaces safe provision status", async () => {
		const modelInputs: unknown[] = [];
		const executed: string[] = [];
		let plannerCall = 0;

		const runtime = {
			useModel: vi.fn(async (_modelType: unknown, options: unknown) => {
				plannerCall++;
				modelInputs.push(options);
				if (plannerCall === 1) {
					return tasksToolCall("provision_workspace", "call_provision_1");
				}
				if (plannerCall === 2) {
					// A model that can read the surfaced provision result advances.
					return tasksToolCall("spawn_agent", "call_spawn_1");
				}
				return {
					text: "On it — building now.",
					finishReason: "stop",
					toolCalls: [],
					usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
				} as GenerateTextResult;
			}),
		};

		const executeToolCall = vi.fn(
			async (toolCall: { name: string; params?: Record<string, unknown> }) => {
				const sub = String(toolCall.params?.subaction ?? "");
				executed.push(sub);
				if (sub === "provision_workspace")
					return completedNestedResult(sub, toolCall.params ?? {}, {
						rawText: "Created workspace w1",
						rawData: {
							workspaceId: "w1",
							path: "/workspaces/w1",
							branch: "main",
							isWorktree: false,
						},
					});
				if (sub === "spawn_agent")
					return completedNestedResult(sub, toolCall.params ?? {}, {
						continueChain: false,
						rawText: "Agent spawned into workspace w1.",
						rawData: {
							agentId: "AGENT_PRIVATE_3f2504e0",
							workspaceId: "w1",
						},
					});
				return { success: true as const, text: "ok", continueChain: false };
			},
		);

		// The evaluator that fired the original loop: after provision succeeds the
		// WHOLE task is not done, so it returns CONTINUE.
		const evaluate = vi.fn(
			async (args: { trajectory: { steps: unknown[] } }) => {
				if (args.trajectory.steps.length < 2) {
					return {
						success: false,
						decision: "CONTINUE" as const,
						thought: "Provisioned; still need to spawn the agent.",
					};
				}
				return {
					success: true,
					decision: "FINISH" as const,
					thought: "Agent spawned.",
					messageToUser: "Done — the agent is building hello-world.",
				};
			},
		);

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx-8007-advance" },
			tools: [TASKS_TOOL],
			executeToolCall,
			evaluate,
		});

		// Advanced to the next op exactly once each — provision is NOT re-dispatched.
		expect(executed).toEqual(["provision_workspace", "spawn_agent"]);

		// The second turn carries only the safe operation/status projection.
		const secondTurnInput = JSON.stringify(modelInputs[1] ?? {});
		expect(secondTurnInput).toContain(
			'{\\"operation\\":\\"provision_workspace\\",\\"status\\":\\"completed\\"}',
		);
		for (const forbidden of ["Created workspace w1", "/workspaces/w1", "w1"]) {
			expect(secondTurnInput).not.toContain(forbidden);
		}

		expect(result.status).toBe("finished");
	});

	it("surfaces safe provision and spawn status before submit", async () => {
		const modelInputs: unknown[] = [];
		const executed: string[] = [];
		let plannerCall = 0;

		const runtime = {
			useModel: vi.fn(async (_modelType: unknown, options: unknown) => {
				plannerCall++;
				modelInputs.push(options);
				if (plannerCall === 1)
					return tasksToolCall("provision_workspace", "p1");
				if (plannerCall === 2) return tasksToolCall("spawn_agent", "s1");
				if (plannerCall === 3) return tasksToolCall("submit_workspace", "sub1");
				return {
					text: "Submitted.",
					finishReason: "stop",
					toolCalls: [],
					usage: { promptTokens: 40, completionTokens: 4, totalTokens: 44 },
				} as GenerateTextResult;
			}),
		};

		const executeToolCall = vi.fn(
			async (toolCall: { name: string; params?: Record<string, unknown> }) => {
				const sub = String(toolCall.params?.subaction ?? "");
				executed.push(sub);
				if (sub === "provision_workspace")
					return completedNestedResult(sub, toolCall.params ?? {}, {
						rawText: "Created workspace w1",
						rawData: { workspaceId: "w1", path: "/workspaces/w1" },
					});
				// spawn without continueChain:false here so the chain continues to submit.
				if (sub === "spawn_agent")
					return completedNestedResult(sub, toolCall.params ?? {}, {
						rawText: "Agent spawned into workspace w1.",
						rawData: {
							agentId: "AGENT_PRIVATE_3f2504e0",
							workspaceId: "w1",
						},
					});
				if (sub === "submit_workspace")
					return completedNestedResult(sub, toolCall.params ?? {}, {
						continueChain: false,
						rawText: "Submitted PR for workspace w1.",
						rawData: { prUrl: "https://github.com/org/hello-world/pull/1" },
					});
				return { success: true as const, text: "ok", continueChain: false };
			},
		);

		const evaluate = vi.fn(
			async (args: { trajectory: { steps: unknown[] } }) => {
				if (args.trajectory.steps.length < 3) {
					return {
						success: false,
						decision: "CONTINUE" as const,
						thought: "More steps remain in the build chain.",
					};
				}
				return {
					success: true,
					decision: "FINISH" as const,
					thought: "Build chain complete.",
					messageToUser: "Done.",
				};
			},
		);

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx-8007-three-step" },
			tools: [TASKS_TOOL],
			executeToolCall,
			evaluate,
		});

		// All three ops ran once, in order — no restart-from-first.
		expect(executed).toEqual([
			"provision_workspace",
			"spawn_agent",
			"submit_workspace",
		]);

		// By the third turn, both statuses are present and all raw payloads stay out.
		const thirdTurnInput = JSON.stringify(modelInputs[2] ?? {});
		expect(thirdTurnInput).toContain(
			'{\\"operation\\":\\"provision_workspace\\",\\"status\\":\\"completed\\"}',
		);
		expect(thirdTurnInput).toContain(
			'{\\"operation\\":\\"spawn_agent\\",\\"status\\":\\"completed\\"}',
		);
		for (const forbidden of [
			"Created workspace w1",
			"Agent spawned into workspace w1",
			"/workspaces/w1",
			"AGENT_PRIVATE_3f2504e0",
		]) {
			expect(thirdTurnInput).not.toContain(forbidden);
		}

		expect(result.status).toBe("finished");
	});

	it("bounds a weak model that keeps re-emitting the same provision step (no infinite loop / timeout)", async () => {
		let plannerCall = 0;

		const runtime = {
			useModel: vi.fn(async () => {
				plannerCall++;
				// Weak model never advances — always re-emits provision with identical
				// args (the #8007 failure mode). Distinct ids, same name+args.
				return tasksToolCall("provision_workspace", `p_${plannerCall}`);
			}),
		};

		const executeToolCall = vi.fn(async () =>
			completedNestedResult(
				"provision_workspace",
				{ subaction: "provision_workspace", repo: "org/hello-world" },
				{ rawText: "Created workspace w1" },
			),
		);

		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "CONTINUE" as const,
			thought: "Still not done.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx-8007-weak-model" },
			tools: [TASKS_TOOL],
			executeToolCall,
			// Small bounds so the mitigation fires fast; it must fire well within.
			config: { maxToolCalls: 30, maxRepeatedToolCalls: 3 },
			evaluate,
		});

		// The redundant-succeeded loop-breaker means provision is actually EXECUTED
		// only once — not 8×/70×. Every later identical call is recognized as an
		// exact repeat and skipped rather than re-run.
		expect(executeToolCall).toHaveBeenCalledTimes(1);

		// The loop terminates cleanly via forced synthesis — never an unbounded
		// spin to the token/trajectory limit that surfaced as the 120s timeout.
		expect(result.status).toBe("finished");
		// Sanity: the model was polled a bounded number of times.
		expect(plannerCall).toBeLessThanOrEqual(10);
	});
});
