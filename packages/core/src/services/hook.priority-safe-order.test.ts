/**
 * Hook execution ordering. `dispatchToHooks` runs hooks sequentially so each
 * one can modify the payload before the next sees it, which makes the order
 * load-bearing rather than cosmetic.
 *
 * `HookPriority` is a bare `number`, `register` guards only absence
 * (`options.priority ?? DEFAULT_HOOK_PRIORITY`), and `setPriority` writes the
 * caller's value with no validation at all. A non-finite priority therefore
 * reaches the comparator, where the subtraction returns NaN and
 * `Array.prototype.sort` leaves the pair as is — silently reordering hooks that
 * are themselves perfectly well-formed.
 *
 * Drives the real service through the real event interceptor it installs on a
 * minimal fake runtime. No model, no DB.
 */
import { describe, expect, it } from "vitest";

import { EventType } from "../types/events";
import type { IAgentRuntime } from "../types/runtime";
import { HookService } from "./hook";

const EVENT = EventType.HOOK_SESSION_START;

type Interceptor = (payload: unknown) => Promise<void>;

function makeRuntime(sink: Map<string, Interceptor>): IAgentRuntime {
	const noop = () => {};
	return {
		agentId: "00000000-0000-0000-0000-0000000000aa",
		logger: { debug: noop, info: noop, warn: noop, error: noop, trace: noop },
		registerEvent: (eventType: string, handler: Interceptor) => {
			sink.set(eventType, handler);
		},
	} as unknown as IAgentRuntime;
}

async function runOrder(
	priorities: Array<{ name: string; priority?: number }>,
	mutate?: (service: HookService, ids: Map<string, string>) => void,
): Promise<string[]> {
	const interceptors = new Map<string, Interceptor>();
	const service = (await HookService.start(
		makeRuntime(interceptors),
	)) as HookService;
	const order: string[] = [];
	const ids = new Map<string, string>();
	for (const spec of priorities) {
		const id = service.register(
			EVENT,
			async () => {
				order.push(spec.name);
			},
			{
				name: spec.name,
				...(spec.priority === undefined ? {} : { priority: spec.priority }),
			},
		);
		ids.set(spec.name, id);
	}
	mutate?.(service, ids);
	const interceptor = interceptors.get(EVENT as unknown as string);
	if (!interceptor) throw new Error("hook interceptor was not registered");
	await interceptor({});
	return order;
}

describe("hook execution order", () => {
	it("runs higher priority hooks first", async () => {
		expect(
			await runOrder([
				{ name: "low", priority: 1 },
				{ name: "high", priority: 10 },
				{ name: "mid", priority: 5 },
			]),
		).toEqual(["high", "mid", "low"]);
	});

	it("does not let a NaN priority preempt every properly-prioritized hook", async () => {
		// The comparator returns NaN for every pair the bad hook takes part in, so
		// sort leaves it where it started — ahead of hooks that outrank it.
		const order = await runOrder([
			{ name: "bad", priority: Number.NaN },
			{ name: "p9", priority: 9 },
			{ name: "p5", priority: 5 },
			{ name: "p1", priority: 1 },
		]);
		expect(order[0]).not.toBe("bad");
		expect(order.filter((n) => n !== "bad")).toEqual(["p9", "p5", "p1"]);
	});

	it("treats a NaN priority as the default priority", async () => {
		// DEFAULT_HOOK_PRIORITY is 0, so an unusable priority must rank below a
		// positive one and above a negative one instead of returning NaN.
		expect(
			await runOrder([
				{ name: "bad", priority: Number.NaN },
				{ name: "positive", priority: 5 },
				{ name: "negative", priority: -5 },
			]),
		).toEqual(["positive", "bad", "negative"]);
	});

	it("does not let setPriority(NaN) promote a hook above its peers", async () => {
		// setPriority performs no validation at all, so this is the most direct
		// route for a non-finite priority to reach the comparator.
		const order = await runOrder(
			[
				{ name: "bad", priority: 8 },
				{ name: "positive", priority: 5 },
				{ name: "negative", priority: -5 },
			],
			(service, ids) => {
				const id = ids.get("bad");
				if (id) service.setPriority(id, Number.NaN);
			},
		);
		// DEFAULT_HOOK_PRIORITY is 0, so the demoted hook belongs between them.
		expect(order).toEqual(["positive", "bad", "negative"]);
	});

	it("keeps registration order for equal priorities", async () => {
		expect(
			await runOrder([
				{ name: "first", priority: 5 },
				{ name: "second", priority: 5 },
			]),
		).toEqual(["first", "second"]);
	});
});
