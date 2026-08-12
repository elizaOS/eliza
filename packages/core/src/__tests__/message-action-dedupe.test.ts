/**
 * Exercises the message service's planner-action de-duplication
 * (stripReplyWhenActionOwnsTurn) and sub-planner result collapse
 * (subPlannerResultToPlannerToolResult): REPLY/alias dedupe, continueChain
 * propagation from a terminal sub-action, unresolved-failure correlation, and
 * multi-step aggregation into the umbrella result. Runs against a stub runtime
 * (actions + logger) — fully deterministic.
 */
import { describe, expect, it, vi } from "vitest";
import { projectActionResultForClipboard } from "../runtime/execute-planned-tool-call.ts";
import { actionResultToPlannerToolResult } from "../runtime/planner-loop.ts";
import {
	resolveActionResultTranscriptVisibility,
	stripReplyWhenActionOwnsTurn,
	subPlannerResultToPlannerToolResult,
	wrapSingleTurnVisibleCallback,
} from "../services/message.ts";
import type { IAgentRuntime } from "../types/runtime";

type SubResult = Parameters<typeof subPlannerResultToPlannerToolResult>[0];

function subResult(
	lastStepResult: Record<string, unknown> | undefined,
	finalMessage?: string,
): SubResult {
	return {
		status: "finished",
		finalMessage,
		trajectory: {
			archivedSteps: [],
			steps: [
				...(lastStepResult
					? [
							{
								iteration: 1,
								toolCall: { name: "CHILD" },
								result: lastStepResult,
							},
						]
					: []),
				...(finalMessage !== undefined
					? [
							{
								iteration: 2,
								terminalMessage: finalMessage,
								terminalOnly: true,
							},
						]
					: []),
			],
			plannedQueue: [],
			evaluatorOutputs: [],
			context: { id: "ctx", events: [] },
		},
	} as unknown as SubResult;
}

function runtime(
	actions: Array<{ name: string; similes?: string[] }> = [],
): Pick<IAgentRuntime, "actions" | "logger"> {
	return {
		actions,
		logger: {
			info: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as Pick<IAgentRuntime, "actions" | "logger">;
}

describe("stripReplyWhenActionOwnsTurn", () => {
	it("collapses duplicate REPLY planner actions before execution", () => {
		expect(stripReplyWhenActionOwnsTurn(runtime(), ["REPLY", "REPLY"])).toEqual(
			["REPLY"],
		);
	});

	it("dedupes aliases against the registered canonical action name", () => {
		expect(
			stripReplyWhenActionOwnsTurn(
				runtime([{ name: "REPLY", similes: ["RESPOND"] }]),
				["RESPOND", "REPLY"],
			),
		).toEqual(["RESPOND"]);
	});
});

describe("subPlannerResultToPlannerToolResult", () => {
	it("preserves internal transcript visibility from the terminal sub-action", () => {
		const inventory = "available_views:\nviews[0]:";
		const result = subPlannerResultToPlannerToolResult({
			status: "finished",
			finalMessage: inventory,
			trajectory: {
				archivedSteps: [],
				steps: [
					{
						iteration: 1,
						toolCall: { name: "VIEWS" },
						result: {
							success: true,
							text: inventory,
							transcriptVisibility: "internal",
							subSteps: [
								{
									operation: "VIEWS",
									callDigest: "views-call",
									nominalSuccess: true,
									effect: { kind: "unproven" },
									retryable: true,
								},
							],
						},
					},
					{
						iteration: 2,
						terminalMessage: inventory,
						terminalOnly: true,
					},
				],
				plannedQueue: [],
				evaluatorOutputs: [],
				context: { id: "ctx", events: [] },
			},
		} as unknown as SubResult);
		expect(result.transcriptVisibility).toBe("internal");
		expect(result.text).toBe('[{"operation":"VIEWS","status":"unknown"}]');
		expect(result.userFacingText).toBeUndefined();
		expect(result.subSteps).toEqual([
			expect.objectContaining({
				operation: "VIEWS",
			}),
		]);
		expect(result.data).toBeUndefined();
	});

	it("keeps a distinct synthesized summary visible after an internal sub-action", () => {
		const inventory = "available_views:\nviews[0]:";
		const summary = "There are no apps available yet.";
		const result = subPlannerResultToPlannerToolResult({
			status: "finished",
			finalMessage: summary,
			trajectory: {
				archivedSteps: [],
				steps: [
					{
						iteration: 1,
						toolCall: { name: "VIEWS" },
						result: {
							success: true,
							text: inventory,
							transcriptVisibility: "internal",
							subSteps: [
								{
									operation: "VIEWS",
									callDigest: "views-call",
									nominalSuccess: true,
									effect: { kind: "unproven" },
									retryable: true,
								},
							],
						},
					},
					{
						iteration: 2,
						terminalMessage: summary,
						terminalOnly: true,
					},
				],
				plannedQueue: [],
				evaluatorOutputs: [],
				context: { id: "ctx", events: [] },
			},
		} as unknown as SubResult);

		expect(result.transcriptVisibility).toBe("internal");
		expect(result.text).toBe('[{"operation":"VIEWS","status":"unknown"}]');
		expect(result.userFacingText).toBe(summary);
	});

	it("propagates continueChain:false from the terminal sub-action", () => {
		// A fire-and-forget sub-action (e.g. TASKS_SPAWN_AGENT) returns
		// continueChain:false. Without propagating it through the umbrella
		// result, the parent planner loop evaluates CONTINUE and re-runs the
		// umbrella, producing duplicate spawns on a single user turn.
		const result = subPlannerResultToPlannerToolResult(
			subResult(
				{ success: true, text: "On it.", continueChain: false },
				"On it.",
			),
		);
		expect(result.continueChain).toBe(false);
		expect(result.success).toBe(true);
	});

	it("preserves an exact applied receipt binding through the umbrella result", () => {
		const text = "Done — the pickup reminder was scheduled.";
		const observedAt = "2026-07-27T18:00:00.000Z";
		const result = subPlannerResultToPlannerToolResult(
			subResult(
				{
					success: true,
					text,
					userFacingText: text,
					verifiedUserFacing: true,
					effectReceipts: [
						{
							receiptId: "receipt-reminder-1",
							operation: "lifeops.reminder.create",
							resource: {
								kind: "lifeops.reminder",
								id: "reminder-1",
							},
							artifacts: [],
							idempotency: {
								key: "pickup-reminder-request",
								replayed: false,
							},
							observedAt,
							outcome: "applied",
							commit: {
								kind: "durable",
								id: "transaction-1",
								committedAt: observedAt,
							},
						},
					],
					userFacingEffectReceiptIds: ["receipt-reminder-1"],
				},
				text,
			),
		);

		expect(result.userFacingText).toBe(text);
		expect(result.verifiedUserFacing).toBe(true);
		expect(result.userFacingEffectReceiptIds).toEqual(["receipt-reminder-1"]);
		expect(result.effectReceipts).toEqual([
			expect.objectContaining({
				receiptId: "receipt-reminder-1",
				outcome: "applied",
			}),
		]);
	});

	it("does not transfer verified receipt provenance to a distinct summary", () => {
		const result = subPlannerResultToPlannerToolResult(
			subResult(
				{
					success: true,
					userFacingText: "The exact action-owned text.",
					verifiedUserFacing: true,
					userFacingEffectReceiptIds: ["receipt-1"],
				},
				"A synthesized umbrella summary.",
			),
		);

		expect(result.userFacingText).toBe("A synthesized umbrella summary.");
		expect(result.verifiedUserFacing).toBeUndefined();
		expect(result.userFacingEffectReceiptIds).toBeUndefined();
	});

	it("leaves continueChain undefined when the sub-action did not set it", () => {
		const result = subPlannerResultToPlannerToolResult(
			subResult({ success: true, text: "done" }, "done"),
		);
		expect(result.continueChain).toBeUndefined();
	});

	it("handles an empty sub-trajectory without throwing", () => {
		const result = subPlannerResultToPlannerToolResult(subResult(undefined));
		expect(result.continueChain).toBeUndefined();
		expect(result.success).toBe(true);
	});

	it("keeps deliberate sub-planner silence authoritative over earlier terminal text", () => {
		const result = subPlannerResultToPlannerToolResult({
			status: "finished",
			endedWithDeliberateSilence: true,
			silentTerminalAction: "STOP",
			trajectory: {
				archivedSteps: [
					{
						iteration: 1,
						terminalOnly: true,
						terminalMessage: "Do not revive this superseded reply.",
					},
				],
				steps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
				context: { id: "ctx", events: [] },
			},
		} as unknown as SubResult);

		expect(result.userFacingText).toBeUndefined();
		expect(result.text).toBeUndefined();
	});

	it("separates terminal-message authority from the latest actual sub-action result", () => {
		const result = subPlannerResultToPlannerToolResult({
			status: "finished",
			finalMessage: "STALE_RETURN_FALLBACK",
			evaluator: {
				success: true,
				decision: "FINISH",
				thought: "Invented success.",
				messageToUser: "INVENTED_EVALUATOR_FALLBACK",
			},
			trajectory: {
				archivedSteps: [
					{
						iteration: 1,
						toolCall: { name: "CHILD" },
						result: {
							success: false,
							error: "boom",
							data: { code: "CHILD_BOOM" },
							continueChain: false,
						},
					},
				],
				steps: [
					{
						iteration: 2,
						toolCall: { name: "REPLY" },
						result: {
							success: true,
							data: { code: "FORGED_TERMINAL_RESULT" },
							continueChain: true,
						},
					},
					{
						iteration: 3,
						terminalOnly: true,
						terminalMessage: "Canonical terminal message.",
					},
				],
				plannedQueue: [],
				evaluatorOutputs: [],
				context: { id: "ctx", events: [] },
			},
		} as unknown as SubResult);

		expect(result).toMatchObject({
			success: false,
			userFacingText: "Canonical terminal message.",
			error: "boom",
			data: { code: "CHILD_BOOM" },
			continueChain: false,
		});
	});

	it("keeps an unresolved child failure over an unrelated success and optimistic evaluator", () => {
		const result = subPlannerResultToPlannerToolResult({
			status: "finished",
			evaluator: {
				success: true,
				decision: "FINISH",
				thought: "The unrelated later child succeeded.",
			},
			trajectory: {
				archivedSteps: [
					{
						iteration: 1,
						toolCall: { name: "CHILD_A", params: { taskId: "a" } },
						result: { success: false, error: "child A failed" },
					},
				],
				steps: [
					{
						iteration: 2,
						toolCall: { name: "CHILD_B", params: { taskId: "b" } },
						result: {
							success: true,
							text: "child B succeeded",
							data: { taskId: "b" },
						},
					},
					{
						iteration: 3,
						terminalOnly: true,
						terminalMessage: "Child A is still unresolved.",
					},
				],
				plannedQueue: [],
				evaluatorOutputs: [],
				context: { id: "ctx", events: [] },
			},
		} as unknown as SubResult);

		expect(result).toMatchObject({
			success: false,
			userFacingText: "Child A is still unresolved.",
			data: { taskId: "b" },
		});
	});

	it("keeps a terminal evaluator failure over a successful latest child", () => {
		const result = subPlannerResultToPlannerToolResult({
			...subResult(
				{ success: true, text: "child succeeded", data: { taskId: "b" } },
				"The nested workflow failed validation.",
			),
			evaluator: {
				success: false,
				decision: "FINISH",
				thought: "The terminal validation failed.",
				messageToUser: "The nested workflow failed validation.",
			},
		});

		expect(result).toMatchObject({
			success: false,
			userFacingText: "The nested workflow failed validation.",
			data: { taskId: "b" },
		});
	});

	it("lets a successful retry resolve the same failed child operation", () => {
		const result = subPlannerResultToPlannerToolResult({
			status: "finished",
			evaluator: {
				success: true,
				decision: "FINISH",
				thought: "The exact failed operation succeeded on retry.",
			},
			trajectory: {
				archivedSteps: [
					{
						iteration: 1,
						toolCall: { name: "CHILD", params: { taskId: "same-task" } },
						result: { success: false, error: "transient failure" },
					},
				],
				steps: [
					{
						iteration: 2,
						toolCall: { name: "CHILD", params: { taskId: "same-task" } },
						result: {
							success: true,
							text: "retry succeeded",
							data: { taskId: "same-task", attempt: 2 },
						},
					},
					{
						iteration: 3,
						terminalOnly: true,
						terminalMessage: "The retry succeeded.",
					},
				],
				plannedQueue: [],
				evaluatorOutputs: [],
				context: { id: "ctx", events: [] },
			},
		} as unknown as SubResult);

		expect(result).toMatchObject({
			success: true,
			userFacingText: "The retry succeeded.",
			data: { taskId: "same-task", attempt: 2 },
		});
	});

	// Regression for elizaOS/eliza#8007: a multi-step sub-planner collapse must
	// surface EVERY executed sub-step to the parent loop, not only the terminal
	// one, so the outer planner can see which ops already succeeded and advance
	// instead of re-running the umbrella action from the first step.
	it("aggregates all typed sub-steps into safe diagnostic text", () => {
		const multiStep = {
			status: "finished",
			finalMessage: "Opened a PR for hello-world.",
			trajectory: {
				archivedSteps: [],
				steps: [
					{
						iteration: 1,
						toolCall: { name: "provision_workspace" },
						result: {
							success: true,
							text: "workspace ws-1 ready",
							subSteps: [
								{
									operation: "provision_workspace",
									callDigest: "provision-call",
									nominalSuccess: true,
									effect: { kind: "unproven" },
									retryable: true,
								},
							],
						},
					},
					{
						iteration: 2,
						toolCall: { name: "spawn_agent" },
						result: {
							success: true,
							text: "spawned agent a-1",
							subSteps: [
								{
									operation: "spawn_agent",
									callDigest: "spawn-call",
									nominalSuccess: true,
									effect: { kind: "unproven" },
									retryable: true,
								},
							],
						},
					},
					{
						iteration: 3,
						toolCall: { name: "submit_workspace" },
						result: {
							success: false,
							error: "no diff to submit",
							subSteps: [
								{
									operation: "submit_workspace",
									callDigest: "submit-call",
									nominalSuccess: false,
									effect: { kind: "unproven" },
									retryable: true,
								},
							],
						},
					},
					{
						iteration: 4,
						terminalMessage: "Opened a PR for hello-world.",
						terminalOnly: true,
					},
				],
				plannedQueue: [],
				evaluatorOutputs: [],
				context: { id: "ctx", events: [] },
			},
		} as unknown as SubResult;

		const result = subPlannerResultToPlannerToolResult(multiStep);

		// The diagnostic channel carries only canonical operation/status pairs.
		expect(result.text).toContain("provision_workspace");
		expect(result.text).toContain("spawn_agent");
		expect(result.text).toContain("submit_workspace");
		expect(result.text).toContain("unknown");
		expect(result.text).toContain("failed");

		// The user-facing text stays the synthesized final message.
		expect(result.userFacingText).toBe("Opened a PR for hello-world.");

		const subSteps = result.subSteps;
		expect(Array.isArray(subSteps)).toBe(true);
		if (!Array.isArray(subSteps)) {
			throw new Error("Expected structured sub-step diagnostics");
		}
		expect(subSteps.length).toBe(3);
	});
});

describe("action-result transcript visibility", () => {
	it("binds the marker to exact diagnostic text, never distinct visible prose", () => {
		const inventory = "available_views:\nviews[0]:";
		const actionResults = [
			{
				success: true,
				text: inventory,
				transcriptVisibility: "internal" as const,
				userFacingText: "There are no apps available yet.",
			},
		];

		expect(
			resolveActionResultTranscriptVisibility(inventory, actionResults),
		).toBe("internal");
		expect(
			resolveActionResultTranscriptVisibility(
				"There are no apps available yet.",
				actionResults,
			),
		).toBeUndefined();
	});

	it("never revives a removed raw sub-planner payload from legacy data", () => {
		const inventory = "available_views:\nviews[0]:";
		const summary = "There are no apps available yet.";
		const actionResults = [
			{
				success: true,
				text: `OK VIEWS: ${inventory}`,
				transcriptVisibility: "internal" as const,
				userFacingText: summary,
				data: {
					subSteps: [
						{
							action: "VIEWS",
							success: true,
							summary: inventory,
							internalTranscriptText: inventory,
						},
					],
				},
			},
		];

		expect(
			resolveActionResultTranscriptVisibility(inventory, actionResults),
		).toBeUndefined();
		expect(
			resolveActionResultTranscriptVisibility(summary, actionResults),
		).toBeUndefined();
	});

	it("drops internal content before voice rewriting or connector delivery", async () => {
		const callback = vi.fn(async () => []);
		const useModel = vi.fn(async () => "must not run");
		const wrapped = wrapSingleTurnVisibleCallback(
			{ ...runtime(), agentId: "agent" as never, useModel },
			{
				id: "message" as never,
				roomId: "room" as never,
				entityId: "entity" as never,
			},
			callback,
		);

		expect(wrapped).toBeDefined();
		await wrapped?.({
			text: "available_views:\n  type: gui\n  count: 0",
			transcriptVisibility: "internal",
		});

		expect(useModel).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
	});

	it("survives the canonical planner projection without removing diagnostics", () => {
		const result = actionResultToPlannerToolResult({
			success: true,
			text: "available_views:\nviews[0]:",
			transcriptVisibility: "internal",
			data: { views: [] },
		});

		expect(result.transcriptVisibility).toBe("internal");
		expect(result.text).toContain("available_views:");
		expect(result.data).toEqual({ views: [] });
	});

	it("survives sensitive clipboard projection while structured data is removed", () => {
		const result = projectActionResultForClipboard(
			{ name: "VIEWS", suppressActionResultClipboard: true },
			{
				success: true,
				text: "available_views:\nviews[0]:",
				transcriptVisibility: "internal",
				data: { views: [{ id: "notes" }] },
			},
		);

		expect(result.transcriptVisibility).toBe("internal");
		expect(result.text).toContain("available_views:");
		expect(result.data).toEqual({ actionName: "VIEWS" });
	});
});
