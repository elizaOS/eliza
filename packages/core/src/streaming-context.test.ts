/**
 * Covers per-turn streaming context propagation, the visible-stream suppression
 * seam, and the model-stream chunk delivery depth.
 *
 * Three properties are load-bearing. Streaming observers must never alter
 * model/action flow, so a throwing hook is reported and swallowed rather than
 * propagated. `runWithSuppressedModelStream` must PASS THROUGH when there is no
 * chunk consumer to detach — installing a discarding callback there would make
 * a context that merely carries cancellation look like a stream consumer to
 * `useModel`, moving otherwise non-streaming internal calls onto the streaming
 * path (#16230). And when it does suppress, the abort signal and structured
 * hooks must survive, because only the visible token channel is being detached.
 *
 * Runs against the real module on the real Node manager; no mocks.
 */
import { describe, expect, it } from "vitest";

import {
	emitStreamingHook,
	getModelStreamChunkDeliveryDepth,
	getStreamingContext,
	runInsideModelStreamChunkDelivery,
	runWithStreamingContext,
	runWithSuppressedModelStream,
	type StreamingContext,
} from "./streaming-context.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("emitStreamingHook", () => {
	it("is a no-op when the context or the hook is absent", async () => {
		await expect(
			emitStreamingHook(undefined, "onToolCall", {} as never),
		).resolves.toBeUndefined();
		await expect(
			emitStreamingHook({} as StreamingContext, "onToolCall", {} as never),
		).resolves.toBeUndefined();
	});

	it("delivers the payload to the hook", async () => {
		const seen: unknown[] = [];
		const payload = { name: "act" } as never;
		await emitStreamingHook(
			{
				onToolCall: (value: unknown) => void seen.push(value),
			} as StreamingContext,
			"onToolCall",
			payload,
		);
		expect(seen).toEqual([payload]);
	});

	it("awaits an async hook before resolving", async () => {
		let finished = false;
		await emitStreamingHook(
			{
				onToolCall: async () => {
					await tick();
					finished = true;
				},
			} as unknown as StreamingContext,
			"onToolCall",
			{} as never,
		);
		expect(finished).toBe(true);
	});

	it("swallows a throwing hook so an observer cannot break the turn", async () => {
		await expect(
			emitStreamingHook(
				{
					onToolCall: () => {
						throw new Error("observer blew up");
					},
				} as unknown as StreamingContext,
				"onToolCall",
				{} as never,
			),
		).resolves.toBeUndefined();
	});

	it("swallows a rejecting async hook too", async () => {
		await expect(
			emitStreamingHook(
				{
					onToolCall: async () => Promise.reject(new Error("nope")),
				} as unknown as StreamingContext,
				"onToolCall",
				{} as never,
			),
		).resolves.toBeUndefined();
	});

	it("routes the failure to reportError with the scope and hook name", async () => {
		const reported: Array<
			[string, unknown, Record<string, unknown> | undefined]
		> = [];
		await emitStreamingHook(
			{
				onEvaluation: () => {
					throw new Error("boom");
				},
				reportError: (scope, error, context) =>
					void reported.push([scope, error, context]),
			} as unknown as StreamingContext,
			"onEvaluation",
			{} as never,
		);
		expect(reported).toHaveLength(1);
		expect(reported[0]?.[0]).toBe("StreamingContext.emitHook");
		expect(reported[0]?.[2]).toMatchObject({ hook: "onEvaluation" });
	});

	it("still swallows the failure when no reportError is installed", async () => {
		await expect(
			emitStreamingHook(
				{
					onToolResult: () => {
						throw new Error("boom");
					},
				} as unknown as StreamingContext,
				"onToolResult",
				{} as never,
			),
		).resolves.toBeUndefined();
	});
});

describe("context propagation", () => {
	const ctx = (overrides: Partial<StreamingContext> = {}): StreamingContext =>
		({ messageId: "m1", ...overrides }) as StreamingContext;

	it("is undefined outside any scope", () => {
		expect(getStreamingContext()).toBeUndefined();
	});

	it("exposes the context inside the scope and clears it afterwards", () => {
		const seen = runWithStreamingContext(ctx(), () => getStreamingContext());
		expect(seen?.messageId).toBe("m1");
		expect(getStreamingContext()).toBeUndefined();
	});

	it("returns the callback's value", () => {
		expect(runWithStreamingContext(ctx(), () => 7)).toBe(7);
	});

	it("survives an await boundary", async () => {
		const seen = await runWithStreamingContext(ctx(), async () => {
			await tick();
			return getStreamingContext()?.messageId;
		});
		expect(seen).toBe("m1");
	});

	it("restores the outer context when a nested scope exits", () => {
		const observed = runWithStreamingContext(
			ctx({ messageId: "outer" }),
			() => {
				const inner = runWithStreamingContext(
					ctx({ messageId: "inner" }),
					() => getStreamingContext()?.messageId,
				);
				return { inner, after: getStreamingContext()?.messageId };
			},
		);
		expect(observed).toEqual({ inner: "inner", after: "outer" });
	});

	it("keeps concurrent turns isolated", async () => {
		const [a, b] = await Promise.all([
			runWithStreamingContext(ctx({ messageId: "a" }), async () => {
				await tick();
				await tick();
				return getStreamingContext()?.messageId;
			}),
			runWithStreamingContext(ctx({ messageId: "b" }), async () => {
				await tick();
				return getStreamingContext()?.messageId;
			}),
		]);
		expect([a, b]).toEqual(["a", "b"]);
	});

	it("treats an explicitly undefined context as no context", () => {
		expect(
			runWithStreamingContext(undefined, () => getStreamingContext()),
		).toBeUndefined();
	});
});

describe("runWithSuppressedModelStream", () => {
	it("passes through when no streaming context is active", () => {
		const seen = runWithSuppressedModelStream(() => getStreamingContext());
		expect(seen).toBeUndefined();
	});

	it("passes through unchanged when the context has no chunk consumer", () => {
		// Installing a discarding callback here would make a cancellation-only
		// context look like a stream consumer to useModel (#16230).
		const outer = { messageId: "m1" } as StreamingContext;
		const seen = runWithStreamingContext(outer, () =>
			runWithSuppressedModelStream(() => getStreamingContext()),
		);
		expect(seen).toBe(outer);
		expect(seen?.onStreamChunk).toBeUndefined();
	});

	it("detaches the visible chunk channel when there is one", async () => {
		const chunks: string[] = [];
		const outer = {
			messageId: "m1",
			onStreamChunk: async (chunk: string) => void chunks.push(chunk),
		} as unknown as StreamingContext;

		await runWithStreamingContext(outer, async () => {
			await runWithSuppressedModelStream(async () => {
				await getStreamingContext()?.onStreamChunk?.("suppressed" as never);
			});
			await getStreamingContext()?.onStreamChunk?.("visible" as never);
		});

		expect(chunks).toEqual(["visible"]);
	});

	it("keeps the abort signal and structured hooks while suppressing", () => {
		const controller = new AbortController();
		const onToolCall = () => undefined;
		const outer = {
			messageId: "m1",
			abortSignal: controller.signal,
			onToolCall,
			onStreamChunk: async () => undefined,
		} as unknown as StreamingContext;

		const inner = runWithStreamingContext(outer, () =>
			runWithSuppressedModelStream(() => getStreamingContext()),
		);
		expect(inner?.abortSignal).toBe(controller.signal);
		expect((inner as unknown as { onToolCall: unknown }).onToolCall).toBe(
			onToolCall,
		);
		expect(inner?.messageId).toBe("m1");
	});

	it("restores the visible channel after the suppressed scope exits", () => {
		const onStreamChunk = async () => undefined;
		const outer = { onStreamChunk } as unknown as StreamingContext;
		const after = runWithStreamingContext(outer, () => {
			runWithSuppressedModelStream(() => undefined);
			return getStreamingContext()?.onStreamChunk;
		});
		expect(after).toBe(onStreamChunk);
	});
});

describe("model stream chunk delivery depth", () => {
	it("is zero outside any delivery", () => {
		expect(getModelStreamChunkDeliveryDepth()).toBe(0);
	});

	it("is greater than zero inside a delivery", () => {
		const depth = runInsideModelStreamChunkDelivery(() =>
			getModelStreamChunkDeliveryDepth(),
		);
		expect(depth).toBeGreaterThan(0);
	});

	it("increments while nested", () => {
		const depths = runInsideModelStreamChunkDelivery(() => {
			const outer = getModelStreamChunkDeliveryDepth();
			const inner = runInsideModelStreamChunkDelivery(() =>
				getModelStreamChunkDeliveryDepth(),
			) as number;
			return { outer, inner };
		}) as { outer: number; inner: number };
		expect(depths.inner).toBe(depths.outer + 1);
	});

	it("returns to zero after the delivery completes", () => {
		runInsideModelStreamChunkDelivery(() => undefined);
		expect(getModelStreamChunkDeliveryDepth()).toBe(0);
	});

	it("survives an await inside the delivery", async () => {
		const depth = await runInsideModelStreamChunkDelivery(async () => {
			await tick();
			return getModelStreamChunkDeliveryDepth();
		});
		expect(depth).toBeGreaterThan(0);
		expect(getModelStreamChunkDeliveryDepth()).toBe(0);
	});

	it("returns the callback's value", () => {
		expect(runInsideModelStreamChunkDelivery(() => "v")).toBe("v");
	});
});
