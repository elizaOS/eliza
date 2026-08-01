/**
 * Provider execution invariants for state composition: sibling providers start
 * concurrently, valid work has no elapsed-time deadline, duplicate in-flight
 * work coalesces, failures stay observable, and owner cancellation reaches
 * provider boundaries.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import { AgentRuntime } from "../runtime";
import { TurnAbortedError } from "../runtime/turn-controller";
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

	it("waits for valid provider work until the provider completes", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-no-deadline" } as Character,
		});
		const started = deferred();
		const release = deferred();
		let settled = false;
		runtime.registerProvider({
			name: "OWNER_BOUND_WORK",
			get: async () => {
				started.resolve();
				await release.promise;
				return { text: "completed without a clock" };
			},
		});

		const compose = runtime.composeState(
			makeMessage("abababab-abab-abab-abab-abababababab"),
			["OWNER_BOUND_WORK"],
			true,
		);
		void compose.finally(() => {
			settled = true;
		});
		await started.promise;
		await Promise.resolve();
		expect(settled).toBe(false);

		release.resolve();
		const state = await compose;
		expect(state.text).toBe("completed without a clock");
		expect(settled).toBe(true);
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
		expect(receivedSignal).toBe(turnSignal);
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

	it("stops awaiting non-cooperative work when the owning turn is cancelled", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-owner-cancellation" } as Character,
		});
		const started = deferred();
		const release = deferred();
		let providerCompleted = false;
		runtime.registerProvider({
			name: "NON_COOPERATIVE",
			get: async () => {
				started.resolve();
				await release.promise;
				providerCompleted = true;
				return { text: "late result" };
			},
		});
		const message = makeMessage("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");

		const turn = runtime.turnControllers.runWith(ROOM_ID, () =>
			runtime.composeState(message, ["NON_COOPERATIVE"], true),
		);
		await started.promise;
		runtime.turnControllers.abortTurn(ROOM_ID, "owner cancelled");

		const error = await turn.catch((cause: unknown) => cause);
		expect(error).toMatchObject({ code: "TURN_ABORTED" });
		expect(providerCompleted).toBe(false);
		expect(runtime.stateCache.has(message.id as string)).toBe(false);

		release.resolve();
		await release.promise;
		await Promise.resolve();
		expect(providerCompleted).toBe(true);
		expect(runtime.stateCache.has(message.id as string)).toBe(false);
	});

	it("treats a provider-owned TimeoutError as a provider failure", async () => {
		const runtime = new AgentRuntime({
			character: { name: "provider-timeout-error" } as Character,
		});
		runtime.registerProvider({
			name: "PLUGIN_TIMEOUT_ERROR",
			get: async () => {
				const error = new Error("provider operation timed out");
				error.name = "TimeoutError";
				throw error;
			},
		});

		const error = await runtime
			.composeState(
				makeMessage("ffffffff-ffff-ffff-ffff-ffffffffffff"),
				["PLUGIN_TIMEOUT_ERROR"],
				true,
			)
			.catch((cause: unknown) => cause);

		expect(error).toMatchObject({ code: "PROVIDER_COMPOSITION_FAILED" });
	});
});
