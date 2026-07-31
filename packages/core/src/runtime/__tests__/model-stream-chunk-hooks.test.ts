/**
 * Per-token `model_stream_chunk` hook dispatch through the real
 * `AgentRuntime.useModel` stream path. The runtime consults a cached per-phase
 * hook list before building the per-token hook context (the zero-hook fast
 * path), so these tests lock the cases that cache could break: hooks still
 * receive every chunk with cumulative accumulated text, registration and
 * unregistration mid-stream take effect on the next chunk, and position
 * ordering survives the cache. Real runtime over the in-memory adapter with a
 * registered fake streaming model handler; deterministic.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { type Character, ModelType } from "../../types";

const TOKENS = ["alpha ", "beta ", "gamma"];

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "StreamHookAgent",
			bio: "test",
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

function registerStreamingModel(runtime: AgentRuntime): void {
	runtime.registerModel(
		ModelType.TEXT_SMALL,
		async (
			_runtime,
			params: {
				prompt?: string;
				onStreamChunk?: (chunk: string) => Promise<void> | void;
			},
		) => {
			for (const token of TOKENS) {
				await Promise.resolve();
				await params.onStreamChunk?.(token);
			}
			return TOKENS.join("");
		},
		"test",
		0,
		// Declare handler streaming support so useModel forwards onStreamChunk.
		{ streamable: true },
	);
}

describe("AgentRuntime.useModel model_stream_chunk hooks", () => {
	it("streams with zero hooks registered (fast path) and still delivers every chunk downstream", async () => {
		const runtime = makeRuntime();
		registerStreamingModel(runtime);
		const received: string[] = [];

		const result = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "stream it",
			onStreamChunk: (chunk: string) => {
				received.push(chunk);
			},
		});

		expect(result).toBe(TOKENS.join(""));
		expect(received).toEqual(TOKENS);
	});

	it("delivers every chunk with cumulative accumulated text to a registered hook", async () => {
		const runtime = makeRuntime();
		registerStreamingModel(runtime);
		const seen: Array<{ chunk: string; accumulated: string }> = [];
		runtime.registerPipelineHook({
			id: "capture-stream",
			phase: "model_stream_chunk",
			handler: (_rt, ctx) => {
				if (ctx.phase === "model_stream_chunk") {
					seen.push({ chunk: ctx.chunk, accumulated: ctx.accumulated });
				}
			},
		});

		await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "stream it",
			onStreamChunk: () => undefined,
		});

		expect(seen.map((s) => s.chunk)).toEqual(TOKENS);
		expect(seen.map((s) => s.accumulated)).toEqual([
			"alpha ",
			"alpha beta ",
			"alpha beta gamma",
		]);
	});

	it("picks up a hook registered mid-stream on the next chunk (cache invalidation)", async () => {
		const runtime = makeRuntime();
		registerStreamingModel(runtime);
		const seen: string[] = [];
		let registered = false;

		await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "stream it",
			onStreamChunk: () => {
				if (!registered) {
					registered = true;
					runtime.registerPipelineHook({
						id: "late-hook",
						phase: "model_stream_chunk",
						handler: (_rt, ctx) => {
							if (ctx.phase === "model_stream_chunk") seen.push(ctx.chunk);
						},
					});
				}
			},
		});

		// The first chunk raced the registration (zero hooks at dispatch time);
		// every later chunk must reach the late hook.
		expect(seen).toEqual(TOKENS.slice(1));
	});

	it("stops delivering to a hook unregistered mid-stream", async () => {
		const runtime = makeRuntime();
		registerStreamingModel(runtime);
		const seen: string[] = [];
		runtime.registerPipelineHook({
			id: "short-lived",
			phase: "model_stream_chunk",
			handler: (_rt, ctx) => {
				if (ctx.phase === "model_stream_chunk") {
					seen.push(ctx.chunk);
					runtime.unregisterPipelineHook("short-lived");
				}
			},
		});

		await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "stream it",
			onStreamChunk: () => undefined,
		});

		expect(seen).toEqual([TOKENS[0]]);
	});

	it("keeps position ordering across the cached per-phase list", async () => {
		const runtime = makeRuntime();
		registerStreamingModel(runtime);
		const order: string[] = [];
		const handlerFor = (label: string) =>
			vi.fn((_rt: unknown, ctx: { phase: string }) => {
				if (ctx.phase === "model_stream_chunk") order.push(label);
			});
		// Registered out of position order; dispatch must sort by position.
		runtime.registerPipelineHook({
			id: "hook-late",
			phase: "model_stream_chunk",
			position: 10,
			handler: handlerFor("late"),
		});
		runtime.registerPipelineHook({
			id: "hook-early",
			phase: "model_stream_chunk",
			position: -10,
			handler: handlerFor("early"),
		});

		await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "stream it",
			onStreamChunk: () => undefined,
		});

		// model_stream_chunk hooks run concurrently per chunk but are STARTED in
		// sorted order; with synchronous handlers the observed order is stable.
		expect(order.slice(0, 2)).toEqual(["early", "late"]);
		expect(order).toHaveLength(TOKENS.length * 2);
	});
});
