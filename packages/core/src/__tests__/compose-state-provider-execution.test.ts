/**
 * Provider execution invariants for state composition: sibling providers start
 * concurrently, duplicate in-flight work coalesces, failures stay observable,
 * and turn cancellation reaches provider-owned boundaries.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { ElizaError } from "../errors";
import { AgentRuntime } from "../runtime";
import { TurnAbortedError } from "../runtime/turn-controller";
import { runWithStreamingContext } from "../streaming-context";
import {
	type Character,
	type Memory,
	ModelType,
	type Provider,
	type ProviderExecutionContext,
	type UUID,
} from "../types";

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const OTHER_ROOM_ID = "33333333-3333-3333-3333-333333333333" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;

function makeMessage(id: string): Memory {
	return {
		id: id as UUID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text: "gm" },
	};
}

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("composeState provider execution", () => {
	it("starts sibling providers concurrently", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-parallel" } as Character,
		});
		const release = deferred();
		const allStarted = deferred();
		let active = 0;
		let maxActive = 0;
		let starts = 0;

		for (const name of ["AAA", "BBB", "CCC"]) {
			runtime.registerProvider({
				name,
				get: async () => {
					starts += 1;
					active += 1;
					maxActive = Math.max(maxActive, active);
					if (starts === 3) allStarted.resolve();
					await release.promise;
					active -= 1;
					return { text: name };
				},
			});
		}

		const compose = runtime.composeState(
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
			["AAA", "BBB", "CCC"],
			true,
		);
		await allStarted.promise;
		expect(maxActive).toBe(3);
		release.resolve();
		await compose;
	});

	it("uses position only for render order and gives siblings the same pre-compose state", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-order" } as Character,
		});
		const seenProviderMaps: unknown[] = [];
		runtime.registerProvider({
			name: "LATE_POSITION",
			position: 20,
			get: async (_runtime, _message, state) => {
				seenProviderMaps.push(state.data.providers);
				await new Promise((resolve) => setTimeout(resolve, 20));
				return { text: "late-position" };
			},
		});
		runtime.registerProvider({
			name: "EARLY_POSITION",
			position: -20,
			get: async (_runtime, _message, state) => {
				seenProviderMaps.push(state.data.providers);
				return { text: "early-position" };
			},
		});

		const state = await runtime.composeState(
			makeMessage("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
			["LATE_POSITION", "EARLY_POSITION"],
			true,
		);

		expect(state.text).toBe("early-position\nlate-position");
		expect(seenProviderMaps).toEqual([undefined, undefined]);
	});

	it("coalesces duplicate in-flight provider work for the same message", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-coalescing" } as Character,
		});
		const release = deferred();
		const started = deferred();
		let calls = 0;
		runtime.registerProvider({
			name: "AAA",
			get: async () => {
				calls += 1;
				started.resolve();
				await release.promise;
				return { text: "coalesced" };
			},
		});
		const message = makeMessage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

		const first = runtime.composeState(message, ["AAA"], true);
		await started.promise;
		const second = runtime.composeState(message, ["AAA"], true);
		release.resolve();

		const [firstState, secondState] = await Promise.all([first, second]);
		expect(calls).toBe(1);
		expect(firstState.text).toBe("coalesced");
		expect(secondState.text).toBe("coalesced");
	});

	it("does not reuse cached provider state for the same message id in another room", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-room-cache-isolation" } as Character,
		});
		let calls = 0;
		runtime.registerProvider({
			name: "ROOM_SCOPED",
			get: async (_runtime, message) => {
				calls += 1;
				return { text: message.roomId };
			},
		});
		const firstMessage = makeMessage("abababab-abab-abab-abab-abababababab");
		const secondMessage = { ...firstMessage, roomId: OTHER_ROOM_ID };

		const first = await runtime.composeState(
			firstMessage,
			["ROOM_SCOPED"],
			true,
		);
		const second = await runtime.composeState(
			secondMessage,
			["ROOM_SCOPED"],
			true,
		);

		expect(calls).toBe(2);
		expect(first.text).toBe(ROOM_ID);
		expect(second.text).toBe(OTHER_ROOM_ID);
	});

	it("does not coalesce concurrent provider work across rooms with the same message id", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-room-inflight-isolation" } as Character,
		});
		const release = deferred();
		let calls = 0;
		runtime.registerProvider({
			name: "ROOM_SCOPED",
			get: async (_runtime, message) => {
				calls += 1;
				await release.promise;
				return { text: message.roomId };
			},
		});
		const firstMessage = makeMessage("cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd");
		const secondMessage = { ...firstMessage, roomId: OTHER_ROOM_ID };

		const first = runtime.composeState(firstMessage, ["ROOM_SCOPED"], true);
		const second = runtime.composeState(secondMessage, ["ROOM_SCOPED"], true);
		await new Promise<void>((resolve) => setImmediate(resolve));
		release.resolve();

		expect(calls).toBe(2);
		const [firstState, secondState] = await Promise.all([first, second]);
		expect(firstState.text).toBe(ROOM_ID);
		expect(secondState.text).toBe(OTHER_ROOM_ID);
	});

	it("throws and reports provider failures instead of caching empty context", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-failure" } as Character,
		});
		runtime.registerProvider({
			name: "BROKEN",
			get: async () => {
				throw new Error("database unavailable");
			},
		});
		const message = makeMessage("cccccccc-cccc-cccc-cccc-cccccccccccc");

		const error = await runtime
			.composeState(message, ["BROKEN"], true)
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ElizaError);
		expect((error as ElizaError).code).toBe("PROVIDER_COMPOSITION_FAILED");
		expect(runtime.stateCache.has(message.id as string)).toBe(false);
		expect(runtime.getRecentReportedErrors()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "PROVIDER_COMPOSITION_FAILED",
					context: expect.objectContaining({ provider: "BROKEN" }),
				}),
			]),
		);
	});

	it.each(["AbortError", "TimeoutError"])(
		"keeps a provider-originated %s observable as an ordinary failure",
		async (errorName) => {
			const runtime = new AgentRuntime({
				character: { name: "provider-originated-error" } as Character,
			});
			runtime.registerProvider({
				name: "BROKEN_REMOTE",
				get: async () => {
					const error = new Error("provider boundary failed");
					error.name = errorName;
					throw error;
				},
			});
			const message = makeMessage("12121212-1212-1212-1212-121212121212");

			const error = await runtime
				.composeState(message, ["BROKEN_REMOTE"], true)
				.catch((cause: unknown) => cause);

			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("PROVIDER_COMPOSITION_FAILED");
			expect(runtime.stateCache.has(message.id as string)).toBe(false);
		},
	);

	it("passes the active turn signal to providers and reports cancellation", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-abort" } as Character,
		});
		const started = deferred();
		let receivedSignal: AbortSignal | undefined;
		const provider: Provider = {
			name: "ABORTABLE",
			get: async (
				_runtime,
				_message,
				_state,
				context?: ProviderExecutionContext,
			) => {
				receivedSignal = context?.signal;
				started.resolve();
				return new Promise((_, reject) => {
					const signal = context?.signal;
					if (!signal) {
						reject(new Error("missing provider signal"));
						return;
					}
					if (signal.aborted) {
						reject(signal.reason);
						return;
					}
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
			},
		};
		runtime.registerProvider(provider);
		const message = makeMessage("dddddddd-dddd-dddd-dddd-dddddddddddd");

		const turn = runtime.turnControllers.runWith(ROOM_ID, () =>
			runtime.composeState(message, ["ABORTABLE"], true),
		);
		await started.promise;
		const turnSignal = runtime.turnControllers.signalFor(ROOM_ID);
		expect(receivedSignal).toBeDefined();
		expect(receivedSignal).not.toBe(turnSignal);
		expect(runtime.turnControllers.abortTurn(ROOM_ID, "user stopped")).toBe(
			true,
		);
		expect(receivedSignal?.aborted).toBe(true);
		expect(receivedSignal?.reason).toBe(turnSignal?.reason);

		// A designed turn abort surfaces as the abort itself (TURN_ABORTED), so
		// the message boundary keeps its ack-and-stop contract instead of
		// treating cancellation as a runtime failure. The per-provider
		// cancellation stays observable through the error report stream.
		const error = await turn.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(TurnAbortedError);
		expect((error as TurnAbortedError).code).toBe("TURN_ABORTED");
		expect((error as TurnAbortedError).reason).toBe("user stopped");
		expect(runtime.getRecentReportedErrors()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "PROVIDER_COMPOSITION_ABORTED",
					context: expect.objectContaining({ provider: "ABORTABLE" }),
				}),
			]),
		);
	});

	it("stops awaiting non-cooperative work and observes its detached rejection", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-non-cooperative-abort" } as Character,
		});
		const started = deferred();
		let rejectProvider!: (reason?: unknown) => void;
		runtime.registerProvider({
			name: "NON_COOPERATIVE",
			get: async () => {
				started.resolve();
				return new Promise((_, reject) => {
					rejectProvider = reject;
				});
			},
		});
		const message = makeMessage("13131313-1313-1313-1313-131313131313");
		const controller = new AbortController();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);

		try {
			const turn = runWithStreamingContext(
				{ onStreamChunk: async () => {}, abortSignal: controller.signal },
				() => runtime.composeState(message, ["NON_COOPERATIVE"], true),
			);
			await started.promise;
			controller.abort("user stopped");

			const outcome = await Promise.race([
				turn.catch((cause: unknown) => cause),
				new Promise((resolve) =>
					setTimeout(() => resolve("still waiting"), 250),
				),
			]);
			expect(outcome).toBeInstanceOf(TurnAbortedError);
			expect(runtime.stateCache.has(message.id as string)).toBe(false);

			rejectProvider(new Error("detached provider failed later"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("observes host cancellation through the merged owner inside a room turn", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-merged-host-owner" } as Character,
		});
		const started = deferred();
		runtime.registerProvider({
			name: "HOST_CANCELLED",
			get: async () => {
				started.resolve();
				return new Promise(() => {});
			},
		});
		const hostController = new AbortController();
		const message = makeMessage("18181818-1818-1818-1818-181818181818");

		const compose = runtime.turnControllers.runWith(ROOM_ID, (roomSignal) =>
			runWithStreamingContext(
				{
					onStreamChunk: async () => {},
					abortSignal: AbortSignal.any([hostController.signal, roomSignal]),
				},
				() => runtime.composeState(message, ["HOST_CANCELLED"], true),
			),
		);
		await started.promise;
		hostController.abort("request disconnected");

		const outcome = await Promise.race([
			compose.catch((cause: unknown) => cause),
			new Promise((resolve) => setTimeout(() => resolve("still waiting"), 250)),
		]);
		expect(outcome).toBeInstanceOf(TurnAbortedError);
		expect((outcome as TurnAbortedError).reason).toBe("request disconnected");
		expect(runtime.stateCache.has(message.id as string)).toBe(false);
	});

	it("keeps nested model work on the shared execution when its creator cancels", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init();
		const runtime = new AgentRuntime({
			character: { name: "provider-nested-model-owner" } as Character,
			adapter,
		});
		const modelStarted = deferred();
		const releaseModel = deferred();
		let nestedModelSignal: AbortSignal | undefined;
		let providerCalls = 0;
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_runtime, params: unknown) => {
				const signal = (params as { signal?: AbortSignal }).signal;
				nestedModelSignal = signal;
				modelStarted.resolve();
				return new Promise<string>((resolve, reject) => {
					const rejectFromAbort = () => reject(signal?.reason);
					if (signal?.aborted) {
						rejectFromAbort();
						return;
					}
					signal?.addEventListener("abort", rejectFromAbort, { once: true });
					void releaseModel.promise.then(() => {
						signal?.removeEventListener("abort", rejectFromAbort);
						resolve("nested model result");
					});
				});
			},
			"provider-nested-model-test",
		);
		runtime.registerProvider({
			name: "USES_MODEL",
			get: async (providerRuntime) => {
				providerCalls += 1;
				const text = await providerRuntime.useModel(ModelType.TEXT_SMALL, {
					prompt: "shared recall query",
				});
				return { text };
			},
		});
		const message = makeMessage("19191919-1919-1919-1919-191919191919");
		const creatorController = new AbortController();
		const waiterController = new AbortController();
		const creator = runWithStreamingContext(
			{
				onStreamChunk: async () => {},
				abortSignal: creatorController.signal,
			},
			() => runtime.composeState(message, ["USES_MODEL"], true),
		);
		await modelStarted.promise;
		const waiter = runWithStreamingContext(
			{
				onStreamChunk: async () => {},
				abortSignal: waiterController.signal,
			},
			() => runtime.composeState(message, ["USES_MODEL"], true),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		creatorController.abort("creator disconnected");
		const creatorOutcome = await creator.catch((cause: unknown) => cause);
		expect(creatorOutcome).toBeInstanceOf(TurnAbortedError);
		expect(nestedModelSignal?.aborted).toBe(false);

		releaseModel.resolve();
		const waiterState = await waiter;
		expect(waiterState.text).toBe("nested model result");
		expect(providerCalls).toBe(1);
		await adapter.close();
	});

	it("keeps nested provider model tokens out of the visible reply stream", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init();
		const runtime = new AgentRuntime({
			character: { name: "provider-hidden-model-stream" } as Character,
			adapter,
		});
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_runtime, params: unknown) => {
				const streamingParams = params as {
					onStreamChunk?: (chunk: string) => Promise<void> | void;
				};
				await streamingParams.onStreamChunk?.("internal provider token");
				return "provider model result";
			},
			"provider-hidden-model-stream-test",
			0,
			{ streamable: true },
		);
		runtime.registerProvider({
			name: "USES_HIDDEN_MODEL_STREAM",
			get: async (providerRuntime) => ({
				text: await providerRuntime.useModel(ModelType.TEXT_SMALL, {
					prompt: "build private provider context",
				}),
			}),
		});
		const streamed: string[] = [];
		const state = await runWithStreamingContext(
			{
				onStreamChunk: (chunk) => {
					streamed.push(chunk);
				},
			},
			() =>
				runtime.composeState(
					makeMessage("20202020-2020-2020-2020-202020202020"),
					["USES_HIDDEN_MODEL_STREAM"],
					true,
				),
		);

		expect(state.text).toBe("provider model result");
		expect(streamed).toEqual([]);
		await adapter.close();
	});

	it("keeps provider-internal model calls off the streaming path for a caller with no streaming context", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init();
		const runtime = new AgentRuntime({
			character: { name: "provider-nonstreaming-caller" } as Character,
			adapter,
		});
		const observed: { stream?: unknown; hasSignal: boolean }[] = [];
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_runtime, params: unknown) => {
				const streamingParams = params as {
					stream?: boolean;
					signal?: AbortSignal;
				};
				observed.push({
					stream: streamingParams.stream,
					hasSignal: streamingParams.signal !== undefined,
				});
				return "provider model result";
			},
			"provider-nonstreaming-caller-test",
			0,
			{ streamable: true },
		);
		runtime.registerProvider({
			name: "USES_INTERNAL_MODEL",
			get: async (providerRuntime) => ({
				text: await providerRuntime.useModel(ModelType.TEXT_SMALL, {
					prompt: "build private provider context",
				}),
			}),
		});

		// No ambient streaming context: an evaluator/autonomy/prompt-batcher
		// compose. The execution-owned cancellation scope must still reach the
		// nested call, but it carries no chunk consumer and must not flip the
		// call onto the streaming code path.
		const state = await runtime.composeState(
			makeMessage("21212121-2121-2121-2121-212121212121"),
			["USES_INTERNAL_MODEL"],
			true,
		);

		expect(state.text).toBe("provider model result");
		expect(observed).toEqual([{ stream: false, hasSignal: true }]);
		await adapter.close();
	});

	it("does not start provider work for an owner that was already cancelled", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-pre-aborted-owner" } as Character,
		});
		let calls = 0;
		runtime.registerProvider({
			name: "MUST_NOT_START",
			get: async () => {
				calls += 1;
				return { text: "too late" };
			},
		});
		const controller = new AbortController();
		controller.abort("owner already stopped");

		const outcome = await runWithStreamingContext(
			{ onStreamChunk: async () => {}, abortSignal: controller.signal },
			() =>
				runtime.composeState(
					makeMessage("15151515-1515-1515-1515-151515151515"),
					["MUST_NOT_START"],
					true,
				),
		).catch((cause: unknown) => cause);

		expect(outcome).toBeInstanceOf(TurnAbortedError);
		expect(calls).toBe(0);
	});

	it("does not cache state when the owner aborts after providers settle", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-post-settle-abort" } as Character,
		});
		const controller = new AbortController();
		let abortTriggered = false;
		const values: Record<string, string> = {};
		Object.defineProperty(values, "abortDuringComposition", {
			enumerable: true,
			get: () => {
				if (!abortTriggered) {
					abortTriggered = true;
					controller.abort("owner stopped after provider settlement");
				}
				return "observed";
			},
		});
		runtime.registerProvider({
			name: "SETTLED",
			get: async () => ({ text: "settled", values }),
		});
		const message = makeMessage("14141414-1414-1414-1414-141414141414");

		const outcome = await runWithStreamingContext(
			{ onStreamChunk: async () => {}, abortSignal: controller.signal },
			() => runtime.composeState(message, ["SETTLED"], true),
		).catch((cause: unknown) => cause);

		expect(abortTriggered).toBe(true);
		expect(outcome).toBeInstanceOf(TurnAbortedError);
		expect(runtime.stateCache.has(message.id as string)).toBe(false);
	});

	it("does not finish composition after runtime shutdown begins post-settlement", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-post-settle-runtime-stop" } as Character,
		});
		let stopPromise: Promise<void> | undefined;
		const values: Record<string, string> = {};
		Object.defineProperty(values, "stopDuringComposition", {
			enumerable: true,
			get: () => {
				stopPromise ??= runtime.stop();
				return "observed";
			},
		});
		runtime.registerProvider({
			name: "SETTLED_BEFORE_STOP",
			get: async () => ({ text: "settled", values }),
		});
		const message = makeMessage("17171717-1717-1717-1717-171717171717");

		const outcome = await runtime
			.composeState(message, ["SETTLED_BEFORE_STOP"], true)
			.catch((cause: unknown) => cause);
		await stopPromise;

		expect(outcome).toBeInstanceOf(TurnAbortedError);
		expect((outcome as TurnAbortedError).reason).toBe("runtime-stop");
		expect(runtime.stateCache.has(message.id as string)).toBe(false);
	});

	it("lets a coalesced waiter cancel its own turn without killing the owner (#17602)", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-coalesced-abort" } as Character,
		});
		const release = deferred();
		const started = deferred();
		let calls = 0;
		runtime.registerProvider({
			name: "SLOW",
			get: async () => {
				calls += 1;
				started.resolve();
				await release.promise;
				return { text: "slow" };
			},
		});
		const message = makeMessage("ffffffff-ffff-ffff-ffff-ffffffffffff");

		// Turn A owns the execution; turn B (a re-delivery of the same message
		// while A is still streaming) coalesces onto it. B's request-level signal
		// cancels only B — and B must stop promptly instead of silently riding A's
		// execution to completion. An out-of-band room abort intentionally cancels
		// every active room turn and therefore is not the per-waiter seam tested here.
		const first = runtime.turnControllers.runWith(ROOM_ID, () =>
			runtime.composeState(message, ["SLOW"], true),
		);
		await started.promise;
		const waiterController = new AbortController();
		const second = runtime.turnControllers.runWith(ROOM_ID, () =>
			runWithStreamingContext(
				{
					onStreamChunk: async () => {},
					abortSignal: waiterController.signal,
				},
				() => runtime.composeState(message, ["SLOW"], true),
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toBe(1);

		waiterController.abort(new TurnAbortedError("user stopped"));
		const secondOutcome = await Promise.race([
			second.then(
				() => "completed",
				(cause: unknown) => cause,
			),
			new Promise((resolve) => setTimeout(() => resolve("swallowed"), 250)),
		]);
		// On the broken path the stop is swallowed: `second` neither rejects nor
		// resolves until the owner's provider settles ("swallowed"), and then
		// completes as if never cancelled.
		expect(secondOutcome).toBeInstanceOf(TurnAbortedError);
		expect((secondOutcome as TurnAbortedError).reason).toBe("user stopped");

		// The owner's turn is unaffected by the waiter's cancellation.
		release.resolve();
		const firstState = await first;
		expect(firstState.text).toBe("slow");
		expect(calls).toBe(1);
	});

	it("counts signal-less callers so a waiter's abort cannot kill their shared work", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-signalless-owner" } as Character,
		});
		const release = deferred();
		const started = deferred();
		let calls = 0;
		let providerAborted = false;
		runtime.registerProvider({
			name: "SLOW",
			get: async (
				_runtime,
				_message,
				_state,
				context?: ProviderExecutionContext,
			) => {
				calls += 1;
				context?.signal?.addEventListener(
					"abort",
					() => {
						providerAborted = true;
					},
					{ once: true },
				);
				started.resolve();
				await release.promise;
				return { text: "slow" };
			},
		});
		const message = makeMessage("99999999-9999-9999-9999-999999999999");

		// Caller X composes with NO signal (no turn controller for the room,
		// no streaming context) and owns the execution; turn Y coalesces onto
		// it and is stopped. Y's abort must not kill the provider X is still
		// awaiting: a signal-less caller is a caller.
		const first = runtime.composeState(message, ["SLOW"], true);
		await started.promise;
		const second = runtime.turnControllers.runWith(ROOM_ID, () =>
			runtime.composeState(message, ["SLOW"], true),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toBe(1);

		expect(runtime.turnControllers.abortTurn(ROOM_ID, "user stopped")).toBe(
			true,
		);
		const secondError = await second.catch((cause: unknown) => cause);
		expect(secondError).toBeInstanceOf(TurnAbortedError);

		expect(providerAborted).toBe(false);
		release.resolve();
		const firstState = await first;
		expect(firstState.text).toBe("slow");
		expect(providerAborted).toBe(false);
		expect(calls).toBe(1);
	});

	it("keeps the shared provider alive when the owner aborts while a waiter remains (#17602)", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-owner-abort" } as Character,
		});
		const release = deferred();
		const started = deferred();
		let calls = 0;
		let providerAborted = false;
		runtime.registerProvider({
			name: "SLOW",
			get: async (
				_runtime,
				_message,
				_state,
				context?: ProviderExecutionContext,
			) => {
				calls += 1;
				context?.signal?.addEventListener(
					"abort",
					() => {
						providerAborted = true;
					},
					{ once: true },
				);
				started.resolve();
				await release.promise;
				return { text: "slow" };
			},
		});
		const message = makeMessage("88888888-8888-8888-8888-888888888888");

		// The OWNER (the caller that started the execution) aborts while a
		// coalesced waiter is still interested. The shared work must survive
		// the owner's departure: ownership confers no special kill authority —
		// the provider dies only when the last interested caller leaves.
		const ownerController = new AbortController();
		const owner = runWithStreamingContext(
			{ onStreamChunk: async () => {}, abortSignal: ownerController.signal },
			() => runtime.composeState(message, ["SLOW"], true),
		);
		await started.promise;
		const waiter = runtime.turnControllers.runWith(ROOM_ID, () =>
			runtime.composeState(message, ["SLOW"], true),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toBe(1);

		ownerController.abort("owner stopped");
		const ownerError = await owner.catch((cause: unknown) => cause);
		expect(ownerError).toBeInstanceOf(TurnAbortedError);
		expect((ownerError as TurnAbortedError).reason).toBe("owner stopped");

		expect(providerAborted).toBe(false);
		release.resolve();
		const waiterState = await waiter;
		expect(waiterState.text).toBe("slow");
		expect(providerAborted).toBe(false);
		expect(calls).toBe(1);
	});

	it("aborts the shared provider exactly when the last interested caller aborts (#17602)", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-last-abort" } as Character,
		});
		const started = deferred();
		const providerSawAbort = deferred();
		let calls = 0;
		let providerAborted = false;
		runtime.registerProvider({
			name: "SLOW",
			get: async (
				_runtime,
				_message,
				_state,
				context?: ProviderExecutionContext,
			) => {
				calls += 1;
				started.resolve();
				return new Promise((_, reject) => {
					const signal = context?.signal;
					if (!signal) {
						reject(new Error("missing provider signal"));
						return;
					}
					signal.addEventListener(
						"abort",
						() => {
							providerAborted = true;
							providerSawAbort.resolve();
							reject(signal.reason);
						},
						{ once: true },
					);
				});
			},
		});
		const message = makeMessage("77777777-7777-7777-7777-777777777777");

		// Three callers coalesce onto one execution, then abort one at a time.
		// After each of the first two aborts someone is still waiting, so the
		// provider must keep running; the third abort leaves no interested
		// caller and must reach the shared provider (a lone caller's stop may
		// never strand work running for nobody).
		const controllers = [
			new AbortController(),
			new AbortController(),
			new AbortController(),
		];
		const compose = (controller: AbortController) =>
			runWithStreamingContext(
				{ onStreamChunk: async () => {}, abortSignal: controller.signal },
				() => runtime.composeState(message, ["SLOW"], true),
			);
		const first = compose(controllers[0] as AbortController);
		await started.promise;
		const second = compose(controllers[1] as AbortController);
		const third = compose(controllers[2] as AbortController);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toBe(1);

		controllers[0]?.abort("first caller stopped");
		const firstError = await first.catch((cause: unknown) => cause);
		expect(firstError).toBeInstanceOf(TurnAbortedError);
		expect((firstError as TurnAbortedError).reason).toBe(
			"first caller stopped",
		);
		expect(providerAborted).toBe(false);

		controllers[1]?.abort("second caller stopped");
		const secondError = await second.catch((cause: unknown) => cause);
		expect(secondError).toBeInstanceOf(TurnAbortedError);
		expect((secondError as TurnAbortedError).reason).toBe(
			"second caller stopped",
		);
		expect(providerAborted).toBe(false);

		controllers[2]?.abort("last caller stopped");
		await providerSawAbort.promise;
		expect(providerAborted).toBe(true);
		const thirdError = await third.catch((cause: unknown) => cause);
		expect(thirdError).toBeInstanceOf(TurnAbortedError);
		expect((thirdError as TurnAbortedError).reason).toBe("last caller stopped");
		expect(calls).toBe(1);
	});

	it("does not hand a fresh caller a departed owner's abort reason while eviction lags settlement", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-evict-race" } as Character,
		});
		const release = deferred();
		const started = deferred();
		let calls = 0;
		runtime.registerProvider({
			name: "RACY",
			get: async () => {
				calls += 1;
				started.resolve();
				await release.promise;
				return { text: `racy-${calls}` };
			},
		});
		const message = makeMessage("66666666-6666-6666-6666-666666666666");

		// Owner is the SOLE waiter on the shared execution.
		const ownerController = new AbortController();
		const owner = runWithStreamingContext(
			{ onStreamChunk: async () => {}, abortSignal: ownerController.signal },
			() => runtime.composeState(message, ["RACY"], true),
		);
		await started.promise;
		expect(calls).toBe(1);

		// Abort the owner, then IMMEDIATELY (same synchronous tick, no await in
		// between) issue a fresh composeState for the SAME message with a
		// fresh, unaborted signal. controller.abort() is synchronous but the
		// in-flight map entry is only evicted once the shared promise finishes
		// unwinding through runProviderExecution/withProviderStep, so a caller
		// landing in that window can still find and attach to the dying
		// execution instead of starting its own.
		ownerController.abort("owner stopped");
		const freshController = new AbortController();
		const fresh = runWithStreamingContext(
			{ onStreamChunk: async () => {}, abortSignal: freshController.signal },
			() => runtime.composeState(message, ["RACY"], true),
		);

		const ownerError = await owner.catch((cause: unknown) => cause);
		expect(ownerError).toBeInstanceOf(TurnAbortedError);
		expect((ownerError as TurnAbortedError).reason).toBe("owner stopped");

		release.resolve();
		// A fresh caller with its own, never-aborted signal must get a real
		// provider result from a provider run made on ITS behalf, not the
		// departed owner's abort reason.
		const freshState = await fresh;
		expect(freshState.text).toBe("racy-2");
		expect(calls).toBe(2);
	});

	it("runtime stop releases a signal-less caller from non-cooperative work", async () => {
		// Stopping the runtime clears providerExecutionsInFlight. The execution's
		// AbortController is reachable only through that map, so dropping the
		// entries without firing it strands the provider call: nothing that
		// outlives teardown holds a handle able to cancel it.
		const runtime = new AgentRuntime({
			character: { name: "provider-stop-abort" } as Character,
		});
		const started = deferred();
		let receivedSignal: AbortSignal | undefined;

		runtime.registerProvider({
			name: "HANGING",
			get: async (
				_runtime,
				_message,
				_state,
				context?: ProviderExecutionContext,
			) => {
				receivedSignal = context?.signal;
				started.resolve();
				return new Promise(() => {});
			},
		});

		const compose = runtime
			.composeState(
				makeMessage("dddddddd-dddd-dddd-dddd-dddddddddddd"),
				["HANGING"],
				true,
			)
			.catch((cause: unknown) => cause);
		await started.promise;
		expect(receivedSignal?.aborted).toBe(false);

		const stopped = runtime.stop();

		await stopped;
		expect(receivedSignal?.aborted).toBe(true);
		const outcome = await Promise.race([
			compose,
			new Promise((resolve) => setTimeout(() => resolve("still waiting"), 250)),
		]);
		expect(outcome).not.toBe("still waiting");
	});

	it.each(["explicit refresh", "message without id"])(
		"runtime stop also releases one-off provider work for %s",
		async (mode) => {
			const runtime = new AgentRuntime({
				character: { name: "provider-stop-one-off" } as Character,
			});
			const started = deferred();
			let receivedSignal: AbortSignal | undefined;
			runtime.registerProvider({
				name: "ONE_OFF_HANGING",
				get: async (_runtime, _message, _state, context) => {
					receivedSignal = context?.signal;
					started.resolve();
					return new Promise(() => {});
				},
			});
			const message = makeMessage("16161616-1616-1616-1616-161616161616");
			if (mode === "message without id") {
				Reflect.deleteProperty(message, "id");
			}
			const refreshProviders =
				mode === "explicit refresh" ? ["ONE_OFF_HANGING"] : null;
			const compose = runtime
				.composeState(
					message,
					["ONE_OFF_HANGING"],
					true,
					false,
					refreshProviders,
				)
				.catch((cause: unknown) => cause);
			await started.promise;

			await runtime.stop();
			expect(receivedSignal?.aborted).toBe(true);
			const outcome = await Promise.race([
				compose,
				new Promise((resolve) =>
					setTimeout(() => resolve("still waiting"), 250),
				),
			]);
			expect(outcome).not.toBe("still waiting");
		},
	);
});
