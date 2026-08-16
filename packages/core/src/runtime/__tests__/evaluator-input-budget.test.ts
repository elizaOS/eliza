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
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { type Character, ModelType } from "../../types";
import { computePrefixHashes } from "../context-hash";
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
	providerOptions?: { eliza?: { thinking?: unknown } };
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

function makeRegisteredRuntime(
	registrations: Array<{
		modelType: string;
		provider: string;
		model: string;
	}>,
) {
	const base = makeRuntime();
	return {
		...base,
		runtime: {
			...base.runtime,
			getModelRegistrations: () =>
				registrations.map((registration) => ({
					modelType: registration.modelType,
					provider: registration.provider,
					metadata: { displayModel: registration.model },
				})),
		},
	};
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
	it("preserves a large-context candidate's 30k tool result byte-for-byte", async () => {
		const result = "large-context-result-".repeat(1_600);
		const { runtime, captured } = makeRegisteredRuntime([
			{
				modelType: "RESPONSE_HANDLER",
				provider: "large",
				model: "claude-sonnet-5",
			},
		]);

		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, result)]),
			effects: {},
		});

		const request = captured[0];
		if (!request) throw new Error("no captured request");
		expect(toolMessageValues(request)[0]).toContain(result);
		expect(toolMessageValues(request)[0]).not.toContain("chars truncated]");
	});

	it("preserves the selected primary input and lets AgentRuntime compact a smaller failover", async () => {
		const result = "x".repeat(500_000);
		const { runtime, captured } = makeRegisteredRuntime([
			{
				modelType: "RESPONSE_HANDLER",
				provider: "primary",
				model: "claude-sonnet-5",
			},
			{
				modelType: "TEXT_SMALL",
				provider: "backup",
				model: "llama3.1-8b",
			},
		]);

		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, result)]),
			effects: {},
		});

		const request = captured[0];
		if (!request) throw new Error("no captured request");
		const value = toolMessageValues(request)[0] ?? "";
		expect(value).toContain(result);
		expect(value).not.toContain("chars truncated]");
	});

	it("rebudgets on a real AgentRuntime failover attempt", async () => {
		const primaryRequests: CapturedRequest[] = [];
		const backupRequests: CapturedRequest[] = [];
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async (_runtime, request) => {
				primaryRequests.push(request as CapturedRequest);
				throw new Error("[cli-inference:sdk] subscription rate limit reached");
			},
			"primary",
			100,
			{ displayModel: "claude-sonnet-5" },
		);
		runtime.registerModel(
			ModelType.TEXT_NANO,
			async (_runtime, request) => {
				backupRequests.push(request as CapturedRequest);
				return ENVELOPE;
			},
			"backup",
			10,
			{ displayModel: "llama3.1-8b" },
		);
		const result = "x".repeat(100_000);
		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, result)]),
			effects: {},
		});
		expect(primaryRequests).toHaveLength(1);
		expect(backupRequests).toHaveLength(1);
		const primaryRequest = primaryRequests[0];
		const backupRequest = backupRequests[0];
		if (!primaryRequest || !backupRequest)
			throw new Error("missing failover request");
		expect(toolMessageValues(primaryRequest)[0]).toContain(result);
		expect(toolMessageValues(backupRequest)[0]).toContain("chars truncated]");
		expect(backupRequest.providerOptions?.eliza?.thinking).toBe("off");
	});

	it("rebudgets a smaller backup registered under the same model type", async () => {
		const primaryRequests: CapturedRequest[] = [];
		const backupRequests: CapturedRequest[] = [];
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async (_runtime, request) => {
				primaryRequests.push(request as CapturedRequest);
				throw new Error("[cli-inference:sdk] subscription rate limit reached");
			},
			"primary",
			100,
			{ displayModel: "claude-sonnet-5" },
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async (_runtime, request) => {
				backupRequests.push(request as CapturedRequest);
				return ENVELOPE;
			},
			"backup",
			10,
			{ displayModel: "llama3.1-8b" },
		);
		const result = "x".repeat(100_000);

		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, result)]),
			effects: {},
		});

		expect(primaryRequests).toHaveLength(1);
		expect(backupRequests).toHaveLength(1);
		expect(
			toolMessageValues(primaryRequests[0] as CapturedRequest)[0],
		).toContain(result);
		expect(
			toolMessageValues(backupRequests[0] as CapturedRequest)[0],
		).toContain("chars truncated]");
	});

	it("does not fail over after an unrelated attempt-preparation error", async () => {
		const primaryHandler = vi.fn(async () => ENVELOPE);
		const backupHandler = vi.fn(async () => ENVELOPE);
		const prepareModelAttempt = vi.fn((attempt: { provider: string }) => {
			if (attempt.provider === "primary") {
				throw new Error("attempt preparation defect");
			}
		});
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			primaryHandler,
			"primary",
			100,
			{ displayModel: "claude-sonnet-5" },
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			backupHandler,
			"backup",
			10,
			{ displayModel: "llama3.1-8b" },
		);

		await expect(
			runtime.useModel(ModelType.RESPONSE_HANDLER, {
				messages: [{ role: "user", content: "test" }],
				prepareModelAttempt,
			}),
		).rejects.toThrow("attempt preparation defect");

		expect(prepareModelAttempt).toHaveBeenCalledTimes(1);
		expect(primaryHandler).not.toHaveBeenCalled();
		expect(backupHandler).not.toHaveBeenCalled();
	});

	it("rejects a known-over-budget fallback before its provider handler", async () => {
		const backupHandler = vi.fn(async () => ENVELOPE);
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async () => {
				throw new Error("[cli-inference:sdk] subscription rate limit reached");
			},
			"primary",
			100,
			{ displayModel: "claude-sonnet-5" },
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			backupHandler,
			"backup",
			10,
			{ displayModel: "llama3.1-8b" },
		);

		await expect(
			runEvaluator({
				runtime,
				context: {
					...CONTEXT,
					staticPrefix: {
						characterPrompt: {
							content: "characterization ".repeat(10_000),
							stable: true,
						},
					},
				},
				trajectory: makeTrajectory([makeStep(1, "small result")]),
				effects: {},
			}),
		).rejects.toMatchObject({ code: "EVALUATOR_INPUT_OVER_BUDGET" });
		expect(backupHandler).not.toHaveBeenCalled();
	});

	it("budgets the actual owner-selected provider before its first attempt", async () => {
		const largeRequests: CapturedRequest[] = [];
		const smallHandler = vi.fn(async () => ENVELOPE);
		const runtime = new AgentRuntime({
			character: {
				name: "EvaluatorAgent",
				bio: "test",
				settings: {
					ELIZA_BRAIN_PROVIDER: "large",
					SMALL_EVALUATOR_MODEL: "llama3.1-8b",
				},
			} as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			smallHandler,
			"small",
			100,
			{ displayModelSetting: "SMALL_EVALUATOR_MODEL" },
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async (_runtime, request) => {
				largeRequests.push(request as CapturedRequest);
				return ENVELOPE;
			},
			"large",
			10,
			{ displayModel: "claude-sonnet-5" },
		);
		const result = "x".repeat(100_000);

		await runEvaluator({
			runtime,
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, result)]),
			effects: {},
		});

		expect(smallHandler).not.toHaveBeenCalled();
		expect(largeRequests).toHaveLength(1);
		expect(toolMessageValues(largeRequests[0] as CapturedRequest)[0]).toContain(
			result,
		);
	});

	it("uses env-backed model metadata and the ACTION_PLANNER fallback chain", async () => {
		vi.stubEnv("EVALUATOR_ACTION_MODEL", "claude-sonnet-5");
		try {
			const { runtime, captured } = makeRegisteredRuntime([
				{
					modelType: "ACTION_PLANNER",
					provider: "primary",
					model: "env-placeholder",
				},
				{ modelType: "TEXT_MEDIUM", provider: "medium", model: "llama3.1-8b" },
				{ modelType: "TEXT_SMALL", provider: "small", model: "llama3.1-8b" },
			]);
			const registered = runtime.getModelRegistrations?.() ?? [];
			(runtime.getModelRegistrations as () => Array<Record<string, unknown>>) =
				() => [
					{
						modelType: "ACTION_PLANNER",
						provider: "primary",
						metadata: { displayModelSetting: "EVALUATOR_ACTION_MODEL" },
					},
					...registered.slice(1),
				];
			await runEvaluator({
				runtime,
				modelType: ModelType.ACTION_PLANNER,
				context: CONTEXT,
				trajectory: makeTrajectory([makeStep(1, "x".repeat(500_000))]),
				effects: {},
			});
			const request = captured[0];
			if (!request) throw new Error("missing action planner request");
			expect(toolMessageValues(request)[0]).toContain("x".repeat(500_000));
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("keeps a usable input budget for a sub-10k custom model window", async () => {
		vi.stubEnv("MODEL_CONTEXT_WINDOWS_JSON", '{"tiny-evaluator":8000}');
		try {
			const { runtime, captured } = makeRegisteredRuntime([
				{
					modelType: "RESPONSE_HANDLER",
					provider: "tiny",
					model: "tiny-evaluator",
				},
			]);

			await runEvaluator({
				runtime,
				context: CONTEXT,
				trajectory: makeTrajectory([makeStep(1, "small result")]),
				effects: {},
			});

			expect(captured).toHaveLength(1);
		} finally {
			vi.unstubAllEnvs();
		}
	});

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

	it("records structured-parameter budget failure before making a provider call", async () => {
		const recorded: Array<{ stage: Record<string, unknown> }> = [];
		const { runtime } = makeRuntime();
		const runtimeWithRecorder = {
			...runtime,
			getModelRegistrations: () => [
				{
					modelType: "RESPONSE_HANDLER",
					provider: "small",
					metadata: { displayModel: "llama3.1-8b" },
				},
			],
		};
		const oversizedParams = { payload: "p".repeat(200_000) };
		await expect(
			runEvaluator({
				runtime: runtimeWithRecorder,
				recorder: {
					recordStage: vi.fn(
						async (_id: string, stage: Record<string, unknown>) => {
							recorded.push({ stage });
						},
					),
				} as never,
				trajectoryId: "budget-params",
				context: CONTEXT,
				trajectory: makeTrajectory([
					{
						...makeStep(1, "ok"),
						toolCall: {
							id: "tool-1-0",
							name: "BIG_PARAMS",
							params: oversizedParams,
						},
					},
				]),
				effects: {},
			}),
		).rejects.toMatchObject({ code: "EVALUATOR_INPUT_OVER_BUDGET" });
		expect(runtimeWithRecorder.useModel).not.toHaveBeenCalled();
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.stage).toMatchObject({
			kind: "evaluation",
			evaluation: { protocolFailure: true },
		});
		expect(String(recorded[0]?.stage.model?.response)).toContain(
			"EVALUATOR_INPUT_OVER_BUDGET",
		);
	});
});

describe("runEvaluator — failover continues past an over-budget mid-chain registration", () => {
	const OVERSIZED_STABLE_CONTEXT = {
		...CONTEXT,
		staticPrefix: {
			characterPrompt: {
				content: "characterization ".repeat(10_000),
				stable: true,
			},
		},
	};

	function registerRateLimitedPrimary(runtime: AgentRuntime) {
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async () => {
				throw new Error("[cli-inference:sdk] subscription rate limit reached");
			},
			"primary",
			100,
			{ displayModel: "claude-sonnet-5" },
		);
	}

	it("skips a rejected smaller registration and succeeds on a later larger one", async () => {
		const smallHandler = vi.fn(async () => ENVELOPE);
		const finalRequests: CapturedRequest[] = [];
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		registerRateLimitedPrimary(runtime);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			smallHandler,
			"small",
			50,
			{
				displayModel: "llama3.1-8b",
			},
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async (_runtime, request) => {
				finalRequests.push(request as CapturedRequest);
				return ENVELOPE;
			},
			"backup-large",
			10,
			{ displayModel: "claude-sonnet-5" },
		);

		const output = await runEvaluator({
			runtime,
			context: OVERSIZED_STABLE_CONTEXT,
			trajectory: makeTrajectory([makeStep(1, "small result")]),
			effects: {},
		});

		// The chain must be: large primary rate-limits -> small candidate is
		// rejected pre-handler (its handler never runs) -> the LATER large
		// registration still serves the turn instead of the typed budget error
		// stranding it.
		expect(output.success).toBe(true);
		expect(smallHandler).not.toHaveBeenCalled();
		expect(finalRequests).toHaveLength(1);
		expect(toolMessageValues(finalRequests[0] as CapturedRequest)[0]).toContain(
			"small result",
		);
	});

	it("records the terminal budget failure with the last rejected attempt's request", async () => {
		const recordedStages: Array<Record<string, unknown>> = [];
		const smallHandler = vi.fn(async () => ENVELOPE);
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		registerRateLimitedPrimary(runtime);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			smallHandler,
			"small",
			10,
			{
				displayModel: "llama3.1-8b",
			},
		);

		await expect(
			runEvaluator({
				runtime,
				recorder: {
					recordStage: vi.fn(
						async (_id: string, stage: Record<string, unknown>) => {
							recordedStages.push(stage);
						},
					),
				} as never,
				trajectoryId: "terminal-budget",
				context: OVERSIZED_STABLE_CONTEXT,
				trajectory: makeTrajectory([makeStep(1, "small result")]),
				effects: {},
			}),
		).rejects.toMatchObject({ code: "EVALUATOR_INPUT_OVER_BUDGET" });

		expect(smallHandler).not.toHaveBeenCalled();
		expect(recordedStages).toHaveLength(1);
		const stage = recordedStages[0] as {
			kind: string;
			model: { provider?: string; response: string };
			evaluation: { protocolFailure?: boolean };
		};
		expect(stage.kind).toBe("evaluation");
		expect(stage.evaluation.protocolFailure).toBe(true);
		expect(stage.model.response).toContain("EVALUATOR_INPUT_OVER_BUDGET");
		// The stage must attribute the failure to the registration that
		// rejected the input, not the preflight provider selection.
		expect(stage.model.provider).toBe("small");
	});
});

describe("runEvaluator — trajectory stage records the per-attempt prepared request", () => {
	it("persists the successful failover attempt's request, not the preflight snapshot", async () => {
		const backupRequests: CapturedRequest[] = [];
		const recordedStages: Array<Record<string, unknown>> = [];
		const runtime = new AgentRuntime({
			character: { name: "EvaluatorAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async () => {
				throw new Error("[cli-inference:sdk] subscription rate limit reached");
			},
			"primary",
			100,
			{ displayModel: "claude-sonnet-5" },
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			async (_runtime, request) => {
				backupRequests.push(request as CapturedRequest);
				return ENVELOPE;
			},
			"backup",
			10,
			{ displayModel: "llama3.1-8b" },
		);

		await runEvaluator({
			runtime,
			recorder: {
				recordStage: vi.fn(
					async (_id: string, stage: Record<string, unknown>) => {
						recordedStages.push(stage);
					},
				),
			} as never,
			trajectoryId: "attempt-snapshot",
			context: CONTEXT,
			trajectory: makeTrajectory([makeStep(1, "x".repeat(100_000))]),
			effects: {},
		});

		expect(backupRequests).toHaveLength(1);
		expect(recordedStages).toHaveLength(1);
		const backupRequest = backupRequests[0] as CapturedRequest;
		const stage = recordedStages[0] as {
			model: {
				provider?: string;
				messages: unknown;
				providerOptions?: unknown;
			};
			cache: { segmentHashes: string[]; prefixHash: string };
		};
		// The recorded request must be byte-identical to what the selected
		// handler received — including the failover compaction the preflight
		// snapshot (rendered for the large primary) does not have.
		expect(stage.model.messages).toEqual(backupRequest.messages);
		expect(stage.model.providerOptions).toEqual(backupRequest.providerOptions);
		expect(JSON.stringify(stage.model.messages)).toContain("chars truncated]");
		expect(stage.model.provider).toBe("backup");
		// Cache metadata must describe the prepared attempt's segments too.
		const expectedHashes = computePrefixHashes(
			(backupRequest.promptSegments ?? []) as never,
		);
		expect(stage.cache.segmentHashes).toEqual(
			expectedHashes.map((entry) => entry.segmentHash),
		);
	});
});
