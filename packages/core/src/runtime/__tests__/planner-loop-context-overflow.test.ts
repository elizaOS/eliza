/**
 * Covers the planner loop's provider context-overflow boundary: when a planner
 * model call is rejected at the provider's documented context limit (live:
 * Cerebras 400 "Please reduce the length of the messages or completion.
 * Current length is 202427 while limit is 131072"), the loop must not die.
 * The largest completed tool result is replaced by a typed protocol-failure
 * result — NOT truncated; the complete result was rejected whole at dispatch —
 * and the iteration retries once. With nothing to substitute, or a second
 * overflow, a typed PROVIDER_CONTEXT_OVERFLOW ElizaError surfaces instead of
 * the raw provider 400. Deterministic — vitest-mocked `useModel` throwing the
 * live error shape + injected `executeToolCall`/`evaluate`; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_CONTEXT_OVERFLOW } from "../../utils/model-errors";
import { runPlannerLoop } from "../planner-loop";

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

describe("planner-loop — provider context-overflow recovery", () => {
	it("replaces the largest tool result with a typed failure and retries once", async () => {
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
			return {
				success: true,
				text: toolCall.name === "FETCH" ? HUGE_TEXT : "summary ready",
			};
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

		// The FETCH step keeps its tool call but now carries the typed failure.
		const fetchStep = result.trajectory.steps.find(
			(step) => step.toolCall?.name === "FETCH",
		);
		expect(fetchStep?.result?.success).toBe(false);
		expect(fetchStep?.result?.text).toMatch(
			/FETCH result of \d+ characters was rejected at the provider context boundary \(limit ~131072 tokens\)/,
		);
		expect(fetchStep?.result?.text).toContain("NOT truncated");
		expect(fetchStep?.result?.data?.providerContextOverflow).toBe(true);

		// The retried planner call sees the typed failure, never the huge text.
		const retryMessages = JSON.stringify(seenMessages[2] ?? []);
		expect(retryMessages).toContain(
			"rejected at the provider context boundary",
		);
		expect(retryMessages).not.toContain(HUGE_MARKER);
	});

	it("throws the typed error when the retry overflows again", async () => {
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
		).rejects.toThrowError(
			expect.objectContaining({ code: PROVIDER_CONTEXT_OVERFLOW }),
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

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				executeToolCall: vi.fn(),
				evaluate: vi.fn(),
			}),
		).rejects.toThrowError(
			expect.objectContaining({ code: PROVIDER_CONTEXT_OVERFLOW }),
		);
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
