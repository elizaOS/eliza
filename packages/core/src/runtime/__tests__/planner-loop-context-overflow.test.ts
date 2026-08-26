/**
 * Covers the planner loop's terminal provider context-overflow boundary. A
 * provider rejection becomes a typed error without rewriting successful tool
 * history or allowing an unverified retrieval/FINISH continuation.
 */
import { describe, expect, it, vi } from "vitest";
import type { ElizaError } from "../../errors";
import { PROVIDER_CONTEXT_OVERFLOW } from "../../utils/model-errors";
import { runPlannerLoop } from "../planner-loop";
import type { PlannerToolResult, PlannerTrajectory } from "../planner-types";

const LIVE_CEREBRAS_MESSAGE =
	"Bad Request: Please reduce the length of the messages or completion. " +
	"Current length is 202427 while limit is 131072";

function liveOverflowError(): Error {
	return Object.assign(new Error(LIVE_CEREBRAS_MESSAGE), {
		name: "AI_APICallError",
		statusCode: 400,
		responseBody:
			'{"message":"Please reduce the length of the messages or completion. Current length is 202427 while limit is 131072","type":"invalid_request_error","param":"validation_error","code":"context_length_exceeded"}',
		url: "https://api.cerebras.ai/v1/chat/completions",
	});
}

const HUGE_MARKER = "HUGE-DOCUMENT-RESULT";
const HUGE_TEXT = `${HUGE_MARKER}${"x".repeat(200_000)}`;
const DOCUMENT_ID = "00000000-0000-0000-0000-000000000123";

function nestedDocumentReadView() {
	return {
		reference: {
			kind: "document" as const,
			ref: `document:${DOCUMENT_ID}`,
			revision: "rev-1",
		},
		slice: {
			range: { unit: "line" as const, start: 0, end: 500, total: 500 },
			hasPrevious: false,
			hasMore: false,
			revision: "rev-1",
			completeness: "complete" as const,
			sliceSha256: "a".repeat(64),
		},
	};
}

describe("planner-loop — provider context-overflow boundary", () => {
	it("terminates typed with a successful result and every projection byte-intact", async () => {
		const runtime = {
			useModel: vi.fn(async () => {
				const turn = runtime.useModel.mock.calls.length;
				if (turn === 1) {
					return {
						text: "",
						toolCalls: [
							{
								id: "document-read",
								name: "DOCUMENT",
								arguments: { action: "read", documentId: DOCUMENT_ID },
							},
						],
					};
				}
				if (turn === 2) throw liveOverflowError();
				return {
					text: "Here is the summary.",
					toolCalls: [{ id: "summarize", name: "SUMMARIZE", arguments: {} }],
				};
			}),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};
		const originalResult: PlannerToolResult = {
			success: true,
			text: HUGE_TEXT,
			data: {
				actionName: "DOCUMENT",
				subaction: "read",
				documentId: DOCUMENT_ID,
				readView: nestedDocumentReadView(),
			},
			promptData: {
				actionName: "DOCUMENT",
				subaction: "read",
				documentId: DOCUMENT_ID,
				readView: nestedDocumentReadView(),
			},
		};
		let capturedTrajectory: PlannerTrajectory | undefined;
		const executeToolCall = vi.fn(
			async (
				toolCall: { name: string },
				context: { trajectory: PlannerTrajectory },
			) => {
				capturedTrajectory = context.trajectory;
				if (toolCall.name !== "DOCUMENT") {
					throw new Error(`unexpected recovery action: ${toolCall.name}`);
				}
				return originalResult;
			},
		);
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "CONTINUE" as const,
			thought: "Retrieve a narrower source before finishing.",
		}));

		let thrown: ElizaError | undefined;
		try {
			await runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [
					{
						name: "DOCUMENT",
						description: "Read a document page by id and range.",
					},
					{
						name: "SUMMARIZE",
						description: "Summarize retrieved source text.",
					},
				],
				executeToolCall,
				evaluate,
			});
		} catch (error) {
			thrown = error as ElizaError;
		}

		expect(thrown?.code).toBe(PROVIDER_CONTEXT_OVERFLOW);
		expect(thrown?.context?.recovery).toBe("typed_boundary_terminal");
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(1);

		const documentStep = capturedTrajectory?.steps.find(
			(step) => step.toolCall?.name === "DOCUMENT",
		);
		expect(documentStep?.result).toEqual(originalResult);
		expect(documentStep?.result?.promptData).toMatchObject({
			actionName: "DOCUMENT",
			subaction: "read",
			documentId: DOCUMENT_ID,
		});
		const modelHistory = JSON.stringify(capturedTrajectory?.modelHistory ?? []);
		expect(modelHistory).toContain(HUGE_MARKER);
		expect(modelHistory).toContain(DOCUMENT_ID);
		expect(modelHistory).toContain("subaction");
		const toolResultEvent = capturedTrajectory?.context.events.find(
			(event) => event.type === "tool_result",
		);
		expect(toolResultEvent?.metadata?.status).toBe("completed");
		expect(String(toolResultEvent?.metadata?.result)).toContain(HUGE_MARKER);
		expect(String(toolResultEvent?.metadata?.result)).toContain(DOCUMENT_ID);
	});

	it("does not treat a nested ReadView plus an exposed resolver as an invocable whole-result contract", async () => {
		const runtime = {
			useModel: vi.fn(async () => {
				if (runtime.useModel.mock.calls.length === 1) {
					return {
						text: "",
						toolCalls: [{ id: "fetch", name: "FETCH", arguments: {} }],
					};
				}
				throw liveOverflowError();
			}),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};
		const executeToolCall = vi.fn(async (toolCall: { name: string }) => {
			if (toolCall.name === "READ_TOOL_RESULT") {
				return { success: true, text: "resolved narrow source" };
			}
			return {
				success: true,
				text: HUGE_TEXT,
				promptData: { nested: { readView: nestedDocumentReadView() } },
			};
		});

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [
					{ name: "FETCH", description: "Fetch the full source." },
					{
						name: "READ_TOOL_RESULT",
						description: "Resolve a declared tool-result page.",
					},
				],
				executeToolCall,
				evaluate: vi.fn(async () => ({
					success: true,
					decision: "CONTINUE" as const,
					thought: "Resolve the source before finishing.",
				})),
			}),
		).rejects.toMatchObject({ code: PROVIDER_CONTEXT_OVERFLOW });
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(executeToolCall.mock.calls[0]?.[0]).toMatchObject({ name: "FETCH" });
	});

	it("terminates typed when the initial planner input itself overflows", async () => {
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
		).rejects.toMatchObject({
			code: PROVIDER_CONTEXT_OVERFLOW,
			context: { recovery: "typed_boundary_terminal" },
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("propagates an ordinary provider 400 untouched", async () => {
		const runtime = {
			useModel: vi.fn(async () => {
				if (runtime.useModel.mock.calls.length === 1) {
					return {
						text: "",
						toolCalls: [{ id: "fetch", name: "FETCH", arguments: {} }],
					};
				}
				throw Object.assign(new Error("Bad Request"), { statusCode: 400 });
			}),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};
		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [{ name: "FETCH", description: "Fetch source." }],
				executeToolCall: vi.fn(async () => ({
					success: true,
					text: HUGE_TEXT,
				})),
				evaluate: vi.fn(async () => ({
					success: true,
					decision: "CONTINUE" as const,
				})),
			}),
		).rejects.toThrow("Bad Request");
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});
});
