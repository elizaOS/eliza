/**
 * The model-call timing window opens at the handler invocation, not at
 * `useModel` entry. Everything before the handler — pre_model hooks,
 * secret/PII swap sessions, streaming setup, prompt extraction — is runtime
 * work, and charging it to the provider span made `model:*` timings unreadable
 * as provider latency (#16394). These tests pin the window with a deliberately
 * slow pre_model hook and a handler of known duration: the `post_model`
 * `durationMs` must reflect the handler alone. Real runtime over the in-memory
 * adapter with registered fake model handlers; deterministic.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { type Character, ModelType } from "../../types";

const PRE_HOOK_DELAY_MS = 250;
const HANDLER_DELAY_MS = 40;
// Generous ceiling between the handler's real duration and the pre-hook
// delay: timers can overshoot, but never by the full 250ms pre-hook cost.
const SPAN_CEILING_MS = PRE_HOOK_DELAY_MS - 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "SpanWindowAgent",
			bio: "test",
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

function captureModelSpan(runtime: AgentRuntime): { durationMs: number[] } {
	const captured: { durationMs: number[] } = { durationMs: [] };
	runtime.registerPipelineHook({
		id: "capture-span",
		phase: "post_model",
		handler: (_rt, ctx) => {
			if (ctx.phase === "post_model") captured.durationMs.push(ctx.durationMs);
		},
	});
	return captured;
}

describe("AgentRuntime.useModel span window", () => {
	it("excludes a slow pre_model hook from the reported model duration", async () => {
		const runtime = makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => {
				await sleep(HANDLER_DELAY_MS);
				return "handler-result";
			},
			"test",
			0,
		);
		runtime.registerPipelineHook({
			id: "slow-pre-model",
			phase: "pre_model",
			handler: async () => {
				await sleep(PRE_HOOK_DELAY_MS);
			},
		});
		const span = captureModelSpan(runtime);

		const result = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "measure me",
		});

		expect(result).toBe("handler-result");
		expect(span.durationMs).toHaveLength(1);
		expect(span.durationMs[0]).toBeGreaterThanOrEqual(HANDLER_DELAY_MS - 5);
		expect(span.durationMs[0]).toBeLessThan(SPAN_CEILING_MS);
	});

	it("keeps the handler-only window on the streaming path", async () => {
		const runtime = makeRuntime();
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (
				_rt,
				params: { onStreamChunk?: (chunk: string) => Promise<void> | void },
			) => {
				await sleep(HANDLER_DELAY_MS);
				await params.onStreamChunk?.("streamed");
				return "streamed";
			},
			"test",
			0,
			{ streamable: true },
		);
		runtime.registerPipelineHook({
			id: "slow-pre-model-stream",
			phase: "pre_model",
			handler: async () => {
				await sleep(PRE_HOOK_DELAY_MS);
			},
		});
		const span = captureModelSpan(runtime);

		const result = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "measure the stream",
			onStreamChunk: () => {},
		});

		expect(result).toBe("streamed");
		expect(span.durationMs).toHaveLength(1);
		expect(span.durationMs[0]).toBeLessThan(SPAN_CEILING_MS);
	});
});
