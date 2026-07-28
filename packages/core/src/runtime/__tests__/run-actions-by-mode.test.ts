/**
 * Exercises `AgentRuntime.runActionsByMode` (the hook-mode action runner):
 * mode filtering, `modePriority` ordering, parallel DURING execution, context
 * gating, error isolation, and callback attribution. Real runtime over the
 * in-memory adapter with a stubbed `composeState` — deterministic, no model.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import {
	getStreamingContext,
	runWithStreamingContext,
} from "../../streaming-context";
import {
	type Action,
	ActionMode,
	type Character,
	HOOK_MODES,
	type Memory,
} from "../../types";
import type { EffectReceipt } from "../../types/effects";
import { effectDeliveryBindingProvesApplication } from "../effect-delivery";

function makeProbe(
	name: string,
	mode: ActionMode,
	ledger: string[],
	options: {
		modePriority?: number;
		contexts?: string[];
		validate?: () => boolean;
		throwInHandler?: boolean;
		delayMs?: number;
	} = {},
): Action {
	return {
		name,
		description: `probe:${mode}`,
		mode,
		modePriority: options.modePriority,
		contexts: options.contexts,
		examples: [],
		validate: async () => options.validate?.() ?? true,
		handler: async () => {
			if (options.delayMs) {
				await new Promise((r) => setTimeout(r, options.delayMs));
			}
			ledger.push(name);
			if (options.throwInHandler) {
				throw new Error(`probe ${name} threw`);
			}
			return { success: true };
		},
	};
}

function makeCharacter(): Character {
	return {
		name: "TestAgent",
		bio: "test",
		settings: {},
	} as Character;
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-00000000000a" as Memory["id"],
		entityId: "00000000-0000-0000-0000-00000000000b" as Memory["entityId"],
		roomId: "00000000-0000-0000-0000-00000000000c" as Memory["roomId"],
		content: { text: "hello", source: "test" },
	} as Memory;
}

function appliedEffectReceipt(receiptId: string): EffectReceipt {
	return {
		receiptId,
		operation: "test.hook.apply",
		resource: { kind: "test.hook", id: receiptId },
		artifacts: [],
		idempotency: { key: `request-${receiptId}`, replayed: false },
		observedAt: "2026-07-27T18:00:00.000Z",
		outcome: "applied",
		commit: {
			kind: "durable",
			id: `commit-${receiptId}`,
			committedAt: "2026-07-27T18:00:00.000Z",
		},
	};
}

describe("runActionsByMode", () => {
	let runtime: AgentRuntime;

	beforeAll(async () => {
		runtime = new AgentRuntime({
			character: makeCharacter(),
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		// Register the runtime with a no-op composeState so we don't need a
		// model provider.
		runtime.composeState = async () => ({ values: {}, data: {}, text: "" });
	});

	it("filters actions by mode and ignores PLANNER actions", async () => {
		const ledger: string[] = [];
		const before = makeProbe("p-before", "ALWAYS_BEFORE", ledger);
		const after = makeProbe("p-after", "ALWAYS_AFTER", ledger);
		const planner = makeProbe("p-planner", "PLANNER", ledger);
		runtime.actions.length = 0;
		runtime.actions.push(before, after, planner);

		await runtime.runActionsByMode("ALWAYS_BEFORE", makeMessage());
		expect(ledger).toEqual(["p-before"]);
	});

	it("honors validate() — actions returning false are skipped", async () => {
		const ledger: string[] = [];
		const ok = makeProbe("ok", "ALWAYS_AFTER", ledger);
		const skip = makeProbe("skip", "ALWAYS_AFTER", ledger, {
			validate: () => false,
		});
		runtime.actions.length = 0;
		runtime.actions.push(ok, skip);

		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage());
		expect(ledger).toEqual(["ok"]);
	});

	it("runs sequential modes in modePriority ascending, alphabetical tiebreak", async () => {
		const ledger: string[] = [];
		runtime.actions.length = 0;
		runtime.actions.push(
			makeProbe("late", "ALWAYS_AFTER", ledger, { modePriority: 200 }),
			makeProbe("first", "ALWAYS_AFTER", ledger, { modePriority: 50 }),
			makeProbe("second-b", "ALWAYS_AFTER", ledger, { modePriority: 100 }),
			makeProbe("second-a", "ALWAYS_AFTER", ledger, { modePriority: 100 }),
		);
		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage());
		expect(ledger).toEqual(["first", "second-a", "second-b", "late"]);
	});

	it("DURING modes run handlers in parallel (overlap detected)", async () => {
		const events: string[] = [];
		const make = (name: string) =>
			({
				name,
				description: `probe:DURING:${name}`,
				mode: ActionMode.ALWAYS_DURING,
				examples: [],
				validate: async () => true,
				handler: async () => {
					events.push(`${name}:start`);
					await new Promise((r) => setTimeout(r, 30));
					events.push(`${name}:end`);
					return { success: true };
				},
			}) as Action;
		runtime.actions.length = 0;
		runtime.actions.push(make("a"), make("b"));
		await runtime.runActionsByMode("ALWAYS_DURING", makeMessage());
		// Both should have started before either ended (true parallelism).
		const aStart = events.indexOf("a:start");
		const bStart = events.indexOf("b:start");
		const aEnd = events.indexOf("a:end");
		const bEnd = events.indexOf("b:end");
		expect(aStart).toBeLessThan(bEnd);
		expect(bStart).toBeLessThan(aEnd);
	});

	it("CONTEXT_* gates by intersection of action.contexts and selectedContexts", async () => {
		const ledger: string[] = [];
		const knowledge = makeProbe("k", "CONTEXT_BEFORE", ledger, {
			contexts: ["documents"],
		});
		const wallet = makeProbe("w", "CONTEXT_BEFORE", ledger, {
			contexts: ["wallet"],
		});
		const both = makeProbe("kw", "CONTEXT_BEFORE", ledger, {
			contexts: ["documents", "wallet"],
		});
		const none = makeProbe("n", "CONTEXT_BEFORE", ledger, { contexts: [] });
		runtime.actions.length = 0;
		runtime.actions.push(knowledge, wallet, both, none);

		await runtime.runActionsByMode("CONTEXT_BEFORE", makeMessage(), undefined, {
			selectedContexts: ["documents"],
		});
		expect(ledger.sort()).toEqual(["k", "kw"]);
	});

	it("handler errors don't stop the run; subsequent actions still execute", async () => {
		const ledger: string[] = [];
		runtime.actions.length = 0;
		runtime.actions.push(
			makeProbe("first", "ALWAYS_AFTER", ledger, {
				modePriority: 10,
				throwInHandler: true,
			}),
			makeProbe("second", "ALWAYS_AFTER", ledger, { modePriority: 20 }),
		);
		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage());
		expect(ledger).toEqual(["first", "second"]);
	});

	it("attributes callback text to the hook action that emitted it", async () => {
		const callback = vi.fn(async () => []);
		runtime.actions.length = 0;
		runtime.actions.push({
			name: "HOOK_STATUS",
			description: "hook status",
			mode: ActionMode.ALWAYS_AFTER,
			examples: [],
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, cb) => {
				await cb?.({ text: "raw hook output" });
				return { success: true };
			},
		} as Action);

		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage(), undefined, {
			callback,
		});

		expect(callback).toHaveBeenCalledWith(
			{ text: "raw hook output" },
			"HOOK_STATUS",
		);
	});

	it("delivers a mutation hook callback only after binding exact receipt proof", async () => {
		const receipt = appliedEffectReceipt("receipt-hook-mutation");
		const callback = vi.fn(async () => []);
		const canonicalText = "The hook mutation is committed.";
		runtime.actions.length = 0;
		runtime.actions.push({
			name: "HOOK_MUTATION",
			description: "hook mutation",
			mode: ActionMode.ALWAYS_AFTER,
			tags: ["capability:write"],
			examples: [],
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, cb) => {
				await cb?.({ text: canonicalText });
				return {
					success: true,
					userFacingText: canonicalText,
					verifiedUserFacing: true,
					effectReceipts: [receipt],
					userFacingEffectReceiptIds: [receipt.receiptId],
				};
			},
		} as Action);

		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage(), undefined, {
			callback,
		});

		expect(callback).toHaveBeenCalledOnce();
		const delivered = callback.mock.calls[0]?.[0];
		expect(delivered).toEqual(
			expect.objectContaining({
				text: canonicalText,
				effectReceiptIds: [receipt.receiptId],
			}),
		);
		expect(
			delivered ? effectDeliveryBindingProvesApplication(delivered) : false,
		).toBe(true);
	});

	it("suppresses a receipt-required mutation hook callback that has no effect receipt", async () => {
		const callback = vi.fn(async () => []);
		runtime.actions.length = 0;
		runtime.actions.push({
			name: "LEGACY_HOOK_MUTATION",
			description: "legacy hook mutation",
			mode: ActionMode.ALWAYS_AFTER,
			tags: ["capability:write", "effect:receipt-required"],
			examples: [],
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, cb) => {
				await cb?.({ text: "Done." });
				return { success: true, text: "Done." };
			},
		} as Action);

		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage(), undefined, {
			callback,
		});

		expect(callback).not.toHaveBeenCalled();
	});

	it("delivers an explicit mutation failure without fabricating effect proof", async () => {
		const callback = vi.fn(async () => []);
		runtime.actions.length = 0;
		runtime.actions.push({
			name: "FAILED_HOOK_MUTATION",
			description: "failed mutation",
			mode: ActionMode.ALWAYS_AFTER,
			tags: ["capability:write"],
			examples: [],
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, cb) => {
				const text = "The change was rejected before anything was written.";
				await cb?.({ text });
				return { success: false, text, error: "PRECONDITION_REJECTED" };
			},
		} as Action);

		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage(), undefined, {
			callback,
		});

		expect(callback).toHaveBeenCalledWith(
			{ text: "The change was rejected before anything was written." },
			"FAILED_HOOK_MUTATION",
		);
	});

	it("discards a failed hook callback and continues to the next action", async () => {
		const callback = vi.fn(async () => []);
		const ledger: string[] = [];
		runtime.actions.length = 0;
		runtime.actions.push(
			{
				name: "FAILING_HOOK",
				description: "fails after trying to reply",
				mode: ActionMode.ALWAYS_AFTER,
				modePriority: 10,
				examples: [],
				validate: async () => true,
				handler: async (_runtime, _message, _state, _options, cb) => {
					ledger.push("failing");
					await cb?.({ text: "This must not escape." });
					throw new Error("hook failed");
				},
			} as Action,
			makeProbe("following", "ALWAYS_AFTER", ledger, { modePriority: 20 }),
		);

		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage(), undefined, {
			callback,
		});

		expect(ledger).toEqual(["failing", "following"]);
		expect(callback).not.toHaveBeenCalled();
	});

	it("reports callback delivery failure without failing or rerunning a settled hook", async () => {
		const receipt = appliedEffectReceipt("receipt-hook-delivery");
		const callback = vi.fn(async () => {
			throw new Error("hook transport unavailable");
		});
		const reportError = vi
			.spyOn(runtime, "reportError")
			.mockImplementation(() => undefined);
		const handler = vi.fn(async (_runtime, _message, _state, _options, cb) => {
			const text = "The hook change is committed.";
			await cb?.({ text });
			return {
				success: true,
				userFacingText: text,
				verifiedUserFacing: true,
				effectReceipts: [receipt],
				userFacingEffectReceiptIds: [receipt.receiptId],
			};
		});
		runtime.actions.length = 0;
		runtime.actions.push({
			name: "HOOK_DELIVERY_FAILURE",
			description: "settles independently of callback delivery",
			mode: ActionMode.ALWAYS_AFTER,
			tags: ["capability:write"],
			examples: [],
			validate: async () => true,
			handler,
		} as Action);

		await expect(
			runtime.runActionsByMode("ALWAYS_AFTER", makeMessage(), undefined, {
				callback,
			}),
		).resolves.toEqual([
			expect.objectContaining({ name: "HOOK_DELIVERY_FAILURE" }),
		]);

		expect(handler).toHaveBeenCalledOnce();
		expect(reportError).toHaveBeenCalledWith(
			"ActionCallbackDelivery",
			expect.any(Error),
			expect.objectContaining({
				actionName: "HOOK_DELIVERY_FAILURE",
				effectReceiptIds: [receipt.receiptId],
			}),
		);
		reportError.mockRestore();
	});

	it("keeps parallel hook callback settlement isolated per action", async () => {
		const callback = vi.fn(async () => []);
		const makeMutationHook = (name: string, delayMs: number): Action => {
			const receipt = appliedEffectReceipt(`receipt-${name.toLowerCase()}`);
			const text = `${name} committed.`;
			return {
				name,
				description: `parallel mutation ${name}`,
				mode: ActionMode.ALWAYS_DURING,
				tags: ["capability:write"],
				examples: [],
				validate: async () => true,
				handler: async (_runtime, _message, _state, _options, cb) => {
					await cb?.({ text });
					await new Promise((resolve) => setTimeout(resolve, delayMs));
					return {
						success: true,
						userFacingText: text,
						verifiedUserFacing: true,
						effectReceipts: [receipt],
						userFacingEffectReceiptIds: [receipt.receiptId],
					};
				},
			};
		};
		runtime.actions.length = 0;
		runtime.actions.push(
			makeMutationHook("HOOK_A", 20),
			makeMutationHook("HOOK_B", 5),
		);

		await runtime.runActionsByMode("ALWAYS_DURING", makeMessage(), undefined, {
			callback,
		});

		expect(callback).toHaveBeenCalledTimes(2);
		const deliveries = callback.mock.calls.map(([content, actionName]) => ({
			actionName,
			text: content.text,
			receiptIds: content.effectReceiptIds,
			applied: effectDeliveryBindingProvesApplication(content),
		}));
		expect(deliveries).toEqual(
			expect.arrayContaining([
				{
					actionName: "HOOK_A",
					text: "HOOK_A committed.",
					receiptIds: ["receipt-hook_a"],
					applied: true,
				},
				{
					actionName: "HOOK_B",
					text: "HOOK_B committed.",
					receiptIds: ["receipt-hook_b"],
					applied: true,
				},
			]),
		);
	});

	it("strips forged receipt IDs from a non-mutating hook callback", async () => {
		const callback = vi.fn(async () => []);
		runtime.actions.length = 0;
		runtime.actions.push({
			name: "HOOK_READ",
			description: "read hook",
			mode: ActionMode.ALWAYS_AFTER,
			tags: ["capability:read"],
			examples: [],
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, cb) => {
				await cb?.({ text: "Read complete.", effectReceiptIds: ["forged"] });
				return { success: true, text: "Read complete." };
			},
		} as Action);

		await runtime.runActionsByMode("ALWAYS_AFTER", makeMessage(), undefined, {
			callback,
		});

		expect(callback).toHaveBeenCalledWith(
			{ text: "Read complete." },
			"HOOK_READ",
		);
	});

	// #16230: runActionsByMode wraps each hook handler in
	// runWithSuppressedModelStream, so a hook action's INTERNAL model call cannot
	// stream into the turn's visible reply channel. The visible stream is scoped
	// to the top-level response generation; hooks speak through their callback.
	it("keeps a hook action's internal useModel output off the visible stream (#16230)", async () => {
		const LEDGER = '```json\n{"state":{"facts":["internal"]}}\n```';
		const visibleSink = vi.fn();
		runtime.actions.length = 0;
		runtime.actions.push({
			name: "INTERNAL_MODELER",
			description: "hook that calls the model internally",
			mode: ActionMode.ALWAYS_AFTER,
			examples: [],
			validate: async () => true,
			handler: async (rt) => {
				await rt.useModel("TEXT_LARGE" as never, { prompt: "extract ledger" });
				return { success: true };
			},
		} as Action);
		// A streaming model: it pushes intermediate output into whatever streaming
		// context is active during the call. The wrap makes that context's
		// onStreamChunk a no-op for the duration of the handler.
		const originalUseModel = runtime.useModel;
		runtime.useModel = (async () => {
			const active = getStreamingContext();
			await active?.onStreamChunk?.(LEDGER, undefined, LEDGER);
			return LEDGER;
		}) as typeof runtime.useModel;
		try {
			await runWithStreamingContext(
				{
					messageId: "m",
					onStreamChunk: async (chunk: string) => {
						visibleSink(chunk);
					},
				} as never,
				() => runtime.runActionsByMode("ALWAYS_AFTER", makeMessage()),
			);
			expect(visibleSink).not.toHaveBeenCalled();

			// Positive control: the same emission at the top level (outside the hook
			// seam) DOES reach the sink — the negative assertion is not vacuous.
			await runWithStreamingContext(
				{
					messageId: "m",
					onStreamChunk: async (chunk: string) => {
						visibleSink(chunk);
					},
				} as never,
				() => runtime.useModel("TEXT_LARGE" as never, { prompt: "reply" }),
			);
			expect(visibleSink).toHaveBeenCalledWith(LEDGER);
		} finally {
			runtime.useModel = originalUseModel;
		}
	});

	it("HOOK_MODES export covers all 9 hook positions", () => {
		expect(HOOK_MODES.length).toBe(9);
		expect(HOOK_MODES).toContain("ALWAYS_BEFORE");
		expect(HOOK_MODES).toContain("RESPONSE_HANDLER_BEFORE");
		expect(HOOK_MODES).toContain("RESPONSE_HANDLER_DURING");
		expect(HOOK_MODES).toContain("RESPONSE_HANDLER_AFTER");
		expect(HOOK_MODES).toContain("CONTEXT_BEFORE");
		expect(HOOK_MODES).toContain("CONTEXT_DURING");
		expect(HOOK_MODES).toContain("CONTEXT_AFTER");
		expect(HOOK_MODES).toContain("ALWAYS_DURING");
		expect(HOOK_MODES).toContain("ALWAYS_AFTER");
		expect(HOOK_MODES).not.toContain("PLANNER");
	});
});
