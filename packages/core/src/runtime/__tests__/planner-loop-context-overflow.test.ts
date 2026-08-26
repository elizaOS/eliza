/**
 * Covers the planner loop's provider context-overflow boundary contract: a
 * hard provider length rejection (live: Cerebras 400 "Please reduce the
 * length of the messages or completion. Current length is 202427 while limit
 * is 131072") TERMINATES the turn with the typed PROVIDER_CONTEXT_OVERFLOW
 * ElizaError — trajectory, cached model history, and context events all
 * byte-intact — UNLESS the largest completed tool result declares a lossless
 * retrieval contract (a recoverable-content locator `ReadView` in its
 * data/promptData). Only then is the oversized projection swapped for its
 * declared retrieval form, preserving the result's own success value, and the
 * iteration retried exactly once; a second overflow is terminal. A successful
 * result is NEVER rewritten to a failure: the reviewed regression (FETCH
 * succeeds, gets erased to a fabricated failure, SUMMARIZE runs without the
 * transcript, turn finishes with an invented recap) is pinned impossible
 * here. Deterministic — vitest-mocked `useModel` throwing the live error
 * shape + injected `executeToolCall`/`evaluate`; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import type { ElizaError } from "../../errors";
import { PROVIDER_CONTEXT_OVERFLOW } from "../../utils/model-errors";
import { runPlannerLoop } from "../planner-loop";
import type { PlannerTrajectory } from "../planner-types";

const LIVE_CEREBRAS_MESSAGE =
	"Bad Request: Please reduce the length of the messages or completion. " +
	"Current length is 202427 while limit is 131072";

/** The AI_APICallError shape from the live incident (statusCode + flat body). */
function liveOverflowError(): Error {
	return Object.assign(new Error(LIVE_CEREBRAS_MESSAGE), {
		name: "AI_APICallError",
		statusCode: 400,
		responseBody:
			'{"message":"Please reduce the length of the messages or completion. Current length is 202427 while limit is 131072","type":"invalid_request_error","param":"validation_error","code":"context_length_exceeded"}',
		url: "https://api.cerebras.ai/v1/chat/completions",
	});
}

const HUGE_MARKER = "HUGE-RECAP-RESULT";
const HUGE_TEXT = `${HUGE_MARKER}${"x".repeat(200_000)}`;
const LOCATOR_REF = "tool-result:fetch-recap-1";

/**
 * A valid progressive-read ReadView: the repo's canonical lossless-retrieval
 * contract (recoverable-content locator + caller-requested pagination via
 * nextOffset). Shape-checked by validateReadView at the boundary.
 */
function losslessRetrievalReadView() {
	return {
		reference: {
			kind: "tool-result" as const,
			ref: LOCATOR_REF,
			revision: "r1",
		},
		slice: {
			range: { unit: "byte" as const, start: 0, end: 4096, total: 200_017 },
			hasPrevious: false,
			hasMore: true,
			nextOffset: 4096,
			revision: "r1",
			completeness: "partial-recoverable" as const,
			sliceSha256: "a".repeat(64),
		},
	};
}

describe("planner-loop — provider context-overflow boundary", () => {
	it("terminates typed on overflow when the largest result declares no retrieval contract — history byte-intact, no retry", async () => {
		const runtime = {
			useModel: vi.fn(async () => {
				const turn = runtime.useModel.mock.calls.length;
				if (turn === 1) {
					return {
						text: "",
						toolCalls: [
							{ id: "c1", name: "FETCH", arguments: { range: "all" } },
						],
					};
				}
				throw liveOverflowError();
			}),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};
		let capturedTrajectory: PlannerTrajectory | undefined;
		const executeToolCall = vi.fn(
			async (
				_toolCall: { name: string },
				context: { trajectory: PlannerTrajectory },
			) => {
				capturedTrajectory = context.trajectory;
				return { success: true, text: HUGE_TEXT };
			},
		);

		let thrown: ElizaError | undefined;
		try {
			await runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [{ name: "FETCH", description: "Fetch a transcript range." }],
				executeToolCall,
				evaluate: vi.fn(async () => ({
					success: true,
					decision: "CONTINUE" as const,
					thought: "Keep going.",
				})),
			});
		} catch (error) {
			thrown = error as ElizaError;
		}
		expect(thrown?.code).toBe(PROVIDER_CONTEXT_OVERFLOW);
		expect(thrown?.context?.recovery).toBe("no_lossless_retrieval_contract");
		expect(thrown?.context?.largestResultAction).toBe("FETCH");
		// No substitution, no retry: the overflowing call is the last one.
		expect(runtime.useModel).toHaveBeenCalledTimes(2);

		// The successful result is still present and unmodified — success flag,
		// complete text, and absence of any substitution marker.
		const fetchStep = capturedTrajectory?.steps.find(
			(step) => step.toolCall?.name === "FETCH",
		);
		expect(fetchStep?.result).toEqual({ success: true, text: HUGE_TEXT });
		// Every model-facing projection still carries the complete result.
		expect(JSON.stringify(capturedTrajectory?.modelHistory ?? [])).toContain(
			HUGE_MARKER,
		);
		const toolResultEvent = capturedTrajectory?.context.events.find(
			(event) => event.type === "tool_result",
		);
		expect(toolResultEvent?.metadata?.status).toBe("completed");
		expect(String(toolResultEvent?.metadata?.result)).toContain(HUGE_MARKER);
	});

	it("swaps the oversized result for its declared lossless retrieval form and retries once", async () => {
		const seenMessages: unknown[][] = [];
		const runtime = {
			useModel: vi.fn(
				async (_modelType: unknown, params: { messages: unknown[] }) => {
					seenMessages.push(params.messages);
					const turn = runtime.useModel.mock.calls.length;
					if (turn === 1) {
						return {
							text: "",
							toolCalls: [
								{ id: "c1", name: "FETCH", arguments: { range: "all" } },
							],
						};
					}
					if (turn === 2) throw liveOverflowError();
					return {
						text: "",
						toolCalls: [{ id: "c2", name: "SUMMARIZE", arguments: {} }],
					};
				},
			),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};
		const executed: string[] = [];
		const executeToolCall = vi.fn(async (toolCall: { name: string }) => {
			executed.push(toolCall.name);
			if (toolCall.name === "FETCH") {
				return {
					success: true,
					text: HUGE_TEXT,
					data: { readView: losslessRetrievalReadView() },
				};
			}
			return { success: true, text: "summary ready" };
		});
		const evaluate = vi.fn(async () => {
			if (executed.includes("SUMMARIZE")) {
				return {
					success: true,
					decision: "FINISH" as const,
					messageToUser: "Here is the short version.",
				};
			}
			return {
				success: true,
				decision: "CONTINUE" as const,
				thought: "Now condense it.",
			};
		});

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [
				{ name: "FETCH", description: "Fetch a transcript range." },
				{ name: "SUMMARIZE", description: "Summarize fetched content." },
			],
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toContain("short version");
		expect(executed).toEqual(["FETCH", "SUMMARIZE"]);
		// One overflow + one successful retry: 3 planner calls total.
		expect(runtime.useModel).toHaveBeenCalledTimes(3);

		// The FETCH step keeps its tool call AND its success — the swap is the
		// declared retrieval form, never a fabricated failure label.
		const fetchStep = result.trajectory.steps.find(
			(step) => step.toolCall?.name === "FETCH",
		);
		expect(fetchStep?.result?.success).toBe(true);
		expect(fetchStep?.result?.text).toMatch(
			/FETCH completed, but its \d+-character result could not be dispatched within the provider context boundary \(limit ~131072 tokens\)/,
		);
		expect(fetchStep?.result?.text).toContain(LOCATOR_REF);
		expect(fetchStep?.result?.data?.providerContextOverflow).toBe(true);
		expect(fetchStep?.result?.data?.readView).toEqual(
			losslessRetrievalReadView(),
		);

		// The retried planner call sees the declared retrieval form (still a
		// successful result), never the huge text.
		const retryMessages = JSON.stringify(seenMessages[2] ?? []);
		expect(retryMessages).toContain(LOCATOR_REF);
		expect(retryMessages).toContain(
			"could not be dispatched within the provider context boundary",
		);
		expect(retryMessages).not.toContain(HUGE_MARKER);
		expect(retryMessages).not.toContain('\\"success\\":false');
	});

	it("throws the typed error when the retry after a lossless swap overflows again", async () => {
		const runtime = {
			useModel: vi.fn(async () => {
				const turn = runtime.useModel.mock.calls.length;
				if (turn === 1) {
					return {
						text: "",
						toolCalls: [{ id: "c1", name: "FETCH", arguments: {} }],
					};
				}
				throw liveOverflowError();
			}),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: HUGE_TEXT,
			data: { readView: losslessRetrievalReadView() },
		}));

		let thrown: ElizaError | undefined;
		try {
			await runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [{ name: "FETCH", description: "Fetch a transcript range." }],
				executeToolCall,
				evaluate: vi.fn(async () => ({
					success: true,
					decision: "CONTINUE" as const,
					thought: "Keep going.",
				})),
			});
		} catch (error) {
			thrown = error as ElizaError;
		}
		expect(thrown?.code).toBe(PROVIDER_CONTEXT_OVERFLOW);
		expect(thrown?.context?.recovery).toBe(
			"retry_after_substitution_overflowed",
		);
		// Tool-call turn + overflow + failed retry: exactly one retry, no loop.
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
	});

	it("throws the typed error when no tool result exists to substitute", async () => {
		const runtime = {
			useModel: vi.fn(async () => {
				throw liveOverflowError();
			}),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};

		let thrown: ElizaError | undefined;
		try {
			await runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				executeToolCall: vi.fn(),
				evaluate: vi.fn(),
			});
		} catch (error) {
			thrown = error as ElizaError;
		}
		expect(thrown?.code).toBe(PROVIDER_CONTEXT_OVERFLOW);
		expect(thrown?.context?.recovery).toBe("no_substitutable_tool_result");
		// Nothing substitutable — no blind retry against the same boundary.
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("propagates an ordinary 400 untouched — no substitution, no retry", async () => {
		const runtime = {
			useModel: vi.fn(async () => {
				const turn = runtime.useModel.mock.calls.length;
				if (turn === 1) {
					return {
						text: "",
						toolCalls: [{ id: "c1", name: "FETCH", arguments: {} }],
					};
				}
				throw Object.assign(new Error("Bad Request"), { statusCode: 400 });
			}),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: HUGE_TEXT,
			data: { readView: losslessRetrievalReadView() },
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "CONTINUE" as const,
			thought: "Keep going.",
		}));

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [{ name: "FETCH", description: "Fetch a transcript range." }],
				executeToolCall,
				evaluate,
			}),
		).rejects.toThrow("Bad Request");
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});
});
