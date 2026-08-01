/**
 * Per-provider composeState time budgets: fail-fast is the default, while an
 * explicitly optional provider can publish a distinguishable unavailable
 * result. The harness also proves cooperative work receives cancellation and
 * cannot finish a late side effect after composition returns.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Character, Memory, Provider, UUID } from "../types";

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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("composeState per-provider time budget", () => {
	it("aborts an optional provider and keeps an explicit unavailable result in deterministic order", async () => {
		const runtime = new AgentRuntime({
			character: { name: "budget-truncation" } as Character,
		});
		let lateSideEffect = false;
		let receivedSignal: AbortSignal | undefined;
		const slow: Provider = {
			name: "SLOW_NETWORK",
			position: -10,
			timeoutMs: 300,
			timeoutMode: "degrade",
			get: async (_runtime, _message, _state, context) => {
				receivedSignal = context?.signal;
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						lateSideEffect = true;
						resolve();
					}, 1_500);
					context?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(context.signal?.reason);
						},
						{ once: true },
					);
				});
				return { text: "SLOW_RESULT_MUST_NOT_APPEAR", values: {}, data: {} };
			},
		};
		const fast: Provider = {
			name: "FAST_LOCAL",
			position: 10,
			get: async () => ({ text: "FAST_RESULT_PRESENT", values: {}, data: {} }),
		};
		runtime.registerProvider(slow);
		runtime.registerProvider(fast);

		const start = Date.now();
		const state = await runtime.composeState(
			makeMessage("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
			null,
			false,
			true,
		);
		const elapsed = Date.now() - start;

		expect(state.text).toContain("FAST_RESULT_PRESENT");
		expect(state.text).not.toContain("SLOW_RESULT_MUST_NOT_APPEAR");
		expect(state.text).toMatch(
			/^\[Provider SLOW_NETWORK unavailable this turn: exceeded 300ms deadline\.\]/,
		);
		expect(state.data.providers).toMatchObject({
			SLOW_NETWORK: {
				providerOutcome: "deadline_exceeded",
				data: {
					available: false,
					reason: "deadline_exceeded",
					timeoutMs: 300,
				},
			},
		});
		expect(receivedSignal?.aborted).toBe(true);
		await sleep(50);
		expect(lateSideEffect).toBe(false);
		// Compose returns at the slow provider's budget, not its full runtime.
		expect(elapsed).toBeLessThan(1_400);
	});

	it("honors a declared budget larger than the elapsed work", async () => {
		const runtime = new AgentRuntime({
			character: { name: "budget-headroom" } as Character,
		});
		const withinBudget: Provider = {
			name: "WITHIN_BUDGET",
			timeoutMs: 2_000,
			get: async () => {
				await sleep(400);
				return { text: "WITHIN_BUDGET_PRESENT", values: {}, data: {} };
			},
		};
		runtime.registerProvider(withinBudget);

		const state = await runtime.composeState(
			makeMessage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
			null,
			false,
			true,
		);
		expect(state.text).toContain("WITHIN_BUDGET_PRESENT");
	});

	it("coalesced callers share one deadline and one unavailable checkpoint", async () => {
		const runtime = new AgentRuntime({
			character: { name: "budget-coalesced" } as Character,
		});
		let calls = 0;
		const optional: Provider = {
			name: "OPTIONAL_REMOTE",
			timeoutMs: 250,
			timeoutMode: "degrade",
			get: async (_runtime, _message, _state, context) => {
				calls += 1;
				return new Promise((_, reject) => {
					context?.signal?.addEventListener(
						"abort",
						() => reject(context.signal?.reason),
						{ once: true },
					);
				});
			},
		};
		runtime.registerProvider(optional);
		const message = makeMessage("ffffffff-ffff-ffff-ffff-ffffffffffff");

		const [first, second] = await Promise.all([
			runtime.composeState(message, [optional.name], true),
			runtime.composeState(message, [optional.name], true),
		]);

		expect(calls).toBe(1);
		expect(first.text).toBe(second.text);
		expect(first.data.providers).toMatchObject({
			OPTIONAL_REMOTE: { providerOutcome: "deadline_exceeded" },
		});
	});

	it("discards a non-cooperative provider's late result without rewriting the cached timeout", async () => {
		const runtime = new AgentRuntime({
			character: { name: "budget-late-result" } as Character,
		});
		let completed = false;
		const optional: Provider = {
			name: "NON_COOPERATIVE_READ",
			timeoutMs: 250,
			timeoutMode: "degrade",
			get: async () => {
				await sleep(450);
				completed = true;
				return { text: "LATE_RESULT_MUST_NOT_REPLACE_TIMEOUT" };
			},
		};
		runtime.registerProvider(optional);
		const message = makeMessage("abababab-abab-abab-abab-abababababab");

		const first = await runtime.composeState(message, [optional.name], true);
		expect(first.text).toContain("unavailable this turn");
		expect(first.text).not.toContain("LATE_RESULT_MUST_NOT_REPLACE_TIMEOUT");

		await sleep(300);
		expect(completed).toBe(true);
		const reused = await runtime.composeState(
			message,
			[optional.name],
			true,
			false,
			[],
		);
		expect(reused.text).toBe(first.text);
		expect(reused.text).not.toContain("LATE_RESULT_MUST_NOT_REPLACE_TIMEOUT");
		expect(reused.data.providers).toMatchObject({
			NON_COOPERATIVE_READ: { providerOutcome: "deadline_exceeded" },
		});
	});

	it("does not mistake a provider-owned TimeoutError for the runtime deadline", async () => {
		const runtime = new AgentRuntime({
			character: { name: "budget-error-classification" } as Character,
		});
		const provider: Provider = {
			name: "PLUGIN_TIMEOUT_ERROR",
			timeoutMs: 1_000,
			timeoutMode: "degrade",
			get: async () => {
				const error = new Error("plugin operation timed out");
				error.name = "TimeoutError";
				throw error;
			},
		};
		runtime.registerProvider(provider);

		const error = await runtime
			.composeState(
				makeMessage("acacacac-acac-acac-acac-acacacacacac"),
				[provider.name],
				true,
			)
			.catch((cause: unknown) => cause);

		expect(error).toMatchObject({ code: "PROVIDER_COMPOSITION_FAILED" });
	});

	it("an explicit budget fails composition by default instead of caching partial state", async () => {
		const runtime = new AgentRuntime({
			character: { name: "budget-fail-default" } as Character,
		});
		const correctnessCritical: Provider = {
			name: "CORRECTNESS_CRITICAL",
			timeoutMs: 300,
			// Deliberately no timeoutMode: fail-fast remains authoritative.
			get: async (_runtime, _message, _state, context) => {
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, 1_500);
					context?.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(context.signal?.reason);
						},
						{ once: true },
					);
				});
				return {
					text: "FAILED_BUDGET_SLOW_MUST_NOT_APPEAR",
					values: {},
					data: {},
				};
			},
		};
		const fast: Provider = {
			name: "FAST_LOCAL",
			get: async () => ({
				text: "FAST_RESULT_PRESENT",
				values: {},
				data: {},
			}),
		};
		runtime.registerProvider(correctnessCritical);
		runtime.registerProvider(fast);

		const start = Date.now();
		const message = makeMessage("dddddddd-dddd-dddd-dddd-dddddddddddd");
		const error = await runtime
			.composeState(message, null, false, true)
			.catch((cause: unknown) => cause);
		const elapsed = Date.now() - start;

		expect(error).toMatchObject({ code: "PROVIDER_DEADLINE_EXCEEDED" });
		expect(runtime.stateCache.has(message.id as string)).toBe(false);
		// Compose returns at the declared budget, not the provider's full 1.5s.
		expect(elapsed).toBeLessThan(1_400);
	});

	it("preserves provider behavior when neither metadata nor an operator default declares a budget", async () => {
		const runtime = new AgentRuntime({
			character: { name: "budget-opt-in" } as Character,
		});
		const unbudgeted: Provider = {
			name: "UNBUDGETED_COMPATIBILITY",
			get: async () => {
				await sleep(350);
				return { text: "UNBUDGETED_RESULT_PRESENT" };
			},
		};
		runtime.registerProvider(unbudgeted);

		const state = await runtime.composeState(
			makeMessage("adadadad-adad-adad-adad-adadadadadad"),
			[unbudgeted.name],
			true,
		);

		expect(state.text).toBe("UNBUDGETED_RESULT_PRESENT");
	});

	it("ignores sub-floor timeoutMs declarations instead of racing at unusable budgets", async () => {
		const runtime = new AgentRuntime({
			character: { name: "budget-floor" } as Character,
		});
		const declaredTooLow: Provider = {
			name: "FLOOR_GUARDED",
			// Below the 250ms floor, so this declaration is ignored rather than
			// racing ordinary provider startup at an unusable budget.
			timeoutMs: 1,
			get: async () => {
				await sleep(50);
				return { text: "FLOOR_GUARDED_PRESENT", values: {}, data: {} };
			},
		};
		runtime.registerProvider(declaredTooLow);

		const state = await runtime.composeState(
			makeMessage("cccccccc-cccc-cccc-cccc-cccccccccccc"),
			null,
			false,
			true,
		);
		expect(state.text).toContain("FLOOR_GUARDED_PRESENT");
	});
});
