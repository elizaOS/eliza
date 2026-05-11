import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../types/model";
import { runPlannerLoop } from "../planner-loop";

/**
 * Regression: when tools[] is non-empty the planner must pass tools to useModel
 * and MUST NOT set responseSchema (schema-mode and native-tool-calling mode are
 * mutually exclusive — sending both causes HTTP 400 on Cerebras and OpenAI).
 *
 * When tools is empty (or omitted) the planner must set responseSchema and must
 * NOT include tools in the useModel call.
 */

const MOCK_TOOL: ToolDefinition = {
	name: "LOOKUP",
	description: "Fetch information",
	parameters: {
		type: "object",
		properties: { query: { type: "string" } },
		required: ["query"],
	},
};

describe("planner-loop responseSchema/tools collision regression", () => {
	it("omits responseSchema when tools[] is non-empty", async () => {
		const capturedParams: unknown[] = [];
		const runtime = {
			useModel: vi.fn(async (_modelType: unknown, params: unknown) => {
				capturedParams.push(params);
				return {
					text: "",
					toolCalls: [
						{ id: "tc-1", name: "LOOKUP", arguments: { query: "x" } },
					],
				};
			}),
		};
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
		}));
		const executeToolCall = vi.fn(async () => ({ success: true, text: "ok" }));

		await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [MOCK_TOOL],
			executeToolCall,
			evaluate,
		});

		expect(runtime.useModel).toHaveBeenCalled();
		const plannerCall = capturedParams.find(
			(p) =>
				typeof p === "object" &&
				p !== null &&
				"tools" in p &&
				Array.isArray((p as Record<string, unknown>).tools),
		) as Record<string, unknown> | undefined;

		expect(plannerCall).toBeDefined();
		expect(plannerCall?.tools).toHaveLength(1);
		// responseSchema MUST be absent when tools is non-empty
		expect(plannerCall?.responseSchema).toBeUndefined();
	});

	it("sets responseSchema when tools is empty", async () => {
		const capturedParams: unknown[] = [];
		const runtime = {
			useModel: vi.fn(async (_modelType: unknown, params: unknown) => {
				capturedParams.push(params);
				return `{"thought":"ok","toolCalls":[],"messageToUser":"Done."}`;
			}),
		};
		const executeToolCall = vi.fn();
		const evaluate = vi.fn();

		await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [],
			executeToolCall,
			evaluate,
		});

		expect(runtime.useModel).toHaveBeenCalled();
		const plannerCall = capturedParams[0] as Record<string, unknown>;
		// responseSchema MUST be set when no tools are provided
		expect(plannerCall.responseSchema).toBeDefined();
		// tools must not be present or must be absent
		expect(plannerCall.tools).toBeUndefined();
	});

	it("sets responseSchema when tools param is omitted entirely", async () => {
		const capturedParams: unknown[] = [];
		const runtime = {
			useModel: vi.fn(async (_modelType: unknown, params: unknown) => {
				capturedParams.push(params);
				return `{"thought":"ok","toolCalls":[],"messageToUser":"Done."}`;
			}),
		};

		await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
		});

		const plannerCall = capturedParams[0] as Record<string, unknown>;
		expect(plannerCall.responseSchema).toBeDefined();
		expect(plannerCall.tools).toBeUndefined();
	});

	it("passes toolChoice through when tools are provided", async () => {
		const capturedParams: unknown[] = [];
		const runtime = {
			useModel: vi.fn(async (_modelType: unknown, params: unknown) => {
				capturedParams.push(params);
				return {
					text: "",
					toolCalls: [
						{ id: "tc-1", name: "LOOKUP", arguments: { query: "x" } },
					],
				};
			}),
		};
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
		}));

		await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [MOCK_TOOL],
			toolChoice: "required",
			executeToolCall: vi.fn(async () => ({ success: true })),
			evaluate,
		});

		const plannerCall = capturedParams[0] as Record<string, unknown>;
		expect(plannerCall.toolChoice).toBe("required");
	});

	it("forces required tool choice when Stage 1 requires a tool", async () => {
		const capturedParams: unknown[] = [];
		const runtime = {
			useModel: vi.fn(async (_modelType: unknown, params: unknown) => {
				capturedParams.push(params);
				return {
					text: "",
					toolCalls: [
						{ id: "tc-1", name: "LOOKUP", arguments: { query: "x" } },
					],
				};
			}),
		};
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
		}));

		await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [MOCK_TOOL],
			toolChoice: "auto",
			requireNonTerminalToolCall: true,
			executeToolCall: vi.fn(async () => ({ success: true })),
			evaluate,
		});

		const plannerCall = capturedParams[0] as Record<string, unknown>;
		expect(plannerCall.toolChoice).toBe("required");
	});

	it("caps required-tool planner misses", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "I should answer later.",
				toolCalls: [],
			})),
		};

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				tools: [MOCK_TOOL],
				requireNonTerminalToolCall: true,
				config: { maxRequiredToolMisses: 1 },
				executeToolCall: vi.fn(),
				evaluate: vi.fn(),
			}),
		).rejects.toMatchObject({
			name: "TrajectoryLimitExceeded",
			kind: "required_tool_misses",
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});
});
