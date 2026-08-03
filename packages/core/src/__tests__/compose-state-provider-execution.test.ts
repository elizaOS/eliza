/**
 * Provider execution invariants for state composition: sibling providers start
 * concurrently, duplicate in-flight work coalesces, failures stay observable,
 * and turn cancellation reaches provider-owned boundaries.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import { AgentRuntime } from "../runtime";
import { TurnAbortedError } from "../runtime/turn-controller";
import { runWithStreamingContext } from "../streaming-context";
import type {
	Character,
	Memory,
	Provider,
	ProviderExecutionContext,
	UUID,
} from "../types";

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
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
		// while A is still streaming) coalesces onto it. The registry maps the
		// room to B's controller, so the user's stop aborts B — and B must stop
		// promptly instead of silently riding A's execution to completion.
		const first = runtime.turnControllers.runWith(ROOM_ID, () =>
			runtime.composeState(message, ["SLOW"], true),
		);
		await started.promise;
		const second = runtime.turnControllers.runWith(ROOM_ID, () =>
			runtime.composeState(message, ["SLOW"], true),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(calls).toBe(1);

		expect(runtime.turnControllers.abortTurn(ROOM_ID, "user stopped")).toBe(
			true,
		);
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

	it("counts signal-less callers so a waiter's abort cannot kill their shared work (#17604 review)", async () => {
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
});
