/**
 * Covers the evaluator's over-window input degrade contract: an assembled
 * evaluator input whose rendered tool results would exceed the model context
 * window must be trimmed to fit (per-result cap, then bounded tightening)
 * instead of hard-erroring the provider call with context_length_exceeded
 * (live incident: one ~5MB grep result rendered verbatim = 2.28M tokens vs
 * cerebras's 131,072 hard limit). Deterministic — mocked useModel returning a
 * canned envelope, no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { runEvaluator } from "../evaluator";
import {
	DEFAULT_MAX_KEPT_STEP_CHARS,
	mergeChainingLoopConfig,
} from "../limits";
import { buildModelInputBudget } from "../model-input-budget";
import { trajectoryStepsToMessages } from "../planner-rendering";

const ENVELOPE = `{
  "success": true,
  "decision": "FINISH",
  "thought": "Compared the approaches.",
  "messageToUser": "Here is the comparison."
}`;

const CONTEXT = {
	id: "ctx",
	staticPrefix: {
		characterPrompt: { content: "agent_name: Eliza", stable: true },
	},
	events: [
		{
			id: "msg",
			type: "message",
			message: { role: "user", content: { text: "compare alex's approach" } },
		},
	],
};

interface CapturedRequest {
	messages: Array<{
		role: string;
		content:
			| string
			| Array<{
					type: string;
					output?: { type: string; value: string };
			  }>;
	}>;
	promptSegments?: Array<{ content: string; stable?: boolean }>;
}

function makeStep(iteration: number, resultText: string) {
	return {
		iteration,
		thought: "",
		toolCall: {
			id: `tool-${iteration}-0`,
			name: "GREP",
			params: { pattern: "approach" },
		},
		result: { success: true, text: resultText },
	};
}

function makeTrajectory(steps: ReturnType<typeof makeStep>[]) {
	return {
		context: { id: "ctx" },
		steps,
		archivedSteps: [],
		plannedQueue: [],
		evaluatorOutputs: [],
	};
}

function makeRuntime() {
	const captured: CapturedRequest[] = [];
	const runtime = {
		useModel: vi.fn(async (_modelType: unknown, request: unknown) => {
			captured.push(request as CapturedRequest);
			return ENVELOPE;
		}),
	};
	return { runtime, captured };
}

function toolMessageValues(request: CapturedRequest): string[] {
	return request.messages
		.filter((message) => message.role === "tool")
		.flatMap((message) =>
			Array.isArray(message.content)
				? message.content
						.filter((part) => part.type === "tool-result")
						.map((part) => part.output?.value ?? "")
				: [],
		);
}

function systemMessageContent(request: CapturedRequest): string {
	const system = request.messages.find((message) => message.role === "system");
	return typeof system?.content === "string" ? system.content : "";
}

describe("runEvaluator — over-window input trims to fit (never context_length_exceeded)", () => {
	it("caps a single 5MB tool result so the sent input fits the window, without touching the system message", async () => {
		// All-emoji payload: every possible cut index lands on a surrogate
		// boundary, exercising the surrogate-safe head/tail truncation.
		const hugeResult = "😀".repeat(2_500_000); // 5,000,000 UTF-16 code units
		const { runtime, captured } = makeRuntime();

		const output = await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, hugeResult)]),
			effects: {},
		});

		expect(output.success).toBe(true);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);

		const request = captured[0];
		expect(request).toBeDefined();
		if (!request) throw new Error("no captured request");
		// The estimate the provider would see must be under the compaction
		// threshold (window - reserve). On unfixed code the 5MB result renders
		// verbatim (~1.43M estimated tokens) and this assertion fails.
		const budget = buildModelInputBudget({
			messages: request.messages as never,
			promptSegments: request.promptSegments as never,
		});
		expect(budget.shouldCompact).toBe(false);

		const values = toolMessageValues(request);
		expect(values).toHaveLength(1);
		const value = values[0] ?? "";
		expect(value).toContain("chars truncated]");
		expect(value.length).toBeLessThanOrEqual(DEFAULT_MAX_KEPT_STEP_CHARS);
		// Surrogate-safe: no lone surrogates left by the head/tail cuts
		// (encodeURIComponent throws URIError on a lone surrogate).
		expect(() => encodeURIComponent(value)).not.toThrow();

		// Control: same context with a tiny result — the system/instructions
		// message must be byte-identical (trimming never rewrites context).
		const control = makeRuntime();
		await runEvaluator({
			runtime: control.runtime,
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, "z".repeat(100))]),
			effects: {},
		});
		const controlRequest = control.captured[0];
		if (!controlRequest) throw new Error("no control request");
		expect(systemMessageContent(request)).toBe(
			systemMessageContent(controlRequest),
		);
	});

	it("tightens the per-result cap when many capped results still exceed the window", async () => {
		// 20 steps x 200k chars: capped at the 30k default they still total
		// ~600k chars (~171k estimated tokens) — over the 118k threshold — so
		// the degrade loop must tighten to 7.5k per result.
		const steps = Array.from({ length: 20 }, (_, i) =>
			makeStep(i + 1, "y".repeat(200_000)),
		);
		const { runtime, captured } = makeRuntime();

		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory(steps),
			effects: {},
		});

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		const request = captured[0];
		if (!request) throw new Error("no captured request");
		const budget = buildModelInputBudget({
			messages: request.messages as never,
			promptSegments: request.promptSegments as never,
		});
		expect(budget.shouldCompact).toBe(false);

		const values = toolMessageValues(request);
		expect(values).toHaveLength(20);
		for (const value of values) {
			// Tightened cap (30_000 / 4 = 7_500), not just the per-result default.
			expect(value.length).toBeLessThanOrEqual(7_500);
			expect(value).toContain("chars truncated]");
		}
	});

	it("leaves the planner chaining-loop config uncapped (fence-respect: fix stays in the evaluator)", () => {
		expect(DEFAULT_MAX_KEPT_STEP_CHARS).toBe(30_000);
		// The planner path (fenced planner-loop.ts) is deliberately UNCHANGED:
		// the config default stays undefined so no fenced behavior shifts. The
		// cap is applied directly inside the evaluator (evaluator.ts), which is
		// the call that actually 400'd, keeping the fix off the planner loop.
		expect(
			mergeChainingLoopConfig(undefined).compactionMaxKeptStepChars,
		).toBeUndefined();

		// Behavioral: the constant + truncation the evaluator uses caps a 5MB
		// step to head+tail. Fails if the constant reverts (no-op cap).
		const messages = trajectoryStepsToMessages(
			[makeStep(1, "x".repeat(5_000_000))] as never,
			{
				maxToolResultChars: DEFAULT_MAX_KEPT_STEP_CHARS,
			},
		);
		const toolMessage = messages.find((message) => message.role === "tool");
		const part = Array.isArray(toolMessage?.content)
			? toolMessage.content[0]
			: undefined;
		const value =
			part && part.type === "tool-result" && part.output?.type === "text"
				? String(part.output.value)
				: "";
		expect(value.length).toBeLessThanOrEqual(30_001);
		expect(value).toContain("chars truncated]");
	});

	it("leaves a small turn byte-identical (zero-overhead passthrough)", async () => {
		const steps = [makeStep(1, "a".repeat(1_000))];
		const { runtime, captured } = makeRuntime();

		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory(steps),
			effects: {},
		});

		const request = captured[0];
		if (!request) throw new Error("no captured request");
		for (const message of request.messages) {
			expect(JSON.stringify(message.content)).not.toContain("chars truncated]");
		}
		// The step messages sent are exactly the default-cap render — no
		// re-render, no marker, no mutation.
		const control = trajectoryStepsToMessages(steps as never, {
			maxToolResultChars: DEFAULT_MAX_KEPT_STEP_CHARS,
		});
		const sentPairs = request.messages.filter(
			(message) => message.role === "assistant" || message.role === "tool",
		);
		expect(sentPairs).toEqual(JSON.parse(JSON.stringify(control)));
	});
});

describe("runEvaluator — bottom-out guard (stable segments alone over budget)", () => {
	it("fails fast with EVALUATOR_INPUT_OVER_BUDGET instead of calling the provider", async () => {
		// Overflow in the STABLE prefix, which the degrade loop deliberately
		// never trims: even at the 2k tool-result floor the input cannot fit,
		// so the evaluator must throw a typed error before useModel.
		const hugeStablePrompt = "characterization ".repeat(2_000_000);
		const { runtime } = makeRuntime();

		await expect(
			runEvaluator({
				runtime,
				context: {
					...CONTEXT,
					staticPrefix: {
						characterPrompt: { content: hugeStablePrompt, stable: true },
					},
				},
				trajectory: makeTrajectory([makeStep(1, "small result")]),
				effects: {},
			}),
		).rejects.toMatchObject({ code: "EVALUATOR_INPUT_OVER_BUDGET" });

		expect(runtime.useModel).not.toHaveBeenCalled();
	});
});
