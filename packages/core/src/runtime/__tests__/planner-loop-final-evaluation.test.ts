/**
 * Exercises final intent judgment through the real planner loop and evaluator,
 * using deterministic model responses and a stateful tool executor. A native
 * terminal reply must not bypass unfulfilled work after a settled tool result.
 */
import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/model";
import { runPlannerLoop } from "../planner-loop";
import type { PlannerRuntime } from "../planner-types";

const compoundContext = {
	id: "compound",
	events: [
		{
			id: "handler",
			type: "message_handler" as const,
			metadata: { plan: { intents: ["read record", "open Home"] } },
		},
	],
};

function call(name: string, scope: "more_work_pending" | "final") {
	return {
		id: name.toLowerCase(),
		name,
		arguments: { eliza_turn_scope: scope },
	};
}

describe("post-tool final intent judgment", () => {
	it.each(["REPLY", "REPLY + STOP", "completed text"])(
		"rejects premature %s and completes the remaining effect exactly once",
		async (terminalKind) => {
			const executed: string[] = [];
			let readNote: string | undefined;
			let destination = "/notes";
			const prematureText = "The record was read and the destination is open.";
			const finalText = "The record says bluebird, and Home is now open.";
			const terminal =
				terminalKind === "completed text"
					? JSON.stringify({ completed: true, messageToUser: prematureText })
					: {
							text: prematureText,
							toolCalls: [
								call("REPLY", "final"),
								...(terminalKind === "REPLY + STOP"
									? [call("STOP", "final")]
									: []),
							],
						};
			const originalTerminal = structuredClone(terminal);
			const plans = [
				{ text: "", toolCalls: [call("READ", "more_work_pending")] },
				terminal,
				{ text: "", toolCalls: [call("NAVIGATE", "final")] },
			];
			let planIndex = 0;
			const evaluatedInputs: string[] = [];
			const useModel = vi.fn<PlannerRuntime["useModel"]>(
				async (type, params) => {
					if (type === ModelType.ACTION_PLANNER) {
						const plan = plans[planIndex++];
						if (!plan) throw new Error("Unexpected planner call");
						return plan;
					}
					evaluatedInputs.push(JSON.stringify(params.messages));
					return JSON.stringify(
						readNote === "bluebird" && destination === "/chat"
							? {
									thought: "Both requested operations have execution results.",
									success: true,
									decision: "FINISH",
									messageToUser: finalText,
								}
							: {
									success: false,
									decision: "CONTINUE",
									thought: "The navigation has no execution result yet.",
								},
					);
				},
			);
			const result = await runPlannerLoop({
				runtime: { useModel },
				context: compoundContext,
				executeToolCall: (tool) => {
					executed.push(tool.name);
					if (tool.name === "READ") readNote = "bluebird";
					if (tool.name === "NAVIGATE") destination = "/chat";
					return {
						success: true,
						transcriptVisibility: "internal",
						data:
							tool.name === "READ" ? { note: readNote } : { path: destination },
					};
				},
			});
			expect(executed).toEqual(["READ", "NAVIGATE"]);
			expect(result.finalMessage).toBe(finalText);
			expect(result.evaluator).toMatchObject({
				decision: "FINISH",
				success: true,
			});
			expect(
				evaluatedInputs.some((input) => input.includes(prematureText)),
			).toBe(true);
			expect(evaluatedInputs.at(-1)).toContain("bluebird");
			expect(evaluatedInputs.at(-1)).toContain("/chat");
			expect(
				result.trajectory.steps.filter((step) => step.toolCall),
			).toHaveLength(2);
			expect(plans[1]).toEqual(originalTerminal);
		},
	);

	it.each([
		{
			label: "failed action",
			success: false,
			data: {},
			text: "The requested write was denied.",
		},
		{
			label: "input widget",
			success: true,
			data: { awaitingUserInput: true },
			text: '[FORM]\n{"title":"Choose a date","fields":[{"name":"when","label":"When","type":"date"}]}\n[/FORM]',
		},
	])(
		"preserves the $label delivery authority after a native reply",
		async ({ success, data, text }) => {
			let planCount = 0;
			const useModel = vi.fn<PlannerRuntime["useModel"]>(async (type) => {
				if (type === ModelType.ACTION_PLANNER) {
					planCount++;
					if (planCount > 2) throw new Error("Unexpected planner retry");
					return {
						text: planCount === 2 ? text : "",
						toolCalls: [
							call(
								planCount === 1 ? "WRITE" : "REPLY",
								planCount === 1 ? "more_work_pending" : "final",
							),
						],
					};
				}
				return JSON.stringify(
					planCount === 1
						? {
								success: false,
								decision: "CONTINUE",
								thought: "The tool has a prerequisite.",
							}
						: {
								success: false,
								decision: "FINISH",
								thought: "The tool's prerequisite needs the user.",
								messageToUser: "The operation is not complete.",
							},
				);
			});
			const executeToolCall = vi.fn(() => ({
				success,
				data,
				verifiedUserFacing: true,
				userFacingText: text,
			}));
			const result = await runPlannerLoop({
				runtime: { useModel },
				context: compoundContext,
				executeToolCall,
			});
			expect(executeToolCall).toHaveBeenCalledTimes(1);
			expect(result.finalMessage).toBe(text);
			expect(result.evaluator?.success).toBe(false);
		},
	);

	it("does not invent a final evaluator before any non-terminal tool executed", async () => {
		const useModel = vi.fn<PlannerRuntime["useModel"]>(async () => ({
			text: "The answer needs no tool.",
			toolCalls: [call("REPLY", "final")],
		}));
		const executeToolCall = vi.fn();
		const result = await runPlannerLoop({
			runtime: { useModel },
			context: compoundContext,
			executeToolCall,
		});
		expect(result.finalMessage).toBe("The answer needs no tool.");
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(executeToolCall).not.toHaveBeenCalled();
	});

	it.each([
		{
			error: Object.assign(new Error("Rate limited"), { statusCode: 429 }),
			kind: "rate_limited",
		},
		{
			error: Object.assign(new Error("Unavailable"), { statusCode: 503 }),
			kind: "provider_issue",
		},
		{
			error: Object.assign(new Error("No provider"), {
				name: "NoModelProviderConfiguredError",
			}),
			kind: "no_provider",
		},
	])(
		"keeps the settled effect non-replayable when final judgment is $kind",
		async ({ error, kind }) => {
			const records = new Set(["selected", "untouched"]);
			const receipt = {
				receiptId: "delete-selected",
				operation: "record.delete",
				resource: { kind: "record", id: "selected" },
				artifacts: [],
				idempotency: { key: "delete-request", replayed: false },
				observedAt: "2026-09-05T12:00:00.000Z",
				outcome: "applied" as const,
				commit: {
					kind: "durable" as const,
					id: "commit-selected",
					committedAt: "2026-09-05T12:00:00.000Z",
				},
			};
			let planCount = 0;
			const useModel = vi.fn<PlannerRuntime["useModel"]>(async (type) => {
				if (type === ModelType.ACTION_PLANNER) {
					planCount++;
					if (planCount > 2) throw new Error("Unexpected planner replay");
					return {
						text: planCount === 2 ? "The selected record was deleted." : "",
						toolCalls: [
							call(
								planCount === 1 ? "DELETE" : "REPLY",
								planCount === 1 ? "more_work_pending" : "final",
							),
						],
					};
				}
				if (planCount === 2) throw error;
				return JSON.stringify({
					success: false,
					decision: "CONTINUE",
					thought: "The planner should inspect the remaining request.",
				});
			});
			const executeToolCall = vi.fn(() => {
				const deleted = records.delete("selected");
				return {
					success: deleted,
					transcriptVisibility: "internal" as const,
					effectReceipts: [receipt],
					data: { deleted },
				};
			});
			const result = await runPlannerLoop({
				runtime: { useModel },
				context: compoundContext,
				executeToolCall,
			});
			expect([...records]).toEqual(["untouched"]);
			expect(executeToolCall).toHaveBeenCalledTimes(1);
			expect(planCount).toBe(2);
			expect(result.terminalFailure).toMatchObject({
				kind,
				transient: false,
				code: "EVALUATOR_REPLY_GENERATION_FAILED",
			});
			expect(result.finalMessage).toBeUndefined();
			expect(result.trajectory.steps[0]?.result).toMatchObject({
				success: true,
				data: { deleted: true },
				effectReceipts: [receipt],
				replyFailure: result.terminalFailure,
			});
		},
	);
});
