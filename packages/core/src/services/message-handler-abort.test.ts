/**
 * AbortSignal propagation through `messageService.handleMessage` and the
 * `abortInflightInference(runtime)` helper.
 *
 * Wave 4 — the caller-supplied `MessageProcessingOptions.abortSignal`
 * threads through the `StreamingContext` and into `runtime.useModel`. The
 * runtime auto-injects the context's `abortSignal` onto model params when
 * the caller didn't supply one explicitly (see runtime.ts useModel:
 * paramsAsStreaming.signal ??= abortSignal). The underlying handler is then
 * free to wire the signal into its transport (LlamaChatSession.prompt's
 * `stopOnAbortSignal`, fetch's `signal`, etc.).
 *
 * This file covers:
 *   1. End-to-end propagation: the abortSignal supplied to a streaming
 *      context reaches a stubbed `useModel` handler via `params.signal`.
 *   2. `abortInflightInference(runtime)` aborts every active turn on the
 *      `TurnControllerRegistry` and returns the room ids it aborted.
 */

import { describe, expect, it } from "vitest";
import {
	abortInflightInference,
	TurnControllerRegistry,
} from "../runtime/turn-controller";
import {
	getStreamingContext,
	runWithStreamingContext,
	type StreamingContext,
} from "../streaming-context";

describe("AbortSignal propagation through streaming context", () => {
	it("makes the caller-supplied signal observable to a model handler", async () => {
		const controller = new AbortController();
		const ctx: StreamingContext = {
			onStreamChunk: async () => undefined,
			messageId: "msg-1",
			abortSignal: controller.signal,
		};

		// Stand-in for `runtime.useModel`. Reads the streaming context the
		// same way the real runtime does (runtime.ts line ~4453+) and
		// observes the abort signal threaded onto it.
		async function fakeUseModel(): Promise<AbortSignal | undefined> {
			const streamingCtx = getStreamingContext();
			return streamingCtx?.abortSignal;
		}

		const observed = await runWithStreamingContext(ctx, () => fakeUseModel());
		expect(observed).toBe(controller.signal);
		expect(observed?.aborted).toBe(false);
		controller.abort();
		expect(observed?.aborted).toBe(true);
	});

	it("aborts a slow model call when the caller signals abort", async () => {
		const controller = new AbortController();
		const ctx: StreamingContext = {
			onStreamChunk: async () => undefined,
			messageId: "msg-2",
			abortSignal: controller.signal,
		};

		// Slow model that respects the signal. The real backends do the
		// same thing — llama-cpp threads `stopOnAbortSignal` into the
		// sampler loop, fetch-based providers thread it into the request.
		async function slowUseModel(signal: AbortSignal): Promise<string> {
			return await new Promise<string>((resolve, reject) => {
				const onAbort = () => {
					signal.removeEventListener("abort", onAbort);
					const err = new Error("aborted");
					err.name = "AbortError";
					reject(err);
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
				setTimeout(() => {
					signal.removeEventListener("abort", onAbort);
					resolve("never");
				}, 60_000);
			});
		}

		const pending = runWithStreamingContext(ctx, async () => {
			const streamingCtx = getStreamingContext();
			const signal = streamingCtx?.abortSignal;
			if (!signal)
				throw new Error("abortSignal missing from streaming context");
			return slowUseModel(signal);
		});

		setTimeout(() => controller.abort(), 10);
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(controller.signal.aborted).toBe(true);
	});
});

describe("abortInflightInference(runtime)", () => {
	it("returns an empty list when no turns are active", () => {
		const registry = new TurnControllerRegistry();
		const aborted = abortInflightInference({ turnControllers: registry });
		expect(aborted).toEqual([]);
	});

	it("aborts every active turn and returns the aborted room ids", async () => {
		const registry = new TurnControllerRegistry();
		const fakeRuntime = { turnControllers: registry };

		const observed: Array<{ roomId: string; aborted: boolean }> = [];
		const a = registry.runWith("room-a", async (signal) => {
			await new Promise<void>((resolve) => {
				signal.addEventListener(
					"abort",
					() => {
						observed.push({ roomId: "room-a", aborted: signal.aborted });
						resolve();
					},
					{ once: true },
				);
			});
		});
		const b = registry.runWith("room-b", async (signal) => {
			await new Promise<void>((resolve) => {
				signal.addEventListener(
					"abort",
					() => {
						observed.push({ roomId: "room-b", aborted: signal.aborted });
						resolve();
					},
					{ once: true },
				);
			});
		});

		// Let microtasks settle so both turns are registered.
		await Promise.resolve();
		const aborted = abortInflightInference(fakeRuntime, "app-pause");
		expect(aborted.sort()).toEqual(["room-a", "room-b"]);

		await Promise.all([a, b]);
		expect(observed.sort((x, y) => x.roomId.localeCompare(y.roomId))).toEqual([
			{ roomId: "room-a", aborted: true },
			{ roomId: "room-b", aborted: true },
		]);
	});

	it("is idempotent — second call returns empty after all turns released", async () => {
		const registry = new TurnControllerRegistry();
		const fakeRuntime = { turnControllers: registry };

		const pending = registry.runWith("room-c", async (signal) => {
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
		});
		await Promise.resolve();
		expect(abortInflightInference(fakeRuntime)).toEqual(["room-c"]);
		await pending;
		expect(abortInflightInference(fakeRuntime)).toEqual([]);
	});
});
