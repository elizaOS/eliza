/**
 * Deterministic tests for the token/cache backfill added to `recordLlmCall`
 * in the duplicate-trajectory fix (#17532). Several providers (xAI, OpenAI
 * buffered stream) do not surface token counts in the detail they hand to
 * recordLlmCall even though the SDK result carries them. Because the generic
 * useModel fallback is suppressed once the provider record lands, failing to
 * backfill from `result.usage` would silently lose token/cost attribution.
 */
import { describe, expect, it } from "vitest";
import { runWithTrajectoryContext } from "./trajectory-context";
import { type RecordLlmCallDetails, recordLlmCall } from "./trajectory-utils";
import type { IAgentRuntime } from "./types";

function details(
	overrides: Partial<RecordLlmCallDetails> = {},
): RecordLlmCallDetails {
	return {
		model: "fixture-model",
		modelType: "ACTION_PLANNER",
		provider: "fixture-provider",
		systemPrompt: "",
		userPrompt: "",
		temperature: 0,
		maxTokens: 128,
		purpose: "external_llm",
		actionType: "fixture.generate",
		...overrides,
	};
}

/** Minimal fake runtime whose trajectories service captures logLlmCall args. */
function fakeRuntime(logLlmCall: (params: Record<string, unknown>) => void) {
	const service = {
		logLlmCall,
		isEnabled: () => true,
	};
	return {
		getService: () => service,
		getServicesByType: () => [service],
	} as unknown as IAgentRuntime;
}

describe("recordLlmCall — token backfill from result.usage (#17532)", () => {
	it("backfills missing promptTokens/completionTokens from result.usage", async () => {
		const captured: Record<string, unknown>[] = [];
		const runtime = fakeRuntime((p) => captured.push(p));
		const trajCtx = { trajectoryStepId: "step-1" };

		await runWithTrajectoryContext(trajCtx, async () => {
			await recordLlmCall(
				runtime,
				// Provider detail omits token fields entirely (xAI-like).
				details({ promptTokens: undefined, completionTokens: undefined }),
				// SDK result carries usage.
				async () => ({
					text: "ok",
					usage: { promptTokens: 42, completionTokens: 7 },
				}),
			);
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].promptTokens).toBe(42);
		expect(captured[0].completionTokens).toBe(7);
	});

	it("backfills cache token variants when the SDK reports them", async () => {
		const captured: Record<string, unknown>[] = [];
		const runtime = fakeRuntime((p) => captured.push(p));

		await runWithTrajectoryContext({ trajectoryStepId: "step-1" }, async () => {
			await recordLlmCall(runtime, details({}), async () => ({
				text: "ok",
				usage: {
					promptTokens: 100,
					completionTokens: 10,
					cacheReadInputTokens: 50,
					cacheCreationInputTokens: 5,
				},
			}));
		});

		expect(captured[0].cacheReadInputTokens).toBe(50);
		expect(captured[0].cacheCreationInputTokens).toBe(5);
	});

	it("never overwrites explicitly provider-supplied token values", async () => {
		const captured: Record<string, unknown>[] = [];
		const runtime = fakeRuntime((p) => captured.push(p));

		await runWithTrajectoryContext({ trajectoryStepId: "step-1" }, async () => {
			await recordLlmCall(
				runtime,
				// Provider explicitly supplies tokens in its detail.
				details({ promptTokens: 999, completionTokens: 1 }),
				async () => ({
					text: "ok",
					usage: { promptTokens: 42, completionTokens: 7 },
				}),
			);
		});

		// The provider-supplied values must win.
		expect(captured[0].promptTokens).toBe(999);
		expect(captured[0].completionTokens).toBe(1);
	});

	it("accepts legacy input/output token aliases", async () => {
		const captured: Record<string, unknown>[] = [];
		const runtime = fakeRuntime((p) => captured.push(p));

		await runWithTrajectoryContext({ trajectoryStepId: "step-1" }, async () => {
			await recordLlmCall(runtime, details({}), async () => ({
				text: "ok",
				usage: { input: 33, output: 4 },
			}));
		});

		expect(captured[0].promptTokens).toBe(33);
		expect(captured[0].completionTokens).toBe(4);
	});

	it("leaves token fields undefined when result has no usage object", async () => {
		const captured: Record<string, unknown>[] = [];
		const runtime = fakeRuntime((p) => captured.push(p));

		await runWithTrajectoryContext({ trajectoryStepId: "step-1" }, async () => {
			await recordLlmCall(runtime, details({}), async () => "plain string");
		});

		expect(captured[0].promptTokens).toBeUndefined();
		expect(captured[0].completionTokens).toBeUndefined();
	});

	it("ignores non-finite token values in result.usage", async () => {
		const captured: Record<string, unknown>[] = [];
		const runtime = fakeRuntime((p) => captured.push(p));

		await runWithTrajectoryContext({ trajectoryStepId: "step-1" }, async () => {
			await recordLlmCall(runtime, details({}), async () => ({
				text: "ok",
				usage: {
					promptTokens: Number.POSITIVE_INFINITY,
					completionTokens: "not-a-number",
				},
			}));
		});

		expect(captured[0].promptTokens).toBeUndefined();
		expect(captured[0].completionTokens).toBeUndefined();
	});

	it("marks the call as provider-recorded so the generic fallback is suppressed", async () => {
		// After recordLlmCall logs, markProviderRecordedCall must have fired,
		// so a nested scope observes recorded=true.
		const runtime = fakeRuntime(() => {});
		let observedRecorded: boolean | undefined;

		await runWithTrajectoryContext({ trajectoryStepId: "step-1" }, async () => {
			const { runWithModelCallRecordingScope, isProviderRecordedCall } =
				await import("./trajectory-utils");
			await runWithModelCallRecordingScope(async () => {
				await recordLlmCall(runtime, details({}), async () => "ok");
				observedRecorded = isProviderRecordedCall();
			});
		});

		expect(observedRecorded).toBe(true);
	});
});
