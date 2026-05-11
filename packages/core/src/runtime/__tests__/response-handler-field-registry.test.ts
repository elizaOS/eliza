import { describe, expect, it } from "vitest";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import type {
	ResponseHandlerFieldEvaluator,
	ResponseHandlerSenderRole,
} from "../response-handler-field-evaluator";
import { ResponseHandlerFieldRegistry } from "../response-handler-field-registry";

const ROOM = "00000000-0000-0000-0000-00000000000a";

function fakeRuntime(): IAgentRuntime {
	const warnCalls: unknown[][] = [];
	return {
		agentId: "00000000-0000-0000-0000-000000000001",
		logger: {
			debug: () => undefined,
			info: () => undefined,
			warn: (...args: unknown[]) => {
				warnCalls.push(args);
			},
			error: () => undefined,
			trace: () => undefined,
			fatal: () => undefined,
		},
		_warnCalls: warnCalls,
	} as unknown as IAgentRuntime;
}

function fakeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000002",
		roomId: ROOM,
		entityId: "00000000-0000-0000-0000-0000000000aa",
		content: { text: "hi" },
	} as unknown as Memory;
}

function fakeState(): State {
	return { values: {}, data: {}, text: "" } as unknown as State;
}

function makeEvaluator(
	overrides: Partial<ResponseHandlerFieldEvaluator> & { name: string },
): ResponseHandlerFieldEvaluator {
	return {
		description: `description for ${overrides.name}`,
		schema: { type: "string" },
		...overrides,
	} as ResponseHandlerFieldEvaluator;
}

function defaultDispatchArgs(
	turnSignal: AbortSignal = new AbortController().signal,
	rawParsed: Record<string, unknown> = {},
): Parameters<ResponseHandlerFieldRegistry["dispatch"]>[0] {
	return {
		rawParsed,
		runtime: fakeRuntime(),
		message: fakeMessage(),
		state: fakeState(),
		senderRole: "USER" as ResponseHandlerSenderRole,
		turnSignal,
	};
}

describe("ResponseHandlerFieldRegistry", () => {
	describe("register", () => {
		it("stores evaluator and size() reflects count", () => {
			const reg = new ResponseHandlerFieldRegistry();
			expect(reg.size()).toBe(0);
			reg.register(makeEvaluator({ name: "a" }));
			expect(reg.size()).toBe(1);
			reg.register(makeEvaluator({ name: "b" }));
			expect(reg.size()).toBe(2);
		});

		it("dedups by name (first wins, no throw on second)", () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(makeEvaluator({ name: "a", description: "first" }));
			expect(() =>
				reg.register(makeEvaluator({ name: "a", description: "second" })),
			).not.toThrow();
			expect(reg.size()).toBe(1);
			const list = reg.list();
			expect(list[0]?.description).toBe("first");
		});

		it("throws when name is empty", () => {
			const reg = new ResponseHandlerFieldRegistry();
			expect(() => reg.register(makeEvaluator({ name: "" } as never))).toThrow(
				/non-empty name/,
			);
		});

		it("throws when description is missing", () => {
			const reg = new ResponseHandlerFieldRegistry();
			expect(() =>
				reg.register(
					makeEvaluator({
						name: "noDesc",
						description: "",
					} as never),
				),
			).toThrow(/non-empty description/);
		});

		it("throws when schema is missing", () => {
			const reg = new ResponseHandlerFieldRegistry();
			expect(() =>
				reg.register(
					makeEvaluator({
						name: "noSchema",
						schema: undefined as never,
					}),
				),
			).toThrow(/JSONSchema/);
		});
	});

	describe("unregister", () => {
		it("returns true when found", () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(makeEvaluator({ name: "a" }));
			expect(reg.unregister("a")).toBe(true);
			expect(reg.size()).toBe(0);
		});

		it("returns false when not found", () => {
			const reg = new ResponseHandlerFieldRegistry();
			expect(reg.unregister("nope")).toBe(false);
		});

		it("invalidates the cached schema", () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(makeEvaluator({ name: "a" }));
			reg.register(makeEvaluator({ name: "b" }));
			const before = reg.composeSchemaSignature();
			reg.unregister("b");
			const after = reg.composeSchemaSignature();
			expect(after).not.toBe(before);
		});
	});

	describe("list ordering", () => {
		it("returns sorted by priority then name", () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(makeEvaluator({ name: "z-late", priority: 50 }));
			reg.register(makeEvaluator({ name: "a-late", priority: 50 }));
			reg.register(makeEvaluator({ name: "m-early", priority: 10 }));
			reg.register(makeEvaluator({ name: "default-100" }));

			const names = reg.list().map((e) => e.name);
			expect(names).toEqual([
				"m-early", // priority 10
				"a-late", // priority 50, name "a" before "z"
				"z-late", // priority 50
				"default-100", // priority defaults to 100
			]);
		});
	});

	describe("composeSchema / composeSchemaSignature", () => {
		it("produces byte-stable bytes across calls", () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(makeEvaluator({ name: "foo", schema: { type: "string" } }));
			reg.register(makeEvaluator({ name: "bar", schema: { type: "array" } }));
			const s1 = JSON.stringify(reg.composeSchema());
			const s2 = JSON.stringify(reg.composeSchema());
			expect(s1).toBe(s2);
			expect(reg.composeSchemaSignature()).toBe(s1);
		});

		it("includes all registered evaluators as required properties", () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(makeEvaluator({ name: "alpha" }));
			reg.register(makeEvaluator({ name: "beta" }));
			const schema = reg.composeSchema();
			expect(schema.type).toBe("object");
			expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
				"alpha",
				"beta",
			]);
			expect((schema.required ?? []).sort()).toEqual(["alpha", "beta"]);
		});

		it("sets additionalProperties to false", () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(makeEvaluator({ name: "alpha" }));
			const schema = reg.composeSchema();
			expect(schema.additionalProperties).toBe(false);
		});

		it("composeSchemaSignature changes when an evaluator is registered", () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(makeEvaluator({ name: "alpha" }));
			const sigBefore = reg.composeSchemaSignature();
			reg.register(makeEvaluator({ name: "beta" }));
			const sigAfter = reg.composeSchemaSignature();
			expect(sigAfter).not.toBe(sigBefore);
		});

		it("composeSchemaSignature works without explicit composeSchema call", () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(makeEvaluator({ name: "alpha" }));
			const sig = reg.composeSchemaSignature();
			expect(sig).toContain("alpha");
		});
	});

	describe("composePromptSlices", () => {
		const ctx = {
			runtime: fakeRuntime(),
			message: fakeMessage(),
			state: fakeState(),
			senderRole: "USER" as ResponseHandlerSenderRole,
			turnSignal: new AbortController().signal,
		};

		it("includes only evaluators where shouldRun returned true as 'active'", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(
				makeEvaluator({
					name: "alwaysOn",
					description: "always on slice",
					shouldRun: () => true,
				}),
			);
			reg.register(
				makeEvaluator({
					name: "alwaysOff",
					description: "always off slice",
					shouldRun: () => false,
				}),
			);

			const result = await reg.composePromptSlices(ctx);
			expect(result.activeFieldNames).toEqual(["alwaysOn"]);
			expect(result.skippedFieldNames).toEqual(["alwaysOff"]);
			expect(result.rendered).toContain("### alwaysOn");
			expect(result.rendered).toContain("always on slice");
		});

		it("includes skipped evaluators with the 'Not applicable this turn' prompt", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(
				makeEvaluator({
					name: "off",
					description: "off-desc",
					shouldRun: () => false,
				}),
			);
			const result = await reg.composePromptSlices(ctx);
			expect(result.rendered).toContain("### off");
			expect(result.rendered).toContain("Not applicable this turn");
			expect(result.rendered).not.toContain("off-desc");
		});

		it("treats missing shouldRun as always-active", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(makeEvaluator({ name: "noShould" }));
			const result = await reg.composePromptSlices(ctx);
			expect(result.activeFieldNames).toEqual(["noShould"]);
		});

		it("supports async shouldRun", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(
				makeEvaluator({
					name: "asyncOff",
					shouldRun: async () => false,
				}),
			);
			const result = await reg.composePromptSlices(ctx);
			expect(result.skippedFieldNames).toEqual(["asyncOff"]);
		});
	});

	describe("dispatch", () => {
		it("runs handlers in priority order", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			const callOrder: string[] = [];
			reg.register(
				makeEvaluator({
					name: "high",
					priority: 90,
					schema: { type: "string" },
					handle: () => {
						callOrder.push("high");
						return undefined;
					},
				}),
			);
			reg.register(
				makeEvaluator({
					name: "low",
					priority: 10,
					schema: { type: "string" },
					handle: () => {
						callOrder.push("low");
						return undefined;
					},
				}),
			);

			await reg.dispatch(
				defaultDispatchArgs(undefined, { low: "x", high: "y" }),
			);
			expect(callOrder).toEqual(["low", "high"]);
		});

		it("parsed result preserves raw values supplied by the LLM", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(
				makeEvaluator({ name: "asString", schema: { type: "string" } }),
			);
			reg.register(
				makeEvaluator({ name: "asArray", schema: { type: "array" } }),
			);
			reg.register(
				makeEvaluator({ name: "asBool", schema: { type: "boolean" } }),
			);

			const result = await reg.dispatch(
				defaultDispatchArgs(undefined, {
					asString: "hello",
					asArray: ["x", "y"],
					asBool: true,
				}),
			);
			expect(result.parsed.asString).toBe("hello");
			expect(result.parsed.asArray).toEqual(["x", "y"]);
			expect(result.parsed.asBool).toBe(true);
		});

		it("default empty values are seeded for fields whose evaluator is gated off by shouldRun", async () => {
			// When shouldRun=false the loop `continue`s before the re-stamp, so
			// the buildDefaultedResult seed survives.
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(
				makeEvaluator({
					name: "asString",
					schema: { type: "string" },
					shouldRun: () => false,
				}),
			);
			reg.register(
				makeEvaluator({
					name: "asArray",
					schema: { type: "array" },
					shouldRun: () => false,
				}),
			);
			reg.register(
				makeEvaluator({
					name: "asObject",
					schema: { type: "object" },
					shouldRun: () => false,
				}),
			);
			reg.register(
				makeEvaluator({
					name: "asBool",
					schema: { type: "boolean" },
					shouldRun: () => false,
				}),
			);
			reg.register(
				makeEvaluator({
					name: "asNumber",
					schema: { type: "number" },
					shouldRun: () => false,
				}),
			);
			reg.register(
				makeEvaluator({
					name: "asInt",
					schema: { type: "integer" },
					shouldRun: () => false,
				}),
			);
			reg.register(
				makeEvaluator({
					name: "asNullable",
					schema: { type: ["string", "null"] },
					shouldRun: () => false,
				}),
			);

			const result = await reg.dispatch(defaultDispatchArgs(undefined, {}));
			expect(result.parsed.asString).toBe("");
			expect(result.parsed.asArray).toEqual([]);
			expect(result.parsed.asObject).toEqual({});
			expect(result.parsed.asBool).toBe(false);
			expect(result.parsed.asNumber).toBe(0);
			expect(result.parsed.asInt).toBe(0);
			// First non-null type in a union becomes the default — "string" → "".
			expect(result.parsed.asNullable).toBe("");
		});

		it("default empty value falls back to null when no concrete type is declared", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(
				makeEvaluator({
					name: "untyped",
					schema: {} as never,
					shouldRun: () => false,
				}),
			);
			const result = await reg.dispatch(defaultDispatchArgs(undefined, {}));
			expect(result.parsed.untyped).toBeNull();
		});

		it("handler returning preempt stops subsequent handlers", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			let secondCalled = false;
			reg.register(
				makeEvaluator({
					name: "stopper",
					priority: 10,
					handle: () => ({
						preempt: { mode: "ack-and-stop", reason: "abort" },
					}),
				}),
			);
			reg.register(
				makeEvaluator({
					name: "after",
					priority: 20,
					handle: () => {
						secondCalled = true;
						return undefined;
					},
				}),
			);

			const res = await reg.dispatch(
				defaultDispatchArgs(undefined, { stopper: "x", after: "y" }),
			);
			expect(secondCalled).toBe(false);
			expect(res.preempt).toEqual({ mode: "ack-and-stop", reason: "abort" });
		});

		it("handler returning mutateResult mutates the running parsed result", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(
				makeEvaluator({
					name: "first",
					priority: 10,
					handle: () => ({
						mutateResult: (r) => {
							(r as Record<string, unknown>).injected = "yes";
						},
					}),
				}),
			);
			reg.register(
				makeEvaluator({
					name: "second",
					priority: 20,
					handle: (ctx) => {
						// Sibling read.
						(ctx.runtime as unknown as { _seen?: unknown })._seen =
							ctx.parsed.injected;
						return undefined;
					},
				}),
			);

			const args = defaultDispatchArgs(undefined, {
				first: "a",
				second: "b",
			});
			const res = await reg.dispatch(args);
			expect((res.parsed as Record<string, unknown>).injected).toBe("yes");
			expect((args.runtime as unknown as { _seen?: unknown })._seen).toBe(
				"yes",
			);
		});

		it("parse returning null soft-fails (trace.parseOutcome='soft-fail', handler skipped)", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			let handlerCalled = false;
			reg.register(
				makeEvaluator({
					name: "softFail",
					parse: () => null,
					handle: () => {
						handlerCalled = true;
						return undefined;
					},
				}),
			);
			const res = await reg.dispatch(
				defaultDispatchArgs(undefined, { softFail: "bad" }),
			);
			const trace = res.traces.find((t) => t.fieldName === "softFail");
			expect(trace?.parseOutcome).toBe("soft-fail");
			expect(trace?.handled).toBe(false);
			expect(handlerCalled).toBe(false);
			expect(res.fieldErrors.softFail).toMatch(/soft fail/);
		});

		it("parse throwing hard-fails (trace.parseOutcome='hard-fail') and records fieldErrors", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			let handlerCalled = false;
			reg.register(
				makeEvaluator({
					name: "hardFail",
					parse: () => {
						throw new Error("parse-blew-up");
					},
					handle: () => {
						handlerCalled = true;
						return undefined;
					},
				}),
			);
			const res = await reg.dispatch(
				defaultDispatchArgs(undefined, { hardFail: "bad" }),
			);
			const trace = res.traces.find((t) => t.fieldName === "hardFail");
			expect(trace?.parseOutcome).toBe("hard-fail");
			expect(trace?.errorMessage).toBe("parse-blew-up");
			expect(res.fieldErrors.hardFail).toBe("parse-blew-up");
			expect(handlerCalled).toBe(false);
		});

		it("handler throwing is caught and recorded in fieldErrors", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(
				makeEvaluator({
					name: "boom",
					handle: () => {
						throw new Error("handle-boom");
					},
				}),
			);
			const res = await reg.dispatch(
				defaultDispatchArgs(undefined, { boom: "v" }),
			);
			expect(res.fieldErrors.boom).toBe("handle-boom");
			const trace = res.traces.find((t) => t.fieldName === "boom");
			expect(trace?.errorMessage).toBe("handle-boom");
		});

		it("an already-aborted turnSignal short-circuits remaining handlers after a preempt", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			const controller = new AbortController();
			let secondHandled = false;

			reg.register(
				makeEvaluator({
					name: "preempter",
					priority: 10,
					handle: () => {
						controller.abort();
						return { preempt: { mode: "ack-and-stop", reason: "stop" } };
					},
				}),
			);
			reg.register(
				makeEvaluator({
					name: "afterPreempt",
					priority: 20,
					handle: () => {
						secondHandled = true;
						return undefined;
					},
				}),
			);

			const res = await reg.dispatch(
				defaultDispatchArgs(controller.signal, {
					preempter: "a",
					afterPreempt: "b",
				}),
			);
			// Either the preempt or the abort check short-circuits the second handler.
			expect(secondHandled).toBe(false);
			expect(res.preempt).toEqual({ mode: "ack-and-stop", reason: "stop" });
		});

		it("aborted turnSignal mid-dispatch skips handler on a subsequent field but still records trace", async () => {
			// Three-field setup. First handler aborts the signal but does NOT preempt.
			// Second handler should be skipped because of the abort check at the top
			// of the per-evaluator loop (not the preempt break).
			const reg = new ResponseHandlerFieldRegistry();
			const controller = new AbortController();
			let secondHandled = false;
			let thirdHandled = false;

			reg.register(
				makeEvaluator({
					name: "abortsSiblings",
					priority: 10,
					handle: () => {
						controller.abort();
						return undefined; // No preempt — only signal abort.
					},
				}),
			);
			reg.register(
				makeEvaluator({
					name: "skippedDueToAbort",
					priority: 20,
					handle: () => {
						secondHandled = true;
						return undefined;
					},
				}),
			);
			reg.register(
				makeEvaluator({
					name: "alsoSkipped",
					priority: 30,
					handle: () => {
						thirdHandled = true;
						return undefined;
					},
				}),
			);

			const res = await reg.dispatch(
				defaultDispatchArgs(controller.signal, {
					abortsSiblings: "x",
					skippedDueToAbort: "y",
					alsoSkipped: "z",
				}),
			);
			expect(secondHandled).toBe(false);
			expect(thirdHandled).toBe(false);
			const skipTrace = res.traces.find(
				(t) => t.fieldName === "skippedDueToAbort",
			);
			expect(skipTrace?.handled).toBe(false);
		});

		it("skips handler when shouldRun returns false and records trace as inactive", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			let handlerCalled = false;
			reg.register(
				makeEvaluator({
					name: "off",
					shouldRun: () => false,
					handle: () => {
						handlerCalled = true;
						return undefined;
					},
				}),
			);
			const res = await reg.dispatch(
				defaultDispatchArgs(undefined, { off: "x" }),
			);
			expect(handlerCalled).toBe(false);
			const trace = res.traces.find((t) => t.fieldName === "off");
			expect(trace?.active).toBe(false);
			expect(trace?.parseOutcome).toBe("skipped");
		});

		it("evaluator without a handle is still parsed and traced", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(
				makeEvaluator({
					name: "noHandle",
					parse: (v) => (typeof v === "string" ? `parsed:${v}` : null),
				}),
			);
			const res = await reg.dispatch(
				defaultDispatchArgs(undefined, { noHandle: "raw" }),
			);
			expect((res.parsed as Record<string, unknown>).noHandle).toBe(
				"parsed:raw",
			);
			const trace = res.traces.find((t) => t.fieldName === "noHandle");
			expect(trace?.parseOutcome).toBe("ok");
			expect(trace?.handled).toBe(false);
		});

		it("records debug strings from effect.debug into the trace", async () => {
			const reg = new ResponseHandlerFieldRegistry();
			reg.register(
				makeEvaluator({
					name: "noisy",
					handle: () => ({ debug: ["one", "two"] }),
				}),
			);
			const res = await reg.dispatch(
				defaultDispatchArgs(undefined, { noisy: "x" }),
			);
			const trace = res.traces.find((t) => t.fieldName === "noisy");
			expect(trace?.debug).toEqual(["one", "two"]);
		});
	});
});
