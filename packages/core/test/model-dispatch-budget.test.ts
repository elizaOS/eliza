/**
 * The final model-input budget attached to providerOptions must equal a full
 * measurement of the request that carries it, while the dispatcher serializes
 * the request only once to compute it.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { describe, expect, it } from "vitest";
import type { Character } from "../src/types/agent.ts";
import { ModelType } from "../src/types/model.ts";

function utf8Length(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function makeRuntime() {
	const runtime = createSQLiteTestRuntime({
		character: { name: "BudgetAgent", bio: "test", settings: {} } as Character,
		logLevel: "fatal",
	});
	let received: Record<string, unknown> | undefined;
	runtime.registerModel(
		ModelType.TEXT_LARGE,
		async (_runtime, params) => {
			received = params as Record<string, unknown>;
			return "ok";
		},
		"budget-provider",
	);
	return {
		runtime,
		take() {
			if (!received) throw new Error("model handler was not invoked");
			const value = received;
			received = undefined;
			return value;
		},
	};
}

function attachedEstimate(params: Record<string, unknown>): number {
	const options = params.providerOptions as {
		eliza: { modelInputBudget: { estimatedInputTokens: number } };
	};
	return options.eliza.modelInputBudget.estimatedInputTokens;
}

describe("final model-input budget", () => {
	it("matches a full re-measure across digit-count boundaries", async () => {
		const { runtime, take } = makeRuntime();
		const lengths = [
			...Array.from({ length: 60 }, (_, i) => 640 + i * 7),
			...Array.from({ length: 30 }, (_, i) => 9560 + i * 17),
		];
		for (const length of lengths) {
			await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: "é".repeat(length % 5) + "x".repeat(length),
				providerOptions: { other: { keep: true } },
			});
			const params = take();
			expect(attachedEstimate(params)).toBe(utf8Length(params));
			expect(params.providerOptions).toMatchObject({
				other: { keep: true },
			});
		}
	});

	it("serializes the request once", async () => {
		const { runtime, take } = makeRuntime();
		let serializations = 0;
		class Probe {
			toJSON() {
				serializations += 1;
				return "probe";
			}
		}
		await runtime.useModel(ModelType.TEXT_LARGE, {
			prompt: "hello",
			probe: new Probe(),
		} as never);
		expect(serializations).toBe(1);
		const params = take();
		expect(attachedEstimate(params)).toBe(utf8Length(params));
	});
});
