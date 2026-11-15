/** Regression tests for the counterexamples checked in quint/ActionSettlement.qnt. */
import { expect, it } from "vitest";
import { settleActionHandler } from "../src/runtime/action-handler-settlement";
import type { Action, HandlerCallback } from "../src/types/components";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ActionSettlement.qnt DeliveredInEmissionOrder: a callback emitted after the
// handler returned must not overtake callbacks still buffered for delivery.
it("delivers a callback emitted during the buffered drain after the buffered ones", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Settlement order", bio: [] },
		logLevel: "fatal",
	});
	const action: Action = {
		name: "ORDER_FIXTURE",
		description: "Emits two callbacks, then one more after it returns",
		validate: async () => true,
		handler: async () => ({ success: true }),
	};
	const delivered: string[] = [];
	// A transport that takes a moment per message, like a chat API call.
	const callback: HandlerCallback = async (content) => {
		delivered.push(content.text ?? "");
		await tick(20);
		return [];
	};

	await settleActionHandler({
		runtime,
		action,
		callback,
		invoke: async (cb) => {
			await cb?.({ text: "first" });
			await cb?.({ text: "second" });
			// Background work that reports after the handler has returned.
			setTimeout(() => void cb?.({ text: "third" }), 5);
			return { success: true };
		},
	});
	await tick(60);

	expect(delivered).toEqual(["first", "second", "third"]);
});
