/**
 * Provider execution invariants for state composition: sibling providers start
 * concurrently, duplicate in-flight work coalesces, failures stay observable,
 * and turn cancellation reaches provider-owned boundaries.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import { AgentRuntime } from "../runtime";
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
		expect(receivedSignal).toBe(runtime.turnControllers.signalFor(ROOM_ID));
		expect(runtime.turnControllers.abortTurn(ROOM_ID, "user stopped")).toBe(
			true,
		);

		const error = await turn.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(ElizaError);
		expect((error as ElizaError).code).toBe("PROVIDER_COMPOSITION_ABORTED");
	});
});
