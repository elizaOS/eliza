/**
 * Adversarial terminal-authority regressions for #18466. Deterministic model,
 * evaluator, and tool doubles exercise compaction and every terminal seam.
 */
import { describe, expect, it, vi } from "vitest";
import {
	FAILED_TOOL_FALLBACK_MESSAGE,
	HANDLED_STEP_FALLBACK_MESSAGE,
	type PlannerTrajectory,
	runPlannerLoop,
} from "../planner-loop";

const compactEveryCompletedStep = {
	contextWindowTokens: 1_200,
	compactionReserveTokens: 1_000,
	compactionKeepSteps: 0,
};

function modelPayload(
	useModel: ReturnType<typeof vi.fn>,
	index: number,
): string {
	const params = useModel.mock.calls[index]?.[1] as
		| { messages?: Array<{ role?: string; content?: unknown }> }
		| undefined;
	return (params?.messages ?? [])
		.filter((message) => message.role === "user")
		.map((message) => String(message.content))
		.join("\n");
}

describe("terminal authority survives compaction (#18466)", () => {
	it("forces synthesis from original context and canonical receipts only", async () => {
		const canonicalReceipt = '[FORM]\n{"receipt":"release-R42"}\n[/FORM]';
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "THOUGHT_SECRET",
				toolCalls: [
					{
						id: "TOOL_CALL_ID_SECRET",
						name: "LOOKUP",
						arguments: { query: "PARAM_SECRET" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "TERMINAL_PLANNER_OUTPUT_SECRET",
				toolCalls: [],
			})
			.mockResolvedValueOnce({
				text: "SECOND_THOUGHT_SECRET",
				toolCalls: [
					{
						id: "SECOND_TOOL_CALL_ID_SECRET",
						name: "LOOKUP",
						arguments: { query: "PARAM_SECRET" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "INVENTED_SYNTHESIS_TEXT",
				toolCalls: [],
			});
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: `RAW_RESULT_SECRET ${"planner-only diagnostics ".repeat(500)}`,
			userFacingText: canonicalReceipt,
			verifiedUserFacing: true,
			userFacingEffect: "none" as const,
			data: {
				awaitingUserInput: true,
				privateData: "RESULT_DATA_SECRET",
				privateError: "RESULT_ERROR_SECRET",
			},
		}));
		const evaluatorTrajectories: PlannerTrajectory[] = [];
		const evaluate = vi.fn(
			async ({ trajectory }: { trajectory: PlannerTrajectory }) => {
				evaluatorTrajectories.push(trajectory);
				return {
					success: true,
					decision: "CONTINUE" as const,
					thought: "EVALUATOR_THOUGHT_SECRET",
					messageToUser: "EVALUATOR_MESSAGE_SECRET",
				};
			},
		);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: {
				id: "ctx",
				events: [
					{
						id: "request",
						type: "message",
						message: { role: "user", content: "REQUEST_ALLOWED" },
					},
					{
						id: "provider",
						type: "provider",
						name: "GROUNDING",
						text: "PROVIDER_ALLOWED",
						data: { private: "PROVIDER_DATA_SECRET" },
					},
					{
						id: "instruction",
						type: "instruction",
						content: "INSTRUCTION_ALLOWED",
					},
					{
						id: "reply-reference",
						type: "segment",
						modelInputKind: "reply_reference",
						segment: {
							label: "reply_reference",
							content: "REPLY_REFERENCE_ALLOWED",
							stable: false,
						},
					},
					{
						id: "hostile-terminal",
						type: "evaluation",
						metadata: { raw: "ORIGINAL_EVALUATOR_RAW_SECRET" },
					},
				],
			},
			provider: "pinned-provider",
			tools: [{ name: "LOOKUP", description: "Look up release data." }],
			executeToolCall,
			evaluate,
			config: {
				...compactEveryCompletedStep,
				maxRepeatedToolCalls: 0,
			},
		});

		expect(useModel).toHaveBeenCalledTimes(4);
		expect(useModel.mock.calls[3]?.[2]).toBe("pinned-provider");
		const synthesis = modelPayload(useModel, 3);
		expect(synthesis).toContain("REQUEST_ALLOWED");
		expect(synthesis).toContain("PROVIDER_ALLOWED");
		expect(synthesis).toContain("INSTRUCTION_ALLOWED");
		expect(synthesis).toContain("REPLY_REFERENCE_ALLOWED");
		expect(synthesis).toContain('tool_name: "LOOKUP"');
		expect(synthesis).toContain("machine_status: success");
		expect(synthesis).toContain(JSON.stringify(canonicalReceipt));
		expect(synthesis).not.toMatch(
			/THOUGHT_SECRET|TOOL_CALL_ID_SECRET|PARAM_SECRET|RAW_RESULT_SECRET|RESULT_DATA_SECRET|RESULT_ERROR_SECRET|TERMINAL_PLANNER_OUTPUT_SECRET|EVALUATOR_THOUGHT_SECRET|EVALUATOR_MESSAGE_SECRET|PROVIDER_DATA_SECRET|ORIGINAL_EVALUATOR_RAW_SECRET|compaction/,
		);
		const terminalEvaluatorView = evaluatorTrajectories.find(
			(trajectory) => trajectory.steps.at(-1)?.terminalOnly === true,
		);
		expect(terminalEvaluatorView).toBeDefined();
		expect(
			terminalEvaluatorView?.steps.some(
				(step) => step.toolCall?.name === "LOOKUP",
			),
		).toBe(true);
		expect(terminalEvaluatorView?.archivedSteps).toEqual([]);
		expect(JSON.stringify(terminalEvaluatorView)).not.toMatch(
			/THOUGHT_SECRET|TOOL_CALL_ID_SECRET|PARAM_SECRET|RAW_RESULT_SECRET|RESULT_DATA_SECRET|RESULT_ERROR_SECRET|TERMINAL_PLANNER_OUTPUT_SECRET/,
		);
		expect(result.finalMessage).toBe(canonicalReceipt);
		expect(result.finalMessage).not.toContain("INVENTED_SYNTHESIS_TEXT");
		expect(result.trajectory.steps.at(-1)?.terminalMessage).toBe(
			result.finalMessage,
		);
	});

	it("keeps an archived failure authoritative over invented success", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "failed", name: "DEPLOY", arguments: { target: "prod" } },
				],
			})
			.mockResolvedValueOnce({
				text: "Everything deployed successfully.",
				toolCalls: [],
			});
		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [{ name: "DEPLOY", description: "Deploy a release." }],
			executeToolCall: vi.fn(async () => ({
				success: false,
				text: `deployment failed ${"private log ".repeat(500)}`,
			})),
			evaluate: vi.fn(async () => ({
				success: true,
				decision: "FINISH" as const,
				thought: "Invent success.",
				messageToUser: "The deployment completed successfully.",
			})),
			config: compactEveryCompletedStep,
		});

		expect(result.trajectory.archivedSteps).toHaveLength(1);
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
		expect(result.trajectory.steps.at(-1)?.terminalMessage).toBe(
			FAILED_TOOL_FALLBACK_MESSAGE,
		);
	});

	it.each(["STOP", "IGNORE"] as const)(
		"keeps %s silent after a typed tool result without compaction",
		async (silentTerminal) => {
			const observedAt = "2026-08-12T08:00:00.000Z";
			const useModel = vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [{ id: "work", name: "WORK", arguments: {} }],
				})
				.mockResolvedValueOnce({
					text: "Do not turn earlier output into a reply.",
					toolCalls: [{ id: "silent", name: silentTerminal, arguments: {} }],
				});
			const result = await runPlannerLoop({
				runtime: { useModel },
				context: { id: "ctx" },
				tools: [{ name: "WORK", description: "Perform internal work." }],
				executeToolCall: vi.fn(async () => ({
					success: true,
					text: "INTERNAL_WORK_LOG",
					userFacingText: "Do not revive",
					verifiedUserFacing: true,
					data: { taskId: "task-silent" },
					effectReceipts: [
						{
							receiptId: "receipt-silent",
							operation: "work.finish",
							resource: { kind: "work", id: "task-silent" },
							artifacts: [],
							idempotency: { key: "task-silent", replayed: false },
							observedAt,
							outcome: "applied" as const,
							commit: {
								kind: "durable" as const,
								id: "commit-silent",
								committedAt: observedAt,
							},
						},
					],
				})),
				evaluate: vi.fn(async () => ({
					success: true,
					decision: "CONTINUE" as const,
					thought: "The planner may deliberately choose silence.",
				})),
			});

			expect(result.finalMessage).toBeUndefined();
			expect(result.endedWithDeliberateSilence).toBe(true);
			expect(result.silentTerminalAction).toBe(silentTerminal);
			expect(result.trajectory.archivedSteps).toEqual([]);
			expect(result.trajectory.steps).toEqual([
				expect.objectContaining({
					toolCall: expect.objectContaining({ name: "WORK" }),
					result: expect.objectContaining({
						userFacingText: "Do not revive",
						data: { taskId: "task-silent" },
						effectReceipts: [
							expect.objectContaining({ receiptId: "receipt-silent" }),
						],
					}),
				}),
			]);
		},
	);

	it("sanitizes a raw REPLY before the sole terminal append", async () => {
		const rawReply = "call:SECRET_TOOL{token:never-show}";
		const result = await runPlannerLoop({
			runtime: {
				useModel: vi.fn(async () => ({
					text: "",
					toolCalls: [
						{
							id: "reply",
							name: "REPLY",
							arguments: { text: rawReply },
						},
					],
				})),
			},
			context: { id: "ctx" },
			executeToolCall: vi.fn(),
		});

		expect(result.finalMessage).toBe(HANDLED_STEP_FALLBACK_MESSAGE);
		const terminalSteps = result.trajectory.steps.filter(
			(step) => step.terminalOnly === true,
		);
		expect(terminalSteps).toEqual([
			expect.objectContaining({
				terminalMessage: result.finalMessage,
			}),
		]);
		expect(JSON.stringify(result.trajectory)).not.toContain(rawReply);
	});

	it.each([
		{
			name: "raw no-tool output",
			params: {
				runtime: {
					useModel: vi.fn(async () => ({
						text: "call:SECRET_TOOL{token:never-show}",
						toolCalls: [],
					})),
				},
				context: { id: "ctx" },
				executeToolCall: vi.fn(),
			},
		},
		{
			name: "captured refusal",
			params: {
				runtime: {
					useModel: vi.fn(async () => ({
						text: "",
						toolCalls: [
							{
								id: "reply",
								name: "REPLY",
								arguments: {
									text: "I can't access that service from this runtime.",
								},
							},
						],
					})),
				},
				context: { id: "ctx" },
				tools: [{ name: "LOOKUP", description: "Look up data." }],
				requireNonTerminalToolCall: true,
				config: { maxRequiredToolMisses: 0 },
				executeToolCall: vi.fn(),
			},
		},
	])(
		"stores exactly the returned terminal bytes for $name",
		async ({ name, params }) => {
			const result = await runPlannerLoop(params);
			const terminalSteps = result.trajectory.steps.filter(
				(step) => step.terminalOnly === true,
			);
			expect(terminalSteps).toEqual([
				expect.objectContaining({ terminalMessage: result.finalMessage }),
			]);
			if (name === "raw no-tool output") {
				expect(JSON.stringify(result.trajectory)).not.toContain(
					"call:SECRET_TOOL{token:never-show}",
				);
			}
		},
	);

	it("does not reset maxToolCalls when keepSteps=0 archives the live window", async () => {
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "planner output ".repeat(500),
			userFacingText: "First operation completed.",
		}));
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [{ id: "one", name: "STEP_ONE", arguments: {} }],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [{ id: "two", name: "STEP_TWO", arguments: {} }],
			});

		await expect(
			runPlannerLoop({
				runtime: { useModel },
				context: { id: "ctx" },
				tools: [
					{ name: "STEP_ONE", description: "First step." },
					{ name: "STEP_TWO", description: "Second step." },
				],
				executeToolCall,
				evaluate: vi.fn(async () => ({
					success: true,
					decision: "CONTINUE" as const,
					thought: "Run the next step.",
				})),
				config: {
					...compactEveryCompletedStep,
					maxToolCalls: 1,
				},
			}),
		).rejects.toThrow("Trajectory limit exceeded: tool_calls (2/1)");
		expect(executeToolCall).toHaveBeenCalledTimes(1);
	});
});
