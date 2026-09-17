/**
 * Exercises real runtime model dispatch with PGlite and a strict fixture provider.
 * A registered but never dispatched fixture must not count as a passing test.
 */

import { createTestRuntimeWithModelProvider } from "@elizaos/testing/model-provider-runtime";
import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../types/model.ts";

describe("model-provider-runtime", () => {
	it.each([false, true])(
		"rejects unused fixtures while draining teardown (stop failure: %s)",
		async (failStop) => {
			const previousDirectory = process.env.PGLITE_DATA_DIR;
			const harness = await createTestRuntimeWithModelProvider({
				fixtures: [
					{ name: "required-but-unused", response: "answer", times: 1 },
				],
			});
			const stopFailure = new Error("stop failure after drain");
			const stop = harness.runtime.stop.bind(harness.runtime);
			vi.spyOn(harness.runtime, "stop").mockImplementation(async () => {
				await stop();
				if (failStop) throw stopFailure;
			});
			const close = vi.spyOn(harness.runtime, "close");
			const failure = await harness.cleanup().then(
				() => null,
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(Error);
			if (!(failure instanceof Error))
				throw new Error("Cleanup unexpectedly succeeded");
			if (failStop) {
				expect(failure).toBeInstanceOf(AggregateError);
				if (!(failure instanceof AggregateError)) throw failure;
				expect(failure.errors).toContain(stopFailure);
				expect(failure.errors).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							message: expect.stringContaining("required-but-unused"),
						}),
					]),
				);
			} else {
				expect(failure.message).toContain("required-but-unused");
			}
			expect(close).toHaveBeenCalledOnce();
			expect(process.env.PGLITE_DATA_DIR).toBe(previousDirectory);
		},
	);

	it("dispatches through the runtime and consumes the exact expected response", async () => {
		const testFixture = {
			name: "sample-query-fixture",
			match: {
				modelType: ModelType.TEXT_LARGE,
				prompt: "test-query",
			},
			response: "deterministic-answer",
			times: 1,
		};

		const harness = await createTestRuntimeWithModelProvider({
			characterName: "TestFixtureAgent",
			fixtures: [testFixture],
		});

		try {
			expect(() => harness.assertFixturesConsumed()).toThrow();
			await expect(
				harness.runtime.useModel(ModelType.TEXT_LARGE, {
					prompt: "test-query",
				}),
			).resolves.toBe("deterministic-answer");
			harness.assertFixturesConsumed();
		} finally {
			await harness.cleanup();
		}
	});
});
