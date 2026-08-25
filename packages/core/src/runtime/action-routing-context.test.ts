/**
 * Covers the action-scoped routing context that the runtime wraps around every
 * action handler so a transitive `useModel` call can read the executing
 * action's `modelClass`.
 *
 * The load-bearing properties are the ones AsyncLocalStorage exists to provide:
 * the context survives `await` boundaries inside a handler, concurrently
 * running handlers never observe each other's context, and nesting restores
 * the outer context on exit. `runWithoutActionRoutingContext` is the seam the
 * `useModel` resolver uses to make a routed sub-call without re-entering the
 * routing path and looping, so it must actually clear — not merely shadow.
 *
 * Runs against the real module on the real Node manager; no mocks.
 */
import { describe, expect, it } from "vitest";
import type { ActionModelClass } from "../types/components.ts";
import {
	getActionRoutingContext,
	runWithActionRoutingContext,
	runWithoutActionRoutingContext,
} from "./action-routing-context.ts";

const ctx = (actionName: string, modelClass?: ActionModelClass) => ({
	actionName,
	modelClass,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("action routing context", () => {
	it("is undefined outside any run", () => {
		expect(getActionRoutingContext()).toBeUndefined();
	});

	it("exposes the context synchronously inside the callback", () => {
		const seen = runWithActionRoutingContext(ctx("SEND"), () =>
			getActionRoutingContext(),
		);
		expect(seen).toEqual({ actionName: "SEND", modelClass: undefined });
	});

	it("returns the callback's value unchanged", () => {
		expect(runWithActionRoutingContext(ctx("A"), () => 42)).toBe(42);
	});

	it("does not leak the context after the run completes", () => {
		runWithActionRoutingContext(ctx("A"), () => getActionRoutingContext());
		expect(getActionRoutingContext()).toBeUndefined();
	});

	it("survives an await boundary inside the handler", async () => {
		const seen = await runWithActionRoutingContext(ctx("SLOW"), async () => {
			await tick();
			return getActionRoutingContext()?.actionName;
		});
		expect(seen).toBe("SLOW");
	});

	it("keeps concurrently running handlers isolated from each other", async () => {
		const [a, b] = await Promise.all([
			runWithActionRoutingContext(ctx("A"), async () => {
				await tick();
				await tick();
				return getActionRoutingContext()?.actionName;
			}),
			runWithActionRoutingContext(ctx("B"), async () => {
				await tick();
				return getActionRoutingContext()?.actionName;
			}),
		]);
		expect([a, b]).toEqual(["A", "B"]);
	});

	it("restores the outer context when a nested run exits", () => {
		const observed = runWithActionRoutingContext(ctx("OUTER"), () => {
			const inner = runWithActionRoutingContext(
				ctx("INNER"),
				() => getActionRoutingContext()?.actionName,
			);
			return { inner, afterInner: getActionRoutingContext()?.actionName };
		});
		expect(observed).toEqual({ inner: "INNER", afterInner: "OUTER" });
	});

	it("clears the context inside runWithoutActionRoutingContext", () => {
		const observed = runWithActionRoutingContext(ctx("OUTER"), () => {
			const cleared = runWithoutActionRoutingContext(() =>
				getActionRoutingContext(),
			);
			return { cleared, restored: getActionRoutingContext()?.actionName };
		});
		expect(observed).toEqual({ cleared: undefined, restored: "OUTER" });
	});

	it("keeps the context cleared across an await inside the cleared run", async () => {
		const seen = await runWithActionRoutingContext(ctx("OUTER"), async () =>
			runWithoutActionRoutingContext(async () => {
				await tick();
				return getActionRoutingContext();
			}),
		);
		expect(seen).toBeUndefined();
	});

	it("carries the modelClass hint through to a transitive reader", () => {
		const seen = runWithActionRoutingContext(
			ctx("REPLY", "TEXT_LARGE" as ActionModelClass),
			() => {
				const deep = () => getActionRoutingContext();
				return deep();
			},
		);
		expect(seen?.modelClass).toBe("TEXT_LARGE");
	});

	it("treats an explicitly undefined context as no context", () => {
		const seen = runWithActionRoutingContext(undefined, () =>
			getActionRoutingContext(),
		);
		expect(seen).toBeUndefined();
	});
});
